---
id: PRD-004
title: Three plugins in one marketplace, a global develop-phase, and waves
status: in-progress
created: 2026-10-10
updated: 2026-10-14
---

# PRD-004 — Three plugins in one marketplace, a global develop-phase, and waves

## 1. Executive summary

`harness-audit` started as an audit and now does four jobs: it diagnoses a harness, runs the loops that
build against it, guards every session, and reports what the agents did. The name describes one of the
four, `plugin.json` needs a paragraph to say what it ships, and the README runs to 729 lines.

The coupling that costs the most is mechanical: the audit *emits* `develop-phase.js` into each project
(Step 4b, ~280 lines of `SKILL.md`). Every project then holds its own fork. Twelve projects on the
maintainer's machine hold twelve different copies (twelve distinct checksums), so every loop improvement
is twelve hand patches and none of them reaches a stranger who installed last month.

This PRD splits the repository into three plugins in the same marketplace, makes `develop-phase` one
global script that projects call through a small wrapper, and adds what the loop lacks against Matt
Pocock's skills: test-first implementation, a Spec review axis, and **waves**, an outer loop that works
a ticket graph without a human between tickets.

## 2. Decisions (taken 2026-10-10)

- **D1: one repository, three plugins.** One marketplace (`.claude-plugin/marketplace.json`) lists three
  plugins, each with its own `source` folder. Separate repositories would triple CI, releases and READMEs
  for a single maintainer and split the stars.
- **D2: names by job.**

  | Plugin | Job | Who it is for | Ships |
  |---|---|---|---|
  | `harness-audit` | Diagnose | Anyone bringing coding agents to an existing repo | the skill, `rubric-template.md`, `verifier-protocol.md`, line-up resolution |
  | `harness-loops` | Build | Developers who want agents to ship multi-ticket work unattended | `develop-phase`, `develop-spec` (waves), `/review-loop`, `/iterate`, `/orchestrate`, `/skill-loop`, the critic agents, `loop-gate.js`, the external-review bridge, Jev (opt-in) |
  | `harness-guards` | Protect and observe | Anyone running Claude Code | the write-time guards, `repeat-tool-guard`, `loop-telemetry`, `/dashboard-harness`, `/session-review`, `loop-stats` |

  `harness-audit` keeps its name so existing installs and the blog link keep working.
- **D3: the audit and the loops meet at a contract, not a copy.** The audit writes `harness-rubric.md`
  and a project wrapper. The wrapper is the project's config:

  ```js
  export const meta = { name: 'develop-phase', description: 'Project wrapper around the global develop-phase' }
  return await workflow({ scriptPath: '<stable path>/develop-phase.js' }, {
    lang: 'fr', preflight: 'pnpm preflight', reviewerModel: 'opus',
    forbidden: ['wrangler deploy', 'pnpm deploy*'], tickets: 'docs/tickets', ...args,
  })
  ```

  `workflow({scriptPath})` runs a script inline with one nesting level (verified 2026-10-10), so the
  global script ships with the plugin and an update reaches every project at once.
- **D4: compose with Pocock, never absorb.** The loops read `tdd`, `to-tickets` and `codebase-design`
  from `~/.agents/skills/` when installed and degrade to today's behaviour when not. `CREDITS.md` names
  them. Both projects are MIT.
- **D5: defaults that work for a stranger.** The default reviewer is a native Anthropic model from a
  different tier than the implementer. The OpenRouter bridge stays opt-in.
- **D6: independent semver per plugin, changesets for the changelog.** `harness-audit` goes to 3.0.0
  (it stops emitting the template), `harness-loops` and `harness-guards` start at 1.0.0.
- **D7: deliverable language is per project.** Specs, tickets and commit messages follow the project's
  `lang`, never a hard-coded language.

## 3. develop-phase gains

1. **Test-first.** The analyst's plan carries a `Seams` section (the public interfaces to test). The
   pre-launch question shows the seams, so the human agrees them once, before the run. The implementer
   reads `tdd/SKILL.md` and works red before green, one vertical slice at a time.
2. **Spec axis.** Today the reviewer receives the diff and the rubric but not the task, so "scope as
   agreed" is judged blind. A second review seat receives the diff, the task, the plan and the PRD path,
   and reports missing requirements, unrequested behaviour and wrong implementations, quoting the spec.
   Approval needs both axes. They are reported side by side, never merged or re-ranked.
3. **Mechanical rubric criteria become checks.** Following Pocock's `retro`: a rubric criterion that
   matches a fixed pattern becomes a lint rule or a test in the preflight. The rubric keeps the judgement
   calls.

## 4. develop-spec: waves

Input: a tickets folder, one file per ticket with `Status:` and `Blocked by:`.

1. The **frontier** is every `ready-for-agent` ticket whose blockers are all `done`.
2. Each frontier ticket gets a named worktree created from the integration branch and runs the full
   develop-phase loop inside it (implementer, both review axes, preflight). `agent({isolation: 'worktree'})`
   gives each agent a *fresh* worktree, so the implementer and its reviewers share a named one instead.
