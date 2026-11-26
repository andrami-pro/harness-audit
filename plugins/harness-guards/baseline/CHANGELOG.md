# Harness baseline — what each version brings

Each project keeps the version it has applied in `.claude/harness-baseline`. When a session opens, the
`baseline-check` hook of the harness-guards plugin compares it with `VERSION` and, when the project is behind, says so
and offers `/harness-guards:catch-up`. To improve every project: change the command (or `deny.json`), add an entry
here and raise `VERSION`.

The source of these files is `plugins/harness-guards/baseline/` in the harness-audit repository. The plugin keeps a
copy under `~/.claude/harness-baseline/`; an edit made in the copy is overwritten at the next session start.

## User-level changes (no version bump: no project has anything to do)

- 2026-11-26: the baseline ships in the harness-guards plugin. The two hooks are Node scripts the plugin registers
  (`baseline-check`, `project-gate`), and `/arnes-al-dia` is now `/harness-guards:catch-up`. The hand-installed
  `~/.claude/hooks/*.sh` and their entries in `~/.claude/settings.json` can be removed.
- 2026-11-25: the gate writes each run to `~/.claude/gate-log.ndjson`; `scripts/gate-stats.js` counts, per project,
  how many regressions it caught.

## 2026.11.13

- Deny rules committed in `.claude/settings.json` (the list is `deny.json`), so they travel to cloud sessions.
- A green verification gate (`.claude/verify.sh` or the `preflight` script) that the Stop hook can run.
- A prompt audit of the project's config (CLAUDE.md, AGENTS.md, agents, skills, commands) against the current model.
- CI that runs the same gate on every PR (reported when missing).
- Pi gets the same through the extension `~/.pi/agent/extensions/harness-baseline.ts` (secrets and force-push
  blocked, the baseline notice, verification when a turn ends) and the same command as a prompt template.
