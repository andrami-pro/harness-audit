---
id: PRD-005
title: Confirmed mission routing and a daily design line-up
status: in-progress
created: 2026-10-27
updated: 2026-10-27
---

# PRD-005 — Confirmed mission routing and a daily design line-up

## 1. Executive summary

Pi already has the pieces for mission routing, but the operator still has to assemble them by hand:
Jev suggests a skill and a tier, `/develop-phase` and `/develop-spec` are typed commands, the line-up
assigns models to seats, and the model advisor refreshes rankings without applying them. This PRD joins
those pieces into one **confirmed** mission router. A new prompt can be answered in the current chat,
run through develop-phase, planned and run through develop-spec, or handled with the design seat. The
router proposes; the operator always sees the route and model and approves it before any switch or
loop starts. A daily, deterministic advisor refresh keeps the design candidate current without spending
an LLM request on rankings.

## 2. Problem and evidence

The operator launches three recurring mission shapes:

- a question or explanation;
- bounded development, today requiring a manual model choice and `/develop-phase`;
- complex development, today requiring PRD/tickets and a manual `/develop-spec`;
- design work, where the best available OpenCode Go model changes faster than the hand-edited line-up.

The current Pi extension `~/.pi/agent/extensions/jev-router.ts` is advisory only. `develop-spec.ts` is
manual and also has a mandatory plan/confirmation boundary; it does not activate itself. The existing
`lineup-advise.js` already joins live Pi catalog entries, rankings, prices and data-policy rules. Its
systemd timer is weekly, its service points at a non-existent repository-level `bin/lineup-advise`, and
there is no design role in the advisor even though `harness.pi.creativo` already exists in the operator's
line-up.

A second incident on 2026-10-27 established the non-negotiable constraint: a silent writer-route model
switch consumed the wrong provider. Automatic routing must never mean unconfirmed routing.

## 3. Decisions

- **D1 — Extend Jev; do not add a general-purpose router LLM.** The existing Jev request gains one
  `mission` question alongside `skill` and `tier`. Classification still reads at most 1500 prompt chars,
  has one 1.5 s budget, and fails open to the current chat/model. There is no second classifier call.
- **D2 — Every consequential route is confirmed.** The dialog names the mission, recommended model or
  loop, current model, and alternatives. Escape/decline keeps the current chat and model. No TUI, low
  confidence, Jev failure, explicit model/route instructions, slash commands, short follow-ups and
  harness seats bypass automatic routing.
- **D3 — Reuse the loops; do not reimplement them.** Bounded development dispatches the existing
  `/develop-phase` command. Complex development uses the existing `/develop-spec` planning command when
  a ticket folder is present, and requires the existing `--confirmed` checkpoint before execution. With
  no ticket folder, complex work stays in chat with the `architect` seat to produce the PRD/tickets; it
  does not invent a waves run.
- **D4 — One-shot chat routes restore the prior model.** `question` uses `explainer`, `design` uses
  `creativo`, and complex planning uses `architect`. Restoration happens at `agent_end` unless the
  operator changed the model manually during the run. A develop-phase/spec run owns its own seat models.
- **D5 — The daily model refresh is deterministic.** `lineup-advise.js` already computes rankings in
  code. Add the `creativo` role, driven primarily by LMArena WebDev plus intelligence/coding evidence,
  price, catalog constraints and data policy. Refresh once daily with `--no-probe`. Do not use Jev or a
  cheap LLM to summarize rankings, and do not probe every model in the background.
- **D6 — Advice never mutates the line-up.** New rankings are consumed by `/line-up advise`, where the
  operator applies a role explicitly. Mission routing reads the saved line-up, not an unreviewed daily
  suggestion.
- **D7 — Keep the implementation testable and canonical.** Pure routing decisions live in
  `plugins/harness-loops/scripts/mission-router.js`. The thin Pi extension is canonical at
  `plugins/harness-loops/pi/jev-router.ts` and is copied to `~/.pi/agent/extensions/jev-router.ts` on this
  machine. Shared line-up resolver copies remain byte-identical across the three plugins.
- **D8 — This task's explicit model allocation is not a new default.** PRD/design work uses
  `opencode-go/kimi-k3.1-pro`; implementation uses `opencode-go/mimo-v2.6-pro`. Neither edits the saved
  line-up to make those choices permanent.

## 4. User flows

### Question

Jev returns `question` with sufficient confidence. Pi offers the explainer model, the current model,
and available seat alternatives. On approval it changes only this run, then restores the prior model.

