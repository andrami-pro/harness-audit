# 03 — Rule-author seat: project rules written before the code

Status: ready-for-agent
Blocked by: 02

PRD: `docs/prds/PRD-006-ui-check.md` §3 D1–D2.

## Problem

The universal rules know nothing of the product. "Approving a task removes it from the pending list" or "the room
thread stays the main thing in its column" are project rules, and nobody writes them: the squeezed thread stayed green
because no rule existed.

## What to do

An optional seat (`uiRules: true`), before the implementer, on a model outside the implementer's family (D25a). It reads
the ticket and `.harness/ui-check.json`, and writes the rules this ticket's screens must keep into
`.harness/ui-rules/<ticket>.js` — the same contract as `staticRules` (a function of `document, window` returning
`[{ rule, where, detail }]`). ui-check loads every file in that folder. The implementer may not edit them.

## Acceptance criteria

- A stub-seat check: the seat runs before the implementer, the implementer's prompt forbids editing the rule file,
  ui-check reports a project rule like a universal one.

## Out of scope

Promoting a project rule to block automatically.
