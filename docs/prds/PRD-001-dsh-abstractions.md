---
id: PRD-001
title: Four abstractions from deepseek-harness
status: done
created: 2026-08-25
updated: 2026-08-25
---

# PRD-001 — Four abstractions from deepseek-harness

## 1. Executive summary

`deepseek-ai/deepseek-harness` (dsh) is an agent runtime, not an audit methodology — a plugin tree over
Cordis with its own loop, tools, sandbox and UI. It is not a competitor to this plugin; it is a candidate
install target. What is worth taking is how that repository is developed: memory with a shape on disk and
a gate over it, a guard against tool-call loops, a taxonomy of prose that leaks the authoring session,
and a worker handoff that is labelled as a report rather than a certificate. This PRD brings four of those
into harness-audit 2.6.0, additively. Every requirement is stated as the `scripts/validate.js` check that
proves it, because that script is this repository's only gate.

## 2. Problem

The audit describes four things it cannot verify.

- **Memory has a scale but no shape.** Pillar 4 grades memory M1–M5 by reading two or three notes and
  classifying them. Nothing in the rubric points at a directory, so two auditors can grade the same repo
  M2 and M4 and both be defensible.
- **Loops have a gate but no hygiene.** The plugin refuses a malformed finding and a half-written run; it
  says nothing when a model re-runs the same grep eight times. That failure is cheap to detect and costs
  real budget every time it is not.
- **The style critic measures comment density and eyeballs everything else.** "Sounds AI-generated" is
  explicitly not a finding, but prose written from the authoring session's vantage — `(decision 7)`,
  "rejected in review", "probably fine for now" — has no name and no battery, so it ships.
- **A worker's "done" reads as a verdict.** `develop-phase` returns `approved: true` computed from the
  reviewer's own text, and `/iterate` recomputes the score by hand and never gates the builder's report.
  A status nobody shape-checks is taken on trust by the chair that is also driving the seat.

## 3. Source

Read on 2026-08-24 from the `master` branch of `github.com/deepseek-ai/deepseek-harness` (last commit
2026-08-21). Taken: the Agent Note lifecycle and its mandatory *Alternatives considered* section
(`.agents/notes/README.md`); the postmortem contract (`docs/postmortem/README.md`); doc word budgets
(`scripts/verify-doc-budgets.ts`, the doc-tiers note); the repeat-tool-guard plugin and its
advisory-only rule (`packages/guard/repeat-tool-reminder`); the chain-of-thought leakage taxonomy and
recall batteries (`.agents/skills/dsh-trim-cot-leakage`); the `continue | complete | blocked` report and
the "a worker reported the outcome, not independent certification" label (`packages/workflow/tool-ralph`).

