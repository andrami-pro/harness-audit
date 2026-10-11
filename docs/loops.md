# The loops, in detail

What each loop does, what it writes, when it stops, and the run that backs it. The short version is in
[plugins/harness-loops/README.md](../plugins/harness-loops/README.md). Paths like `scripts/…` are
relative to the plugin that ships the file.

## The six loops — which one do you need?

| Your situation | Loop | Command | Cost | Stops when |
|---|---|---|---|---|
| "Every commit verified, no babysitting" | 1 · Stateless | smoke tests + `wip-green` (pattern, no command) | free | tests green |
| "My skills should improve weekly, with proof" | 2 · Learning | `/skill-loop <skill>` | med-high | A/B gain ≤ +1 for 2 rounds (max 4) |
| "Four specialist reviewers on this draft/PR" | 3 · Multi-agent review | `/orchestrate <paths>` | medium | no new blocker/major (max 3) |
| "Deep audit of the whole app — rare, token-hungry" | 4 · Verification | `/review-loop [max-iter]` · plus the `develop-phase` workflow the audit generates per repo | high | score ≥ 90 ∧ 0 blockers (max 5) |
| "Improve the *process* that builds the product" | 5 · Workflow improvement | `/iterate <task>` | high | score ≥ 90 ∧ optimizer out of proposals (max 5) |
| "Improve how *I* drive the agent — fully local" | 6 · Operator | `/session-review [--since 30d]` | med-low | single pass; re-run weekly |

