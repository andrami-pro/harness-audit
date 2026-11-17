# 05 — Nightly exploration: Bombadil with the universal rules

Status: ready-for-agent
Blocked by: 01

PRD: `docs/prds/PRD-006-ui-check.md` §2.

## Problem

ui-check visits the screens a config names; bugs that need an unusual sequence of actions stay out of reach.

## What to do

A scheduled run (cron or the `schedule` skill) that drives Bombadil over the project with the universal rules as
`always` properties, a wait action while the app boots, and a jump into deep routes (Bombadil cannot start at a `#`
URL). A violation becomes a ticket with the shrunk trace.

## Notes from the spike

`--no-sandbox` is needed on Ubuntu with AppArmor user-namespace restrictions; about 50 MB of screenshots every
3 minutes; it crashed once on a lone UTF-16 surrogate while typing.
