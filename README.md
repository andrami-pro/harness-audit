# harness-audit

Coding agents are only as good as the harness around them: the rules they read, the checks that can say
no, the reviewer that did not write the code, the loop that knows when to stop. This repository gives
Claude Code (and, partly, Cursor, Kilo Code, OpenCode and Pi) that harness, in three plugins you install
separately. *The model is the horse, the harness is the saddle*: models change every few months, the
harness stays.

## Which plugin do I need?

| If you want to… | Install | What you get |
|---|---|---|
| Know what your repo is missing before you let agents loose on it | `harness-audit` | An audit against four pillars, an **executable rubric** (`harness-rubric.md`, every row a command), a stack-tailored plan, and a `develop-phase` wrapper for the project |
| Let agents ship work with an independent reviewer and real stop conditions | `harness-loops` | `/orchestrate`, `/review-loop`, `/iterate`, `/skill-loop`, the seven critic/scorer agents, and the global `develop-phase` loop: scout → analyst → implementer → reviewer from another model family → preflight → commit |
| Stop dangerous commands and see how your sessions actually go | `harness-guards` | Four write-time guards, local telemetry, `/dashboard-harness` and `/session-review` — nothing leaves your machine |

They work alone and together: the audit writes the rubric and the wrapper, the loops converge against
them, the guards watch every session.

## Install

### Option 1 — Claude Code plugins (recommended)

```
/plugin marketplace add andrami-pro/harness-audit
/plugin install harness-audit@harness-audit     # diagnose
/plugin install harness-loops@harness-audit     # build
/plugin install harness-guards@harness-audit    # protect and observe
```

**Upgrading from 2.x:** `harness-audit` used to ship all three jobs. Since 3.0 it ships the audit only;
install `harness-loops` and `harness-guards` to keep the loops, guards and dashboard you had.

`harness-guards` installs four guards that run on every session:

| Hook | What it blocks |
|---|---|
| `destructive-guard` | `rm -rf` against root/home, `git checkout --force`, `git clean -fdx`, `git reset --hard origin/*`, writes to block devices |
| `secret-scan` | Writing files that contain credential patterns (`sk-…`, `ghp_…`, `AKIA…`, PEM private keys, Slack tokens) |
| `block-no-verify` | `git commit/push --no-verify` — the pre-commit gate cannot be silently bypassed |
| `repeat-tool-guard` | Nothing — it is advisory. After 3, 5 and 8 consecutive identical tool calls it reminds the model to re-read the last result and change approach; a human prompt resets the count |

The guards are deliberately conservative: short, high-precision patterns that allow when in doubt. To
disable them, uninstall `harness-guards`.

Four more hooks, none of which blocks anything. `loop-telemetry` comes with `harness-guards`; the other
three with `harness-loops`:

| Hook | Event | What it does |
|---|---|---|
| `loop-telemetry` | `SubagentStop`, `Stop` | Appends one ndjson line per agent boundary for `/dashboard-harness`. Local file, never sent anywhere |
| `prompt-router` | `UserPromptSubmit` | **Off unless a TypeSafe key is present.** Suggests which installed skill and which subagent tier fit the prompt, in one advisory line. Sends the first 1500 chars of the prompt — see [§Jev](plugins/harness-loops/README.md#jev--the-optional-system-one-classifier) |
| `jev-nudge` | `SessionStart` | While no key is present, says once a day that Jev is off and names `bin/jev-setup`. Silent with a key |
| `sync-workflows` | `SessionStart` | Keeps a copy of the global `develop-phase` loop in `~/.claude/harness/`, and in `.claude/harness/` (git-ignored) of each project that has a wrapper. Writes nothing else |

### Option 2 — skill only (Claude Code, no hooks)

```bash
git clone https://github.com/andrami-pro/harness-audit.git /tmp/harness-audit
cp -R /tmp/harness-audit/plugins/harness-audit/skills/harness-audit ~/.claude/skills/harness-audit
```

### Option 3 — other coding agents

The audit skill follows the open [Agent Skills](https://agentskills.io) standard:

```bash
./install.sh --target cursor        # .cursor/skills/   (project)
./install.sh --target kilo          # ~/.kilo/skills/   (user)
./install.sh --target antigravity   # .agents/skills/   (project)
```

The loops port to OpenCode, Kilo Code and Pi too (`--target opencode | kilo-loops | pi`), with real
losses on the way — read [docs/compatibility.md](docs/compatibility.md) first. The guards and the
dashboard are Claude Code only.

## How it works, in one minute

1. **Audit.** Ask Claude Code to "audit my harness". It detects the stack, grades four pillars
   (harness in code, role separation, automatic verification, loop design), and writes
   `harness-rubric.md`: every criterion has a `Check:` command and a threshold, so a loop can converge
   against it instead of a human re-reading a report. A fresh-context agent re-runs a sample of the
   checks before you see anything.
2. **Wrap.** The audit writes `.claude/workflows/develop-phase.js`, a wrapper that holds only the
   project's config: language, models, preflight command, what the agents must never run.
3. **Loop.** `/develop-phase <task>` runs one global loop (it ships with `harness-loops`, so an
   improvement reaches every project): a cheap scout reads the repo, an analyst plans or stops on a
   blocker, the implementer builds, a reviewer **from another model family** looks for reasons to
   reject, the project's preflight decides, and the commit holds only the files the run touched.
4. **Watch.** `/dashboard-harness` reads your local transcripts and tells you which tools failed, which
   guards fired, which skills you installed and never used — for free, without leaving your machine.

An independent reviewer beats self-critique; the often-cited ~62% → ~89% figures are directional, not
reproduced here yet (see [WHITEPAPER §8.1](WHITEPAPER.md)). A minimal harness beats an inflated one.

## Read more

- [plugins/harness-audit/README.md](plugins/harness-audit/README.md) — the four pillars, the model line-up, what the audit writes
- [plugins/harness-loops/README.md](plugins/harness-loops/README.md) — the loops, `develop-phase`, Jev
- [plugins/harness-guards/README.md](plugins/harness-guards/README.md) — the guards, the dashboard, `/session-review`
- [docs/loops.md](docs/loops.md) — every loop in detail · [docs/compatibility.md](docs/compatibility.md) — other harnesses
- [WHITEPAPER.md](WHITEPAPER.md) — the full rationale
- Articles: [ES](https://andrami.pro/blog/auditoria-de-arnes-ia) · [FR](https://andrami.pro/fr/blog/audit-harnais-ia)

## Repo layout

```
.claude-plugin/marketplace.json   one marketplace, three plugins
plugins/harness-audit/            the audit skill, its templates, the model line-up tools
plugins/harness-loops/            loop commands, agents, loop-gate, the global develop-phase, Jev
plugins/harness-guards/           guards, telemetry, the dashboard
docs/                             loops in detail, compatibility, PRDs
scripts/validate.js               this repository's own gate — `node scripts/validate.js` before releasing
install.sh                        installer for other agents and for Claude Code without plugins
```

Code shared by two plugins (`model-lineup.js`, `skill-inventory.js`) ships as identical copies, because an
installed plugin cannot read a sibling's files; `validate.js` fails when they drift.

## Contributing

Issues and PRs welcome — new stack recipes, sharper rubric checks, more anti-patterns, and above all an
independent reproduction of the verifier benchmark.

## Attribution

By **Andrés Ramírez · andrami** — https://andrami.pro · [MIT License](LICENSE).
