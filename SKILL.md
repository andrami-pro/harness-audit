---
name: harness-audit
description: Audit a project's agent harness against four pillars (harness-in-code, multi-agent role separation, automatic verification, loop design) and produce an EXECUTABLE rubric (harness-rubric.md) plus a stack-tailored remediation plan with stop conditions. Use when starting work in an unfamiliar repo, or when the user says "audit my harness", "audita el harness", "AGENTS.md", "preflight", "reviewer subagent", "harness engineering", "self-improving loop", "loop design", "rubric", "independent verifier", "continuous memory", "loop-readiness", or asks to make a repo portable across Claude Code / Codex / Cursor / Antigravity / Kilo Code. Methodology: the audit IS a rubric a loop converges against, not a static report; an independent verifier sub-agent beats self-critique; memory matures Fail→Investigate→Verify→Distill→Consult; AGENTS.md ≤ 200 lines; a minimal harness beats an inflated one. The model is the horse, the harness is the saddle.
---

# harness-audit — Four pillars + executable rubric + self-correction loop

## Paradigm

The audit is not a static report a human reads and executes — it is an **executable rubric** that a loop converges against. Loop Design in one line: goal → rubric (every criterion checkable by command) → independent verifier → memory that compounds. *"Garbage rubric + great model = a confidently wrong loop."* The human-readable report derives FROM the rubric, never the other way around.

The model is the horse; the harness is the saddle. Models change every few months — the harness stays. That is why the artifact of value is the rubric and the role conventions, not any one model.

See [WHITEPAPER.md](WHITEPAPER.md) for the full rationale, benchmarks, and theory.

## When to invoke

Run this when **any** of these is true:

- Starting a new agent session in an unfamiliar repo and you want to know how mature its harness is
- The user mentions: `AGENTS.md`, harness, preflight, subagent, orchestrator, reviewer, self-improving loop, loop design, rubric, verifier
- The user asks to "make this repo portable" / "set up for Claude Code and Codex"
- Before a multi-week project — invest 30 minutes in the harness so the model becomes interchangeable

## What I produce

1. **Audit report** — four-pillar checklist with ✓/✗/partial per item + **loop-readiness grade L0–L3**
2. **`harness-rubric.md`** — executable rubric: every item carries a `Check:` command + threshold + current state (format in [rubric-template.md](rubric-template.md))
3. **Stack-tailored plan** — concrete files/commands matching the detected stack; every phase has a done-criterion + stop condition
4. **Adversarially verified findings** — a fresh-context subagent re-runs sampled checks before delivery (protocol in [verifier-protocol.md](verifier-protocol.md))

## Workflow

### Step 1 — Detect the project stack

Read these files in order (stop at first match for primary stack, then enumerate secondaries):

| Signal file | Stack |
|---|---|
| `package.json` (root) | Node / JS / TS — inspect deps for: next, react, vue, svelte, vite, express, fastify, nest, remix, astro, hono |
| `pnpm-workspace.yaml` / `turbo.json` / `nx.json` / `lerna.json` | Monorepo (pnpm/turbo/nx/lerna) |
| `pyproject.toml` / `requirements.txt` / `Pipfile` / `poetry.lock` | Python — django, fastapi, flask, pydantic, sqlalchemy |
| `Cargo.toml` | Rust — tokio, axum, actix, leptos, dioxus |
| `go.mod` | Go — gin, echo, fiber, gorm |
| `composer.json` | PHP — Laravel, Symfony |
| `Gemfile` | Ruby — Rails, Sinatra |
| `pom.xml` / `build.gradle(.kts)` | Java / Kotlin — Spring, Quarkus, Micronaut |
| `pubspec.yaml` | Flutter / Dart |
| `Package.swift` / `*.xcodeproj` | Swift / iOS |
| `mix.exs` | Elixir — Phoenix |
| `*.csproj` / `*.sln` | .NET |
| `Dockerfile` / `docker-compose.yml` | Containerized (note runtime layer regardless of primary lang) |
| `terraform/` / `pulumi/` / `cdk.json` | IaC layer |

