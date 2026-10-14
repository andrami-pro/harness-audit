# 02 — Audit rubric: the four PRD-004 §5 criteria

Status: done
Blocked by: None

PRD: `docs/prds/PRD-004-three-plugins-and-waves.md` §5.

## Problem

PRD-004 §5 names four criteria the audit should grade, and only one of them ("wrapper, not fork") is in the rubric:

- a glossary exists and the loops point at it (`GLOSSARY.md` or `GLOSSARY-MAP.md`);
- work is tracked as tickets with blocking edges (`Status:` / `Blocked by:`), not a single growing task list;
- develop-phase carries a Spec axis and agreed seams (the wrapper does not turn `specReview` or `tdd` off without a stated reason);
- the project wrapper calls the global script; no forked copy of `develop-phase.js`.

## What to do

- Add the three missing criteria to `plugins/harness-audit/skills/harness-audit/rubric-template.md` in its entry format,
  each with how to check it (a command or a file to read), and to the rubric table in that skill's `SKILL.md`.
- Keep the `.pi/skills/harness-audit/` copies byte-identical (validate.js checks shared copies).

## Seams

- `rubric-template.md` and `SKILL.md` — both carry a marker for each of the four §5 criteria, and validate.js fails when one is missing from either

## Acceptance criteria

- A check in `scripts/validate.js` (next to the Pillar-4 one) fails when any of the four criteria is missing from either
  file.
- `node scripts/validate.js` green except the live `JEV_LIVE` checks.

## Out of scope

Any loop code. Changing existing criteria.

## Comments
- 2026-10-14: develop-spec: Reported by the implementer/reviewer seats — not independently certified: Preflight skipped checks — supply what they need and re-run; a SKIP is not a PASS — worktree kept at /home/andrami/Documents/harness-audit/.claude/worktrees/spec-prd-004-waves-pilot-02
- 2026-10-14: landed by hand as 1bb94c3 after the pilot run wf_7e6efbb6-227: both axes approved; the only blocker was an undeclared preflight SKIP (private-terms.json is gitignored, so the worktree lacked it). With the file copied in, validate.js is 69/72, 3 NOT VERIFIED (JEV_LIVE).
