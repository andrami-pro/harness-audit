# Jev prompt-router eval — 2026-10-10

What `benchmarks/jev_router_eval.js` measured, and the files each number comes from. Raw output: the `.txt`
and `.json` files with the same date prefix in this folder.

> **Threshold superseded on 2026-10-11.** These runs read the threshold as "holds from there on" and found none.
> The eval now reads it cumulatively, runs two passes and scores capped downgrades: `2026-10-11-jev-router.md`.

## Setup

- **Corpus:** `benchmarks/fixtures/router_corpus.jsonl` — 64 prompts the operator typed in local Claude Code
  sessions, anonymized, labelled by hand: expected skill or `none` (22 / 42), optional `skill_alt` answers that
  also count as right, expected tier (haiku 14 · sonnet 17 · opus 18 · fable 15). One operator, mostly Spanish.
- **Options:** the 102 skills installed on the operator's machine, frozen. Before the fix:
  `2026-10-10-jev-router-before-fix.skills.json`, where 26 descriptions read as the YAML indicator (`>`, `>-`, `|`).
  After: `benchmarks/fixtures/router_skills.json`. Same 102 names; only those 26 descriptions differ.
- **Request:** the hook's own `classify()` — skill and tier in one call, model `jev-latest`.
- **Noise:** the same request twice moves p by up to 0.08; the choice did not change on the 4 prompts probed
  (`2026-10-10-jev-router-noise-probe.txt`). Each arm ran twice.

## Results

| | before r1 | before r2 | after r1 | after r2 |
|---|---|---|---|---|
| tier top-1 | 73.4% | 73.4% | 73.4% | 73.4% |
| skill top-1, strict | 78.1% | 75.0% | 76.6% | 76.6% |
| skill top-1, lax | 81.3% | 81.3% | 79.7% | 79.7% |
| tier threshold (rule below) | none | none | none | none |
| lowest cut-off whose kept predictions reach 0.9 | 0.70 (44 kept) | 0.65 (47) | 0.75 (37) | 0.75 (36) |
| latency p50 / p95 · answers over the hook's 1500 ms | 400 / 1967 ms · 4 | 359 / 710 ms · 0 | 354 / 560 ms · 0 | 365 / 548 ms · 0 |

Tier precision / recall after the fix (r1): haiku 65% / 79% · sonnet 64% / 82% · opus 85% / 61% · fable 92% / 73%.
Opus is under-called: 7 of 18 opus prompts went elsewhere, 6 of them to haiku or sonnet.

**The description fix.** Among the prompts that answered the same in both replicates of each arm, it turned two
misses into hits (`caveman:caveman` on r18, `none` on r50) and made two new misses: r14 and r53 now go to
`ux-squad`, a skill the router could not read before (r14 was right on the primary label, r53 on an
alternative). Strict top-1 averages 76.6% before and after; lax goes from 81.3% to 79.7%, one prompt, which
comes from prompts that also flip between replicates. No measurable gain on this corpus. The fix stays: 26
skills offered to Jev as `">-"` was a bug whatever the score.

**The threshold.** Rule (fixed in the eval before any run): the lowest confidence cut-off from which the tier's
strict precision never drops under 0.9 at a higher cut-off that keeps at least 5 predictions. No run has one.
Precision crosses 0.9 around 0.65–0.75, then falls back to 87–89% at 0.85–0.99, because Jev is wrong with high
confidence on a few prompts: r56 opus → haiku at p = 0.99, r35 haiku → sonnet at 0.92–0.94, r38 sonnet → haiku at
0.89–0.90. `jev.js` keeps `ROUTE_TIER_THRESHOLD = null`, so develop-phase's `routeByJev` keeps the line-up.

## One real run with `routeByJev` (2026-10-11)

`2026-10-11-develop-phase-routebyjev.json`: develop-phase on this repository, task "add a §Jev evals section to
benchmarks/README.md", `preparer: false`, `routeByJev: true`. The route seat ran `jev.js route`; Jev answered
haiku at p = 1.00; with no threshold the decision was `lineup` and the implementer ran on opus, as configured.
Reviewer (fable) approved in one iteration. Preflight (`node scripts/validate.js`) exited 0 with its three
network checks skipped, so the run reports NOT VERIFIED and hands off `continue`.

**Saving observed: none.** Nothing was routed. The route seat is pure overhead: 3 requests, 148 output tokens,
76,445 cache-read and 43,251 cache-write tokens on Haiku, for one Jev answer nobody acted on.
