#!/usr/bin/env node
// port-loops.js — F9: mechanical frontmatter transform for the commands/agents that ship the five
// loops, ported to OpenCode, Kilo Code, and Pi (via the pi-subagents extension). install.sh does the
// gating/UX (interactive prompts, --skip-subagent-check); this file only knows how to read the
// Claude Code schema and write the target's own schema. No YAML dependency: every frontmatter line
// in commands/*.md and agents/*.md is a flat `key: value` pair (verified against the whole corpus
// before this file was written) — a line without a `:` is refused rather than guessed at.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

function parseFrontmatter(src) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(src);
  if (!m) throw new Error('missing or malformed --- frontmatter block');
  const [, fmBlock, body] = m;
  const fm = [];
  for (const line of fmBlock.split('\n')) {
    if (!line.trim()) continue;
    const idx = line.indexOf(':');
    if (idx === -1) {
      throw new Error(`frontmatter line has no ':' — this parser only reads flat key: value pairs, `
        + `not multi-line YAML: "${line}"`);
    }
    fm.push([line.slice(0, idx).trim(), line.slice(idx + 1).trim()]);
  }
  return { fm, body };
}

// `value` is either a plain string (single-line `key: value`) or a plain object, serialized as a
// one-level-deep nested block (`permission:` is the only field this port ever nests).
function serializeFrontmatter(pairs, body) {
  const lines = [];
  for (const [k, v] of pairs) {
    if (v && typeof v === 'object') {
      lines.push(`${k}:`);
      for (const [pk, pv] of Object.entries(v)) lines.push(`  ${pk}: ${pv}`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  return `---\n${lines.join('\n')}\n---\n${body}`;
}

const get = (fm, key) => (fm.find(([k]) => k === key) || [])[1];

// Claude Code tool token -> destination tool id per target family. Only tokens this repo's own
// commands/agents actually declare are listed (verified against every commands/*.md and agents/*.md
// in this repo, 2026-07-12); a token outside this map is dropped, not guessed at — a fabricated tool
// id fails silently at the target's own resolution step, a dropped one is reported by this script.
//   permission: the OpenCode/Kilo Code `permission:` key this tool gates (both share the same
//     vocabulary — verified against opencode.ai/docs/agents and kilo.ai/docs/customize/agent-permissions,
//     2026-07-12).
//   pi: the pi-subagents `tools:` builtin id (verified against github.com/nicobailon/pi-subagents
//     README, 2026-07-12). `null` = no verified equivalent.
const TOOL_MAP = {
  Read: { permission: 'read', pi: 'read' },
  Write: { permission: 'edit', pi: 'write' },
  Edit: { permission: 'edit', pi: 'edit' },
  Grep: { permission: 'grep', pi: 'grep' },
  Glob: { permission: 'glob', pi: null },
  Bash: { permission: 'bash', pi: 'bash' },
  Task: { permission: 'task', pi: 'subagent' },
  WebSearch: { permission: 'websearch', pi: null },
  AskUserQuestion: { permission: 'question', pi: null },
};

// "Task, Read, Bash(git diff:*), Bash(mkdir:*)" -> ["Task", "Read", "Bash", "Bash"]. The `Bash(pattern:*)`
// per-command sub-scoping Claude Code supports has no destination in either target's `permission`/`tools`
// vocabulary (both gate whole categories, not individual shell commands) — collapsed to the base token.
function parseToolList(raw) {
  return raw.split(',').map((t) => t.trim().replace(/\(.*\)$/, '')).filter(Boolean);
}

// OpenCode and Kilo Code share one schema for both commands and agents (verified against
// opencode.ai/docs/commands, opencode.ai/docs/agents, and kilo.ai/docs/customize/{workflows,custom-subagents},
// 2026-07-12 — Kilo Code's newer engine mirrors OpenCode's config shape field for field).

// A command's ONLY carried field is `description`. `argument-hint` is Claude Code's `/command`
// autocomplete hint and has no OpenCode/Kilo Code equivalent.
//
// `allowed-tools` has no destination on a COMMAND in either target — permission lives on the AGENT
// schema there, not the command (see transformAgentOpenCodeKilo).
//
// `disable-model-invocation` — Claude Code's auto-dispatch veto, and the ONLY thing standing between
// the model and firing /review-loop, /iterate or /session-review on its own — has no equivalent field
// in either target. It is DROPPED, and dropping it is a real loss of a guardrail, not a formatting
// detail: two of those loops are token-hungry (cost) and the third analyses the human (consent). This
// function reports it as a dropped field so install.sh can warn about it at the point of install, and
// README §Compatibility carries the standing caveat. Neither target offers anything to translate it
// into; the honest move is to say so, loudly, in both places.
const COMMAND_DROPPED_GUARDRAIL = 'disable-model-invocation';

function transformCommandOpenCodeKilo(fm) {
  const description = get(fm, 'description');
  if (!description) throw new Error('command missing description');
  const dropped = [];
  if (get(fm, COMMAND_DROPPED_GUARDRAIL)) dropped.push(COMMAND_DROPPED_GUARDRAIL);
  return { fm: [['description', description]], dropped };
}

function transformAgentOpenCodeKilo(fm) {
  const description = get(fm, 'description');
  const model = get(fm, 'model');
  const toolsRaw = get(fm, 'tools');
  if (!description) throw new Error('agent missing description');
  const out = [['description', description], ['mode', 'subagent']];
  // `model` is carried verbatim — it is still the Claude Code short alias (sonnet/fable/opus), which
  // neither OpenCode nor Kilo can resolve: they want a `provider/model` id. Without `--lineup` (F11)
  // re-stamping this line, the field is an unresolvable placeholder, not a working pin. README
  // §Option 4 says so and tells the reader to run --lineup; the field is kept rather than omitted
  // because --lineup's re-stamp is a `sed` on an existing `^model:` line, and omitting it here would
  // leave --lineup with nothing to stamp.
  if (model) out.push(['model', model]);
  const permission = {};
  const dropped = [];
  if (toolsRaw) {
    for (const t of parseToolList(toolsRaw)) {
      const mapped = TOOL_MAP[t];
      if (mapped && mapped.permission) permission[mapped.permission] = 'allow';
      else dropped.push(t);
    }
  }
  if (Object.keys(permission).length) out.push(['permission', permission]);
  return { fm: out, dropped };
}

// Pi's agents (via the pi-subagents extension) do not fit the OpenCode/Kilo schema at all — `name` is
// required (Pi's discovery keys agents by filename AND frontmatter `name`), and there is no `mode` or
// `permission` field, just a flat `tools:` allowlist (verified against
// github.com/nicobailon/pi-subagents README "Agent frontmatter" section, 2026-07-12).
function transformAgentPi(fm) {
  const name = get(fm, 'name');
  const description = get(fm, 'description');
  const model = get(fm, 'model');
  const toolsRaw = get(fm, 'tools');
  if (!name) throw new Error('agent missing name (required by pi-subagents agent frontmatter)');
  if (!description) throw new Error('agent missing description');
  const out = [['name', name], ['description', description]];
  const dropped = [];
  if (toolsRaw) {
    const mapped = [...new Set(parseToolList(toolsRaw).map((t) => TOOL_MAP[t] && TOOL_MAP[t].pi)
      .filter((v, i, arr) => { if (v) return true; dropped.push(parseToolList(toolsRaw)[i]); return false; }))];
    if (mapped.length) out.push(['tools', mapped.join(', ')]);
  }
  // Same unresolvable-alias caveat as the OpenCode/Kilo transform above, and the same reason for
  // keeping the field: --lineup re-stamps `^model:` in place, so an omitted line is an unstampable one.
  if (model) out.push(['model', model]);
  // Every one of this repo's agents receives ONLY the artifacts named in its prompt, never the
  // conversation that produced them (the independence property every critic/scorer prompt states
  // explicitly) — the same contract Claude Code's Task tool already enforces by always starting
  // subagents fresh. `defaultContext: fresh` is the pi-subagents field that encodes exactly that,
  // not a guessed default.
  out.push(['defaultContext', 'fresh']);
  return { fm: out, dropped };
}

function destDirsFor(target) {
  switch (target) {
    case 'opencode': return { commands: '.opencode/commands', agents: '.opencode/agents' };
    case 'kilo-loops': return { commands: '.kilo/commands', agents: '.kilo/agents' };
    // Pi's native slash commands (~/.pi/agent/prompts/*.md) are prompt templates, not agent
    // dispatchers (per pi.dev) — porting the loop commands there would look like a working /orchestrate
    // and dispatch nothing. Only agents are ported for Pi.
    case 'pi': return { commands: null, agents: '.pi/agents' };
    default: throw new Error(`port-loops.js: unknown target '${target}' (use opencode|kilo-loops|pi)`);
  }
}

// Drops are reported PER FILE, never as one aggregated set: "dropped: WebSearch" tells a user that
// some capability went missing somewhere, which is not actionable. "correctness-critic.md: WebSearch"
// tells them the fact-checking critic — the one whose entire job is verifying claims against the web —
// can no longer reach the web on this target. Same information, and only one of the two can be acted on.
function portDir(srcDir, destDir, transform) {
  fs.mkdirSync(destDir, { recursive: true });
  const files = fs.readdirSync(srcDir).filter((f) => f.endsWith('.md')).sort();
  const dropped = [];
  for (const f of files) {
    const { fm, body } = parseFrontmatter(fs.readFileSync(path.join(srcDir, f), 'utf8'));
    const result = transform(fm);
    if (result.dropped.length) dropped.push({ file: f, fields: result.dropped });
    fs.writeFileSync(path.join(destDir, f), serializeFrontmatter(result.fm, body));
  }
  return { count: files.length, dropped };
}

function run(target, root) {
  const dest = destDirsFor(target);
  const dropped = [];
  let commandCount = 0;
  if (dest.commands) {
    const r = portDir(path.join(root, 'commands'), dest.commands, transformCommandOpenCodeKilo);
    commandCount = r.count;
    dropped.push(...r.dropped);
  }
  const agentTransform = target === 'pi' ? transformAgentPi : transformAgentOpenCodeKilo;
  const agentResult = portDir(path.join(root, 'agents'), dest.agents, agentTransform);
  dropped.push(...agentResult.dropped);
  return { commandCount, agentCount: agentResult.count, dropped };
}

function main() {
  const argv = process.argv.slice(2);
  const opt = (name, def) => { const i = argv.indexOf(name); return i === -1 || i === argv.length - 1 ? def : argv[i + 1]; };
  const target = opt('--target', null);
  const root = opt('--root', process.cwd());
  if (!target) {
    process.stderr.write('usage: port-loops.js --target <opencode|kilo-loops|pi> [--root <repoRoot>]\n');
    process.exit(1);
  }
  try {
    const { commandCount, agentCount, dropped } = run(target, root);
    process.stdout.write(`✓ ported ${commandCount} command(s) + ${agentCount} agent(s) to ${target}\n`);
    if (dropped.length) {
      process.stdout.write('⚠ fields with no equivalent on this target, dropped per file:\n');
      for (const { file, fields } of dropped) {
        process.stdout.write(`    ${file}: ${fields.join(', ')}\n`);
      }
    }
  } catch (e) {
    process.stderr.write(`port-loops.js: ${e.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  parseFrontmatter, serializeFrontmatter, transformCommandOpenCodeKilo, transformAgentOpenCodeKilo,
  transformAgentPi, destDirsFor, TOOL_MAP, parseToolList, run,
};
