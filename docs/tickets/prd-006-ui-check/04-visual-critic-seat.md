# 04 — Visual critic seat: what no rule covers becomes a rule

Status: ready-for-agent
Blocked by: 02

PRD: `docs/prds/PRD-006-ui-check.md` §3 D1.

## Problem

Judgment guidelines cannot be measured: one primary action per screen, you can see where you are, the empty, loading
and error states exist, nothing reads as a generic template. Jev could not see them (PRD §2).

## What to do

An optional seat (`uiCritic: true`) after ui-check passes, on a vision-capable Claude model outside the implementer's
family. It gets only the screenshots of the screens the change touched (`ui-check --shots`), a checklist distilled from
ui-ux-pro-max, ux-heuristics, information-architecture and no-ai-design-slop, and returns `[PASS|FAIL]` lines. Each
confirmed FAIL that a rule could catch is proposed as a project rule for ticket 03's folder.

## Acceptance criteria

- A stub-seat check: the critic sees screenshots and the checklist, never the implementer's report; a FAIL reaches the
  implementer as its own section.
