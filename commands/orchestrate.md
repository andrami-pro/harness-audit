---
description: "Loop 3 — the critic panel. Four specialist critics (correctness, domain, safety, style) review the given artifacts in parallel, findings are aggregated, fixes are applied, repeat until a round adds no new blocker or major. Dispatch this when a change touches published or customer-facing content, marketing copy, multi-locale text, or factual/regulated claims — and whenever a diff is broad enough that one reviewer would miss a whole class of defect. Do NOT dispatch it for typos or code-only diffs; that is your normal review or develop-phase. Cost: medium (4 critics x up to 3 rounds)."
argument-hint: <paths, PR ref, or a description of the artifacts to review>
allowed-tools: Task, Read, Write, Edit, Grep, Glob, Bash(graphify:*), Bash(git diff:*), Bash(git status:*), Bash(mkdir:*), Bash(date:*)
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

## 3. Aggregate

Collect the four JSON arrays. Assign each finding an `id` of `R<round>-F<k>` (k restarts per round)
and the `critic` field (`correctness` | `domain` | `safety` | `style`) — the critics do not set these.

A finding is **new** if it does not restate a finding from the previous round: same seat, same file,
same defect. Judge by meaning, not by string equality. A finding the fixer failed to resolve stays
open — it is not new, but it is also not gone.

## 4. Fix round

If the round produced **any new blocker or major** → apply fixes. Delegate to the project's
`implementer` subagent if it defines one (`.claude/agents/implementer.md`); otherwise apply them
yourself. Either way: apply **all** findings of the round — blocker, major and minor together.
Then go to round n+1.

The fixer gets the findings. The critics never do.

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
