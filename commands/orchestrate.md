---
description: "Loop 3 — the critic panel. Four specialist critics (correctness, domain, safety, style) review the given artifacts in parallel, findings are aggregated, fixes are applied, repeat until a round adds no new blocker or major. Dispatch this when a change touches published or customer-facing content, marketing copy, multi-locale text, or factual/regulated claims — and whenever a diff is broad enough that one reviewer would miss a whole class of defect. Do NOT dispatch it for typos or code-only diffs; that is your normal review or develop-phase. Cost: medium (4 critics x up to 3 rounds)."
argument-hint: <paths, PR ref, or a description of the artifacts to review>
allowed-tools: Task, Read, Write, Edit, Grep, Glob, Bash(graphify:*), Bash(git diff:*), Bash(git status:*), Bash(mkdir:*), Bash(date:*), Bash(node:*)
---

# /orchestrate — the critic panel (Loop 3)

Artifacts under review: **$ARGUMENTS**

You are the panel chair. You do not review — you dispatch, aggregate, fix, and decide when to stop.

This command is **autonomous**. Once it starts it runs to its stop condition without asking for
confirmation between rounds. The human hears from you at the end, or when you hit the ceiling.

## 0. Announce — one line, before anything else

Print exactly one line naming the loop and why it fired:

```
→ /orchestrate: <one clause — what the artifacts are and why a panel, not a single reviewer>
```

## 1. Resolve the artifacts

Turn `$ARGUMENTS` into a concrete file list (a path, a glob, `git diff --name-only`, a PR ref).
If it resolves to nothing, stop and say so — never review an empty set.

Read the graph before you read the files: `graphify query "<what the artifacts touch>"` returns a
scoped subgraph and costs a fraction of a grep sweep. If the project has no `graphify-out/graph.json`,
skip it and move on.

Name the run — `<YYYY-MM-DD>-orchestrate-<slug>` — and use that one slug for the run directory, the
round files and the findings JSON.

**Then check whether that run is already in progress.** Rounds are files, not conversation: a chair
that dies in round 2 of a panel has already paid for round 1, and the only way to keep it is to have
written it down.

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

## 2. Round — four critics, in parallel (max 3 rounds)

Launch all four in **one message, four Task calls** — they must run in parallel and must not see
each other's findings. Sequential dispatch is a bug: it turns four independent reads into a chain
where the last critic inherits the panel's blind spots.

| subagent_type | seat |
|---|---|
| `correctness-critic` | every verifiable figure, claim, citation, regulator |
| `domain-critic` | the domain/locale contract (parity, market fit, slugs, audience) |
| `safety-critic` | secrets, credentials, risky legal claims |
| `style-critic` | tone, AI-speak, copy, comment density |

Prompt each critic with **artifacts only** — the file list, the round number, and nothing else:

```
Round <n>. Review these artifacts: <resolved file list>.
Query graphify first if the project has a graph; grep only after it orients you.
Return your findings in the JSON contract from your agent definition. Artifacts only:
you get no author reasoning, no conversation history, no other critic's findings.
```

Never pass a critic: the previous round's findings, the fixes you applied, your own opinion of the
artifacts, or another critic's output. Independence is the whole point of a panel — the moment they
share context, four seats collapse into one.

**Re-anchor before every round after the first: re-read the prompt template above in this file and
send it unchanged.** The critics are fresh each round and cannot drift; you are not. By round 3 you
are holding every finding, every fix and every reply, and the natural thing to do with all that
context is to be helpful with it — a clause about what the last round found, a hint about where to
look. Each of those is the independence leak, arriving as a courtesy rather than as a decision. The
round number and the file list are the only two things that change between rounds.

## 3. Aggregate — but gate each seat's JSON first

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

Collect the four gated JSON arrays. Assign each finding an `id` of `R<round>-F<k>` (k restarts per
round) and the `critic` field (`correctness` | `domain` | `safety` | `style`) — the critics do not set
these, and the gate rejects them if they try.

A finding is **new** if it does not restate a finding from the previous round: same seat, same file,
same defect. Judge by meaning, not by string equality. A finding the fixer failed to resolve stays
open — it is not new, but it is also not gone.

## 4. Fix round

If the round produced **any new blocker or major** → apply fixes. Delegate to the project's
`implementer` subagent if it defines one (`.claude/agents/implementer.md`); otherwise apply them
yourself. Either way: apply **all** findings of the round — blocker, major and minor together.
Then go to round n+1.

The fixer gets the findings. The critics never do.

**Close the round on disk before you open the next one.** Write
`docs/harness-dev/loop-runs/<run-slug>/round-<n>.json` — the round object exactly as §6 specifies it,
one round per file. That file is what `resume` counts, and it is the only thing that survives a chair
that dies mid-run. Write it after the fix round, so a resumed run never re-applies fixes that already
landed. Numbering is contiguous from 1: `resume` refuses a gap rather than guessing which round is
missing.

## 5. Stop

| Condition | Action |
|---|---|
| A round adds no new blocker and no new major | STOP · `stoppedBy: "no-new-findings"` |
| 3 rounds done and blockers or majors keep arriving | STOP · `stoppedBy: "round-ceiling"` |

There is no fourth round. When you hit the ceiling without converging, report the open findings to
the human and stop — a panel that cannot converge in three rounds has found a problem the loop is
not equipped to fix, and grinding a fourth round burns tokens to hide that.

`verdict` is `APROBADO` when the loop stops with zero open blockers, `RECHAZADO` otherwise.
Open minors never block: they are reported, not gated.

## 6. Write the findings JSON

Create `docs/harness-dev/loop-runs/` if it does not exist. Write
`docs/harness-dev/loop-runs/<YYYY-MM-DD>-orchestrate-<slug>.json` — `<slug>` names the artifacts.

This is the aggregate, written once at the end: every `round-<n>.json` from §4, in order, under
`rounds`. Writing it is what turns the run directory from in-progress into `RUN_COMPLETE`, so write it
only when the loop has actually stopped.

```json
{
  "run": "2026-07-15-orchestrate-post-ai-native",
  "loop": "orchestrate",
  "rounds": [
    { "n": 1, "score": null,
      "startedAt": "2026-07-15T09:02:11Z",
      "endedAt": "2026-07-15T09:24:03Z",
      "tokens": { "in": 61000, "out": 8200 },
      "findings": [
        { "id": "R1-F1", "critic": "domain", "severity": "blocker",
          "file": "src/content/blog/es/empresa-ai-native.mdx", "line": 42,
          "summary": "figure differs between the two locales", "fix": "unify on the sourced number" }
      ] }
  ],
  "verdict": "APROBADO",
  "stoppedBy": "no-new-findings"
}
```

`severity`: `blocker` (a contract break — locale contract, a false factual claim, a leaked secret, a
broken build) · `major` (quality a client would notice) · `minor` (style).
`critic`: `correctness | domain | safety | style | scorer`.

`startedAt`, `endedAt` and `tokens` are the round's wall clock and what it cost, as the harness reported
it when each Task returned. Omit any of them the harness did not surface — the dashboard reads an absent
field as unmeasured and says so, and it has no way to tell a filled-in guess from a fact.
`score` is `null` here: scoring needs a rubric, and this panel has critics instead. `/review-loop`
fills it.

Record **every** round, including the last one that stopped the loop, and every finding of each round
— not just the open ones. The JSON is the run's evidence; a round with an empty `findings` array is a
result, not an omission.

## 7. Report

Short. Rounds run, findings by severity, what was fixed, what is open, the JSON path. If the verdict
is `RECHAZADO`, lead with the open blockers — that is the only thing the human needs from you.