3. An approved ticket merges into the integration branch through the project's integration script, is
   marked `done`, and the frontier is recomputed: the next wave starts as soon as a slot frees.
4. A ticket that does not converge in `maxIter` is marked `blocked` with its open `[FAIL]` lines. Its
   dependents wait; the rest of the graph continues.
5. Tickets that add a database migration never share a wave (the second declares the first in
   `Blocked by:`).
6. At the end: a two-axis review of the whole integration branch, then one brief for the human: what
   landed, what is blocked and why, which decisions are needed.

Two human checkpoints only: approving the ticket breakdown before the run, reading the brief after.
Never unattended: production deploys, writes to client workspaces, remote migrations.

## 5. New rubric criteria (audit side)

- A glossary exists and the loops point at it (`GLOSSARY.md` or `GLOSSARY-MAP.md`).
- Work is tracked as tickets with blocking edges, not a single growing task list.
- develop-phase carries a Spec axis and agreed seams.
- The project wrapper calls the global script; no forked copy of `develop-phase.js`.

## 6. Migration of existing projects

`notion-impac-pilotage` was set up by hand on 2026-10-10 and is the reference for what the audit must
emit in every project (scaffold only what is missing, ask before renaming):

- the deliverable language as one line in `AGENTS.md` (feeds the wrapper's `lang`);
- `GLOSSARY.md` (renaming a legacy `CONTEXT.md` with `git mv`) and `docs/adr/`;
- `docs/agents/issue-tracker.md` (local markdown: spec = the project's PRD, one ticket per file under
  `docs/tickets/<prd>/` with `Status:` and `Blocked by:`, the task list becomes an index) and
  `docs/agents/domain.md`;
- the `## Agent skills` block in `CLAUDE.md` (Claude Code does not load `AGENTS.md` on its own).

`harness-audit` Step 0 ("upgrade in place") also gains a migration: diff the project's `develop-phase.js`
against the template it was emitted from, move each customisation into the wrapper's config (or flag
the ones that do not fit), then replace the file with the wrapper. Pilot: `notion-impac-pilotage`.

## 7. Open questions

- **A stable `scriptPath`.** Resolved 2026-10-10 by a zero-agent probe: `workflow({scriptPath})` does **not**
  expand `~` ("Workflow script file not found: ~/…"); absolute paths work, and relative ones resolve against the
  session cwd. Named lookup reads a registry loaded at session start (a workflow written mid-session is not
  found). Plugins can ship `workflows/` (documented, namespaced `/<plugin>:<name>`), but whether `workflow()`
  resolves `harness-loops:develop-phase` is unverified until a session runs with the plugin installed. Shipped:
  the `sync-workflows` SessionStart hook copies the loop to `~/.claude/harness/` when it differs, the wrapper
  calls that copy by absolute path and falls back to the plugin name on "not found".
  Corrected the same day by the first live run (elsa-agents): a plain session refuses a `scriptPath` outside
  its readable directories ("scriptPath must be a script path this tool returned, or a file you can already
  read"); the probe had passed only because its session could read `~/.claude`. The hook now also writes a
  git-ignored copy into `.claude/harness/` of every project with a wrapper, and the wrapper reads it first.
- **Pi parity.** `scripts/develop-phase-pi.js` needs the same three gains or a documented gap.
- **Workflow size.** A wave of four tickets is already more than ten agents; document the `/config` setting.

## 8. Order

1. Split into three plugins without behaviour change; `scripts/validate.js` proves each plugin installs
   alone. **Done**, published in 3.0.0.
2. Global develop-phase plus wrapper; migrate the pilot. **Done**, published in 3.0.0: the loop is
   `plugins/harness-loops/workflows/develop-phase.js`, the wrapper template is
   `plugins/harness-audit/skills/harness-audit/develop-phase-wrapper.js`. First live run 2026-10-10
   (elsa-agents: scout, analyst, implementer, reviewer, preflight, commit). Hardened since in loops
   1.1.0–1.2.2 (per-run `prd`, seats isolated from the chat, the verdict is the last verdict line).
   Still unverified: the wrapper's third fallback, resolving the loop by the name `harness-loops:develop-phase`.
3. TDD and the Spec axis. **Done** in loops 1.3.0: `seams` (`'propose'`, then the agreed list), test-first
   implementer (`tdd`), a parallel spec seat (`specReview`) under D25a; approval needs both axes, reported side by side.
   Proven by stub seats in `validate.js` with negative controls, and by a first live run on this repository
   ([2026-10-14](../harness-dev/loop-runs/2026-10-14-develop-phase-seams-spec.md)). Pi: not yet (§7).
4. develop-spec (waves); pilot on one PRD. Not started.
5. Migrate the remaining projects. **Partial**: READMEs are under 150 lines and the root README has the
   "which plugin do I need?" table. Of the projects that held a fork, 7 call the wrapper on their branch,
   3 have it applied but not committed, and 6 wait until their owner's work in progress lands
   (the pilot `notion-impac-pilotage` among them, its wrapper on branch `s/develop-phase-wrapper`).
