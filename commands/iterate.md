---
description: "Loop 5 — the meta-loop. Round after round it builds a multi-requirement feature, scores the app against the rubric, and then a process-optimizer reads the run's own telemetry and makes ONE bounded change — with a falsifiable prediction — to the spec of the process that built it. Two subjects converge: the feature against the rubric, the process against its own waste. The lasting product is not the feature; it is a process that builds the next feature in fewer rounds. Cost: HIGH — builder, scorer and optimizer every round, up to five rounds. Multi-requirement features only: never a bug fix, never a typo, never a one-file change. You may suggest this command; you may never launch it yourself."
argument-hint: <the feature to build> [--spec <process spec path, default docs/process.md>]
allowed-tools: Task, Read, Write, Edit, Grep, Glob, Bash(graphify:*), Bash(git diff:*), Bash(git status:*), Bash(git log:*), Bash(git ls-files:*), Bash(mkdir:*), Bash(date:*), Bash(node:*)
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

Name the run — `<YYYY-MM-DD>-iterate-<slug>` — and use that one slug for the run directory, the
round files and the findings JSON.

**Then check whether that run is already in progress.** Rounds are files, not conversation: a chair
that dies in round 3 of a build loop has already paid for two builder rounds, and the only way to keep
them is to have written them down.

```bash
node "${CLAUDE_PLUGIN_ROOT:-.claude}/scripts/loop-gate.js" resume docs/harness-dev/loop-runs/<run-slug>/
```

**If that command is not available**, list the run directory yourself and read the `round-<n>.json`
files it holds. The rule that matters survives the missing script: unless what you find is plainly the
contiguous sequence `1..n`, stop and hand it to the human rather than reconciling it.

`NO_RUN` → start at round 1. `RESUME_FROM: <n>` → round `n` is the next one: read the round files
already on disk for what is open, and never re-dispatch a round that is recorded. `RUN_COMPLETE` →
that slug has published a verdict; pick another slug or stop. **`AMBIGUOUS_RUN_STATE` (exit 2) → stop
and hand the human the files it listed.** Do not reconcile it yourself — a loop that repairs its own
half-written state resumes into a round nobody chose, and it reports the result as if someone had.

## 2. The round — three seats, in sequence (max 5)

| # | seat | `subagent_type` | what it does |
|---|---|---|---|
| 1 | builder | the project's own **`implementer`** | builds the next open requirement, following the spec, and ends its reply with a handoff (below) |
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

**The builder ends its reply with a handoff** — one fenced `json` block, nothing after it. Put this
contract in its prompt every round:

```json
{ "status": "complete|continue|blocked",
  "summary": "one sentence: where the requirement stands",
  "evidence": ["<a command and its output, or file:line>"],
  "blocker": "<only when blocked: what stops the work, in one sentence>" }
```

`complete` means the requirement is built and the builder can point at why. `continue` means it is
partly built and the next round carries on. `blocked` means it cannot proceed without something it does
not have, and `blocker` names it — a block nobody can name is a stall.

## 3. Gate every seat — the handoff for shape, the scorecard for arithmetic

Write each seat's raw reply to `docs/harness-dev/loop-runs/<run-slug>/raw/<round>-<seat>.json`, then
run the gate over it before anything enters the aggregate. The builder's handoff:

```bash
node "${CLAUDE_PLUGIN_ROOT:-.claude}/scripts/loop-gate.js" check-handoff <file> --seat builder
```

The scorer's scorecard:

```bash
node "${CLAUDE_PLUGIN_ROOT:-.claude}/scripts/loop-gate.js" check-findings <file> --root . --seat <seat>
```

**If that command is not available** — the install has these commands but not the plugin's `scripts/`,
which is what a copied-commands install looks like — say so once, in one line, and check each seat's
JSON yourself against the contract in its agent file: for the handoff, a status from the fixed set,
non-empty summary and evidence, a blocker exactly when blocked; for the scorecard, the fixed severity
ladder, a `file` that exists in the repo, a `line` inside that file, a non-empty summary and fix, and
no `id`/`critic` the seat assigned itself. Then **say in the report that the run was ungated.** A
missing gate is not a passing gate, and a crash from a missing script is not a verdict.