Plus one thing that is not a loop: **`/dashboard-harness`**, the free observer the six are watched through.
It reads your local transcripts and reports how the driving went. See
[Watch them run](../plugins/harness-guards/README.md#watch-them-run--dashboard-harness).

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
— or at 5 rounds. Each round is gated by `loop-gate.js` like Loops 3–4, and the builder's end-of-round
handoff (`complete | continue | blocked`, with evidence) is shape-checked by `check-handoff` — and reported
as the builder's claim, never as a certificate.
*Recorded:* one settled entry in `process-log.md` — the optimizer's first bounded change to a real process
spec, its prediction graded ✅ verified by the following phase.

### Loop 6 · Operator — `/session-review [--since 30d] [--top 20]`

Loops 1–5 improve the work. This one improves the person driving it — the loop the other five leave open.
It reads the transcripts Claude Code already writes on your disk, counts what recurs (free — a script, not
a context window), then spends **one** agent pass on the sampled top-N to say what the recurrence *means*.
It returns **growth-edge cards**: the prompt you keep retyping (→ a skill), the correction you keep issuing
(→ an `AGENTS.md` rule), the dispatch you keep doing by hand (→ a dispatch criterion). Its outputs are the
other loops' inputs. It **proposes and never applies** — you promote, same contract the reviewer has with
your `AGENTS.md`. Single pass; re-run it weekly.

**Nothing leaves your machine.** No upload, no account, no proxy — the analysis runs where the transcripts
already are. Your prompts are the rawest artifact you own; a dashboard is not worth trading them for.

*Recorded:* a real 30-day run over 27 sessions / 165 human prompts — 5 cards, each with a verbatim quote
and an event-deduplicated count. Two findings from that run are now rules of the command itself: prompts a
loop writes to its own subagents are **byte-identical** to human keystrokes in the transcript (filter them
by shape, or your top card is the harness admiring its reflection), and counts are **event** counts, not
record counts (the same message sent twice in eight seconds is one correction).

### When NOT to use each one

Loops are not free, and the wrong one is worse than none.

| Loop | Cost class | Do not run it for |
|---|---|---|
| `/orchestrate` (4 critics × ≤ 3 rounds) | medium | typos, or code-only changes — that is what the develop-phase gate is for |
| `/skill-loop` (2 arms × 2 runs × ≤ 4 rounds + judge) | med-high | a skill you use less than once a week |
| `/review-loop` (critic fan-out × ≤ 5) | high · token-hungry | every commit. Only a large app or corpus, and rarely |
| `/iterate` (builder + scorer + optimizer × ≤ 5) | high | bug fixes, one-file changes — a feature that converges in round 1 teaches the process nothing |
| `/session-review` (free stats + 1 pass over top-N) | med-low | daily runs — a growth edge needs enough sessions to be an edge and not a bad afternoon |
| `/dashboard-harness` · `bin/loop-stats` | free (local script, zero tokens) | — run it as often as you like |

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

Three loops are **manual-only**, shipping with `disable-model-invocation: true`. A model may notice that a
task is the right shape for one and say so in a line; it may never fire one.

- `/review-loop` and `/iterate`, because of **cost**. An auto-dispatched deep review burns a real budget
  without consent, and the guardrail is cheaper than the apology.
- `/session-review`, because of **consent**. It is cheap; that is not the point. Its subject is the human,
  and an agent that decides on its own to analyze how you work has not saved you a step — it has reviewed
  you without asking.

**`disable-model-invocation` itself is Claude Code's field.** OpenCode and Kilo Code have no equivalent,
so a ported copy of these three loses the veto and becomes auto-dispatchable. Pi has no equivalent
field either, but keeps the veto anyway — invocation there is always a typed `/name`, never a tool call
the model can make on its own. See [Compatibility across harnesses](compatibility.md).

### Anatomy of a loop

Every loop above is the same four-part shape, just applied to a different subject (a skill, a diff, an
app, the process itself):

**goal** — the one thing this round is trying to move (a skill's eval score, a draft's blocker count, an
app's rubric score, the process's own waste) → **rubric** — a fixed, checkable target the round is graded
against, never redefined mid-run → **verifier** — an agent that did not write the artifact grades it
(a blind judge, an independent critic panel, a scorer with no edit tools) → **memory** — what survives the
round in a file, not a chat turn (`LEARNINGS.md`, a findings JSON, `process.md` + `process-log.md`).

Full rationale for why the verifier has to be independent and why memory has to mature past raw notes:
[WHITEPAPER.md — Pillar 4, Loop Design](../WHITEPAPER.md#pillar-4--loop-design-rubrics--continuous-memory).

### The one step in a loop no agent wrote — `scripts/loop-gate.js`

Every loop above has the same costume seam: a seat emits JSON, and a chair — a model — reads it,
trusts it, and aggregates it. Nothing between the two can say no. A finding that anchors at a file
which is not in the repo, or at line 900 of a 40-line file, is indistinguishable from a real one once
it is inside the findings JSON, and it will be reported to a human as evidence. That is what a
fabricated finding looks like from the inside, and it is invisible to a chair reading JSON as prose.

`/orchestrate`, `/review-loop` and `/iterate` call the gate every round. It costs zero tokens.

```bash
node scripts/loop-gate.js check-findings <seat.json> --root . --seat correctness
node scripts/loop-gate.js check-handoff <builder.json> --seat builder
node scripts/loop-gate.js resume docs/harness-dev/loop-runs/<run-slug>/
```

**`check-findings`** refuses the defect classes the seats' own agent files already forbid but nothing
measured: an anchor at a file that does not exist or a line past the end of a real one, a severity
outside the fixed ladder, a key the contract does not have, a seat that assigned its own `id`/`critic`,
and — on the scorer's scorecard — a criterion parked at `applies: false` with no justification, or a
failed criterion with no finding behind it. Exit `2` means repair and retry: the errors are numbered
and written to be acted on by the seat itself, so the chair re-dispatches with the list appended
verbatim instead of paraphrasing what it thinks went wrong.

On a scorecard the same call also prints `SCORE: <n>/100 · BLOCKERS: <m>`, computed from the criteria
table with the weights the scorer's own file states. **Arithmetic is the one part of a gate that never
needed judgment**, and until now it was being done by whichever model happened to be holding the chair.
The gate still decides nothing — `score ≥ 90 ∧ blockers = 0` remains the chair's call, on two numbers
it no longer produces itself.

**`resume`** makes a run's rounds files instead of conversation. Each round writes
`docs/harness-dev/loop-runs/<run-slug>/round-<n>.json` as it closes, so a chair that dies in round 2 of
a five-seat deep read does not re-pay for round 1. It answers `NO_RUN`, `RESUME_FROM: <n>`, or
`RUN_COMPLETE` — and when the state is not one of those three (a gap in the sequence, an unreadable
round file), it answers **`AMBIGUOUS_RUN_STATE`, lists the files, and exits 2**. It never reconciles.
A loop that repairs its own half-written state resumes into a round nobody chose and reports the
result as though someone had.

**`check-handoff`** gates the one seat output that is about the seat's own work: the builder's
end-of-round `{ status, summary, evidence, blocker? }`. It refuses a status outside
`complete | continue | blocked`, empty evidence, a `blocked` with no blocker named and a blocker on a
status that is not blocked — the shapes that let a claim hide. It certifies nothing: a handoff that
clears it is what the builder reported, and `/iterate` says so wherever it quotes one. The independent
read is the scorer's scorecard, not the handoff.

From round 2 on, the same script decides which of a round's findings **restate** the previous
round's — the call the stop rule of `/orchestrate` hangs on, and until now the one call left to the
chair, the party holding every fix it applied:

```bash
node scripts/loop-gate.js dedupe round-<n-1>.json raw/<n>-aggregate.json --out dedupe-<n>.json
```

Same critic, same file, normalized summary identical → restated, no model involved. The pairs that
survive that go to Jev (below) as one request, one yes-probability per pair, thresholded in code:
0.85, and **0.95 for a blocker** — deduping away a real new blocker opens a gate on a defect nobody
fixed, so the bar is higher on the side where the mistake costs more. The output is three lines the
chair reads and a JSON it never has to: `DEDUPE:` (`jev` or `exact-only`), `NEW: blocker n major m
minor k` — the stop arithmetic — and `CARRIED:` with every carried blocker and major printed by id.
Nothing is deduped silently. Without a key, or when the API fails, the first line says `exact-only`,
`UNJUDGED:` counts the pairs left, and the chair compares those by meaning and reports the round as
ungated — announced, never hidden.

The gate is Claude Code-only; every other target degrades it to a hand-check the chair performs on
itself. See [Compatibility across harnesses](compatibility.md).


## develop-phase: scout, analyst, and a reviewer from another vendor

One global script, `plugins/harness-loops/workflows/develop-phase.js`, called from a config-only wrapper the audit
writes into each project (`.claude/workflows/develop-phase.js`). It has two seats before the implementer, and a reviewer
that need not be an Anthropic model:

- **Scout** (cheap tier, read-only) reads the repo, code graph first when one exists, and returns a ≤ 400-word brief.
- **Analyst** (workhorse tier) checks the brief and returns a ≤ 300-word plan. A first line `BLOCKER: …` stops the run
  before the implementer spends a token. Scout and analyst run once, outside the loop; if either dies the run goes on
  without it. Pass `preparer: false` for a trivial task: on a one-file task they cost more than the implementation.
- **Reviewer** is a native alias by default. Pass `reviewerModel: "openrouter/<vendor>/<model>"` (any id `pi --list-models`
  shows) and the audit's Step 4c copies `skills/harness-audit/external-review.sh` into the repo as
  `scripts/external-review.sh`: `pi` runs the review with read-only tools and the workflow decides from the last line.
  It needs `pi` on PATH and the provider key in the auth `pi` uses. The reviewer/implementer family rule (D25a) is also
  enforced at run time: the same family returns a `blocked` handoff before any seat runs.
- **Route** (opt-in, `routeByJev: true`, off by default). Before any other seat, a Haiku seat runs
  `node ~/.claude/harness/jev.js route --configured <implementer>` (sync-workflows keeps that copy current; `jevScript`
  points elsewhere) with the task on stdin. `jev.js decideTier()` decides: Jev's tier at or above
  `ROUTE_TIER_THRESHOLD` (0.80), a downgrade one tier at most and never below sonnet — routing down costs quality,
  routing up only money. The loop re-checks what the seat relays and refuses a tier in the reviewer's family (D25a);
  anything else — no key, a dead seat, a low confidence — keeps the line-up. The run returns `routing: { suggested, p,
  threshold, decision, implementer, configured, reason }` and logs one line. Measured by `benchmarks/jev_router_eval.js`
  (two passes, 64 prompts): tier right 91.0% at p ≥ 0.80 on 52% of the prompts; capped downgrades from opus right
  95.3%. The one real run (2026-10-11) predates the threshold and routed nothing. Numbers and files:
  [docs/harness-dev/loop-runs/2026-10-11-jev-router.md](harness-dev/loop-runs/2026-10-11-jev-router.md).

**On Pi** the same loop is `scripts/develop-phase-pi.js` (Pi has no Workflow runtime). The loop is code, not a prompt:
each seat is one `pi -p --mode json --no-session` call with its own tool allowlist, every model comes from the `pi`
column of the line-up at run time (the analyst sits in `architect`, the new `scout` role feeds the brief), D25a is
re-checked before any seat, preflight is the project's own gate run through the shell (a `SKIP` line is not a pass),
and the commit message is the only thing a model writes in the commit step. With a TypeSafe key, Jev sizes the task
first: `trivial` skips scout and analyst, `bounded` gives the analyst the implementer's model. From a Pi session, a
small extension can expose it as `/develop-phase <task>`; from a shell: `node scripts/develop-phase-pi.js --task "…"
[--no-preparer] [--no-commit] [--max-iter N] [--preflight "<cmd>"] [--no-jev] [--run-dir <path>] [--no-tmux]`.

<a id="tmux"></a>
**Live view (tmux).** `--mode json` is what lets each seat's actions show up as they happen instead of only at the
end: `scripts/develop-phase-pi.js` translates the event stream into `<runDir>/<seat>.live.log` (tool calls, brief
thinking, the final answer) and writes the hand-offs between seats — brief → plan → diff → verdict → preflight →
commit — to `<runDir>/bus.log`, the one file that reads like the loop's own "conversation" with itself. Unless
`--no-tmux`, the run also opens a detached tmux session via `scripts/dp-tmux.sh`: `bus.log` on top, the currently
active seat's log on the bottom (`scripts/dp-tail.sh` switches panes the moment a new seat starts). It prints the
attach command once, at start (`tmux attach -t dp-…`), and **never touches an existing tmux session, window or
pane** — including the one running `pi` itself — so it is safe to fire from inside a `pi` session that is itself
inside tmux. Missing tmux, or anything going wrong while starting it, is silent and never fails the run; without it
the two log files are still there, readable with a plain `tail -f`.

Where the saving comes from: the reviewer seat first, then an implementer that no longer reads the repo. Where it does not:
a trivial task, and any plan whose limit counts tokens without weighting them by model, because the scout reads a lot on a
cheap tier.