Not taken, on purpose: Cordis and everything-is-a-plugin (a runtime concern); per-file 100% coverage
(dsh's own notes record it produces assertion-free tests); bilingual docs with a pairing gate; the
`archived/` lifecycle; the ~740-note volume — the format and the gate transfer, the scale does not.

The structured handoff (R4) copies no dsh artifact. It takes the report statuses and the label from
`tool-ralph`; the schema, the gate subcommand and the `develop-phase` wiring are this repository's own.

## 4. Solution

**F1 — Four Pillar-4 criteria** in `rubric-template.md` and the SKILL.md audit table: a decision
lifecycle (`proposed/ implemented/ rejected/`, `## Alternatives considered` in every implemented note), a
postmortem contract (a "why the safety nets missed it" section), doc word budgets (a manifest and
`scripts/check-doc-budgets.js`), and a gate proven by mutation in a versioned script. The first two are
flagged ⚠ aspirational where the directory is absent; the audit never fabricates decisions or incidents.

**F2 — `scripts/hooks/repeat-tool-guard.js`**, a PreToolUse hook on every tool. It counts consecutive
identical calls per session — same tool, same canonical arguments — and injects an escalating reminder
as `additionalContext` at 3, 5 and 8. It never denies; a different call or a human prompt resets it.

**F3 — A chain-of-thought-leakage lens in `agents/style-critic.md`**: eight classes, a keep-list of what
is not leakage, a grep recall battery the critic must run before filing, and a severity mapping. Output
contract unchanged.

**F4 — A structured handoff**: `{ status: complete|continue|blocked, summary, evidence[], blocker? }`,
validated by a new `loop-gate.js check-handoff` subcommand; `/iterate` gates the builder's handoff and
its scorecard every round like Loops 3–4 already do; `develop-phase` returns the same object with a
label that says it was reported by the seats, not certified.

## 5. Requirements and acceptance criteria

Each criterion is a named check in `node scripts/validate.js`; the requirement is met when the check
shows ✓ and its recorded negative controls fail it when applied.

### R1 — Memory with a shape on disk

- R1-AC1 ✓ `rubric-template and SKILL.md both carry the four Pillar-4 criteria, and the ADR/postmortem
  rows are flagged aspirational`.
- R1-AC2 ✓ `check-doc-budgets exits 1 over budget, 0 within, 2 with no manifest`.
- R1-AC3 The SKILL.md memory scale names the decision note and the postmortem section as M2/M4
  evidence; WHITEPAPER §2.2 carries the same paragraph.

### R2 — Loop-hygiene guard

- R2-AC1 ✓ `repeat-tool-guard emits additionalContext at run 3 and 5, not at 2 or 4, and never a
  permissionDecision`.
- R2-AC2 ✓ `README discloses every PreToolUse guard hooks.json installs`.
- R2-AC3 `additionalContext` is a documented PreToolUse field (Claude Code hooks reference, read
  2026-08-25: `permissionDecision`, `permissionDecisionReason`, `updatedInput`, `additionalContext`), and
  subagent calls carry `agent_id`, which the guard folds into its state-file name. First live run
  (`claude --plugin-dir`, 2026-08-25): the hook loaded and wrote its state file, but three identical
  `grep` commands drew no reminder — the model had written a fresh Bash `description` each time and the
  chain never formed. The guard now drops the top-level `description` before hashing; a fixture pins
  it. Second live run (`claude -p --plugin-dir`, same day): the third identical `grep` returned the
  reminder to the model verbatim — `PreToolUse:Bash hook additional context: harness-audit
  repeat-tool-guard: 3 consecutive identical \`Bash\` calls…` — and the state file read `count: 3`.
  Verified.

### R3 — Chain-of-thought leakage lens

- R3-AC1 `agents/style-critic.md` carries the eight classes, the keep-list, the battery and the severity
  mapping; the output contract (findings JSON + `VERDICT`) is byte-identical to before.
- R3-AC2 ✓ every existing frontmatter check (strict YAML, description present) still passes.
- R3-AC3 Run `/orchestrate` on a fixture seeded with `(decision 3)` and "rejected in review: …": the
  style seat files both as `minor` with the class named.

### R4 — Structured handoff, honest label

- R4-AC1 ✓ `loop-gate check-handoff refuses a malformed handoff and accepts a complete one`.
- R4-AC2 ✓ `the panel and build loops actually run their seats through loop-gate` — now over
  `orchestrate`, `review-loop` and `iterate`, with the `check-handoff` producer required of `iterate`.
- R4-AC3 ✓ `port-loops.js transforms every real command/agent into valid target frontmatter` — the new
  `check-handoff` block in `iterate.md` is rewritten to a hand-check on Pi.
- R4-AC4 The `develop-phase` template in SKILL.md returns `handoff` and a `nextStep` prefixed
  "Reported by the implementer/reviewer seats — not independently certified".

### Cross-cutting

- ✓ `no private contract leaks in commands/, agents/, benchmarks/, scripts/, docs/, skills/` — the leak
  gate now walks `docs/` and `scripts/`, so this PRD and the new scripts are inside it.
- `.claude-plugin/plugin.json` reads `2.6.0`; every check in `scripts/validate.js` passes.

## 6. Out of scope

- **dsh as an install target.** It runs Claude Code `hooks.json` natively and reads `.agents/skills/`,
  which makes it a fifth target on paper. Nothing ships until it is verified against a running dsh —
  the Pi port passed its own tests while Pi discarded three of five templates. Spike → PRD-002.
- Dogfooding `docs/doc-budgets.json` on this repository's own README and SKILL.md.
- A versioned mutation test for `validate.js` itself. This repository fails its own R<N+3> row: its
  negative controls are recorded as comments, not as a script. Follow-up: `scripts/validate-mutation.sh`.
- `loop-stats.js` rendering the `handoff` field.
- Escalating the repeat guard to a deny at a high threshold; fuzzy (near-identical) repeat detection.
- The `archived/` lifecycle for decision notes.

## 7. Risks

| Risk | Mitigation |
|---|---|
| Merge conflict with `fix/pi-provider-ids` (validate.js tail, README §line-up, plugin.json) | New checks inserted mid-file; merge that branch to `main` first; re-resolve the version line |
| A new `${CLAUDE_PLUGIN_ROOT}` block in `iterate.md` fails the Pi-port checks | Blocks byte-identical to the substitution table's `from` strings; one new pair for `check-handoff` |
| The reminder reaches the transcript but not the model's attention | Thresholds escalate (3, 5, 8) and the detailed form quotes the arguments; a `deny` escalation is out of scope until there is evidence |
| A subprocess per tool call (`matcher: ".*"`) | One small file read and write, no parsing beyond stdin; pruning bounded to 200 entries |
| A payload without `agent_id` shares the session's chain | A missed nudge, never a block; subagent payloads carry `agent_id` and get their own chain |
| The plugin fails its own mutation-proof row | Stated in §6; not flagged aspirational because it is a real gap |
| `style-critic.md` matches its own battery | The file excludes itself from the sweep, and says so |

## 8. Verification

1. `node scripts/validate.js` → every check ✓ (⊘ only when `private-terms.json` is absent).
2. Live: a Claude Code session with this plugin; the same `Grep` three times → reminder on the third,
   detailed on the fifth; a different call resets.
3. `node scripts/loop-gate.js check-handoff scripts/fixtures/findings/invalid-handoff.json` → exit 2,
   four numbered errors; `valid-handoff.json` → `HANDOFF OK`.
4. `node scripts/check-doc-budgets.js --root scripts/fixtures/doc-budgets --manifest over.json` → exit 1.
5. `./install.sh --target pi` in a scratch directory → `.pi/prompts/iterate.md` carries three hand-check
   blocks and no `${CLAUDE_PLUGIN_ROOT}`; `node scripts/port-loops.js --capabilities pi` names `/iterate`.
6. `/orchestrate` over the new prose (R3-AC3), and a read of the diff against the critic's own §5.

## 9. Open questions

- None open. The one this PRD started with — whether PreToolUse hooks may return `additionalContext` —
  is settled by the hooks reference (R2-AC3); the live observation of the reminder is the remaining
  verification step, not a design question.
