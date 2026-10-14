# 01 — Pi: seams, test-first, declared skips and a read-only reviewer

Status: blocked
Blocked by: None

PRD: `docs/prds/PRD-004-three-plugins-and-waves.md` §3 and §7 ("Pi parity").

## Problem

`plugins/harness-loops/scripts/develop-phase-pi.js` is the Pi mirror of `workflows/develop-phase.js`. Since loops 1.3.0
the Claude loop agrees seams, works test-first, accepts skips a project declares, and tells its code reviewer it is
read-only. The Pi loop does none of it, and `docs/loops.md` says so.

## What to do

- `--seams "<one per line>"`: the agreed seams. The analyst copies them into a `SEAMS:` … `END SEAMS` block or stops on
  `BLOCKER:`. Without the flag the analyst proposes its own block. `--seams propose` stops after the analyst and prints
  the proposed seams in the result.
- The implementer works test-first per seam (same rule text as `TDD_RULES` in `workflows/develop-phase.js`); `--no-tdd`
  turns it off. The reviewer checks one test per seam.
- `--allow-skipped "<substring>"` (repeatable): a preflight SKIP line containing it is reported, not counted.
- The reviewer prompt says read-only, as in the Claude loop.
- Read seams from the plan with the same rules as `seamsOf()` in `workflows/develop-phase.js` (markdown-tolerant markers;
  no END line ends at the first blank line).

## Seams

- `node scripts/develop-phase-pi.js --seams propose …` result — stops before the implementer, `seams.list` holds the analyst's block
- `node scripts/develop-phase-pi.js --seams "<list>" …` — the analyst's prompt carries the agreed seams, the implementer's carries them and the test-first rule
- `runPreflight()` with `--allow-skipped` — a matching SKIP line is reported and does not block; any other SKIP still does

## Acceptance criteria

- The existing `develop-phase-pi` check in `scripts/validate.js` is extended, or a sibling check added, with stub seats
  (the way that check already fakes `pi`), and fails when each rule above is removed.
- `node scripts/validate.js` green except the live `JEV_LIVE` checks.

## Out of scope

The spec review axis on Pi (ticket 03). `workflows/develop-phase.js` itself.

## Comments

- 2026-10-14: develop-spec: Reported by the implementer/reviewer seats — not independently certified: Preflight skipped checks — supply what they need and re-run; a SKIP is not a PASS — worktree kept at /home/andrami/Documents/harness-audit/.claude/worktrees/spec-prd-004-waves-pilot-01
