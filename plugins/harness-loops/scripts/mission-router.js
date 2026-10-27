#!/usr/bin/env node
// mission-router.js — the confirmed mission router's decisions, pure (PRD-005, D7).
//
// One prompt, one answer: stay in the ordinary chat, take a one-shot seat model (question → explainer,
// design → creativo, complex planning → architect), or dispatch an existing loop (bounded →
// /develop-phase, complex with a ticket folder → /develop-spec plan first). Every consequential route
// comes back as a PROPOSAL (`confirm-model` / `confirm-loop`): this file never changes a model and
// never starts a loop — the Pi extension shows the dialog and acts only on approval (D2).
//
// Pure and dependency-free on purpose: no fs, no network, no require. The inputs the side effects live
// on (UI availability, seat models, the credit block) are passed in by the caller, so every gate below
// is fixture-testable without a TUI, a lineup file or a TypeSafe key. The deterministic bypasses run
// BEFORE Jev is asked (bypassReason()), so an ineligible prompt costs zero LLM tokens.
//
// Fail-open is the default everywhere: low confidence, a missing Jev answer, no UI, an explicit model
// or loop instruction, a slash command, a short follow-up, a harness seat, a missing seat model or a
// credit-blocked provider all end at `{ route: 'chat' }` — the current chat and model, unchanged.
//
// CLI (the fixture runner validate.js wires in):
//   node mission-router.js decide < scripts/fixtures/mission/decisions.json
//   stdin: [{ name, input, expect }…]; expect is a subset of the normalized decision. Exit 1 on any
//   mismatch. Launcher flags in a task are a bypass, never reinterpreted as flags (PRD-005 §8).

'use strict';

const MIN_PROMPT_CHARS = 12;
const MIN_CONFIDENCE = 0.5;

// The mission question rides the SAME Jev request as skill and tier — there is no second classifier
// call (D1). Labels double as the decision's `mission` field.
const MISSION_QUESTION = 'Which mission shape does this prompt start?';
const MISSIONS = {
  chat: 'ordinary conversation: opinions, small talk, a follow-up on work already in flight',
  question: 'a question or explanation: where is X, why was this decided, how does this work',
  design: 'design or UI work: screens, layouts, styling, visual polish, copy for an interface',
  bounded: 'bounded development: one feature, one bug, a scoped code change with clear acceptance',
  complex: 'complex development: multi-ticket work, a PRD or ticket folder, several workstreams',
};

// The one-shots (D4): a route that changes this run's model only, restored at agent_end.
const MODEL_ROUTES = { question: 'explainer', design: 'creativo', complex: 'architect' };

