// jev-router for Pi — the advisory line plus the CONFIRMED mission router (PRD-005).
//
// Two jobs, one Jev request per prompt (D1). On every prompt a human submits, Jev answers three
// discrete questions in a single ask: which installed Pi skill fits, which tier the work deserves, and
// which mission shape the prompt starts (mission-router.js MISSIONS). In Claude Code the tier is a
// subagent model; here it is translated to the line-up seat that plays that tier — scout, implementer,
// architect — and its model, so the suggestion is one you can act on in Pi. That part is advisory, as
// it always was: it never picks a model, never rewrites the prompt.
//
// The mission answer feeds mission-router.js — the pure decision layer. Every consequential route is a
// PROPOSAL behind a dialog that names the mission, the recommended model or loop and the current model
// (D2): a one-shot seat switch (question → explainer, design → creativo, complex planning → architect),
// restored at agent_end unless you changed the model yourself mid-run (D4), or a dispatch into the
// EXISTING loops — bounded → /develop-phase, complex with a ticket folder → /develop-spec PLAN first
// and --confirmed only after a second confirmation (D3). Nothing switches silently, nothing launches
// silently: escape/decline keeps the current chat and model. A confirmed dispatch goes out through
// pi.sendUserMessage(..., { expandPromptTemplates: true }) and the input handler answers `handled`
// only AFTER that call, so the original submission is consumed and never runs twice in the main chat.
//
// Bypasses (all fail open, before any dialog): low confidence, Jev failure/timeout, no UI, a prompt
// that names a model/loop/launcher flag itself, slash commands, short follow-ups, harness seats
// (HARNESS_SEAT / PI_SUBAGENT_CHILD), a missing seat model, and a provider blocked by the sticky
// credit block (~/.pi/agent/state/writer-route-credit-block.json — the 2026-10-27 incident). Off
// without a TypeSafe key (TYPESAFE_API_KEY in env or ~/.agents/secrets.env). `/mission` reports and
// switches routing for the session; `/jev` stays the classifier status command.
//
// Classification is cached per prompt (one in-flight promise), so `input` and `before_agent_start`
// share a single Jev call: one eligible prompt costs at most one request and 1.5 s of budget. What
// leaves the machine: the first 1500 chars of the prompt and the names + short descriptions of the
// installed skills. A slow API costs one dropped line, never a held prompt.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const REPO = process.env.HARNESS_AUDIT_DIR || join(homedir(), "Documents", "harness-audit");
// El router de Jev se movió con los loops a plugins/harness-loops/scripts/; se prueban las carpetas conocidas y el glob
// de plugins/*/scripts, para que un reparto distinto no vuelva a romper el comando en silencio.
function harnessScript(name: string): string {
  const dirs = [join(REPO, "plugins", "harness-loops", "scripts"), join(REPO, "scripts")];
  try {
    for (const entry of readdirSync(join(REPO, "plugins"))) dirs.push(join(REPO, "plugins", entry, "scripts"));
  } catch { /* sin carpeta plugins: se queda con las rutas fijas */ }
  return dirs.map((dir) => join(dir, name)).find((file) => existsSync(file)) ?? join(dirs[0]!, name);
}
const JEV = harnessScript("jev.js");
const MISSION_ROUTER = harnessScript("mission-router.js");
const LINEUP = process.env.MODEL_LINEUP_PATH || join(homedir(), ".agents", "model-lineup.json");
// El mismo fichero de bloqueo que writer-route.ts escribe al morir un run sin crédito: si el
// proveedor está bloqueado, su modelo no se propone hasta `/writer-route reset` (PRD-005 §5.7).
const CREDIT_BLOCK = join(homedir(), ".pi", "agent", "state", "writer-route-credit-block.json");

const PROMPT_CHARS = 1500;
const BUDGET_MS = 1500;
const MAX_SKILLS = 120;
const MIN_CONFIDENCE = 0.5;
const CACHE_MS = 60_000;

// Same criteria text as prompt-router.js, so both harnesses ask Jev the same question.
const TIERS: Record<string, string> = {
  haiku: "a mechanical or lookup task: find a file, rename, run a command, answer from something already in view",
  sonnet: "ordinary implementation or review: one feature, one bug, a bounded edit with clear acceptance",
  opus: "multi-file design, ambiguous requirements, architecture or reasoning where the wrong call is expensive",
};
const SEAT_FOR_TIER: Record<string, string> = { haiku: "scout", sonnet: "implementer", opus: "architect" };