### Bounded development

Jev returns `develop-phase`. Pi shows the task, the loop, and its configured implementer/reviewer. On
approval it dispatches `/develop-phase <task>` and consumes the original chat submission, so the task is
not paid for twice. Declining leaves an ordinary chat run.

### Complex development

With a ticket folder in the prompt, Pi offers `/develop-spec --tickets <folder>` (plan only). After the
plan, a short confirmation can dispatch the same command with `--confirmed`, with one final dialog.
Without a ticket folder, Pi offers the architect seat for PRD/ticket preparation and does not launch a
loop.

### Design

Jev returns `design`. Pi offers the saved `creativo` seat. The daily advisor can recommend a replacement,
but only `/line-up advise` applies it.

## 5. Requirements and acceptance criteria

### Router

1. One eligible prompt costs at most one Jev request and 1.5 s of routing budget.
2. A rejected or unavailable route never changes model and never starts a loop.
3. There is no silent provider/model switch. Every switch has a visible confirmation and a visible
   restore/no-restore outcome.
4. Explicit operator choices such as `con kimi-k3.1-pro`, `con mimo-v2.6-pro`, or an explicit loop bypass
   the recommender.
5. A confirmed develop-phase dispatch starts one loop and does not also run the task in the main chat.
6. develop-spec never skips its plan/confirmation boundary.
7. Missing Jev, timeout, missing role, blocked provider, unavailable model and non-interactive mode all
   preserve the current behavior.
8. `/mission` reports status and allows the operator to disable/re-enable routing for the session; `/jev`
   remains the classifier status command.

### Daily design line-up

9. `creativo` appears in the shared role resolver, the Pi line-up UI, advisor JSON and advisor Markdown.
10. Its ranking uses WebDev evidence when available and still enforces privacy and provider/quota rules.
11. The daily timer uses the real plugin script path, `Persistent=true`, and `--no-probe`.
12. A refresh writes cache/report files only; it does not edit `model-lineup.json`, switch the session
    model, or call every candidate model.

## 6. Success metrics

- **Consent:** 0 silent model changes or loop launches in tests and live use.
- **Cost:** 0 LLM tokens for daily ranking; at most one existing Jev classification request per eligible
  prompt; no background model probes.
- **Manual work:** 0 typed `/develop-phase` commands for accepted bounded missions; 0 typed initial
  `/develop-spec` commands for accepted complex missions with tickets.
- **Freshness:** advisor report is at most 24 h old after a successful scheduled refresh.
- **Safety:** all existing preflight checks pass, including shared-file drift and advisor fixtures.

## 7. Out of scope

- Automatic application of daily model suggestions.
- A second LLM that debates or summarizes model rankings.
- Changing the saved implementer, reviewer, architect or creative defaults as part of this task.
- Auto-deploys, production migrations, unattended client-workspace writes, or bypassing develop-spec
  confirmation.
- A new generic mission/workflow engine.

## 8. Dependencies and risks

- **Jev mission labels are new and not yet calibrated like tier labels.** Mitigation: confidence gate,
  explicit confirmation, deterministic bypasses, fixture tests, and advisory-only fallback.
- **Command dispatch must not duplicate the original prompt.** The Pi `input` handler returns `handled`
  only after the extension command has been dispatched with `expandPromptTemplates: true`.
- **Quoted tasks and launcher flags.** A prompt containing launcher flags bypasses auto-dispatch rather
  than being reinterpreted as flags.
- **A global extension can drift from its canonical copy.** The repository holds the canonical source;
  this rollout copies it and records the sync in the run notes. A later installer can own general rollout.
- **The host may not expose `systemctl` inside the execution environment.** Timer files can still be
  corrected; if the daemon cannot be reloaded here, the handoff must name that remaining operator step
  instead of claiming the schedule is active.

## 9. Validation and rollout

1. Unit fixtures cover every route, decline, low confidence, explicit bypass, blocked provider, restore,
   and duplicate-dispatch prevention.
2. The advisor fixture proves `creativo` is ranked and WebDev evidence participates.
3. Run `node scripts/validate.js` from the repository root; no failure is reported as done.
4. Copy the canonical Pi extension and update the live line-up UI/timer files.
5. Smoke-test in a fresh Pi session: question, bounded development declined then accepted, complex
   planning, design declined, and explicit model bypass. No Anthropic model is used for these checks.
6. Record the live smoke results under `docs/harness-dev/loop-runs/` and leave the PRD in progress until
   the real dispatch paths are observed.
