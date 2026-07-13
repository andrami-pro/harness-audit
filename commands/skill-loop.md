---
description: "Loop 2 — the learning loop. Improves one skill against a fixed eval task and proves it with a blind A/B — two runs with the skill, two without, a blind judge scores all four on the same rubric, and the measured gap drives exactly one bounded edit to SKILL.md with the lesson written to LEARNINGS.md. Dispatch this when a skill keeps making the same mistake, when the user asks to make a skill better, or when someone needs evidence that a skill earns its keep. Cost: medium-high (2 arms x 2 runs x up to 4 rounds, plus a judge) — only worth it for a skill used at least weekly. Announce it in one line when you fire it."
argument-hint: [skill name — blank = least-recently-improved]
allowed-tools: Task, Read, Write, Edit, Grep, Glob, AskUserQuestion, Bash(git stash:*), Bash(git status:*), Bash(git diff:*), Bash(mkdir:*), Bash(date:*), Bash(ls:*)
---

# /skill-loop — the learning loop (Loop 2)

Skill under improvement: **$ARGUMENTS**

You drive the experiment. You do not write the skill and you do not score it — you run the arms, read
the gap, and hand it to the improver.

This command is **autonomous**. Once round 1 starts it runs to its stop condition without asking for
confirmation between rounds. Whatever you need from the human, you ask in setup, before the first run.

**Cost: medium-high.** Two arms x two runs x up to four rounds, plus a judge pass over four outputs
per round — as many as 20 agent runs. That is a fair price for a skill you use at least once a week.
For a skill you have run twice in your life, it is not: say so and stop.

## 0. Announce — one line, before anything else

```
→ /skill-loop: <which skill, and what it keeps getting wrong>
```

## 1. Resolve the skill

`$ARGUMENTS` names a skill. Blank means **least-recently-improved**: of the project's skills, the one
whose `LEARNINGS.md` carries the oldest last entry. A skill with no `LEARNINGS.md` has never been
improved at all and wins that tie outright.

Resolve to a folder holding a `SKILL.md`. If it resolves to nothing, or to more than one, stop and say
so — never improve a skill you had to guess.

## 2. Setup — pin the eval task and the rubric

The measurement is only worth the tokens if both arms answer the **same** question and the judge marks
them against the **same** card, every round. Both live in the header of the skill's `LEARNINGS.md`, and
they are written once:

- **Eval task (`ET-1`)** — one concrete, self-contained job this skill exists to do. Small enough that
  four runs are cheap, real enough that doing it badly is visible. Not a trick question: a Tuesday.
- **Rubric — 5 criteria x 0-5 = /25.** Criteria come from what this skill is *for*: its voice or
  register, its domain contract, structure, the failure modes its own instructions warn against, and
  whatever else it claims to enforce. Each level says what it takes to earn it.

If the skill has no `LEARNINGS.md`, draft both from `SKILL.md` and confirm them with **AskUserQuestion**
before spending a token on round 1 — a rubric the human did not agree to measures your taste, not the
skill. Then create `LEARNINGS.md` with the header and no rounds yet.

If it already has one, **reuse the pinned task and rubric unchanged.** Editing the rubric mid-loop
rewrites history: scores from round 1 stop being comparable with round 3, and the trend line you are
about to publish becomes fiction.

This step is the only place you may ask the human anything. After it, you are on your own until the
report.

## 3. The round — two arms, two runs each

| Arm | What it is |
|---|---|
| **with-skill** | a subagent that loads and follows the skill, on `ET-1` |
| **without-skill** | a plain subagent on the same `ET-1`, with no skill loaded and forbidden to read the skill's folder |

Same model, same tools, same working directory, same task text, both arms. The **only** difference in
the whole experiment is the skill. Anything else you vary lands in the gap and is charged to the skill.

Launch all four runs in **one message, four Task calls**. Give each run the eval task and nothing else
— no rubric (a writer who knows the mark card writes for the mark card, not for the reader), no previous
round, no other run's output.

**Two runs per arm — not one, not three.** One run is a single draw from a noisy process: it cannot
tell a skill from a lucky day. Three costs fifty percent more and narrows the interval by very little.

**Record what each of the four runs cost.** The harness reports a run's token usage when its Task
returns: write it down as it comes in, and at the close of the round sum the two runs of each arm into
`armTokens` (§8). Both arms answered the same task on the same model, so the difference between those
two sums is the only token counterfactual this system has — and a round total is the two arms already
collapsed into one number, which can never yield it. If a run came back with no usage attached, leave
`armTokens` out of the round and say so in the report: an unmeasured cost is `n/a`, never an estimate.

## 4. The blind judge

One judge, one pass, four outputs, labelled `A1 A2 B1 B2`. It scores each on the pinned rubric, per
criterion, with a one-line justification per criterion.

**The judge is never told which letter carries the skill.** Not in the prompt, not in the file names,
not in the order. It does not see `SKILL.md`, `LEARNINGS.md`, the previous rounds, or this command.

The mapping alternates by **round parity**, and it is fixed, not random:

| Round | A is | B is |
|---|---|---|
| odd (1, 3) | with-skill | without-skill |
| even (2, 4) | without-skill | with-skill |

