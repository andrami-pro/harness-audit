---
description: Loop 4 — deep verification. The four critics AND the scorer read the whole app or the whole corpus, round after round, until the score clears 90 with zero blockers or the iteration ceiling stops it. This is the thermonuclear read. It is TOKEN-HUNGRY by construction and it is meant to be run rarely — on a codebase or a body of content that has already grown, never on a commit. For one feature, you want develop-phase, not this. You may suggest this command; you may never launch it yourself.
argument-hint: "[max-iterations, default 5]"
allowed-tools: Task, Read, Write, Edit, Grep, Glob, Bash(graphify:*), Bash(git diff:*), Bash(git status:*), Bash(git ls-files:*), Bash(mkdir:*), Bash(date:*), Bash(node:*)
disable-model-invocation: true
---

# /review-loop — deep verification (Loop 4)

```
╔═══════════════════════════════════════════════════════════════════════════╗
║  ⚠  TOKEN-HUNGRY.  COST CLASS: HIGH.                                      ║
║                                                                           ║
║  Five agents per round, reading the whole surface, up to five rounds —    ║
║  plus a fix pass each time findings land. Twenty-five-plus agent runs     ║
║  over an entire codebase is the shape of this loop, and that is the       ║
║  shape it is supposed to have.                                            ║
║                                                                           ║
║  Run it on an app or a corpus that has ALREADY GROWN, and rarely:         ║
║  before a release, before a public launch, when you inherit a codebase.   ║
║                                                                           ║
║  NEVER on a commit. NEVER on one feature. NEVER on a typo.                ║
║  For those, develop-phase gates a single change for a fraction of this.   ║
╚═══════════════════════════════════════════════════════════════════════════╝
```

`MAX_ITERATIONS = $1` — **default 5** when `$1` is blank.

This command is **manual-only** (`disable-model-invocation: true`). A model may notice the codebase
needs it and say so in one line. A model may not spend this much of someone's budget on its own
judgment. Only the human fires it.

Once fired it is **autonomous**: it runs to its stop condition without asking for confirmation between
rounds. The human hears from you at the end, or when you hit the ceiling.

## 0. Announce — one line, before anything else

```
→ /review-loop: <what surface, why it needs the deep read, max <MAX_ITERATIONS> rounds>
```

## 1. Resolve the surface

`$ARGUMENTS` may carry a path or a scope after the iteration count. With none, the surface is the
**whole app**: the tracked source and content of this repo (`git ls-files`), minus vendored and
generated trees.

Read the graph before you read the files: `graphify query "<the app's main flows>"` returns a scoped
subgraph and costs a fraction of a grep sweep. No `graphify-out/graph.json` in the project? Skip it.

Then resolve the **rubric** — the scorer needs one and does not invent it. `harness-rubric.md` at the
repo root by default; whatever path the human named otherwise. If there is no rubric anywhere, stop:
this loop cannot open a gate it has no standard for, and the four critics on their own are
`/orchestrate`, which is cheaper and already exists.

Name the run — `<YYYY-MM-DD>-review-loop-<slug>` — and use that one slug for the run directory, the
round files and the findings JSON.

