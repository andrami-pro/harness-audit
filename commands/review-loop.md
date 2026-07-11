---
description: Loop 4 — deep verification. The four critics AND the scorer read the whole app or the whole corpus, round after round, until the score clears 90 with zero blockers or the iteration ceiling stops it. This is the thermonuclear read. It is TOKEN-HUNGRY by construction and it is meant to be run rarely — on a codebase or a body of content that has already grown, never on a commit. For one feature, you want develop-phase, not this. You may suggest this command; you may never launch it yourself.
argument-hint: "[max-iterations, default 5]"
allowed-tools: Task, Read, Write, Edit, Grep, Glob, Bash(graphify:*), Bash(git diff:*), Bash(git status:*), Bash(git ls-files:*), Bash(mkdir:*), Bash(date:*)
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

## 3. Aggregate — and do the arithmetic yourself

Collect the four finding arrays and the one scorecard.

Give every finding an `id` of `R<round>-F<k>` (k restarts each round) and its `critic` field
(`correctness` | `domain` | `safety` | `style` | `scorer`) — the seats do not set these.

Then **recompute the score from the scorer's `criteria` table.** Do not take its headline on trust:

```
weight(blocker) = 3        weight(quality) = 1

score    = round( 100 × Σ(weight × pass) / Σ(weight) )    over every criterion with applies: true
blockers = how many blocker-class criteria came back pass: false
```

The formula is deterministic and it is short. An agent that does its own arithmetic is an agent whose
arithmetic nobody checked, and this number is a gate. If your recount disagrees with the scorer's
headline, **your recount wins** — and say so in the report, because a scorer that cannot add up is a
finding of its own.

`blockers` counts failed blocker-class **criteria**. A `blocker`-severity finding from one of the four
critics is a defect in the artifacts, not a failed rubric criterion — it goes in the fix round, and it
gates through the rubric row it violates. If it violates none, the rubric has a hole: say so.

## 4. Fix round

If the round produced **any new blocker or major**, or the gate did not open → apply fixes.

Delegate to the project's `implementer` subagent if it defines one (`.claude/agents/implementer.md`);
otherwise apply them yourself. Either way, apply **all** of the round's findings — blocker, major and
minor together. Then go to round n+1.

The fixer gets the findings. The seats never do.

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

```json
{
  "run": "2026-07-15-review-loop-app",
  "loop": "review-loop",
  "rubric": "harness-rubric.md",
  "rounds": [
    { "n": 1, "score": 84, "blockers": 2,
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
