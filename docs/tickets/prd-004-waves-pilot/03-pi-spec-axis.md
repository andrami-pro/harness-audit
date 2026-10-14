# 03 — Pi: the spec review axis

Status: done
Blocked by: 01

PRD: `docs/prds/PRD-004-three-plugins-and-waves.md` §3.2 and §7.

## Problem

The Claude loop approves only when a code reviewer and a spec reviewer both approve. The spec reviewer judges the change
against the task, the PRD, the plan and the seams. The Pi loop has one reviewer.

## What to do

- A second review seat in `plugins/harness-loops/scripts/develop-phase-pi.js`, run in parallel with the code reviewer
  through `pi`, read-only, with the task, the PRD path, the plan, the seams (from ticket 01) and the diff. Same prompt
  intent as `SPEC_PROMPT` in `workflows/develop-phase.js`.
- Its model comes from the line-up (a `spec` role, defaulting to the reviewer's), refused when it shares the
  implementer's family (D25a), as the code reviewer is.
- Approval needs both. The result carries `axes: { code, spec }`, spec evidence lines prefixed `spec: `, and a rejected
  axis reaches the implementer as its own section. `--no-spec-review` turns it off.
- Update the "On Pi" paragraph of `docs/loops.md`: list what Pi still lacks, if anything.

## Seams

- `develop-phase-pi.js` run with a spec seat that rejects — not approved even when the code reviewer approves; the result's `axes.spec.approved` is false
- `develop-phase-pi.js` with a spec model of the implementer's family — exits before any seat runs (D25a)

## Acceptance criteria

- Stub-seat checks in `scripts/validate.js` that fail when the spec verdict is ignored or D25a is not applied to it.
- `node scripts/validate.js` green except the live `JEV_LIVE` checks.

## Out of scope

`workflows/develop-phase.js`.

## Comments

- 2026-10-14: merged by develop-spec from spec/prd-004-waves-pilot-03