**Then check whether that run is already in progress.** Rounds are files, not conversation: a chair
that dies in round 2 of a panel has already paid for round 1, and the only way to keep it is to have
written it down. On this loop that is not a convenience — a lost round of a five-seat deep read is the
single most expensive thing this package can waste.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/loop-gate.js" resume docs/harness-dev/loop-runs/<run-slug>/
```

**If that command is not available**, list the run directory yourself and read the `round-<n>.json`
files it holds. The rule that matters survives the missing script: unless what you find is plainly the
contiguous sequence `1..n`, stop and hand it to the human rather than reconciling it.

`NO_RUN` → start at round 1. `RESUME_FROM: <n>` → round `n` is the next one: read the round files
already on disk for what is open, and never re-dispatch a round that is recorded. `RUN_COMPLETE` →
that slug has published a verdict; pick another slug or stop. **`AMBIGUOUS_RUN_STATE` (exit 2) → stop
and hand the human the files it listed.** Do not reconcile it yourself — a loop that repairs its own
half-written state resumes into a round nobody chose, and it reports the result as if someone had.

## 2. The round — five seats, in parallel (up to MAX_ITERATIONS)

Launch all five in **one message, five Task calls**. They run in parallel and they must not see each
other's work. Dispatching them in sequence is a bug: it turns five independent reads into a chain in
which the last one inherits everybody else's blind spots.

| subagent_type | seat |
|---|---|
| `correctness-critic` | every verifiable figure, claim, citation, named source |
| `domain-critic` | the domain/locale contract — parity, market fit, slugs, audience |
| `safety-critic` | secrets, credentials, risky legal claims |
| `style-critic` | tone, AI-speak, copy, comment discipline and density |
| `scorer` | the rubric, plus the structural spine — returns the scorecard |

The same four critics as `/orchestrate`. This loop adds the fifth seat and the ceiling; it does not
fork the panel.

Prompt each critic with **artifacts only** — the file list, the round number, nothing else:

```
Round <n>. Review these artifacts: <resolved file list>.
Query graphify first if the project has a graph; grep only after it orients you.
Return your findings in the JSON contract from your agent definition. Artifacts only:
no author reasoning, no conversation history, no other critic's findings.
```

Prompt the scorer with the artifacts **and its three parameters**:

```
Round <n>. Score these artifacts: <resolved file list>.
rubric: <path>          — score against this, run its Check column
scope: <what this surface is supposed to be>
Return the scorecard in the JSON contract from your agent definition.
```

Never hand any seat: the previous round's findings, the fixes you applied, your own read of the
artifacts, or another seat's output. Independence is the whole point — the moment they share context,
five seats collapse into one.

**Re-anchor before every round after the first: re-read the prompt templates above in this file and
send them unchanged.** The seats are fresh each round and cannot drift; you are not. By round 4 of a
deep read you are holding every finding, every score and every fix, and the natural thing to do with
all that context is to be helpful with it — a clause about what the last round found, a hint about
which file to start with. Each of those is the independence leak, arriving as a courtesy rather than
as a decision. The round number and the file list are the only two things that change between rounds.

## 3. Aggregate — gate every seat, and let the gate do the arithmetic

Write each seat's raw reply to `docs/harness-dev/loop-runs/<run-slug>/raw/<round>-<seat>.json`, then
run the gate over it before a single finding enters the aggregate:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/loop-gate.js" check-findings <file> --root . --seat <seat>
```

**If that command is not available** — the install has these commands but not the plugin's `scripts/`,
which is what a copied-commands install looks like — say so once, in one line, and check each seat's
JSON yourself against the contract in its agent file: the fixed severity ladder, a `file` that exists
in the repo, a `line` inside that file, a non-empty summary and fix, and no `id`/`critic` the seat
assigned itself. Then **say in the report that the run was ungated.** A missing gate is not a passing
gate, and a crash from a missing script is not a verdict.

Exit 0 → aggregate it. **Exit 2 → do not aggregate it, and do not repair it yourself.** Re-dispatch
that one seat with the gate's error list appended verbatim to its prompt: the errors are written to be
acted on without help, and a chair paraphrasing them is a chair guessing what the seat meant. A seat
that fails the gate twice is a finding about the panel — record it, and carry on with the others.

The gate is deterministic and costs no tokens. It refuses a finding anchored at a file that is not in
the repo or at a line past the end of a real one, a severity outside the fixed ladder, and a seat that
assigned its own `id` or `critic`. None of those are visible to a chair reading JSON as prose, and the
first two are exactly what a fabricated finding looks like from the inside.

Give every gated finding an `id` of `R<round>-F<k>` (k restarts each round) and its `critic` field
(`correctness` | `domain` | `safety` | `style` | `scorer`) — the seats do not set these, and the gate
rejects them if they try.

**The score comes from the gate, not from you and not from the scorer's headline.** Run over the
scorecard, `check-findings` prints the two numbers this loop gates on:

```
SCORE: 86/100 · BLOCKERS: 1
```

It computes them from the `criteria` table with the same weights the scorer's own file states —
`blocker` 3, `quality` 1, over every criterion with `applies: true` — and it is the only party in the
round that is neither writing the artifacts nor grading them. Take those two numbers. If they
disagree with the scorer's own headline, **the gate wins**, and say so in the report: a scorer whose
table does not support its number is a finding of its own, and one the human should hear about.

Arithmetic is the one part of a gate that never needed judgment, and until now it was being done by
whichever model was holding the chair.

`blockers` counts failed blocker-class **criteria**. A `blocker`-severity finding from one of the four
critics is a defect in the artifacts, not a failed rubric criterion — it goes in the fix round, and it
gates through the rubric row it violates. If it violates none, the rubric has a hole: say so.

