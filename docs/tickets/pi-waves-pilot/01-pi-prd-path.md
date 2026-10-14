# 01 — Pi: a PRD path for develop-phase-pi
Status: done
Blocked by: None

PRD: `docs/prds/PRD-004-three-plugins-and-waves.md` §3.2 and §7 ("Pi parity").

## Problem

The Claude loop takes a per-run `prd` (`workflows/develop-phase.js`, `cfg.prd`): the seats read that file as the spec.
`plugins/harness-loops/scripts/develop-phase-pi.js` has no such flag, so its spec reviewer is pointed at the whole
`docs/prds/` folder and has to guess which PRD the task implements. `scripts/develop-spec-pi.js` takes `--prd` but only
gives it to its final review, never to the tickets' runs.

## What to do

- `develop-phase-pi.js` gains `--prd <path>`. When given, the scout and the spec reviewer are told to read that file
  (instead of "the active PRD in docs/prds/"); when absent, the prompts stay as they are. Usage text and header updated.
- `develop-spec-pi.js` forwards its `--prd` to every ticket's `develop-phase-pi.js` run, as it forwards `--preflight`.
- `docs/loops.md`: the Pi paragraph no longer lists the `prd` path as missing; the flag appears in both usage lines.

## Seams

- `develop-phase-pi.js --prd docs/prds/x.md` — the scout's and the spec seat's prompt files name `docs/prds/x.md`; without `--prd` they name `docs/prds/` as before
- `develop-spec-pi.js --prd docs/prds/x.md` — every ticket's develop-phase-pi run receives `--prd docs/prds/x.md`

## Acceptance criteria

- Stub-seat checks in `scripts/validate.js`, next to the existing `develop-phase-pi:` and `develop-spec-pi:` checks,
  that fail when the flag is dropped or not forwarded.
- `node scripts/validate.js` green except the live `JEV_LIVE` checks.

## Out of scope

The Claude loop. Any other flag.

## Comments
- 2026-10-14: merged by develop-spec-pi from spec/pi-waves-pilot-01
