# Jev dedupe eval, live — 2026-10-11

The first measurement of loop-gate's dedupe thresholds (0.85, and 0.95 for a blocker), which had been chosen,
not measured. Corpus: `benchmarks/jev-dedupe/corpus.json`, 31 synthetic cases (17 restatements, 14 new findings).

| run | file | new blocker/major hidden at 0.85/0.95 | precision | recall |
|---|---|---|---|---|
| 1 | `2026-10-11-jev-dedupe-live.validate.txt` (validate.js, verdict line only) | 0 | — | 41% |
| 2 | `2026-10-11-jev-dedupe-live.run1.txt` | 0 | 100% | 47% |
| 3 | `2026-10-11-jev-dedupe-live.run2.txt` | 0 | 100% | 41% |

**What it means.** The thresholds are safe on this corpus: no new finding was hidden from the stop rule. But they
are tight: the dedupe reads more than half of the restatements as new, and each of those costs a redundant fix
round. Separation: the lowest p on a true restatement is 0.25–0.26, the highest on a new finding 0.68. At 0.75,
precision stays at 100% and recall rises to 47–53%; at 0.65 one new minor is hidden.

**Next step:** recalibrate 0.85 / 0.95 against this corpus, plus restatement pairs from real round files, before
moving either number. Not changed in this release.