// One-shot seats and the loop's seats (D3/D4): what the dialog names, read from the SAVED line-up —
// the daily advisor suggests, `/line-up advise` applies, routing never reads an unreviewed ranking (D6).
const ROUTE_ROLES = ["explainer", "creativo", "architect", "implementer", "reviewer"] as const;

// La confirmación corta tras el plan de /develop-spec ("sí", "ejecuta…") es la que PRD-005 §4 pide:
// una sola palabra, un último diálogo, y solo entonces --confirmed.
const CONFIRM_WORD = /^(?:sí|si|yes|ok|vale|dale|adelante|go|ejecuta\w*|confirma\w*)[.!?…]*$/i;

type Classification = { skill: any; tier: any; mission: any } | null;

function skillOptions(cwd: string): Record<string, string> {
  const dirs = [
    join(cwd, ".pi", "skills"),
    join(cwd, ".agents", "skills"),
    join(homedir(), ".pi", "agent", "skills"),
    join(homedir(), ".pi", "skills"),
    join(homedir(), ".agents", "skills"),
  ];
  const options: Record<string, string> = {};
  for (const dir of dirs) {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (options[name] || Object.keys(options).length >= MAX_SKILLS) continue;
      const file = join(dir, name, "SKILL.md");
      if (!existsSync(file)) continue;
      const desc = readFileSync(file, "utf8").match(/^description:\s*["']?(.+?)["']?\s*$/m)?.[1] || name;
      options[name] = desc.slice(0, 120);
    }
  }
  return options;
}

function seatModel(role: string): { provider?: string; model: string } | null {
  try {
    const l = JSON.parse(readFileSync(LINEUP, "utf8"));
    const e = l.harness?.pi?.[role] || l.defaults?.[role];
    return e && e.model ? { provider: e.provider, model: e.model } : null;
  } catch { return null; }
}

function creditBlocked(): string[] {
  try {
    const b = JSON.parse(readFileSync(CREDIT_BLOCK, "utf8"));
    return b && b.provider ? [b.provider] : [];
  } catch { return []; }
}

// One request, three questions (D1). Returns the raw answers so both the advisory line and the mission
// decision read the same classification — never two calls for one prompt.
async function classify(jev: any, router: any, prompt: string, cwd: string): Promise<Classification> {
  const options = skillOptions(cwd);
  const questions: Record<string, unknown> = {
    tier: jev.choiceQuestion("Which model tier does a subagent for this prompt deserve?", TIERS),
    mission: jev.choiceQuestion(router.MISSION_QUESTION, router.MISSIONS),
  };
  if (Object.keys(options).length) {
    questions.skill = jev.choiceQuestion(
      "Which installed skill is the right one to load for this prompt? Pick none when no skill fits.",
      { ...options, none: "no installed skill fits this prompt" },
    );
  }
  const r = await jev.ask({ state: { prompt: prompt.slice(0, PROMPT_CHARS) }, questions }, { timeoutMs: BUDGET_MS, waits: [] });
  return { skill: r.answers.skill, tier: r.answers.tier, mission: r.answers.mission };
}

function advisoryText(answers: Classification): string | null {
  if (!answers) return null;
  const parts: string[] = [];
  const p = (a: any) => Number(a.probabilities?.[a.choice] ?? a.confidence).toFixed(2);
  const skill = answers.skill;
  if (skill?.choice && skill.choice !== "none" && Number(skill.confidence) >= MIN_CONFIDENCE) {
    parts.push(`likely skill \`${skill.choice}\` (p=${p(skill)})`);
  }
  const tier = answers.tier;
  if (tier && TIERS[tier.choice] && Number(tier.confidence) >= MIN_CONFIDENCE) {
    const seat = SEAT_FOR_TIER[tier.choice];
    const model = seatModel(seat);
    parts.push(`tier ${tier.choice} → seat ${seat}${model ? ` (${model.provider ? `${model.provider}/` : ""}${model.model})` : ""} (p=${p(tier)})`);
  }
  const mission = answers.mission;
  if (mission?.choice && Number(mission.confidence) >= MIN_CONFIDENCE) {
    parts.push(`mission ${mission.choice} (p=${p(mission)})`);
  }
  return parts.length ? `harness-audit jev (advisory): ${parts.join("; ")}. Ignore if the prompt already says what to do.` : null;
}

export default function (pi: ExtensionAPI) {
  if (process.env.HARNESS_SEAT || !existsSync(JEV)) return;
  const jev = createRequire(JEV)(JEV);
  const router: any = existsSync(MISSION_ROUTER) ? createRequire(JEV)(MISSION_ROUTER) : null;
  if (!router) return; // sin decisiones puras no hay routing — solo quedaría advisory, y sin router no hay mission

  let disabled = false;                 // /mission off — la sesión, no el fichero
  let previous: any;                    // modelo a restaurar al terminar el run (D4)
  let setByUs: any;                     // el que pusimos: si cambia, fue el operador y se respeta
  let pendingSpec: string | null = null; // --confirmed en espera de la confirmación corta tras el plan
  let classified: { prompt: string; at: number; done: Promise<Classification> } | null = null;

  // Mismo corte que el router de Claude Code (prompt-router.js): slash y follow-ups cortos nunca
  // gastan una llamada de Jev — la decisión ya está tomada por el operador o no es una misión.
  const eligible = (p: string) => !router.isSlash(p) && !router.isShortFollowUp(p)
    && !process.env.HARNESS_SEAT && process.env.PI_SUBAGENT_CHILD !== "1";

  // Un solo ask por prompt: input y before_agent_start comparten la promesa (uno de los dos la crea,
  // el otro la reutiliza) — el caché dura CACHE_MS para que una repetición literal minutos después
  // vuelva a clasificar.
  function classifyOnce(prompt: string, cwd: string): Promise<Classification> {
    const now = Date.now();
    if (classified && classified.prompt === prompt && now - classified.at < CACHE_MS) return classified.done;
    const done: Promise<Classification> = Promise.race([
      classify(jev, router, prompt, cwd).catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), BUDGET_MS)),
    ]);
    classified = { prompt, at: now, done };
    return done;
  }

  function decide(prompt: string, answers: Classification, ctx: any) {
    const a = answers && (answers as any).mission;
    return router.decideMission({
      prompt,
      mission: a ? a.choice : null,
      p: a ? jev.pOf(a) : null,
      hasUI: !!ctx.hasUI,
      isSeat: !!process.env.HARNESS_SEAT || process.env.PI_SUBAGENT_CHILD === "1",
      sessionDisabled: disabled,
      seats: Object.fromEntries(ROUTE_ROLES.map((r) => [r, seatModel(r)])),
      blockedProviders: creditBlocked(),
    });
  }

  // ── despacho de bucles: input `handled` SOLO después de sendUserMessage ──────────────────────────
  pi.on("input", async (event: any, ctx: any) => {
    const text = String(event.text || "").trim();
    // `source: "extension"` es nuestro propio despacho volviendo a pasar por aquí (y los slash, en
    // general, son órdenes ya elegidas): ni se re-procesan ni borran la confirmación pendiente.
    if (!text || event.source === "extension") return { action: "continue" };
    if (router.isSlash(text)) return { action: "continue" };

    // Tras el plan de /develop-spec, una confirmación corta dispara el MISMO comando con --confirmed,
    // con un último diálogo (PRD-005 §4). Cualquier otra entrada cancela la confirmación pendiente.
    if (pendingSpec) {
      const spec = pendingSpec;
      if (!CONFIRM_WORD.test(text)) { pendingSpec = null; return { action: "continue" }; }
      pendingSpec = null;
      if (!ctx.hasUI) return { action: "continue" };
      const ok = await ctx.ui.confirm(`¿Ejecutar ${spec}?`, "El plan ya está en la conversación. Sí lanza la ejecución confirmada; No deja todo como está.");
      if (!ok) return { action: "continue" };
      pi.sendUserMessage(spec, { expandPromptTemplates: true });
      return { action: "handled" };
    }

    if (!jev.isEnabled() || !eligible(text)) return { action: "continue" }; // el operador ya eligió ruta, o no es una misión

    const answers = await classifyOnce(text, ctx.cwd);
    const d = decide(text, answers, ctx);
    if (d.action !== "confirm-loop" || !d.loop || !ctx.hasUI) return { action: "continue" };

    const impl = seatModel("implementer");
    const rev = seatModel("reviewer");
    const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "desconocido";
    const ok = await ctx.ui.confirm(
      `¿Despachar ${d.loop.command}?`,
      `Misión: ${d.mission} (${d.reason})\nTarea: ${text}\nBucle: ${d.loop.command} — implementer ${impl ? `${impl.provider ? `${impl.provider}/` : ""}${impl.model}` : "?"} · reviewer ${rev ? `${rev.provider ? `${rev.provider}/` : ""}${rev.model}` : "?"}\n`
        + `Sí despacha el bucle y consume este mensaje (no se ejecuta también en el chat); No deja la tarea en el chat actual (${current}).`,
    );
    if (!ok) return { action: "continue" };
    if (d.loop.confirmedDispatch) pendingSpec = d.loop.confirmedDispatch;
    pi.sendUserMessage(d.loop.dispatch, { expandPromptTemplates: true });
    return { action: "handled" };
  });

  // ── advisory + propuesta de modelo de un solo uso ────────────────────────────────────────────────
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    const prompt = String(event.prompt || "").trim();
    if (!jev.isEnabled() || !eligible(prompt)) return;
    const answers = await classifyOnce(prompt, ctx.cwd);
    const text = advisoryText(answers);
    if (text && ctx.hasUI) ctx.ui.setStatus("jev", text.replace(/^harness-audit jev \(advisory\): /, "jev: ").replace(/\. Ignore.*$/, ""));

    const d = decide(prompt, answers, ctx);
    if (d.action === "confirm-model" && d.model && ctx.hasUI && event.messageType === "user" && !disabled) {
      const target = ctx.modelRegistry.find(d.model.provider, d.model.model);
      const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "desconocido";
      const label = (m: any) => (m ? `${m.provider ? `${m.provider}/` : ""}${m.model}` : "?");
      const alternatives = ROUTE_ROLES
        .filter((r) => r !== d.role)
        .map((r) => seatModel(r))
        .filter((m): m is NonNullable<typeof m> => !!m && label(m) !== current && label(m) !== label(d.model))
        .map((m) => `Alternativa: ${label(m)}`);
      const pick = await ctx.ui.select(
        `Misión ${d.mission} — ¿con qué modelo?`,
        [`Recomendado: ${d.role} — ${label(d.model)}`, `Actual: ${current}`, ...alternatives],
      );
      if (target && pick && pick.startsWith("Recomendado")) {
        previous = ctx.model;
        setByUs = target;
        if (!(await pi.setModel(target))) {
          previous = undefined;
          setByUs = undefined;
          ctx.ui.notify(`jev-router: falta credencial para ${label(d.model)} — sigo en ${current}`, "warning");
        } else {
          ctx.ui.notify(`jev-router: ${label(d.model)} para esta tarea (${d.reason}); vuelvo a ${current} al terminar`, "info");
        }
      }
    }

    return text ? { message: { customType: "jev-router", content: text, display: false } } : undefined;
  });

  pi.on("agent_end", async (_event: any, ctx: any) => {
    if (!previous) return;
    const back = previous;
    const ours = setByUs;
    previous = undefined;
    setByUs = undefined;
    // Si el operador cambió de modelo a mano durante el run, su elección manda (D4).
    const stillOurs = ours && ctx.model && ctx.model.provider === ours.provider && ctx.model.id === ours.id;
    if (stillOurs) await pi.setModel(back);
  });

  pi.registerCommand("mission", {
    description: "Routing de misiones (PRD-005): estado; `off` lo apaga en esta sesión, `on` lo reactiva",
    handler: async (args: string, ctx: any) => {
      const action = (args || "").trim().toLowerCase();
      if (action === "off" || action === "disable") {
        disabled = true;
        pendingSpec = null;
        ctx.ui.notify("mission: routing apagado en esta sesión (`/mission on` para volver)", "info");
        return;
      }
      if (action === "on" || action === "enable") {
        disabled = false;
        ctx.ui.notify("mission: routing activo en esta sesión", "info");
        return;
      }
      const s = jev.status();
      const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "desconocido";
      const blocked = creditBlocked();
      ctx.ui.notify([
        `mission: ${disabled ? "apagado" : "activo"} (sesión actual) · modelo ${current}`,
        `jev: ${s.enabled ? `on (clave desde ${s.source})` : "off — sin TYPESAFE_API_KEY (bin/jev-setup)"}`,
        blocked.length ? `proveedor bloqueado por crédito: ${blocked.join(", ")} (/writer-route reset)` : "sin bloqueos de crédito",
        pendingSpec ? `pendiente: confirmación corta para ejecutar ${pendingSpec}` : "sin planes esperando confirmación",
        "comandos: /mission off | /mission on · /jev para el clasificador",
      ].join("\n"), "info");
    },
  });

  pi.registerCommand("jev", {
    description: "Estado del router Jev (TypeSafe): on/off y de dónde sale la clave",
    handler: async (_args: string, ctx: any) => {
      const s = jev.status();
      ctx.ui.notify(s.enabled ? `jev: on (clave desde ${s.source})` : "jev: off — sin TYPESAFE_API_KEY (bin/jev-setup en harness-audit)", "info");
    },
  });
}
