# 02 — Pi: stop on a rejection that names no [FAIL]
Status: blocked
Blocked by: 01

PRD: `docs/prds/PRD-004-three-plugins-and-waves.md` §7 ("Pi parity").

## Problem

In the Claude loop (`workflows/develop-phase.js`, the `FAIL_LINE` check after each review), a code or spec review
that says REJECTED without a single `[FAIL]` line stops the run: the implementer has nothing to fix, and looping on it
only burns rounds. `plugins/harness-loops/scripts/develop-phase-pi.js` loops on it until `--max-iter`.

## What to do

- In `develop-phase-pi.js`, after each review round: when an axis (code, or spec when on) rejects and its text has no
  `[FAIL]` line (same pattern as `FAIL_LINE`, a leading `- ` or `* ` allowed), stop at once with `handoff.status`
  `blocked`, a summary naming the axis, and a blocker that quotes the start of that review. Exit 1. No further
  implementer round runs.
- `docs/loops.md`: the Pi paragraph no longer lists this stop as missing.

## Seams

- `develop-phase-pi.js` with a code reviewer that answers `RECHAZADO` and no `[FAIL]` line, `--max-iter 3` — exits 1 after one implementer round, `handoff.status` is `blocked` and the blocker names the code axis
- the same with the spec reviewer — the blocker names the spec axis

## Acceptance criteria

- Stub-seat checks in `scripts/validate.js`, next to the existing `develop-phase-pi:` checks, that fail when the stop is
  removed.
- `node scripts/validate.js` green except the live `JEV_LIVE` checks.

## Out of scope

The Claude loop. Changing how a rejection with `[FAIL]` lines is handled.

## Comments
- 2026-10-14: develop-spec-pi: Ver /tmp/claude-1000/-home-andrami-Documents-harness-audit/5548565a-cbb4-4ffb-9761-5983a7c27527/scratchpad/pi-pilot/run/ticket-02/implementer*.err.txt — worktree kept at /home/andrami/Documents/harness-audit/.pi/worktrees/spec-pi-waves-pilot-02
