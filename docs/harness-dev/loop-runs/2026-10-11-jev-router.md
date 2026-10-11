# Jev prompt-router eval — 2026-10-11

`node benchmarks/jev_router_eval.js`, two passes in one run. Raw output: `2026-10-11-jev-router.txt` and
`.json`. Same corpus and skill snapshot as on 2026-10-10 (`2026-10-10-jev-router.md`); what changed is the
eval:

- **Two passes, always.** Jev moves p by up to 0.08 on the same request (`2026-10-10-jev-router-noise-probe.txt`),
  so every headline number is the mean of two passes, with the range in brackets.
- **The threshold is read cumulatively:** the lowest cut-off whose kept predictions (at least 5) are right at
  least 9 times in 10 together. That is the decision routeByJev makes — route everything above p. The
  2026-10-10 runs used the stricter "holds from there on" reading, which is still printed and still finds
  nothing. With two passes, the higher of the two cut-offs wins.
- **Downgrades are capped and scored on their own.** jev.js `decideTier()` moves the implementer down one tier at
  most and never below sonnet. The eval replays that decision on every prompt from the line-up's implementer
  (opus); a downgrade is right when the tier it lands on covers the labelled one.

## Results

| | mean [min–max] |
|---|---|
| tier top-1 | 73.4% [73.4–73.4] |
| skill top-1, strict / lax | 77.3% [76.6–78.1] / 80.5% [79.7–81.3] |
| tier precision: haiku · sonnet · opus · fable | 66.7% [64.7–68.8] · 60.9% · 84.6% · 95.8% [91.7–100] |
| tier recall: haiku · sonnet · opus · fable | 78.6% · 82.4% · 61.1% · 73.3% |
| cumulative threshold per pass | 0.80 (35 kept, 91%) · 0.70 (42 kept, 90%) → **0.80** |
| at 0.80: precision of what is routed · share of the corpus | 91.0% [90.6–91.4] · 52.3% [50.0–54.7] |
| "holds from there on" threshold | none in either pass |
| capped downgrades at 0.80, from opus | 21/22 and 20/21 right — **95.3%** [95.2–95.5] |

The one wrong downgrade, in both passes, is r56: an opus task Jev called haiku at p = 0.99. The caps landed it
on sonnet; without them it would have run on haiku. Upgrades (opus → fable, 9 and 8 per pass) are not scored:
with the default line-up the reviewer is fable, and D25a refuses them.

Under the cumulative reading the four 2026-10-10 runs give 0.70, 0.65, 0.75 and 0.75; this run's two passes give
0.80 and 0.70. The band is 0.65–0.80, and the shipped value is its top.

**Verdict: ROUTABLE.** `jev.js` carries `ROUTE_TIER_THRESHOLD = 0.8`. routeByJev stays off by default; a wrapper
may set it. Limits: 64 prompts typed by one operator, mostly in Spanish, labelled by that operator's own
criterion; chat prompts, not the task specs develop-phase receives. The one real develop-phase run with routeByJev
(`2026-10-11-develop-phase-routebyjev.json`) predates this threshold and routed nothing.