Also detect: package manager (`pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `package-lock.json` → npm, `bun.lock` → bun), CI (`.github/workflows/` → GitHub Actions, `.gitlab-ci.yml` → GitLab, `.circleci/` → CircleCI), and existing test runner (vitest/jest/playwright/pytest/cargo test/go test).

### Step 2 — Audit the four pillars

#### Pillar 1 — Harness in code (files at repo root + folder conventions)

| Item | What to check | How |
|---|---|---|
| Portable entry point | `AGENTS.md` exists at root | `test -f AGENTS.md` |
| AGENTS.md not bloated | ≤ 200 lines | `wc -l < AGENTS.md` |
| Harness-specific delta | `CLAUDE.md` / `.cursorrules` / Antigravity equivalent, short (~40–60 lines), points to AGENTS.md | `wc -l` + `grep -i agents.md` |
| Preflight script | Single command that runs all health checks | `grep -E '"(preflight\|verify\|check)"' package.json` (or `Makefile`, `justfile`, etc.) |
| Memory exists | Convention for logging progress (sprint log, ADR folder, decision log, memory dir) | `find docs/ .claude/ -iname "*log*" -o -iname "*decision*" -o -iname "*adr*" -o -iname "*memory*" 2>/dev/null` — existence only; **quality is graded in Pillar 4** |
| Task tracking | Tasks file or external tracker reference | `test -f TASKS.md` or check `AGENTS.md` for Linear/Jira link |
| Code-graph index (optional) | A structural index exists so symbol queries beat grep from day one | if the project supports one and it's missing, the plan MAY include initializing it as a Phase 1 step |

#### Pillar 2 — Role separation (multi-agent) + verifier independence

| Item | What to check | How |
|---|---|---|
| Subagents folder | `.claude/agents/` (or equivalent) exists with at least one role definition | `ls .claude/agents/*.md 2>/dev/null` |
| Reviewer present | A subagent that audits diffs against rules | `grep -l -i "reviewer\|review.*diff" .claude/agents/*.md 2>/dev/null` |
| Reviewer independence | Reviewer receives ONLY diff + rules — never the implementer's reasoning or chat context | read reviewer.md: inputs must be artifacts (diff, files, rubric), not conversation |
| Reviewer refutes, not confirms | Reviewer prompted to find reasons to REJECT, with evidence per criterion (PASS/FAIL + quote) | `grep -i "refut\|reject\|evidence" .claude/agents/reviewer*.md` |
| No self-approval | AGENTS.md documents that the implementer never approves its own diff | `grep -i "self.approv\|reviewer" AGENTS.md` |
| Skills (personas) | A skills folder for domain personas (PM, dev, UX, etc.) | `ls .claude/skills/*/SKILL.md 2>/dev/null` |
| Multi-harness portability | Same role conventions discoverable for Codex/Cursor (AGENTS.md mentions roles abstractly) | `grep -i "orchestrat\|implement\|review" AGENTS.md` |

#### Pillar 3 — Automatic verification

| Item | What to check | How |
|---|---|---|
| Lint | Linter configured + `lint` script | Match `eslint.config.*`, `.eslintrc.*`, `.flake8`, `ruff.toml`, `clippy.toml`, etc. |
| Typecheck | Typechecker available (only if typed lang) | `tsc --noEmit` script, `mypy`, `pyright`, `cargo check` |
| Tests | Test runner installed + `test` script | Detect Vitest/Jest/Playwright/pytest/cargo test/go test/rspec |
| Test quality (anti-false-convergence) | Tests contain real assertions — they would FAIL if the code broke. Trivial always-green tests satisfy the letter of "tests pass" while lying to the loop | open 1–2 test files: assertions on behavior, not `expect(true)`; flag suites with 0 assertions |
| Pre-commit hook | Hook framework installed | `test -f lefthook.yml` OR `.husky/` OR `.pre-commit-config.yaml` OR `pre-commit` in git hooks |
| CI workflow | At least one CI pipeline runs preflight on PR | `ls .github/workflows/*.yml` or equivalent |
| Self-improving loop | AGENTS.md/CLAUDE.md instructs reviewer to propose new rules | `grep -i "self.improv\|propose.*rule\|update.*agents.md" AGENTS.md CLAUDE.md 2>/dev/null` |

#### Pillar 4 — Loop design (rubrics + continuous memory)

| Item | What to check | How |
|---|---|---|
| Executable done-rubric | `harness-rubric.md` exists, or AGENTS.md defines done-criteria as `Check:` commands with thresholds | `test -f harness-rubric.md` or `grep -c "Check:" AGENTS.md` |
| Preflight machine-readable | Preflight exits non-zero on failure and prints a parseable summary (a loop can read it) | run preflight; inspect `$?` and output structure |
| Stop conditions | Agent/skill definitions include iteration limits or escalation rules ("until X OR N attempts") | `grep -riE "stop\|max.*(iter\|attempt)\|escalat" .claude/agents/ .claude/skills/ 2>/dev/null` |
| Memory maturity M1–M5 | Grade the BEST memory artifact against the progression scale below | read 2–3 memory/ADR files and classify |
| Memory consulted before acting | AGENTS.md/CLAUDE.md instructs agents to READ memory before starting work, not only write after | `grep -iE "read.*memory\|consult" AGENTS.md CLAUDE.md` |
| Memory compaction policy | Size budget + dedup/merge rule documented (unbounded memory = bloat that degrades recall) | `du -sh` memory dir + `grep -iE "compact\|distill\|merge\|limit" AGENTS.md` |

**Memory maturity scale** (continual-learning progression — grade by what the notes ARE, not how many):

- **M1 Fail** — raw failure notes, guesses, duplicates ("tried X, didn't work")
- **M2 Investigate** — notes explain WHY something failed
- **M3 Verify** — facts tagged `[VERIFIED]` / `[UNVERIFIED]` with the check that proved them
- **M4 Distill** — verified facts compressed into general rules ("when X, always Y")
- **M5 Consult** — rules are actually read before acting (instruction exists + evidence of use, e.g. references in recent commits/ADRs)

### Step 3 — Output the audit report

Use exactly this format so it's machine-readable for follow-up plans:

```markdown
# Harness audit — <project name>

**Stack:** <primary>, <secondary>, <package manager>, <CI provider>
**Maturity:** <0-4> / 4 pillars complete · **Loop-readiness: L<0-3>** · Memory: M<1-5>

## Pillar 1 — Harness in code  [✓ N/M items]
- ✓ <item> — <path or evidence>
- ✗ <missing item> — <impact>
- ⚠ <partial item> — <what's incomplete>

## Pillar 2 — Multi-agent roles + verifier  [✓ N/M items]
…
## Pillar 3 — Verification  [✓ N/M items]
…
## Pillar 4 — Loop design  [✓ N/M items]
…

## Anti-patterns detected
- <e.g., AGENTS.md is 450 lines — bloated, will degrade context>
- <e.g., reviewer sees implementer's reasoning — self-critique in disguise (loses the independent-verifier advantage)>
- <e.g., memory is M1: 40 failure notes, no verified facts, no rules>

## Risks if shipped as-is
- <e.g., model lock-in, silent regressions, confidently wrong loop on a garbage rubric>
```

**Loop-readiness grades:**

- **L0** — no automatic verification: every change needs human eyes
- **L1** — manual verification: lint/tests exist but scattered, no single gate
- **L2** — single machine-checkable preflight gate: a loop can iterate against it
- **L3** — closed loop: executable rubric + independent verifier + consulted memory (Pillar 4 substantially ✓)

### Step 4 — Generate the stack-tailored plan (with stop conditions)

For every ✗ or ⚠ item, propose a concrete fix using the stack's idioms (recipe table below). The plan must be actionable — file paths, commands, dependency versions — not generic advice. **Every phase MUST carry:** (a) a done-criterion checkable by command, (b) an iteration limit, (c) an escalation rule ("if not converged after N attempts, stop and report blockers to the human"). A plan phase without a stop condition is an infinite loop of cosmetic changes waiting to happen.

| Stack | Preflight runner | Pre-commit hook | Test runner | E2E | CI |
|---|---|---|---|---|---|
| **Node + pnpm** | `tsx scripts/preflight.ts` via `pnpm preflight` | lefthook (Go binary, fast) | Vitest | Playwright | GitHub Actions |
| **Node + npm/yarn** | `tsx scripts/preflight.ts` | husky + lint-staged | Vitest / Jest | Playwright | GitHub Actions |
| **Node + bun** | `bun scripts/preflight.ts` | lefthook | bun test | Playwright | GitHub Actions |
| **Python + poetry** | `poetry run python scripts/preflight.py` | pre-commit framework | pytest | Playwright (python) | GitHub Actions |
| **Python + uv** | `uv run python scripts/preflight.py` | pre-commit | pytest | Playwright | GitHub Actions |
| **Rust + cargo** | `cargo xtask preflight` or `just preflight` | pre-commit + cargo-husky | `cargo test` | — | GitHub Actions |
| **Go** | `make preflight` or `task preflight` | lefthook | `go test ./...` | — | GitHub Actions |
| **Flutter** | `dart run tool/preflight.dart` | lefthook | `flutter test` | `flutter drive` / `patrol` | GitHub Actions |
| **Ruby on Rails** | `bin/preflight` | overcommit | RSpec / minitest | Capybara | GitHub Actions |

Preflight checks to always include: (1) AGENTS.md exists and ≤ 200 lines, (2) typecheck, (3) lint, (4) schema/config validation if runtime config exists, (5) domain-specific invariant if any. Preflight must exit non-zero on any failure — it is the loop's gate, not a log.

### Step 4b — Emit the model-by-role develop-phase workflow (ALWAYS)

**This step is mandatory for every audit**, regardless of project size or maturity. Write `.claude/workflows/develop-phase.js` at the repo root. This is the loop engine: Implementer (Sonnet) → Reviewer (Opus) → Preflight (Haiku). Without model differentiation the loop degrades to self-critique-level accuracy; with an independent reviewer it catches materially more defects before merge. *(Provenance: the often-cited ~62% → ~89% figures are directional targets — not reproduced independently here. A reproducible A/B is planned: see `benchmarks/` (TODO) and WHITEPAPER §8.1. Until then, treat the gap as qualitative, not measured.)*

**Model assignment rationale** (heuristic — role/cost fit, pending the benchmark above):

| Role | Model class | Why |
|------|-------------|-----|
| Implementer | fast/mid (e.g. Sonnet) | Speed + cost for code generation; sufficient for routine implementation |
| Reviewer | frontier (e.g. Opus) | Adversarial accuracy: an independent frontier reviewer beats self-critique (directional; numbers pending the benchmark above) |
| Preflight checks | small/fast (e.g. Haiku) | Pure command execution — no reasoning required, fastest + cheapest |
| Complex security review | extended-thinking (top tier) | Use only for high-criticality phases: injection testing, threat modeling |

> The model *classes* matter more than any specific name. Substitute the equivalent tier in whatever harness you run (Claude Code / Codex / Cursor). The point is role-differentiated capability, not a fixed lineup.

**Generic template to write** (adapt the PRD path and project-specific rules to the stack detected in Step 1):

```js
export const meta = {
  name: 'develop-phase',
  description: 'Implementer → Reviewer adversarial loop against harness-rubric.md, then a final Preflight gate.',
  phases: [
    { title: 'Implement', detail: 'Write code against the PRD + memory', model: 'sonnet' },
    { title: 'Review',    detail: 'Find reasons to reject (independent verifier > self-critique)', model: 'opus' },
    { title: 'Preflight', detail: "Run the project's preflight gate", model: 'haiku' },
  ],
}

// args: { task, phase?, maxIter? }
const task    = args?.task    ?? 'implement the active task in TASKS.md or equivalent'
const phaseN  = args?.phase   ?? null
const maxIter = args?.maxIter ?? 5

// Adapt this path to the project's PRD convention (detected in Step 1)
const prdHint = phaseN
  ? `Reference PRD: docs/prd/prd-phase-${phaseN}-*.md`
  : 'Active phase: see TASKS.md or equivalent'

log(`Task: "${task}" · max ${maxIter} iter · Implementer=Sonnet · Reviewer=Opus`)

let approved = false, lastImpl = '', lastReview = '', iteration = 0

while (!approved && iteration < maxIter) {
  iteration++
  log(`── Iteration ${iteration}/${maxIter} ──`)

  phase('Implement')
  const correctionCtx = iteration > 1
    ? `\n\n⚠ Reviewer REJECTED. Reasons:\n${lastReview}\n\nFix ONLY the [FAIL] items.`
    : ''

  lastImpl = await agent(
    `Act as the implementer defined in .claude/agents/implementer.md.
Read: memory/, ${prdHint}, harness-rubric.md, .claude/agents/implementer.md.
TASK: ${task}${correctionCtx}
When done: list created/modified files + a description of each change.`,
    { model: 'sonnet', label: `impl:iter${iteration}`, phase: 'Implement' }
  )

  phase('Review')
  lastReview = await agent(
    `Act as the adversarial reviewer defined in .claude/agents/reviewer.md.
You receive ONLY artifacts — never the implementer's reasoning.
Mandate: find reasons to REJECT. Default = FAIL until there is evidence of PASS.

Implementation received:
${lastImpl}

Read harness-rubric.md and .claude/agents/reviewer.md from the repo.
Evaluate the reviewer's mandatory criteria.
Format: [PASS|FAIL] criterion — concrete evidence
Last line (no extra text): APPROVED or REJECTED`,
    { model: 'opus', label: `review:iter${iteration}`, phase: 'Review' }
  )

  approved = lastReview.includes('APPROVED')
  log(approved ? `✓ APPROVED iter ${iteration}` : `✗ REJECTED — correcting`)
}

if (!approved) log(`⚠ Did not converge after ${maxIter} iter — escalate to the human`)

phase('Preflight')
// Adapt this command to the project's preflight (detected in Step 1)
const preflight = await agent(
  `Run the project's preflight gate and report the full output + exit code.
If it fails: identify the exact check that failed.`,
  { model: 'haiku', label: 'preflight', phase: 'Preflight' }
)

const preflightPassed = preflight.toLowerCase().includes('pass') || preflight.includes('exit:0')
log(`Preflight: ${preflightPassed ? 'PASS' : 'FAIL'}`)

return {
  task, iterations: iteration, approved, preflightPassed,
  nextStep: approved && preflightPassed
    ? 'git add -p && git commit'
    : approved ? 'Preflight failed — fix before commit'
    : `Did not converge — review remaining [FAIL] after ${maxIter} iter and report to the human`,
}
```

**Adaptations required by stack** (from Step 1 detection):

| Stack | Preflight command in the Haiku agent prompt | PRD path hint |
|-------|---------------------------------------------|---------------|
| Node + pnpm | `pnpm preflight` or `./scripts/preflight.sh` | `docs/prd/` or task-tracking file |
| Python + uv | `./scripts/preflight.sh` or `uv run python scripts/preflight.py` | same |
| Go | `make preflight` | same |
| Any | Detect from `package.json` / `Makefile` / `justfile` / `scripts/` | same |

If the project has no PRD folder yet, use `TASKS.md` or the equivalent task-tracking file as `prdHint`. If it has no `harness-rubric.md` yet, the reviewer is instructed to check against AGENTS.md criteria directly.

**Dispatch criterion — when to launch develop-phase vs. a normal session.** Include this in the audit report and in the project's CLAUDE.md so any session applies it without explicit instruction:

```
Launch develop-phase if ANY of these triggers is true:
  A. The task creates ≥1 new file (new page, component, data entry, script)
  B. It touches a critical zone: workers/server entry points, routed pages,
     shared components, AGENTS.md, CLAUDE.md, build/config files, or the
     stack's equivalent
  C. It modifies ≥3 files outside of i18n/ (cross-cutting change)

Normal session if ALL of these are true:
  • Only editing existing files (no new files created)
  • Does not touch critical zones of the stack
  • It is a point bug fix, copy tweak, or pure i18n change

The model evaluates the task at the start of the session and proposes:
  "This task triggers [A/B/C] — shall I launch develop-phase with {task: '...'}?"
  The user approves or overrides to continue in a normal session.
```

### Step 4c — Audit skills/workflows bloat + curated recommendations (NEVER auto-install or auto-remove)

Two parts, in order: **(i) audit what exists and flag saturation** → **(ii) recommend removals and additions**. Never install or remove anything automatically. The "minimal harness" lesson is the north star — anecdotally the Vercel D0 case (−80% tools → 3× faster, an informal talk reference), and corroborated reproducibly by the `ponytail` skill's published benchmark (80–94% less code, 3–6× faster across Haiku/Sonnet/Opus; reproduce with `npx promptfoo eval`). An audit that only adds and never recommends removal is incomplete.

**Part i — audit existing skills and workflows for bloat.** Inventory the global skills folder (affects all projects), the project skills folder, and the project workflows folder. Flag if a scope exceeds its threshold:

| Scope | Threshold | Signal |
|-------|-----------|--------|
| Global skills total | > 15 | High risk of context saturation across all sessions |
| Project skills | > 5 | Agent focus degrades; likely redundancy with AGENTS.md |
| Project workflows | > 3 | Multiple workflows doing overlapping orchestration |

Classify each skill/workflow as **KEEP** (used in this repo, not covered by AGENTS.md), **REVIEW** (overlaps with another skill or with AGENTS.md), or **REMOVE** (domain not present in this repo, no role separation, no stop conditions, no `Check:` criteria, or duplicates `develop-phase.js`).

Global skills: never recommend `rm`. Recommend per-project deactivation via a convention — list skill names in `.claude/skills-ignore` and add a line to `CLAUDE.md` instructing the model not to invoke them here. The model reads CLAUDE.md at session start and honors the list (soft, not a hard block). Project skills and workflows are local files — recommend their removal with a reason, but let the human run the delete.

**Part i output (include in the audit report):**

```markdown
## Skills/workflows — saturation audit

**Global skills**: N (threshold: 15)
**Project skills**: N (threshold: 5)
**Project workflows**: N (threshold: 3)

| Artifact | Scope | Classification | Reason |
|----------|-------|----------------|--------|
| `skill-name` | global | KEEP / REVIEW / REMOVE | concrete reason |
| `workflow-name.js` | project | KEEP / REVIEW / REMOVE | concrete reason |

> ⚠ The audit deletes nothing. The human decides.
> Deactivate a global skill for this project: add it to `.claude/skills-ignore`.
> Remove a project skill: `rm -rf .claude/skills/<name>/`.
> Remove a workflow: `rm .claude/workflows/<name>.js`.
```

**Part ii — recommend additions (after accounting for removals).** Produce a curated short-list of 3–5 skills that would make the Implementer and Reviewer more effective for the detected stack. Recommendation only — the human installs. Total skills after removals + additions must stay ≤ 15 global / ≤ 5 project. Score by: stack match, role utility (does the Implementer use it when writing / the Reviewer to catch domain errors?), minimal-harness fit, not-already-covered by AGENTS.md, and remaining budget. If at threshold with nothing to remove, recommend 0 additions and say so explicitly. Never recommend skills for a domain absent from the repo, or business/content skills in a purely technical project.

### Step 5 — Emit the executable rubric (`harness-rubric.md`)

Convert every audited item into a rubric entry following [rubric-template.md](rubric-template.md): ID, criterion, `Check:` command, threshold, current state (PASS/FAIL + measured value). Write it at the repo root (ask before writing; if running read-only, output its content in the reply). Then close with the loop invocation:

> To converge: iterate until every check in `harness-rubric.md` passes **OR** 10 iterations. After each change, re-run only the affected checks; every 3 iterations, re-run the full rubric. If FAILs remain after 10 iterations, report the blockers to the human.

This is the core idea: the audit is a photo of a static report; the rubric is a **convergence target** a loop runs against.

### Step 6 — Adversarial verification of this audit

Before delivering, spawn a fresh-context subagent (read-only) following [verifier-protocol.md](verifier-protocol.md): it receives ONLY the rubric + repo path — never this audit's reasoning — re-runs the `Check:` commands of 3–5 sampled items (always include any item graded ✓ without a pasted command output), and tries to REFUTE the verdicts. For at least one PASS item, it also runs the **negative-control self-test** from verifier-protocol.md (does the check FAIL on an input it should reject? a check that can't say no is a broken thermometer → verdict INVALID). Fix every discrepancy before the final report and note `verified: N/M sampled checks confirmed` in the summary. Cheap insurance: these are `test -f` / `wc -l` commands, not deep analysis.

## Rules

- **Never inflate.** If the project is tiny (one-file script, weekend hack), say so and recommend a minimal AGENTS.md only. The minimal-harness lesson: less harness, more focus (anecdotal Vercel D0 −80% tools → 3× faster; reproducibly corroborated by ponytail's benchmark).
- **Never delete files** during an audit — read-only except `harness-rubric.md` (and ask before writing it).
- **If AGENTS.md exceeds 200 lines**, the FIRST recommendation is to trim — a bloated harness degrades the model.
- **If the project has neither tests nor lint**, push back: "verification is pillar 3, not optional. What was the project's release process before?"
- **If CLAUDE.md exists but no AGENTS.md**, the lock-in risk is the headline finding.
- **If the rubric can't say no, it isn't a rubric.** Any criterion not checkable by command gets rewritten or dropped — subjective items ("code should be clean") are banned from `harness-rubric.md`.
- **For multi-harness portability**, AGENTS.md is the canonical file. Harness-specific deltas (CLAUDE.md, .cursorrules) are secondary.
- **After every audit, distill (M4) into memory:** a new stack not covered by the recipes, a check that produced a false positive/negative, a new anti-pattern observed. One verified rule per audit beats ten raw notes — the skill itself must climb Fail→Consult between runs.

## Output sequence

Always end with a one-line summary the user can act on:

> Harness maturity: N/4 · Loop-readiness: LX · Memory: MX · verified: N/M checks. Next-best move: <single concrete action>. Executable rubric: `harness-rubric.md`.
