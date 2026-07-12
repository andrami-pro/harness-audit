# harness-audit

A Claude Code **plugin** (and portable **Agent Skill**) that audits a project's agent harness against four pillars — harness-in-code, multi-agent role separation, automatic verification, and loop design — and produces an **executable rubric** (`harness-rubric.md`) plus a stack-tailored remediation plan with stop conditions. The audit is not a static report a human reads and executes; it is a convergence target an autonomous implement-and-verify loop runs against. Its core principle: *the model is the horse, the harness is the saddle* — models change every few months, the harness stays.

Installed as a plugin, it also **protects** your sessions with three write-time security guards (see below).

## Install

### Option 1 — Claude Code plugin (recommended: audit + protection)

```
/plugin marketplace add andrami-pro/harness-audit
/plugin install harness-audit@harness-audit
```

This loads the skill **and** three security hooks that run on every session:

| Hook | What it blocks |
|---|---|
| `destructive-guard` | `rm -rf` against root/home, `git checkout --force`, `git clean -fdx`, `git reset --hard origin/*`, writes to block devices |
| `secret-scan` | Writing files that contain credential patterns (`sk-…`, `ghp_…`, `AKIA…`, PEM private keys, Slack tokens) |
| `block-no-verify` | `git commit/push --no-verify` — the pre-commit gate cannot be silently bypassed |

The guards are deliberately conservative (short, high-precision pattern lists — when in doubt they allow). To disable them, uninstall the plugin and use the skill-only install below.

### Option 2 — skill only (Claude Code, no hooks)

```bash
git clone https://github.com/andrami-pro/harness-audit.git /tmp/harness-audit
cp -R /tmp/harness-audit/skills/harness-audit ~/.claude/skills/harness-audit   # global
# or: cp -R /tmp/harness-audit/skills/harness-audit .claude/skills/harness-audit  # per project
```

### Option 3 — other coding agents (Cursor, Kilo Code, Antigravity, …)