## 4. Fix round

If the round produced **any new blocker or major**, or the gate did not open → apply fixes.

Delegate to the project's `implementer` subagent if it defines one (`.claude/agents/implementer.md`);
otherwise apply them yourself. Either way, apply **all** of the round's findings — blocker, major and
minor together. Then go to round n+1.

The fixer gets the findings. The seats never do.

**Close the round on disk before you open the next one.** Write
`docs/harness-dev/loop-runs/<run-slug>/round-<n>.json` — the round object exactly as §6 specifies it,
one round per file. That file is what `resume` counts, and it is the only thing that survives a chair
that dies mid-run. Write it after the fix round, so a resumed run never re-applies fixes that already
landed. Numbering is contiguous from 1: `resume` refuses a gap rather than guessing which round is
missing.

## 5. Stop

| Condition | Action |
|---|---|
| `score ≥ 90` **and** `blockers = 0` | STOP · `stoppedBy: "gate-passed"` |
| MAX_ITERATIONS rounds done and the gate has not opened | STOP · `stoppedBy: "round-ceiling"` |

The gate is a **conjunction, and it is not negotiable.** A single failed blocker-class criterion holds
the gate shut at any score — because on a rubric of any size, missing one blocker still leaves you a
score in the nineties, and a gate that a high score can talk its way through is not a gate. Quality
passes buy points. They do not buy a blocker.

At the ceiling: report the open blockers and the standing score to the human, and stop. A surface that
cannot clear its own rubric in five rounds has a problem this loop is not equipped to fix, and a sixth
round burns tokens to hide that.

`verdict` is `APROBADO` when the gate opened, `RECHAZADO` otherwise.

## 6. Write the findings JSON

Create `docs/harness-dev/loop-runs/` if it does not exist. Write
`docs/harness-dev/loop-runs/<YYYY-MM-DD>-review-loop-<slug>.json` — `<slug>` names the surface.

This is the aggregate, written once at the end: every `round-<n>.json` from §4, in order, under
`rounds`. Writing it is what turns the run directory from in-progress into `RUN_COMPLETE`, so write it
only when the loop has actually stopped.

```json
{
  "run": "2026-07-15-review-loop-app",
  "loop": "review-loop",
  "rubric": "harness-rubric.md",
  "rounds": [
    { "n": 1, "score": 84, "blockers": 2,
      "startedAt": "2026-07-15T09:02:11Z",
      "endedAt": "2026-07-15T09:48:55Z",
      "tokens": { "in": 210000, "out": 24000 },
      "findings": [
        { "id": "R1-F1", "critic": "scorer", "severity": "blocker",
          "file": "src/lib/router.ts", "line": 0,
          "summary": "the diff pushes this file from 940 to 1180 lines", "fix": "extract the matcher" }
      ] }
  ],
  "verdict": "APROBADO",
  "stoppedBy": "gate-passed"
}
```

`severity`: `blocker` (a contract break — a failed blocker-class criterion, a false factual claim, a
leaked secret, a broken build) · `major` (quality a client would notice) · `minor` (style).
`critic`: `correctness | domain | safety | style | scorer`.

`startedAt`, `endedAt` and `tokens` are the round's wall clock and what it cost, as the harness reported
it when each Task returned. This loop is the expensive one, so the cost of a round is part of its result.
Omit any field the harness did not surface — the dashboard reads an absent field as unmeasured and says
so, and it has no way to tell a filled-in guess from a fact.

Record **every** round, including the one that stopped the loop, and every finding of every round —
not only the ones still open. The JSON is the run's evidence. A round with an empty `findings` array
is a result, not an omission, and the `score` of each round is the trend line this loop exists to
produce.

## 7. Report

Short. The score per round (the trend is the headline), rounds run, findings by severity, what was
fixed, what is open, the JSON path.

If the verdict is `RECHAZADO`, lead with the open blockers and the score — that is the only thing the
human needs from you.

## What this is not

`develop-phase` is the same loop at feature scale: implement → review → score → gate, on one change,
on every change. It is the instance you run all day.

This is the instance you run four times a year, on everything at once. They share the gate
(`score ≥ 90 ∧ 0 blockers`) and they share the scorer. They do not share a cost class, and using this
one where the other belongs is how a loop budget disappears in an afternoon.