Exit 0 → take it. **Exit 2 → do not take it, and do not repair it yourself.** Re-dispatch that one
seat with the gate's error list appended verbatim to its prompt: the errors are written to be acted on
without help, and a chair paraphrasing them is a chair guessing what the seat meant. A seat that fails
the gate twice is a finding about the loop — record it, and carry on. A handoff that comes back
`blocked` is **not** a gate failure: record the blocker, let the scorer score what exists, and report
the block — the human decides whether the loop goes on.

A handoff that clears the gate has been checked for **shape**, nothing more. It is what the builder
reports about its own work; the gate certifies none of it, and the scorer's scorecard is the
independent read. Say so wherever the handoff is quoted: *reported by the builder, not certified*.

**The score comes from the gate, not from you and not from the scorer's headline.** Run over the
scorecard, `check-findings` prints the two numbers this loop gates on:

```
SCORE: 86/100 · BLOCKERS: 1
```

It computes them from the `criteria` table with the same weights the scorer's own file states —
`blocker` 3, `quality` 1, over every criterion with `applies: true` — and it is the only party in the
round that is neither building the feature nor grading it. Take those two numbers. If they disagree
with the scorer's own headline, **the gate wins**, and say so in the report: a scorer whose table does
not support its number is a finding of its own, and one the optimizer should hear about.

Give every gated finding an `id` of `R<round>-F<k>` (k restarts each round) and its `critic` field
(`scorer`) — the seats do not set these, and the gate rejects them if they try.

**Close the round on disk before you open the next one.** Write
`docs/harness-dev/loop-runs/<run-slug>/round-<n>.json` — the round object exactly as §6 specifies it,
one round per file. That file is what `resume` counts, and it is the only thing that survives a chair
that dies mid-run. Write it after the optimizer's change has landed, so a resumed run never re-applies
a spec edit that already exists. Numbering is contiguous from 1: `resume` refuses a gap rather than
guessing which round is missing.

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
      "startedAt": "2026-07-15T09:02:11Z",
      "endedAt": "2026-07-15T09:37:20Z",
      "tokens": { "in": 120000, "out": 15000 },
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
  "stoppedBy": "gate-passed-process-still",
  "handoff": { "status": "complete",
    "summary": "one sentence: where the feature stands, as the builder reported it",
    "evidence": ["SCORE: 92/100 · BLOCKERS: 0 — loop-gate, round 3"] }
}
```

`handoff` is the last round's builder handoff after it cleared `check-handoff` — gated for shape,
reported by the builder, certified by nobody. Omit the field when no round produced one.

`severity`: `blocker` (a contract break — a failed blocker-class criterion, a false factual claim, a
leaked secret, a broken build) · `major` (quality a client would notice) · `minor` (style).

Record **every** round, and both trends: `score` is the app's, `processChange` is the process's. A round
where the optimizer changed nothing records `"processChange": "none"` — that is a result, and it is the
one that stops the loop.

`startedAt`, `endedAt` and `tokens` are the round's wall clock and what it cost, as the harness reported
it when each Task returned. Omit any field the harness did not surface — the dashboard reads an absent
field as unmeasured and says so, and it has no way to tell a filled-in guess from a fact.

## 7. Report

Short. The score per round (the app's trend line), the spec changes with their versions (the process's),
the predictions now open and what will settle them, the JSON path. Say which numbers came from the
gate, and label the handoff as the builder's report, not a certificate.

**Lead with the process, not the feature.** The feature is what you paid for. The process is what you
bought.

## What this is not

`develop-phase` and `/review-loop` build and verify the app; there, the app is the product. This loop
builds the app *in order to have something to measure the process against* — the feature is the
instrument, not the result.

If you would not spend a round of a real feature to learn something durable about how you build
features, do not run this. Run `develop-phase`, and it will cost you a third as much.