The skill follows the open [Agent Skills](https://agentskills.io) standard. From the cloned repo:

```bash
./install.sh --target cursor        # .cursor/skills/  (project)
./install.sh --target kilo         # ~/.kilo/skills/  (user)
./install.sh --target antigravity  # .agents/skills/  (project)
```

The methodology is fully portable; the security hooks are Claude Code plugin-specific.

## Usage

Just ask in natural language. The skill triggers on phrases such as:

- "audit my harness" · "audita el harness"
- "AGENTS.md" · "preflight" · "reviewer subagent"
- "harness engineering" · "self-improving loop" · "loop design"
- "rubric" · "independent verifier" · "loop-readiness"
- "make this repo portable across Claude Code / Codex / Cursor"

It detects the stack automatically, audits the four pillars, grades loop-readiness (L0–L3) and memory maturity (M1–M5), writes an executable rubric, emits a role-differentiated develop-phase workflow (Implementer → adversarial Reviewer → Preflight, each on the model tier that fits the job), and runs an adversarial fresh-context verification of its own findings before delivering.

## The four pillars

1. **Harness in code** — `AGENTS.md` (≤ 200 lines) as the portable entry point, a single preflight gate, a memory convention, all versioned in the repo rather than in IDE config.
2. **Multi-agent role separation** — orchestrator / implementer / reviewer, where the reviewer receives only artifacts (diff + rubric), never the implementer's reasoning — and runs on a *different model family* than the implementer, on purpose. Independence is what lifts review accuracy (an independent verifier beats self-critique; the often-cited ~62%→~89% figures are directional targets, pending an in-house benchmark — see WHITEPAPER §8.1).
3. **Automatic verification** — lint, typecheck, tests with real assertions, a non-zero-on-failure preflight gate, pre-commit hooks, CI — and write-time security gates (secret scan, destructive-command guard, no-verify block). Verification a loop can read.
4. **Loop design** — an executable rubric every criterion of which is checkable by command, explicit stop conditions, and a memory that matures Fail → Investigate → Verify → Distill → Consult.

A minimal harness beats an inflated one: trimming tooling tends to make agents faster, not weaker.

## The five loops — which one do you need?

| Your situation | Loop | Command | Cost | Stops when |
|---|---|---|---|---|
| "Every commit verified, no babysitting" | 1 · Stateless | smoke tests + `wip-green` (pattern, no command) | free | tests green |
| "My skills should improve weekly, with proof" | 2 · Learning | `/skill-loop <skill>` | med-high | A/B gain ≤ +1 for 2 rounds (max 4) |
| "Four specialist reviewers on this draft/PR" | 3 · Multi-agent review | `/orchestrate <paths>` | medium | no new blocker/major (max 3) |
| "Deep audit of the whole app — rare, token-hungry" | 4 · Verification | `/review-loop [max-iter]` · plus the `develop-phase` workflow the audit generates per repo | high | score ≥ 90 ∧ 0 blockers (max 5) |
| "Improve the *process* that builds the product" | 5 · Workflow improvement | `/iterate <task>` | high | score ≥ 90 ∧ optimizer out of proposals (max 5) |

**Honesty rule for this table:** a loop only gets a row once it has at least one real, recorded run — a findings
JSON (or, for the process loop, a settled prediction) in the operating repo's `docs/harness-dev/loop-runs/`.
Loops that are specified but never run do not appear here. Each subsection below names the run that backs it.

### Prerequisites

Loops 2–5 run their critics, scorers, and optimizers through **[Graphify](https://github.com/Graphify-Labs/graphify)**
instead of grepping the repo cold — a scoped subgraph of what-calls-what is cheaper and more accurate
than raw-text search, and it's the difference between a critic that reasons about structure and one that
burns its context window re-deriving it from grep. Install it once per machine:

```bash
uv tool install graphifyy          # preferred — package is `graphifyy` (double y), CLI is `graphify`
# fallback if uv is unavailable:
pipx install graphifyy             # or: pip install graphifyy
```

Then bootstrap the graph in any repo you're about to audit or run a loop against:

```bash
graphify extract . --code-only     # local AST parse, no API key, no network
```

`install.sh` offers to do both automatically. `--skip-graphify` continues in a degraded mode where the
audit marks the Graphify criterion FAIL but does not abort the install.

### Loop 1 · Stateless — the hard verifier

A gate, not a conversation: a small set of end-to-end smoke tests plus a `wip-green` checkpoint commit the
agent can roll back to. It **writes** nothing but a green/red exit code and the checkpoint commit; there is
no journal and no memory — that is what "stateless" means. Stops the moment the tests pass.
*Recorded:* it is the gate every other recorded run had to clear (`preflightPassed: true` in the
verification runs), and it is the one gate that was verified by mutation — break the component under test,
the suite must exit non-zero.

### Loop 2 · Learning — `/skill-loop <skill>`

Runs the same eval task through two arms — with the skill and without it — has a **blind** judge score both
on a fixed rubric, and lets a `skill-improver` agent edit the skill using the gap. It **writes** a
`LEARNINGS.md` inside the skill's own folder (one entry per round: what changed, why, how to apply) and a
findings JSON for the run. Stops when the with-skill gain over the without-skill arm is ≤ +1 for two
consecutive rounds, or at 4 rounds.
*Recorded:* one real run on a content skill — 4 rounds (the gap trend kept moving, so it ran to the round
ceiling rather than the ≤ +1 stop condition), blind A/B, judge on a different model family than the arms.

### Loop 3 · Multi-agent review — `/orchestrate <paths>`

Four orthogonal critics — correctness (checks every figure and claim against sources), domain (your project's
contract), safety (secrets, risky claims), style (tone, no AI-speak) — run in parallel on the artifacts each
round; any `blocker` triggers a fix round by the implementer. It **writes** a findings JSON per run
(`id`, `critic`, `severity`, `file`, `line`, `summary`, `fix`). Stops when a round produces no new
blocker/major, or at 3 rounds.
*Recorded:* one real run against a seeded fixture, which caught the planted blockers in round 1 — including
a fabricated regulatory figure.

### Loop 4 · Verification — `/review-loop [max-iter]`

The deep pass: the same four critics plus a `scorer` that grades the artifacts against an executable rubric
and returns a score out of 100 with a blocker count. Token-hungry by construction. It **writes** a findings
JSON with the score and blocker trend per iteration. Stops at score ≥ 90 **and** zero blockers, or at 5
iterations. Per-feature, the audit also generates a `develop-phase` workflow (Implementer → adversarial
Reviewer → Scorer → Preflight) that gates a single change on the same arithmetic — a fraction of the cost.
*Recorded:* two real `develop-phase` runs (one passing gate, one round-ceiling reject) with a score per
iteration, plus one real `/review-loop` run — a `MAX_ITERATIONS=1` deep pass over `scripts/loop-stats.js`
itself: score 86/100, 10 findings, stopped at the round ceiling (`RECHAZADO`). One of those findings —
this dashboard had zero mentions in any `.md` of the plugin — is what the section you're reading now
exists to fix.

### Loop 5 · Workflow improvement — `/iterate <task>`

The meta-loop. Each round: the implementer builds the next requirement, the scorer grades the app, and a
`process-optimizer` reads the run's own telemetry — never the diff — and makes **one** bounded change to the
spec of the process that built it, with a falsifiable prediction. It **writes** the process spec (versioned,
`docs/process.md` by default) and a `process-log.md` of predictions, each settled by the *next* run, not this
one. Stops only when both subjects are still: score ≥ 90, zero blockers, and the optimizer proposing nothing
— or at 5 rounds.
*Recorded:* one settled entry in `process-log.md` — the optimizer's first bounded change to a real process
spec, its prediction graded ✅ verified by the following phase.

### When NOT to use each one

Loops are not free, and the wrong one is worse than none.

| Loop | Cost class | Do not run it for |
|---|---|---|
| `/orchestrate` (4 critics × ≤ 3 rounds) | medium | typos, or code-only changes — that is what the develop-phase gate is for |
| `/skill-loop` (2 arms × 2 runs × ≤ 4 rounds + judge) | med-high | a skill you use less than once a week |
| `/review-loop` (critic fan-out × ≤ 5) | high · token-hungry | every commit. Only a large app or corpus, and rarely |
| `/iterate` (builder + scorer + optimizer × ≤ 5) | high | bug fixes, one-file changes — a feature that converges in round 1 teaches the process nothing |
| `loop-stats.js` | free (local script, zero tokens) | — run it as often as you like |

### How loops activate

Three levels, and the difference between them is who is allowed to spend your budget.

1. **Deterministic — no judgment, no tokens.** Preflight and smoke tests on a `pre-push` hook, the
   `wip-green` checkpoint. They run themselves, every time. Nothing decides whether they apply.
2. **Model-dispatched — auto, but announced.** `/orchestrate` and the per-feature `develop-phase` workflow
   carry a rich `description` with their triggers, and the dispatch criteria live in `AGENTS.md` ("which
   change goes through the gate, which is a normal session"). The agent may launch them on its own — and
   when it does it **must announce it in one line**: `→ /orchestrate: the diff touches both locales`.
   Live visibility at dispatch; `loop-stats` gives it in retrospect.
3. **Scheduled — optional.** `/skill-loop` on a weekly schedule, once a skill earns it.

The two expensive loops are **manual-only**: `/review-loop` and `/iterate` ship with
`disable-model-invocation: true`. A model may notice that a task is the right shape for one and say so in a
line; it may never fire one. An auto-dispatched deep review burns a real budget without consent, and the
guardrail is cheaper than the apology.

### Watch them run

`scripts/loop-stats.js` is the dashboard for everything above — tokens per agent, activations,
durations, learnings, and the workflow/loop-run history — read straight out of the local Claude Code
transcripts and `docs/harness-dev/loop-runs/`. It is an observer, not a loop: it iterates on nothing,
costs zero tokens, and never leaves your machine.

```bash
node scripts/loop-stats.js                       # this project, all history, ANSI report to stdout
node scripts/loop-stats.js --project <slug>       # a different project's telemetry (default: cwd)
node scripts/loop-stats.js --root <dir>           # telemetry root (default: ~/.claude/projects)
node scripts/loop-stats.js --repo <path>          # read loop-runs/ + LEARNINGS.md from another repo
node scripts/loop-stats.js --since 7d             # window the report to the last N days
node scripts/loop-stats.js --html out.html        # retro-terminal (CRT) report you can share
node scripts/loop-stats.js --json                 # the same aggregate, machine-readable
```

**Reading the `est.$` column (D17):** it is list price × **measured** tokens for that run — never a
multiplier, never a heuristic. A model absent from the price table renders `n/a` instead of a guess —
an invented price is worse than none in a dashboard whose whole claim is that it doesn't invent numbers.
Claude Sonnet 5 carries a dated introductory rate; a run priced during that window is footnoted
`priced at introductory rate` rather than silently re-priced at today's rate.

### Anatomy of a loop

Every loop above is the same four-part shape, just applied to a different subject (a skill, a diff, an
app, the process itself):

**goal** — the one thing this round is trying to move (a skill's eval score, a draft's blocker count, an
app's rubric score, the process's own waste) → **rubric** — a fixed, checkable target the round is graded
against, never redefined mid-run → **verifier** — an agent that did not write the artifact grades it
(a blind judge, an independent critic panel, a scorer with no edit tools) → **memory** — what survives the
round in a file, not a chat turn (`LEARNINGS.md`, a findings JSON, `process.md` + `process-log.md`).

Full rationale for why the verifier has to be independent and why memory has to mature past raw notes:
[WHITEPAPER.md — Pillar 4, Loop Design](WHITEPAPER.md#pillar-4--loop-design-rubrics--continuous-memory).

## Repo layout

```
.claude-plugin/     plugin + marketplace manifests
skills/harness-audit/   SKILL.md + rubric-template.md + verifier-protocol.md (the portable part)
hooks/ + scripts/hooks/ security guards (plugin install only)
scripts/validate.js     this package's own preflight gate — run `node scripts/validate.js` before releasing
install.sh              multi-IDE skill installer
WHITEPAPER.md           full rationale, benchmarks provenance, and theory
```

## Learn more

Background article explaining the methodology:

- ES — https://andrami.pro/blog/auditoria-de-arnes-ia
- FR — https://andrami.pro/fr/blog/audit-harnais-ia

## Contributing

Issues and PRs welcome — new stack recipes, sharper rubric checks, additional anti-patterns, and (especially) an independent reproduction of the 62%→89% verifier benchmark.

## Attribution

By **Andrés Ramírez · andrami** — https://andrami.pro

Released under the [MIT License](LICENSE).
