# process-log.md — optimizer predictions (fixture)

> The ledger is the table. The prose below it is history, and history gets corrected.
> Outcomes are spelled out, not emoji: a parser that only sees ❌ is a parser that reads decoration.

| v | date | change | prediction | resolved by | outcome |
|---|---|---|---|---|---|
| v1 | 2026-01-02 | §1 stop condition | rounds drop from 4 to 3 | the next run + its JSON | **VERIFIED** — 3 rounds |
| v2 | 2026-01-09 | §0 negative control | the next phase escapes ≤ 1 (base: 6) | the next commit + its JSON | **FALSIFIED — ≥3 escapes** (supersedes the VERIFIED resolution below: the single auditor said 0, the review panel found 10 findings + 1 blocker) |
| v3 | 2026-01-16 | §3 contract contradiction | the next contradiction is reported, not silently resolved | the next phase touching a contradictory spec | pending |

---

## Resolution of prediction v2 — 2026-01-10

**Result: 0 escapes. VERIFIED.**

A single human auditor went to the source, checked six things, and found nothing.

## CORRECTION — prediction v2 is FALSIFIED, 2026-01-11

The resolution above is wrong and is kept unedited, because the mis-measurement is the finding: an
auditor only checks what occurs to them. The review panel ran on the same artifact and returned 10
findings, one of them a blocker.

A parser that reads this prose instead of the ledger scores v2 as verified — which is the exact
dishonesty this dashboard exists to refuse.
