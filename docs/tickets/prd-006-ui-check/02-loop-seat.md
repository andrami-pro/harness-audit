# 02 — develop-phase: a ui-check seat after every implementation

Status: done
Blocked by: 01

PRD: `docs/prds/PRD-006-ui-check.md` §3 D3–D5.

## What to do

Wrapper key `uiCheck` (true or a command). After the implementer, a seat runs it and reports fields. BLOCK → back to
the implementer with the report, no review that round. WARN → the code reviewer's prompt. Exit 3 → NOT VERIFIED in the
handoff, accepted only through `allowSkipped`. `sync-workflows` and `install.sh` copy `ui-check.js` to
`~/.claude/harness/`. The audit skill documents the key and a Pillar 3 row.

## Seams

- wrapper `uiCheck` — absent: no seat; set: one `ui:iter<n>` seat per iteration
- the loop result — `handoff.evidence` carries `ui-check: <state>`; a final BLOCK is the `blocker`

## Acceptance criteria

- `scripts/validate.js` "develop-phase uiCheck" check with stub seats, and its three recorded negative controls.

## Comments

- 2026-11-17: built on branch feat/ui-check; not yet run by a live develop-phase on a project.
