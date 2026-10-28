# harness-audit

Coding agents are only as good as the harness around them: the rules they read, the checks that can say
no, the reviewer that did not write the code, the loop that knows when to stop. This repository is that
harness, in three plugins, for Pi and Claude Code; the newest pieces land on Pi first. *The model is the
horse, the harness is the saddle.*

**New in 3.1, Pi-native: confirmed mission routing.** No more routing missions by hand or by Ctrl+P:
type the task normally, and the harness asks once where it belongs — an answer in the chat, the
`develop-phase` loop, a `develop-spec` plan, or the design seat — and which line-up model to use.
Nothing switches silently, and one-shot model changes restore themselves. A daily deterministic advisor
(rankings × price × data policy, zero LLM calls) keeps the candidates fresh; its suggestions apply only
through `/line-up advise`. Details: [What's new](docs/whats-new.md) ·
[PRD-005](docs/prds/PRD-005-confirmed-mission-routing.md).

## Which plugin do I need?

| If you want to… | Install | What you get |
|---|---|---|
| Know what your repo is missing before you let agents loose on it | `harness-audit` | An audit against four pillars, an **executable rubric** (`harness-rubric.md`, every row a command), a stack-tailored plan, and a `develop-phase` wrapper for the project |
| Let agents ship work with an independent reviewer and real stop conditions | `harness-loops` | `/orchestrate`, `/review-loop`, `/iterate`, `/skill-loop`, the seven critic/scorer agents, the global `develop-phase` loop (scout → analyst → test-first implementer → code and spec reviewers from another model family → preflight → commit), and `develop-spec`, which works a folder of tickets in waves — plus, on Pi, the confirmed mission router |
| Stop dangerous commands and see how your sessions actually go | `harness-guards` | Four write-time guards, local telemetry, `/dashboard-harness` and `/session-review` — nothing leaves your machine |

They work alone and together: the audit writes the rubric and the wrapper, the loops converge against
them, the guards watch every session.

## Install

### Pi — the cockpit (all loops, waves, and mission routing)

Pi is where the harness is most complete: both build loops as plain Node scripts, the tmux live view,
and the confirmed mission router. One dependency, named because Pi's core has no sub-agent dispatch:

```bash
pi install npm:pi-subagents
./install.sh --target pi           # loop prompts and critics into this project's .pi/
./install.sh --target pi --lineup  # same, plus each agent's model pinned from your line-up
cp plugins/harness-loops/pi/jev-router.ts ~/.pi/agent/extensions/
```

Then, with the project trusted (nothing loads until then): type the task — the router proposes;
`/mission` shows routing status; `/line-up` edits seats or applies the daily advisor's report;
`/develop-phase <task>` and `/develop-spec` run the loops by hand when you prefer.
What Pi does not get, plainly: `/session-review` and `/dashboard-harness` (they read Claude Code
transcripts) and the four write-time guards (Claude Code hooks).

### Option 1 — Claude Code plugins

```
/plugin marketplace add andrami-pro/harness-audit
/plugin install harness-audit@harness-audit     # diagnose
/plugin install harness-loops@harness-audit     # build
/plugin install harness-guards@harness-audit    # protect and observe
```

**Upgrading from 2.x:** `harness-audit` used to ship all three jobs; since 3.0 install `harness-loops`
and `harness-guards` to keep what you had.

`harness-guards` installs four guards that run on every session:

| Hook | What it blocks |
|---|---|
| `destructive-guard` | `rm -rf` against root/home, `git checkout --force`, `git clean -fdx`, `git reset --hard origin/*`, writes to block devices |
| `secret-scan` | Writing files that contain credential patterns (`sk-…`, `ghp_…`, `AKIA…`, PEM private keys, Slack tokens) |
| `block-no-verify` | `git commit/push --no-verify` — the pre-commit gate cannot be silently bypassed |
| `repeat-tool-guard` | Nothing — it is advisory. After 3, 5 and 8 consecutive identical tool calls it reminds the model to re-read the last result and change approach; a human prompt resets the count |

The guards are deliberately conservative; to disable them, uninstall `harness-guards`.

Four more hooks, none of which blocks anything (`loop-telemetry` with `harness-guards`, the other three
with `harness-loops`):

| Hook | Event | What it does |
|---|---|---|
| `loop-telemetry` | `SubagentStop`, `Stop` | Appends one ndjson line per agent boundary for `/dashboard-harness`. Local file, never sent anywhere |
| `prompt-router` | `UserPromptSubmit` | **Off unless a TypeSafe key is present.** Suggests which installed skill and which subagent tier fit the prompt, in one advisory line. Sends the first 1500 chars of the prompt — see [§Jev](plugins/harness-loops/README.md#jev--the-optional-system-one-classifier) |
| `jev-nudge` | `SessionStart` | While no key is present, says once a day that Jev is off and names `bin/jev-setup`. Silent with a key |
| `sync-workflows` | `SessionStart` | Keeps a copy of the global `develop-phase` loop in `~/.claude/harness/`, and in `.claude/harness/` (git-ignored) of each project that has a wrapper. Writes nothing else; says one line when a project's develop-phase is a fork or an older wrapper |

### Option 2 — skill only, or another coding agent

```bash
./install.sh --target claude-skill      # ~/.claude/skills/harness-audit — audit only, no hooks
./install.sh --target cursor            # .cursor/skills/
./install.sh --target kilo              # ~/.kilo/skills/
./install.sh --target antigravity       # .agents/skills/
```

The loops also port to OpenCode and Kilo Code (`--target opencode | kilo-loops`), with honest losses
read first in [docs/compatibility.md](docs/compatibility.md). The guards and the dashboard are
Claude Code only.

## How it works, in one minute

1. **Audit.** Ask Claude Code to "audit my harness". It detects the stack, grades four pillars
   (harness in code, role separation, automatic verification, loop design), and writes
   `harness-rubric.md`: every criterion has a `Check:` command and a threshold, so a loop can converge
   against it instead of a human re-reading a report. A fresh-context agent re-runs a sample of the
   checks before you see anything.
2. **Wrap.** The audit writes the loop's wrapper, holding only the project's config: language, models,
   preflight command, what the agents must never run.
3. **Loop.** `/develop-phase <task>` runs one global loop (it ships with `harness-loops`, so an
   improvement reaches every project): a cheap scout reads the repo, an analyst plans and names the
   seams to test (or stops on a blocker), the implementer builds test-first, and two reviewers **from
   another model family** look for reasons to reject, one against the rubric and one against the spec.
   The project's preflight decides, and the commit holds only the files the run touched.
4. **Waves.** A folder of ticket files (one per ticket, `Status:` and `Blocked by:` lines) is a graph,
   and `develop-spec` works it: plan first (waves, cycle warnings — nothing runs), then up to
   **two tickets in flight**, each through the full `develop-phase` loop inside its own git worktree;
   an approved one merges, and its dependents start the moment the merge lands. Two human checkpoints
   only: the plan, one final brief. Migrations never share a wave; a stuck ticket is marked blocked
   and the rest of the graph continues.
5. **Route.** On Pi, the mission router classifies each prompt (same Jev call as skills and tiers) and
   proposes one of four paths — chat answer, develop-phase loop, develop-spec plan, design seat — with
   the line-up model it would use. You approve or decline every switch. The daily advisor keeps those
   recommendations current without spending a token per request.
6. **Watch.** `/dashboard-harness` reads your local transcripts and reports which tools failed, which
   guards fired, which skills you installed and never used — free, local.

An independent reviewer beats self-critique; the often-cited ~62% → ~89% figures are directional, not
reproduced yet ([WHITEPAPER §8.1](WHITEPAPER.md)). A minimal harness beats an inflated one.

## Read more

- [docs/whats-new.md](docs/whats-new.md) — every recent change, newest first, operator-facing · [PRD-005](docs/prds/PRD-005-confirmed-mission-routing.md) — the router's decisions and acceptance criteria
- [docs/loops.md](docs/loops.md) — every loop in detail, waves included · [docs/compatibility.md](docs/compatibility.md) — other harnesses
- [plugins/harness-audit/README.md](plugins/harness-audit/README.md) — the four pillars, the model line-up · [plugins/harness-loops/README.md](plugins/harness-loops/README.md) — the loops, Jev
- [plugins/harness-guards/README.md](plugins/harness-guards/README.md) — the guards, the dashboard, `/session-review` · [WHITEPAPER.md](WHITEPAPER.md) — the full rationale, §5.4 routing and §5.5 waves included
- Articles: [ES](https://andrami.pro/blog/auditoria-de-arnes-ia) · [FR](https://andrami.pro/fr/blog/audit-harnais-ia)

## Repo layout

```text
claude-plugin/marketplace.json   one marketplace, three plugins
plugins/harness-audit/           the audit skill, its templates, the model line-up tools
plugins/harness-loops/           loop commands, agents, loop-gate, develop-phase, Jev, the Pi router
plugins/harness-guards/          guards, telemetry, the dashboard
docs/                            loops, compatibility, PRDs, what's new
scripts/validate.js              the repository's own gate — run before releasing
install.sh                       installer for other agents and for Claude Code without plugins
```

Code shared by plugins (`model-lineup.js`, `skill-inventory.js`) ships as identical copies — an installed
plugin cannot read a sibling's files; `validate.js` fails when they drift.

## Contributing and attribution

Issues and PRs welcome — new stack recipes, sharper rubric checks, more anti-patterns, and above all an
independent reproduction of the verifier benchmark.
By **Andrés Ramírez · andrami** — https://andrami.pro · [MIT License](LICENSE).