Deterministic, so the journal alone is enough to reproduce the run. Alternating, so a judge with a
standing preference for the first thing it reads cannot express that preference as a skill effect two
rounds running.

A judge that knows which arm is the treatment scores the treatment higher — that is expectation bias,
and an unblinded A/B measures the judge, not the skill.

Then un-blind and compute:

```
arm score  = mean of that arm's two outputs, out of 25
gap(n)     = mean(with-skill) − mean(without-skill)
```

## 5. Read the gap, make one change

Dispatch the `skill-improver` subagent with: the four outputs, the judge's per-criterion table
**un-blinded** (the improver is not the judge — it needs to know which arm is which), the skill's path,
and the round number.

It returns **one bounded edit** to `SKILL.md` and one entry appended to `LEARNINGS.md`.

One change per round, not a rewrite. Change five things at once and the gap moves for reasons you
cannot name — and attribution is the only thing this loop produces that a careful re-read of the skill
would not have given you for free.

**The round that stops the loop does not edit.** Every other round's change is validated by the round
that follows it; the last one would have nothing behind it. An edit no one is going to measure is a
guess, and the loop does not ship guesses into a skill on its way out the door.

## 6. Rollback

A round whose gap comes in **more than 1 point** below the best round so far is a failed experiment,
and the edit that caused it goes. The improver reports the exact edit it made: revert it with `Edit`,
and **keep the entry in `LEARNINGS.md`**, marked falsified. A change that was tried and lost is a
result. Deleting it means the next round is free to try it again.

A drop of a point or less is **noise** — the same noise floor the stop condition uses below — and you
do not revert an edit on noise. Before you revert anything, look at the criterion the edit was aimed
at: if that criterion improved, the edit did its job and the movement came from somewhere else.
Reverting it would throw away a change that worked because two other criteria wobbled.

If the skill folder already held uncommitted work when the loop started, park it first —
`git stash push -m "pre-skill-loop" -- <skill-dir>` — and `git stash pop` it back when the loop is
done. The loop needs a baseline it owns. It must never quietly absorb someone else's work-in-progress
into its own A/B and then take credit for it.

## 7. Stop

| Condition | Action |
|---|---|
| The gap improves by **≤ +1/25** over the previous round, two rounds running | STOP · `stoppedBy: "plateau"` |
| The gap is **≤ +1/25** in absolute terms, two rounds running | STOP · `stoppedBy: "no-measurable-value"` |
| 4 rounds done | STOP · `stoppedBy: "round-ceiling"` |

`no-measurable-value` means: on this eval task, with the skill is within noise of without it. Report
that in plain words. It is a finding about the skill — possibly the most useful one this loop can
return — and it is not a failure of the loop.

Report the final gap **as measured**, including when it is negative or flat. A learning loop that only
ever reports gains is not an instrument, it is an advertisement, and its numbers are worth what
advertising numbers are worth.

## 8. Write the findings JSON

Create `docs/harness-dev/loop-runs/` if it does not exist. Write
`docs/harness-dev/loop-runs/<YYYY-MM-DD>-skill-loop-<skill>.json`.

```json
{
  "run": "2026-07-15-skill-loop-<skill>",
  "loop": "skill-loop",
  "skill": "<skill>",
  "evalTask": "ET-1",
  "rounds": [
    { "n": 1, "score": 21,
      "startedAt": "2026-07-15T09:02:11Z",
      "endedAt": "2026-07-15T09:31:40Z",
      "blindMap": { "A": "with-skill", "B": "without-skill" },
      "arms": { "withSkill": [21, 20], "withoutSkill": [14, 13] },
      "armTokens": {
        "withSkill": { "in": 26000, "out": 4500 },
        "withoutSkill": { "in": 18000, "out": 2000 }
      },
      "tokens": { "in": 44000, "out": 6500 },
      "gap": 7,
      "change": "one line — the edit the improver applied to SKILL.md",
      "findings": [] }
  ],
  "verdict": "IMPROVED",
  "stoppedBy": "plateau"
}
```

`score` is the with-skill arm's mean, out of 25 — the headline number of the round. `gap` is what the
loop is actually for. `blindMap` records which letter carried the skill, so the blinding is auditable
after the fact instead of taken on trust.

`startedAt`, `endedAt` and `tokens` are the round fields every loop writes. `armTokens` is this loop's
alone, and it is what `loop-stats` turns into the Δ tokens it prints beside the Δ score: each arm is the
sum of that arm's two runs. Write `in`/`out` when the harness reports the split and `{ "total": N }`
when it reports only a total — a total split across `in`/`out` by hand is a number nobody measured.
Omit `armTokens` when no usage came back at all: the dashboard then prints `n/a` and the reason, which
is true, where a filled-in guess would not be.

`verdict`: `IMPROVED` (final gap positive and grown since round 1) · `NO-VALUE` (gap within noise) ·
`REGRESSED` (final gap below round 1). A measurement is not approved or rejected — it comes out how it
comes out.

## 9. Report

Short. The rounds table (gap per round), the edits that landed, the ones that were reverted, the final
gap, the JSON path. Lead with the number, not with the effort.
