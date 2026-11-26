---
description: Brings this project's harness up to the common baseline every project on this machine shares — committed deny rules, a green verification gate the Stop hook can run, a prompt audit of the project's agent config, and CI that runs the same gate. Offer it when the session-start notice says the project is behind; run it only when the operator asks.
argument-hint: "(no arguments)"
---

# /catch-up — bring this project up to the harness baseline

Bring this repository up to the harness baseline common to all the operator's projects. Answer in the operator's language.

The current version is in `~/.claude/harness-baseline/VERSION` and what it brings in `~/.claude/harness-baseline/CHANGELOG.md`: read both first. What is the same for every project already lives at user level and in the harness-guards plugin (the deny rules in `~/.claude/settings.json`, the `project-gate` Stop hook, the global CLAUDE.md and skills; on Pi, the extension `~/.pi/agent/extensions/harness-baseline.ts`, which uses the same list and the same scripts). Do not copy any of it into the repository beyond what is listed below.

Work through what the repository needs, in this order, and skip what is already done:

1. **Committed deny rules.** Merge the list in `~/.claude/harness-baseline/deny.json` into `permissions.deny` of the repository's `.claude/settings.json` (create it if missing; remove nothing it already has). If the repository holds other secret files (a `service-account.json`, a `*.pem`, an `.npmrc` with a token), add them and say so. These are the rules a cloud session carries with it.

2. **A green gate.** The Stop hook runs `.claude/verify.sh` when it is executable, otherwise the `preflight` script of `package.json`.
   - If the repository has neither, propose a `.claude/verify.sh` with its quick checks (lint, typecheck, unit tests; under a minute) and create it once the operator approves.
   - Run the gate once through the hook, so the green run is recorded: `echo '{"cwd":"'"$PWD"'"}' | node ~/.claude/harness-baseline/hooks/project-gate.js --standalone`. Read the gate's script first: if it does more than check (migrations, a deploy, network calls with effects), do not run it and ask.
   - If it is red, find the cause. Fix what is gate configuration (a lint that walks tool folders, for example); present a real code failure to the operator instead of covering it.

3. **Prompt audit of the project's config.** Claude Code only, where the `claude-api` skill exists; on Pi, leave this step pending and tell the operator to run it from Claude Code. Run the `prompt-audit` subcommand of the `claude-api` skill over `CLAUDE.md`, `CLAUDE.local.md` and `AGENTS.md` of the repository, and whatever is in the `agents`, `skills`, `commands` and `rules` folders under `.claude/`. Leave user-level config out. Present the report and the diff; apply only the changes the operator accepts.

4. **CI.** Check whether `.github/workflows/` runs the same gate on every PR. If not, propose the workflow; do not push it.

5. **Stamp.** When 1 and 2 are done (or the operator chose to leave them pending), write the version from `~/.claude/harness-baseline/VERSION` into `.claude/harness-baseline`. End with a short list: what was done, what is pending and why.

Do not commit or push unless the operator asks.
