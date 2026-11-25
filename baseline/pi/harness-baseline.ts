// The same harness baseline Claude Code gets from ~/.claude/settings.json and ~/.claude/hooks, for Pi.
// One source for both tools: the deny list is ~/.claude/harness-baseline/deny.json and the session-start
// and stop checks are the same scripts, so a change there reaches Pi and Claude Code at once.
//
// - tool_call: blocks reads/edits of the secret files in deny.json, bash commands that name them, and
//   force pushes. Pi has no permission system or sandbox, so this is a guard on what the model asks for,
//   not on what a child process opens: a dependency run by a test can still read .env.
// - session_start: runs baseline-check.sh and, when the repo is behind, tells the user and the model.
// - agent_before_settle: runs verify-on-stop.sh; on exit 2 the failure goes back to the model, which
//   continues. The script itself skips unchanged trees and gives up after three failures.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

const HOME = homedir();
const BASELINE = join(HOME, ".claude", "harness-baseline");
const HOOKS = join(HOME, ".claude", "hooks");
const MARKER = "<!-- harness-baseline -->";

type Rules = { files: RegExp[]; dirs: string[]; commands: string[] };

function globToRegex(glob: string): RegExp {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${body}$`);
}

function loadRules(): Rules {
  const rules: Rules = { files: [], dirs: [], commands: [] };
  let raw: string[] = [];
  try {
    raw = JSON.parse(readFileSync(join(BASELINE, "deny.json"), "utf8"));
  } catch {
    return rules;
  }
  for (const rule of raw) {
    const m = /^(Read|Bash)\((.*)\)$/.exec(rule);
    if (!m) continue;
    const [, tool, arg] = m;
    if (tool === "Bash") {
      rules.commands.push(arg.replace(/\*$/, "").trim());
    } else if (arg.startsWith("~/") && arg.endsWith("/**")) {
      rules.dirs.push(join(HOME, arg.slice(2, -3)));
    } else {
      rules.files.push(globToRegex(basename(arg)));
    }
  }
  return rules;
}

function secretPath(path: string, cwd: string, rules: Rules): string | undefined {
  const expanded = path.startsWith("~/") ? join(HOME, path.slice(2)) : path;
  const abs = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  if (rules.files.some((re) => re.test(basename(abs)))) return abs;
  if (rules.dirs.some((d) => abs === d || abs.startsWith(`${d}/`))) return abs;
  return undefined;
}

function blockedCommand(command: string, cwd: string, rules: Rules): string | undefined {
  const flat = command.replace(/\s+/g, " ");
  const forced = rules.commands.find((c) => flat.includes(c));
  if (forced) return `"${forced}" está bloqueado por el baseline de arnés`;
  for (const token of command.split(/[\s'"`;|&<>()=]+/)) {
    if (!token) continue;
    const hit = secretPath(token.replace(/^\$HOME\//, "~/"), cwd, rules);
    if (hit) return `el comando toca ${hit}, que el baseline de arnés marca como secreto`;
  }
  return undefined;
}

function runHook(script: string, cwd: string, timeoutMs: number) {
  return spawnSync(join(HOOKS, script), {
    input: JSON.stringify({ cwd }),
    encoding: "utf8",
    timeout: timeoutMs,
  });
}

function systemMessage(stdout: string | null): string | undefined {
  try {
    return JSON.parse(stdout ?? "")?.systemMessage;
  } catch {
    return undefined;
  }
}

export default function (pi: ExtensionAPI) {
  const rules = loadRules();
  let baselineNote = "";

  pi.on("tool_call", async (event, ctx) => {
    const input = event.input as { path?: string; command?: string };
    if (["read", "edit", "write"].includes(event.toolName) && input.path) {
      const hit = secretPath(input.path, ctx.cwd, rules);
      if (hit) return { block: true, reason: `${hit} es un archivo de secretos (baseline de arnés); no se lee ni se edita.` };
    }
    if (event.toolName === "bash" && input.command) {
      const reason = blockedCommand(input.command, ctx.cwd, rules);
      if (reason) return { block: true, reason };
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    const r = runHook("baseline-check.sh", ctx.cwd, 10_000);
    const msg = systemMessage(r.stdout);
    if (!msg) return;
    ctx.ui.notify(msg, "warning");
    baselineNote = `${MARKER}\nEl baseline de arnés de este repo está atrasado. ${msg} En tu primera respuesta díselo al usuario en una línea y ofrécele /arnes-al-dia; no lo ejecutes sin que lo pida.`;
  });

  pi.on("before_agent_start", async (event) => {
    if (!baselineNote || event.systemPrompt.includes(MARKER)) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${baselineNote}` };
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    const r = runHook("verify-on-stop.sh", ctx.cwd, 300_000);
    const msg = systemMessage(r.stdout);
    if (msg) ctx.ui.notify(msg, "warning");
    if (r.status !== 2) return;
    return {
      entries: [
        ...event.entries,
        { type: "custom_message", customType: "verify-on-stop", content: r.stderr || "La verificación del proyecto falló.", display: true },
      ],
      continue: true,
    };
  });
}