// A prompt that already names a loop, a launcher flag or a model is an operator instruction, not a
// recommendation request. "con kimi-k3.1-pro" / "con mimo-v2.6-pro" (PRD-005 §5.4) match the model
// vocabulary; a launcher flag anywhere bypasses auto-dispatch so task text is never re-parsed as flags.
const LOOP_MENTION = /(?:^|[\s"'`(/])\/?(?:develop-phase|develop-spec|review-loop|orchestrate|skill-loop)\b/;
const LAUNCHER_FLAGS = /(?:^|\s)--(?:tickets|confirmed|max-parallel|prd|worktree-setup|integrate|max-iter|preflight|no-preparer|no-commit|no-jev|allow-skipped|cwd)\b/;
const EXPLICIT_MODEL = /\b(?:con|usa|usar|use|with)\s+(?:[\w-]+\/)?(?:claude|kimi|mimo|glm|grok|qwen|deepseek|gpt|gemini|nemotron|opus|sonnet|haiku|fable)[\w./-]*/i;
const SHORT_FOLLOW_UP = /^(?:ok|okay|vale|sí|si|ya|bueno|continúa|continua|sigue|go on|continue|again|retry|more|y|n|yes|no)[.!?…]*$/i;

// `docs/tickets/<folder>` (or `tickets/<folder>`) in the prompt is the develop-spec entry ticket. The
// captured path is deliberately [\w.-] only: it is interpolated into a dispatched command line, and a
// folder name with a space or a flag in it must never reach a launcher.
const TICKET_FOLDER = /(?:[\w.-]+\/)?tickets\/([\w.-]+)/;

const isSlash = (prompt) => /^\s*\//.test(prompt);
const isShortFollowUp = (prompt) => {
  const t = String(prompt || '').trim();
  return t.length < MIN_PROMPT_CHARS || SHORT_FOLLOW_UP.test(t);
};
const hasExplicitRoute = (prompt) => LOOP_MENTION.test(prompt) || LAUNCHER_FLAGS.test(prompt) || EXPLICIT_MODEL.test(prompt);
const findTicketFolder = (prompt) => (TICKET_FOLDER.exec(String(prompt || '')) || [])[1] || null;

// The dispatch text, built here so the extension and the fixtures agree on what "the same command with
// --confirmed" means (D3). The plan never carries --confirmed; execution always does.
const specCommand = (folder, confirmed) => `/develop-spec --tickets ${folder}${confirmed ? ' --confirmed' : ''}`;

// Every deterministic gate, before any Jev spend. Returns the fail-open reason or null (eligible).
function bypassReason({ prompt, hasUI = true, isSeat = false, sessionDisabled = false } = {}) {
  const p = String(prompt || '');
  if (sessionDisabled) return 'mission routing is off for this session (/mission on to re-enable)';
  if (isSeat) return 'a harness seat or subagent is not a human prompt';
  if (!hasUI) return 'no UI: there is nobody to confirm a switch, so nothing is proposed';
  if (isSlash(p)) return 'a slash command: the operator already chose the route';
  if (hasExplicitRoute(p)) return 'the prompt names a model, a loop or a launcher flag itself';
  if (isShortFollowUp(p)) return 'a short follow-up, not a new mission';
  return null;
}

// The decision. `seats` is the saved line-up's seat map ({ role: { provider, model } }); the daily
// advisor never reaches here (D6). `blockedProviders` carries the sticky credit block (PRD-005 §2):
// a candidate that runs on a blocked provider is not proposed until the operator resets it.
function decideMission({
  prompt = '', mission = null, p = null, hasUI = true, isSeat = false, sessionDisabled = false,
  seats = {}, blockedProviders = [],
} = {}) {
  const chat = (reason, extra) => ({
    route: 'chat', mission: mission || null, action: 'none', role: null, model: null,
    loop: null, restore: false, consumesPrompt: false, reason, ...extra,
  });

  const bypass = bypassReason({ prompt, hasUI, isSeat, sessionDisabled });
  if (bypass) return chat(bypass);
  if (mission == null) return chat('no classification: Jev is off, failed or timed out');
  if (!Object.prototype.hasOwnProperty.call(MISSIONS, mission)) return chat(`Jev answered no known mission (${mission})`);
  if (!(p >= MIN_CONFIDENCE)) return chat(`low confidence (p=${p == null ? 'none' : p} < ${MIN_CONFIDENCE})`);
  if (mission === 'chat') return chat('ordinary chat: stay in the current chat and model');

  const blocked = (provider) => provider && blockedProviders.includes(provider);

  if (mission === 'complex' && findTicketFolder(prompt)) {
    // Complex with a ticket folder: /develop-spec PLAN first (D3). --confirmed is a second, separate
    // confirmation after the plan — never part of this dispatch (acceptance §6).
    const folder = findTicketFolder(prompt);
    const impl = seats.implementer;
    if (blocked(impl && impl.provider)) return chat(`the loop's implementer runs on credit-blocked ${impl.provider}`);
    return {
      route: 'loop', mission, action: 'confirm-loop', role: null, model: null,
      loop: {
        command: '/develop-spec',
        dispatch: specCommand(folder, false),
        confirmedDispatch: specCommand(folder, true),
        phase: 'plan',
      },
      restore: false,
      consumesPrompt: true,
      reason: `complex development with ticket folder ${folder}: propose the /develop-spec plan, confirm again before execution`,
    };
  }

  if (mission === 'bounded') {
    const impl = seats.implementer;
    if (blocked(impl && impl.provider)) return chat(`the loop's implementer runs on credit-blocked ${impl.provider}`);
    return {
      route: 'loop', mission, action: 'confirm-loop', role: null, model: null,
      loop: {
        command: '/develop-phase',
        // The task is the prompt itself. bypassReason() already refused any launcher flag, so nothing
        // in this text can be re-read as a flag by the launcher (PRD-005 §8).
        dispatch: `/develop-phase ${String(prompt).trim()}`,
        confirmedDispatch: null,
        phase: null,
      },
      restore: false,
      consumesPrompt: true,
      reason: 'bounded development: propose the existing /develop-phase loop, consumed so the main chat does not run it twice',
    };
  }

  // One-shot model routes (D4): question → explainer, design → creativo, complex without tickets →
  // architect for PRD/ticket preparation. Restored at agent_end; never a loop launch.
  const role = MODEL_ROUTES[mission];
  const model = seats[role];
  if (!model || !model.model) return chat(`no saved ${role} seat in the line-up — nothing to propose`);
  if (blocked(model.provider)) return chat(`${role} seat runs on credit-blocked ${model.provider}`);
  return {
    route: 'model', mission, action: 'confirm-model', role,
    model: { provider: model.provider || null, model: model.model },
    loop: null,
    restore: true,
    consumesPrompt: false,
    reason: mission === 'complex'
      ? 'complex development without a ticket folder: propose the architect seat to prepare the PRD/tickets in chat — no loop is launched'
      : `${mission}: propose the ${role} seat for this run, restored at the end`,
  };
}

module.exports = {
  MISSIONS, MISSION_QUESTION, MODEL_ROUTES, MIN_CONFIDENCE, MIN_PROMPT_CHARS, TICKET_FOLDER,
  isSlash, isShortFollowUp, hasExplicitRoute, findTicketFolder, specCommand,
  bypassReason, decideMission,
};

// Fixture runner: [{ name, input, expect }] on stdin, one verdict per line, exit 1 on any mismatch.
// `expect` is compared as a subset of the normalized decision so a fixture pins what it is about and
// does not churn on wording.
if (require.main === module && process.argv[2] === 'decide') {
  let raw = '';
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    let cases;
    try { cases = JSON.parse(raw); } catch (e) {
      process.stderr.write(`mission-router: stdin is not JSON — ${e.message}\n`);
      process.exit(1);
    }
    let failed = 0;
    for (const c of cases) {
      const d = decideMission(c.input || {});
      const got = {
        route: d.route, action: d.action, mission: d.mission, role: d.role,
        model: d.model ? (d.model.provider ? `${d.model.provider}/${d.model.model}` : d.model.model) : null,
        dispatch: d.loop ? d.loop.dispatch : null,
        confirmedDispatch: d.loop ? d.loop.confirmedDispatch : null,
        restore: d.restore, consumesPrompt: d.consumesPrompt,
      };
      const wrong = Object.entries(c.expect || {})
        .filter(([k, v]) => JSON.stringify(got[k]) !== JSON.stringify(v))
        .map(([k, v]) => `${k}: got ${JSON.stringify(got[k])}, want ${JSON.stringify(v)}`);
      if (wrong.length) { failed += 1; process.stdout.write(`FALLA ${c.name} — ${wrong.join('; ')}\n`); }
      else process.stdout.write(`ok    ${c.name}\n`);
    }
    process.stdout.write(`${cases.length - failed}/${cases.length} mission-router cases passed\n`);
    process.exit(failed ? 1 : 0);
  });
} else if (require.main === module) {
  process.stderr.write('usage: node mission-router.js decide < cases.json\n');
  process.exit(1);
}
