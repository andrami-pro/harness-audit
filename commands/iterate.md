---
description: Loop 5 — the meta-loop. Round after round it builds a multi-requirement feature, scores the app against the rubric, and then a process-optimizer reads the run's own telemetry and makes ONE bounded change — with a falsifiable prediction — to the spec of the process that built it. Two subjects converge: the feature against the rubric, the process against its own waste. The lasting product is not the feature; it is a process that builds the next feature in fewer rounds. Cost: HIGH — builder, scorer and optimizer every round, up to five rounds. Multi-requirement features only: never a bug fix, never a typo, never a one-file change. You may suggest this command; you may never launch it yourself.
argument-hint: <the feature to build> [--spec <process spec path, default docs/process.md>]
allowed-tools: Task, Read, Write, Edit, Grep, Glob, Bash(graphify:*), Bash(git diff:*), Bash(git status:*), Bash(git log:*), Bash(git ls-files:*), Bash(mkdir:*), Bash(date:*)
disable-model-invocation: true
---

# /iterate — the meta-loop (Loop 5)

```
╔═══════════════════════════════════════════════════════════════════════════╗
║  ⚠  COST CLASS: HIGH.                                                     ║
║                                                                           ║
║  Three seats a round, up to five rounds — and the builder is the          ║
║  expensive one. You are paying for a second product on top of the         ║
║  feature: the retro that makes the next feature cheaper.                  ║
║                                                                           ║
║  Run it on a MULTI-REQUIREMENT feature: enough surface that a round can   ║
║  go wrong in an interesting way, enough rounds that a process change has  ║
║  something to bite on.                                                    ║
║                                                                           ║
║  NEVER on a bug fix. NEVER on a typo. NEVER on a one-file change.         ║
║  A feature that converges in one round teaches the process nothing — and  ║
║  you will have paid an optimizer to tell you so. For those, develop-phase ║
║  gates the change for a fraction of this.                                 ║
╚═══════════════════════════════════════════════════════════════════════════╝
```

Feature under construction: **$ARGUMENTS**

This command is **manual-only** (`disable-model-invocation: true`). A model may notice a feature is the
right shape for this loop and say so in one line. A model may not spend this much of someone's budget
on its own judgment. Only the human fires it.

Once fired it is **autonomous**: it runs to its stop condition without asking for confirmation between
rounds. Whatever you need from the human, you get in setup, before round 1.

## 0. Announce — one line, before anything else

```
→ /iterate: <the feature, and what about the process needs the retro>
```

## 1. Setup — resolve, and settle the last run's predictions

**The task** is `$ARGUMENTS` minus the flags. If it resolves to nothing, stop. A loop that picks its own
scope builds what nobody asked for, and every seat downstream approves it — because none of them has a
scope to enforce either.

**The rubric** the scorer needs: `harness-rubric.md` at the repo root by default. No rubric anywhere →
stop. There is no gate without a standard, and a build loop with no gate is just a build.

**The spec** is `--spec`, default `docs/process.md`. If it does not exist, draft **v1** now, before
round 1, from what the repo *already does* — its contract files, its rubric, its gate commands, its
workflow scripts, its recent history. Not from what it ought to do: this document is a readout, and an
aspirational v1 means every prediction stacked on top of it measures a process nobody runs. Say in your
report that you drafted it, and name the files you drafted it from, so the human can check that their
process is the one you have been optimising.

**Then settle the open predictions.** Read `process-log.md`. Every entry with `Outcome: ⏳ pending`
whose settling artifact now exists gets graded — verified or falsified — and written back. Do this
**first**, before you spend a token on the feature. A prediction nobody grades is the same thing as no
prediction, and an optimizer that never learns it was wrong will cheerfully be wrong the same way
forever.

Read the graph before you read the files: `graphify query "<what the feature touches>"` returns a
scoped subgraph for a fraction of a grep sweep. No `graphify-out/graph.json`? Skip it.

## 2. The round — three seats, in sequence (max 5)

| # | seat | `subagent_type` | what it does |
|---|---|---|---|
| 1 | builder | the project's own **`implementer`** | builds the next open requirement, following the spec |
| 2 | scorer | `scorer` | scores the app against the rubric → scorecard |
| 3 | optimizer | `process-optimizer` | reads the telemetry and the score → ONE bounded change to the spec |

**There is no `builder` agent, and you will not create one.** The project already has an implementer: it
takes a plan and returns a diff, which is the whole job. A second agent under a second name is two files
to keep in sync, and within a month one of them is wrong. If the project defines no
`.claude/agents/implementer.md`, build the round yourself and say so.

These three run **in sequence** — the scorer scores what the builder built, the optimizer reads what
both of them did. The independence that matters in this loop is *directional*, and it is enforced by
what you put in each prompt:

| Seat | Gets | Never gets |
|---|---|---|
| builder | the feature, the requirements still open, the round number, **the current spec** (it is the process it is meant to follow), and from round 2 the previous round's failed criteria | the optimizer's reasoning |
| scorer | the artifacts, the rubric path, the scope | the spec, the builder's reasoning, the optimizer's output — a scorer that knows the process is on trial starts grading the process |
| optimizer | the spec path, the telemetry (`journal.jsonl`, the run's findings JSON so far), and the score | **the app's diff** — its subject is the process, and an optimizer holding the diff writes about the app |

That last row is the one that quietly breaks. Hand the optimizer the diff and you get a very good code
review from a seat that was supposed to be looking somewhere else entirely, and the process goes another
run unexamined.

## 3. Recompute the score yourself

The scorer returns a `criteria` table. Do the arithmetic from the table — do not take its headline on
trust:

```
weight(blocker) = 3        weight(quality) = 1

score    = round( 100 × Σ(weight × pass) / Σ(weight) )   over every criterion with applies: true
blockers = how many blocker-class criteria came back pass: false
```

If your recount disagrees with the scorer's headline, **your recount wins**, and say so in the report:
a scorer whose table does not support its own number is a finding, and it is one the optimizer should
hear about.

## 4. Stop — two subjects, two convergences

| Condition | Action |
|---|---|
| `score ≥ 90` **and** `blockers = 0` **and** the optimizer returned `WASTE: none` | STOP · `stoppedBy: "gate-passed-process-still"` |
| 5 rounds done | STOP · `stoppedBy: "round-ceiling"` |

The loop stops when **both** subjects are still. An app at 92 with an optimizer still pricing real waste
means the next feature will cost more than it should — keep going. An optimizer out of proposals with
the app at 71 means the process is fine and the feature is not — keep building.

The blocker term is not decoration and it is not negotiable. It is the same gate this package uses
everywhere else — see the `scorer` — because on a rubric of any size a single missed blocker still
leaves you a score in the nineties, and a gate a high score can talk its way through is not a gate.
Quality passes buy points. They never buy a blocker.

At the ceiling: report the open blockers, the standing score, and the prediction the last round left
pending. Do not run a sixth round; a feature that cannot clear its own rubric in five has a problem this
loop is not equipped to fix, and grinding another round burns tokens to hide that.

`verdict` is `APROBADO` when the gate opened, `RECHAZADO` otherwise. The verdict is about the **app**.
The process does not get approved or rejected — it gets changed, and then it gets measured.

## 5. The prediction is settled by the NEXT run

This is what separates this loop from the learning loop, and it is the thing people get wrong about it.

A skill's edit is measured by the round that follows it: same task, same rubric, four fresh runs. A
*process* change cannot be measured that way. "This cuts rounds-to-green from 4 to 3" is a claim about
**the next feature**, and the only honest way to settle it is to build the next feature and count.

So the optimizer writes, into every entry, the artifact that will settle it and the date it was made —
and the next run of this loop grades it in setup (step 1) before doing anything else. Within a run you
may see an early sign: a change landed in round 2 is in force for rounds 3, 4 and 5, and if a round
visibly behaves differently, note it. But the entry stays `⏳ pending` until the artifact it named
exists.

A change the optimizer lands in round 5 is not measured by this run at all. That is fine, and it is not
a reason to skip it. It is a reason to write the log entry properly.

## 6. Write the findings JSON

Create `docs/harness-dev/loop-runs/` if it does not exist. Write
`docs/harness-dev/loop-runs/<YYYY-MM-DD>-iterate-<slug>.json` — `<slug>` names the feature.

```json
{
  "run": "2026-07-15-iterate-<slug>",
  "loop": "iterate",
  "spec": "docs/process.md",
  "rubric": "harness-rubric.md",
  "rounds": [
    { "n": 1, "score": 78, "blockers": 1,
      "findings": [
        { "id": "R1-F1", "critic": "scorer", "severity": "blocker",
          "file": "src/lib/router.ts", "line": 0,
          "summary": "one sentence: the defect", "fix": "one sentence: the action" }
      ],
      "specVersion": "v2",
      "processChange": "one line — the exact edit the optimizer made, or 'none'",
      "prediction": "one line — the number, and the artifact that settles it" }
  ],
  "verdict": "APROBADO",
  "stoppedBy": "gate-passed-process-still"
}
```

`severity`: `blocker` (a contract break — a failed blocker-class criterion, a false factual claim, a
leaked secret, a broken build) · `major` (quality a client would notice) · `minor` (style).

Record **every** round, and both trends: `score` is the app's, `processChange` is the process's. A round
where the optimizer changed nothing records `"processChange": "none"` — that is a result, and it is the
one that stops the loop.

## 7. Report

Short. The score per round (the app's trend line), the spec changes with their versions (the process's),
the predictions now open and what will settle them, the JSON path.

**Lead with the process, not the feature.** The feature is what you paid for. The process is what you
bought.

## What this is not

`develop-phase` and `/review-loop` build and verify the app; there, the app is the product. This loop
builds the app *in order to have something to measure the process against* — the feature is the
instrument, not the result.

If you would not spend a round of a real feature to learn something durable about how you build
features, do not run this. Run `develop-phase`, and it will cost you a third as much.
