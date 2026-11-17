# 01 — ui-check: universal UI rules in a real browser

Status: done
Blocked by: None

PRD: `docs/prds/PRD-006-ui-check.md` §3 D1–D3, D5, D6.

## What to do

`plugins/harness-loops/scripts/ui-check.js`: 11 still-screen rules, 4 interaction rules, axe-core, console and network
errors; config in `.harness/ui-check.json`; levels off/warn/block; exit 0/2/1/3; optional `serve`, `failRequests`,
`--json`, `--shots`. Zero dependencies of its own.

## Seams

- `node ui-check.js --config <file>` — exit code and the BLOCK/WARN/SKIP report
- `--json <file>` — `{ stats, blocking, warnings, skipped, violations }`

## Acceptance criteria

- `scripts/validate.js`: each rule fires on `scripts/fixtures/ui-check/bad.html` or `clicks.html`, nothing fires on
  `good.html` (the calibration false positives), a promoted rule exits 2, a typo exits 1, no app exits 3; each
  calibration has a recorded negative control.
- Run on Tama OS: the squeezed thread is reported, no false alarm from the patterns in `good.html`.

## Comments

- 2026-11-17: built on branch feat/ui-check. Tama OS run: 51 screens in 51 s; conversation-starved ×7, phone sideways
  scroll, squeezed session log, 23 small tap targets, 47 axe findings; no overlap false positives.
