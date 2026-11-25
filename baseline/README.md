# baseline/ — the user-level harness, versioned

What every project on this machine gets before any plugin runs: the secret and force-push deny rules, a Stop hook
that runs the project's own gate, a notice when a project is behind, and the `/arnes-al-dia` command that brings a
project up to date. The files are in Spanish because their messages are read by the operator.

This folder is the source. `~/.claude` and `~/.pi` hold copies.

| File | Installed to | What it does |
|---|---|---|
| `VERSION`, `CHANGELOG.md`, `deny.json` | `~/.claude/harness-baseline/` | current version, what each one brings, the deny list |
| `commands/arnes-al-dia.md` | `~/.claude/commands/` | brings one project up to the current version |
| `hooks/baseline-check.sh` | `~/.claude/hooks/` | SessionStart: says when the project is behind |
| `hooks/verify-on-stop.sh` | `~/.claude/hooks/` | Stop: runs `.claude/verify.sh` or `preflight`, sends the agent back on red, logs the run |
| `pi/harness-baseline.ts` | `~/.pi/agent/extensions/` | the same three behaviours for Pi |

```bash
baseline/install.sh           # copy; a copy that differs is kept as <file>.bak-<date>
baseline/install.sh --check   # exit 1 when an installed copy differs from this folder
node baseline/gate-stats.js   # what the gate caught, per project, last 30 days
```

`install.sh` does not edit `~/.claude/settings.json`. The two hooks and the deny rules are registered there once, by
hand.

## What the gate log measures

`verify-on-stop.sh` appends one line per gate run to `~/.claude/gate-log.ndjson`. `gate-stats.js` counts catches:
turns the agent was about to end on a tree that failed the project's checks. That is the point where a session with
no gate stops, so a catch is a failure the harness kept out of a finished turn. It does not show what a session
without the harness would have written in the first place; that needs the same ticket run both ways.
