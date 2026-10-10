# harness-audit: Engineering Convergence Loops for AI Agent Systems

**Type**: Technical reference document
**Author**: Andrés Ramírez · andrami (https://andrami.pro)
**Skill**: `harness-audit`

---

## Abstract

`harness-audit` is a system for auditing and installing an agent harness in AI-agent repositories. Unlike traditional static-audit approaches, it produces an **executable rubric** — a set of command-verifiable criteria — that serves as the convergence target for an autonomous implement-and-verify loop. The system operates over four structural pillars (harness in code, role separation, automatic verification, loop design) and integrates **role-differentiated model selection**, progressive memory M1→M5, and independent adversarial verification. The working hypothesis is that separating the implementer from the verifier materially raises code-review accuracy and lowers false positives. The specific figures cited below (~62% → ~89% accuracy; ~28% → ~7% false positives) are **directional, illustrative targets — not yet independently reproduced in this project**, and do not come from a published Anthropic benchmark. A reproducible in-house A/B is planned (see §8.1 Reproducibility / `benchmarks/`, pending). Until then, read them as expected direction, not measurement.

---

## 1. The Problem: Why Traditional Harnesses Fail

### 1.1 The Category Error

Most teams working with AI agents treat the harness as a documentation artifact: a more detailed `README.md`, a set of instructions for the model. This view is fundamentally wrong.

An agent harness is not documentation. It is the **specification of the feedback environment** the agent operates in. The difference is analogous to describing the rules of chess versus building a position-evaluation engine.

A harness-as-documentation produces:
- Instructions the model interprets subjectively
- Vague "done" criteria ("clean code", "well tested")
- Reviews that are self-critique in disguise (the same model that implements evaluates its own output)
- No stop conditions → infinite loops of cosmetic changes

A harness-as-feedback-environment produces:
- Command-verifiable criteria: `test -f AGENTS.md && wc -l < AGENTS.md` → a number
- "Done" = every check in `harness-rubric.md` in PASS state
- An independent verifier that receives only artifacts, never reasoning
- Explicit stop conditions: "after 10 iterations without convergence → escalate to the human"

### 1.2 The Self-Critique Bias

Language models exhibit three systematic biases when evaluating their own output:

**Confirmation bias**: the model looks for reasons its implementation is correct, rather than reasons it might be wrong.

**Blind spots**: implicit assumptions made during generation (e.g., "this endpoint doesn't need auth because…") silently carry over into the evaluation phase.

**Context anchoring**: the evaluation is anchored to the generation reasoning — the model cannot see the diff with fresh eyes because it already knows why it made each decision.

The expected result (figures are **illustrative, pending reproduction** — see the provenance note in the Abstract; not a published measurement):

| Review method | Accuracy (target) | False positives (target) |
|---------------|----------|-----------------|
| Self-critique (same model) | ~62% | ~28% |
| Independent verifier subagent | **~89%** | **~7%** |

If the order of magnitude holds, a ~28% false-positive rate would mean nearly 1 in 3 "code is correct" approvals is wrong — a silent regression roughly every three merges. The direction (an independent verifier lowers false positives) is well supported in the LLM self-correction literature; the exact magnitude is what this project still has to measure (see §8.1 Reproducibility — contributions welcome).

### 1.3 The Rubric Paradox

> *"A well-designed rubric is doing more work than the model. Garbage rubric + great model = a confidently wrong loop. Rubric design is the skill now; the model is the easy part."*

The quality of the convergence loop is bounded by the quality of the rubric. A top-tier model with a vague rubric converges toward incorrect outputs with high confidence. A modest model with an honest, verifiable rubric converges toward correct outputs — more slowly, but reliably.

`harness-audit` was designed specifically to resolve this paradox: its primary output is not a report, it is a rubric — and the quality of that rubric is the artifact of value.

---

## 2. Theoretical Foundations

### 2.1 Loop Design as a Paradigm

The **Loop Design** paradigm replaces the prompt-engineering approach for high-capability models. The transition is:

```
Prompt Engineering:
  Human → detailed prompt → model → output → human evaluates → repeat

Loop Design:
  Human designs: [goal + rubric + verifier + memory]
      ↓
  Model runs autonomously
      ↓
  Environment provides feedback (tests, commands, metrics)
      ↓
  Model self-corrects
      ↓
  Repeat until rubric converges OR stop condition
```

The fundamental difference: in Prompt Engineering, the human is in the **inner loop**. In Loop Design, the human is in the **outer loop** — intervening only when the system fails to converge after N attempts.

### 2.2 Progressive Memory (Fail → Consult)

A continual-learning view of agent memory defines five maturity levels:

| Level | State | Description |
|-------|-------|-------------|
| **M1** | Fail | Raw error notes with no analysis |
| **M2** | Investigate | Notes explain the WHY of the failure |
| **M3** | Verify | Facts tagged `[VERIFIED]` with the check that proves them |
| **M4** | Distill | Verified facts compressed into general rules |
| **M5** | Consult | Rules read systematically before acting |

The hypothesis is that progressive memory shows up as a steepening success curve across sessions: a system without it tends to stay flat, while a system that reaches M5 (consulting distilled rules before acting) climbs. Any specific numbers here would be illustrative — quantifying this curve in this harness is pending work (see §8.1). The claimed differentiator is not raw model capability but whether earlier verified lessons are read before the next decision.

`harness-audit` installs the memory system at M4 (Distill) from day one, with explicit instructions for agents to read it before acting (the necessary condition for M5).

The scale grades what the notes *are*; it says nothing about where they live, and an audit that cannot point at a directory is grading a vibe. Two artifacts give M2 and M4 a shape on disk. A **decision lifecycle** — `proposed/`, `implemented/`, `rejected/` as folders, so a note's status is its path — with a mandatory *Alternatives considered* section in every implemented note: a decision recorded without what it beat invites re-litigation, which is the failure a decision record exists to prevent. And **postmortems** kept apart from decisions, each with a section on why every safety net missed the bug and which guardrail was added so the class fails loudly next time — a postmortem that records only the fix is M1 wearing a template. The audit checks both by command (Pillar 4) and flags them aspirational where the directories do not exist: it never fabricates an incident to fill a row.

### 2.3 Compounding Gains vs. Isolated Gains

A useful distinction from optimization-benchmark work:

- **Scalar changes** (tuning one parameter, fixing one isolated bug) produce isolated gains that plateau quickly.
- **Structural changes** (loop architecture, role separation, rubric design) produce compounding gains.

Combining several structural changes produces a compounded improvement that a single hyperparameter tweak cannot match.

The direct application: the harness installs the **structural loop**. Each reviewer iteration can reject for structural reasons (import confinement, missing approval gate, `dangerouslySetInnerHTML`) that the implementer would not have caught alone. Those gains compound session over session.

---

## 3. Architecture: The Four Pillars

### Pillar 1 — Harness in Code

The harness exists as versionable artifacts in the repository, not as configuration in the user's IDE.

| Artifact | Purpose | Constraint |
|----------|---------|------------|
| `AGENTS.md` | Portable entry point (Claude Code, Codex, Cursor, Kilo) | ≤ 200 lines |
| `CLAUDE.md` | Harness-specific delta for Claude Code | ~40–60 lines, points to AGENTS.md |
| `harness-rubric.md` | Executable rubric — convergence target | Every criterion: `Check:` by command |
| `TASKS.md` | Task state + done-criterion per phase | — |
| `memory/` | Progressive memory M4+ | Index + per-topic files |
| `scripts/preflight.sh` | Single verifiable gate — exit 0/1 | Non-zero on any failure |

**Portability principle**: `AGENTS.md` is the canonical file. Any agent — regardless of harness (Claude Code, Codex, Cursor) — can find its instructions there. Harness-specific files are secondary.

### Pillar 2 — Role Separation and Verifier Independence

The system operates with strictly separated roles:

```
Orchestrator (main session)
    │
    ├── Implementer (.claude/agents/implementer.md)
    │       Receives: spec + PRD + context
    │       Returns: diff / code
    │       Model: fast/mid tier
    │
    └── Reviewer (.claude/agents/reviewer.md)
            Receives: ONLY diff + rubric (never the implementer's reasoning)
            Returns: PASS/FAIL per criterion + APPROVED/REJECTED
            Model: frontier tier
```

**The independence rule is the most critical**: the reviewer receives artifacts, not conversation. If the reviewer knows the implementer's reasoning, it reproduces the same anchoring context that drives false positives in self-critique.

**Self-improving**: when the reviewer detects a pattern not covered by existing criteria, it proposes a new rule to the orchestrator. The orchestrator adds it to `AGENTS.md` and marks it `[VERIFIED]` in `memory/`. The harness improves itself session over session.

### Pillar 3 — Automatic Verification

All verification runs through commands that exit non-zero on failure:

```bash
# Preflight gate — the loop does not advance if it fails
./scripts/preflight.sh   # exit 0 = green · exit 1 = blocked
```

Mandatory checks:
1. `AGENTS.md` ≤ 200 lines
2. Typecheck (`mypy --strict` / `tsc --noEmit`)
3. Lint (ruff / eslint)
4. Tests (pytest / vitest) with real assertions
5. Pre-commit hook installed (lefthook)
6. CI workflow exists

**Anti-pattern detected and blocked**: tests without real assertions. A test suite with 0 assertions satisfies the letter of "tests pass" while lying to the loop — preflight validates not only that the tests run, but that they contain verifiable assertions.

### Pillar 4 — Loop Design: Rubrics + Continuous Memory

This is the pillar that distinguishes `harness-audit` from a static audit:

**Executable rubric**: every criterion has a reproducible `Check:` with a threshold and a current state.

```markdown
| R-02 | AGENTS.md ≤ 200 lines | `wc -l < AGENTS.md` | ≤ 200 | PASS (119) |
| R-14 | Backend: ruff configured | `grep -q "ruff" pyproject.toml && echo PASS` | PASS | FAIL |
```

**Convergence instruction** (included in every generated rubric):
> Iterate until every check is PASS **OR** 10 iterations. After each change, re-run the affected checks. Every 3 iterations, re-run the full rubric. If FAILs remain after 10 iterations → report the blockers to the human.

**Explicit stop conditions**: no plan phase exists without a stop condition. "Keep improving until it's good" is a forbidden anti-pattern.

---

## 4. The Role-Differentiated Model-Selection Workflow

### 4.1 Justification by Role and Cost

The model assignment is a role/cost-fit heuristic (pending validation by the A/B in §8.1), not an arbitrary preference:

| Role | Model class | Justification |
|------|-------------|---------------|
| **Orchestrator** | Mythos tier (e.g. Fable 5) | Designs the loop, owns the rubric, manages memory across sessions |
| **Implementer** | workhorse frontier tier (e.g. Opus 4.8) | Strong code generation at sustainable cost for the bulk of the work |
| **Reviewer** | Mythos tier (e.g. Fable 5) | Higher adversarial accuracy than self-critique (~89% vs ~62%: illustrative target, pending measurement) — and deliberately a *different family* than the implementer: cross-family review reduces shared blind spots. The premium cost is amortized by every FAIL caught before merge |
| **Preflight checks** | mid/fast tier (e.g. Sonnet 5) | Command execution + result parsing; low cost per iteration |
| **Security review (critical phase)** | Mythos tier, extended thinking | Extended reasoning for threat-model and prompt-injection analysis |

The reviewer at premium tier costs more per iteration, but every FAIL it catches avoids a regression that would cost N times more to debug later. The ROI is positive by design. Model *classes* matter more than specific names — the lineup in parentheses is current as of mid-2026 and will rotate; substitute the equivalent tier in whatever harness you run.

### 4.2 The Convergence Loop

The workflow script (`.claude/workflows/develop-phase.js`) implements:

```
args: { task, phase?, maxIter? }

LOOP (until maxIter=5 or approved=true):
│
├── IMPLEMENT [workhorse tier, e.g. Opus]
│   Reads: memory/ → phase PRD → harness-rubric.md → implementer.md
│   Executes the task + lists modified files
│
├── REVIEW [Mythos tier, e.g. Fable — different family, on purpose]
│   Receives: ONLY the implementer's report (artifact)
│   Reads: harness-rubric.md + reviewer.md
│   Emits: [PASS|FAIL] per criterion → APPROVED | REJECTED
│
└── If REJECTED → correctionCtx = reviewer's reasons → back to IMPLEMENT
    If APPROVED → exit the loop

PREFLIGHT [mid/fast tier, e.g. Sonnet]
│   Runs ./scripts/preflight.sh
│   Reports exit code + failed check (if any)

RETURN: { task, iterations, approved, preflightPassed, nextStep }
```

### 4.3 The Independence Property in the Loop

The `correctionCtx` the implementer receives on iterations > 1 contains **the reviewer's reasons for rejection**, not the reviewer's full output. This distinction is critical:

- **Yes**: "Criterion [2] FAIL — `import internal_agent` detected in `app/routers/auth.py` line 14"
- **No**: the reviewer's full reasoning, including its evaluation process

If the implementer received the full reasoning, it could optimize to satisfy the reviewer rather than satisfy the criteria — a Goodhart's-Law game that would degrade the loop's quality.

---

## 5. The Audit Process

### 5.1 Step Sequence

The skill runs 6 steps in sequence:

**Step 1 — Stack detection**: reads configuration files (`package.json`, `pyproject.toml`, `Cargo.toml`, etc.) to identify language, package manager, test runner, CI provider. This detection determines the concrete recipes in the plan (exact commands, real paths, recommended versions).

**Step 2 — Four-pillar audit**: 28+ command-checked criteria. Each criterion produces a ✓/✗/⚠ verdict with evidence.

**Step 3 — Audit report**: machine-readable format with a maturity score (0/4 pillars), loop-readiness grade (L0–L3), and memory grade (M1–M5).

**Step 4 — Stack-tailored plan with stop conditions**: for each ✗ or ⚠, a concrete action with (a) a checkable done-criterion, (b) an iteration limit, (c) an escalation rule.

**Step 4b — Model-by-role workflow script**: generates `.claude/workflows/develop-phase.js` adapted to the detected stack. Always. Simplified on small projects; completed with extra safety criteria on complex ones.

**Step 5 — Executable harness-rubric.md**: converts each audited item into a rubric entry with a `Check:` command, threshold, and current state.

**Step 6 — Adversarial verification**: a fresh-context subagent re-runs 3–5 selected checks and tries to refute the verdicts. No finding marked ✓ escapes without evidence from an executed command. The target is 0% discrepancies.

### 5.2 Loop-Readiness Grades

| Grade | Description | Implication |
|-------|-------------|-------------|
| **L0** | No automatic verification | Every change needs human eyes |
| **L1** | Lint/tests exist but scattered, no single gate | The loop has criteria but no convergence |
| **L2** | Single machine-checkable preflight gate | A loop can iterate against it autonomously |
| **L3** | Executable rubric + independent verifier + consulted memory | Closed loop — the human is in the outer loop |

A greenfield project reaches L2 once Phase 1 completes (preflight green) and L3 as soon as the reviewer processes its first diff and memory records its first `[VERIFIED]`.

### 5.3 From Theory to Executable Loops

Pillar 4 defines a shape — goal, rubric, independent verifier, memory that outlives the run — not a
single instance of it. The package ships six loops because there are six recurring subjects that shape
applies to, not six different theories:

| # | Loop | Subject | Rubric | Verifier | Memory artifact |
|---|------|---------|--------|----------|------------------|
| 1 | Stateless | a commit | smoke tests + `wip-green` | the test suite itself (mutation-verified) | none by design — the point of "stateless" |
| 2 | Learning | a skill | a fixed eval task, judged blind | a judge on a different model family than the arms | `LEARNINGS.md` inside the skill |
| 3 | Multi-agent review | a draft / diff | the critic panel's checklist | four orthogonal critics, none of which authored the artifact | a findings JSON per round |
| 4 | Verification | an app / corpus | `harness-rubric.md`, score /100 | critics + scorer, `develop-phase` per feature | a findings JSON with score + blocker trend |
| 5 | Workflow improvement | the process itself | the process's own predictions | the *next* round, which settles the previous round's prediction | `process.md` (spec) + `process-log.md` (predictions) |
| 6 | Operator | the human driving | recurrence in the operator's own transcripts, counted locally | the human, who promotes or rejects each card — the loop only proposes | a `session-review` report per run in `loop-runs/`, read back by `/dashboard-harness`, which reports each card as promoted, pending or n/a |

Read against §5.2, the loop-readiness grades are not a separate scale — they are what these loops build,
in order:

- **L0 → L1**: nothing here yet — lint/tests exist but nothing consumes their exit code as a gate.
- **L1 → L2**: Loop 1 *is* the L2 gate. A single preflight command that exits non-zero on failure is the
  minimum a loop can iterate against; every other loop in this package assumes it already passed.
- **L2 → L3**: Loop 4 is L3 made concrete — an executable rubric, a verifier independent of the
  implementer, and a memory artifact (the findings JSON, and for the per-feature `develop-phase` variant,
  the rubric itself) that the next round reads before acting. A project with Loop 1 wired and Loop 4
  available on demand has closed the loop Pillar 4 describes.
- **Loop 2 is M1→M5 applied to a skill**, not a new mechanism: the blind A/B is the "fix that worked" the
  Pillar-4 success-correlation shortcut asks for, and `LEARNINGS.md` is where it lands verified instead of
  guessed.
- **Loop 3 is Pillar 2 generalized past code review**: the same role-separation argument (an independent
  reviewer reduces shared blind spots) applied to any artifact a diff touches — copy, a multilingual pair,
  a regulated claim — not only source files.
- **Loop 5 is the recursive case**: it points the whole apparatus — rubric, verifier, memory — at the
  *process* that runs the other four loops, one level up the stack. Its rubric is a prediction instead of
  a score threshold, and its verifier is time: the next round is what confirms or falsifies what the last
  one predicted.
- **Loop 6 has one precondition, and it is the harness's, not the loop's**: *model-visible ⟺ logged*.
  Everything that reached a model request must be reconstructable from the session log, or
  `/session-review` audits a transcript that is not what the model saw. This is why the repeat-tool guard
  rides `additionalContext` — a channel the harness records — rather than rewriting a tool result in
  place: a harness that injects unlogged context makes every transcript-reading loop lie by omission.

None of this is aspirational — every loop in the table above has at least one recorded run backing the row
it occupies in the README's catalog; see that catalog for what "recorded" means and which run backs which
loop.

---

## 6. System Properties

### 6.1 Multi-Harness Portability

`AGENTS.md` is readable by any agent capable of reading markdown:
- Claude Code (primary)
- OpenAI Codex / GPT with tools
- Cursor (.cursorrules can point to AGENTS.md)
- Antigravity / Kilo Code
- Any agent with filesystem access

Portability is not a future goal — it is a present design constraint. If `AGENTS.md` only works with one harness, the project has **model lock-in**.

### 6.2 Re-Audit Idempotence

Running the audit on an already-audited project produces a **delta audit**:
- What already meets the criteria → ✓ (untouched)
- What is missing → ✗ with an action plan
- `harness-rubric.md` → updated with current PASS/FAIL states
- `.claude/workflows/develop-phase.js` → generated if absent; not overwritten if present

The skill never destroys existing work. It reads first, proposes second, writes only what is missing.

### 6.3 Self-Improving by Design

The self-improvement mechanism is documented in `AGENTS.md` of every audited project:

```
If the reviewer detects an uncovered pattern → it proposes NEW_CRITERION to the orchestrator
The orchestrator evaluates it → if valid, adds it to AGENTS.md as [VERIFIED]
```

This implements the M5 (Consult) step of progressive memory: rules distilled from earlier sessions are consulted systematically before acting in future ones. The harness learns from every project it is installed in.

---

## 7. Comparison with Alternative Approaches

| Dimension | Manual audit | Static audit | **harness-audit** |
|-----------|--------------|--------------|-------------------|
| Primary output | Prose report | Report + checklist | **Executable rubric** |
| Verification | Subjective | Manual with commands | **Adversarial, independent subagent** |
| Convergence | N/A | Manual loop | **Automatic loop with stop conditions** |
| Model selection | Single (session) | Single | **Role-differentiated** |
| Memory | N/A | N/A | **Progressive M1→M5** |
| Portability | Author's harness only | Harness-specific | **Multi-harness (AGENTS.md canonical)** |
| Re-audit | From scratch | From scratch | **Delta audit — no overwrite** |
| Loop-readiness | L0 | L1 | **L2–L3** |

---

## 8. Limitations and Failure Conditions

**Rubric garbage-in, garbage-out**: if the team defines vague criteria ("the code should be clean") in its `AGENTS.md`, the skill incorporates them into the rubric. A subjective criterion cannot be command-checked, so the skill marks it ⚠ — but it cannot force the team to make it concrete.

**The reviewer can also be wrong**: the audit's adversarial verification and the loop's reviewer mitigate this, but do not eliminate it. A reviewer with poorly defined criteria can reject correct work or approve incorrect work. The self-improving mechanism exists to capture these cases session over session.

**Model cost in long loops**: a 5-iteration loop with a frontier-tier reviewer has non-trivial cost. For budget-constrained projects, `maxIter` can drop to 3 and the reviewer can use a mid tier — with the expected loss of adversarial accuracy (the magnitude of the gap is pending measurement; see §8.1).

**Dependence on an honest preflight**: if `scripts/preflight.sh` has checks that always pass (e.g., a hardcoded `exit 0`), the gate is not a gate. The audit verifies that preflight exits non-zero on failure, but cannot audit the integrity of a script designed to deceive. The adversarial verifier (Step 6) mitigates this with a **negative-control self-test**: it confirms each sampled check FAILS on an input it should reject; a check that also passes its negative control is marked INVALID (see `verifier-protocol.md`).

### 8.1 Reproducibility (scaffold built; K≥30 run pending)

The review-accuracy figures (~62% self-critique → ~89% independent verifier; ~28% → ~7% false positives) and the M5 memory-curve numbers in this document are **directional, illustrative targets — not measurements taken in this project**. The direction is supported by the LLM self-correction literature; the exact magnitude in this harness is unmeasured.

The scaffold that will measure them now lives in [`benchmarks/`](benchmarks/). Design discipline inspired by [headroom](https://github.com/headroomlabs-ai/headroom) (TOST-gated evals; no fabricated statistics), alongside `ponytail`'s. Status: **built and runnable, not yet run at N≥30** — the figures above remain unmeasured because the run hasn't happened, not because the instrument is missing.

1. **Verifier vs self-critique A/B** — [`benchmarks/verifier_ab.js`](benchmarks/verifier_ab.js) over [`benchmarks/corpus/`](benchmarks/corpus/) (8 labeled diffs, a mix of correct/incorrect, bugs drawn from the harness's own vocabulary). Arm A: the agent reviews a diff it is told it authored, **anchored with the author's rationale** (reproduces the §1.2 bias). Arm B: a fresh-context verifier that receives **only** diff + rubric, adversarial mandate. Reports the **full confusion matrix** (precision, recall/bug-detection, false-alarm rate, miss rate) — which disambiguates the single "false positives" number above, which today conflates a false alarm (rejecting good code) with a miss (approving a bug). A negative control ([`benchmarks/negative-control.md`](benchmarks/negative-control.md)) validates the instruments before scoring — the same self-test Step 6 requires. Run: `Workflow({ scriptPath: 'benchmarks/verifier_ab.js', args: { kRuns: 30 } })`.
2. **Memory M-level curve** — task success across a series of sessions, with and without memory consulted before acting. *(Pending; a success-correlation technique — see Pillar 4 in SKILL.md — is the likely path to automate populating that memory.)*
3. **Publish the reproduction command** and raw numbers — the command and a frozen contract ([`benchmarks/README.md`](benchmarks/README.md) + [`benchmarks/MANIFEST.md`](benchmarks/MANIFEST.md)) are already published; what's still missing is the **raw numbers from a real run**, in the style of the `ponytail` skill's benchmark (`npx promptfoo eval`, reproducible by anyone) — the honesty bar to clear.

Honest limitation of the scaffold: `agent()` does not expose `temperature`/seed, so runs are reproducible in distribution (at large K) but not bit-for-bit; a fully pinned version would need a runner against the API directly, which this scaffold does not yet have. Until a K≥30 run exists with its raw numbers, the numeric claims should be read as design hypotheses, not evidence.

---

## 9. Case Study: Greenfield Project (0/4 → L2)

A representative greenfield project — a FastAPI + embedded-agent backend with a Vite + React frontend — started as a single `PLAN.md` file (~240 lines), no git, no structure.

**Initial score**: 0/4 pillars · L0 · M1

**Post-audit result** (one session, ~2 hours):

| Artifact created | Contents |
|------------------|----------|
| `AGENTS.md` | 86 lines — portable harness |
| `CLAUDE.md` | Claude Code delta |
| `harness-rubric.md` | 27 executable checks, 11 in PASS from the start |
| `TASKS.md` | 6 phases with a done-criterion each |
| `scripts/preflight.sh` | Single gate, green on greenfield |
| `lefthook.yml` | Pre-commit + pre-push |
| `.github/workflows/ci.yml` | CI backend + frontend on PR |
| `.claude/agents/reviewer.md` | 10 adversarial criteria |
| `.claude/agents/implementer.md` | Hard import-confinement rules |
| `.claude/workflows/develop-phase.js` | Loop with Implementer→Reviewer→Preflight |
| `docs/prd/` × 6 | Full per-phase PRDs with technical specs |
| `docs/adr/001-*.md` | Verified architectural decision |
| `memory/project-context.md` | 5 decisions at M4 (Distill) |

**Final score**: 2/4 pillars → **L1–L2** (rises to L3 once Phase 1 delivers green backend+frontend preflight)

**Adversarial verification**: fresh-context subagent ran 10/10 checks. Discrepancies: 0.

---

## 10. Usage Instructions

### Basic invocation

```
audit my harness
```

The skill detects the stack automatically and runs the 6 steps.

### Re-auditing an existing project

Same. The skill produces a delta — it reports only what is missing and updates the rubric with the current state.

### Invoking the development workflow

A dispatch criterion determines when to launch `develop-phase` vs. continue in a normal session. Document it in the project's `CLAUDE.md` so any session applies it without explicit instruction:

**Launch develop-phase if ANY is true:**
- **A. New feature**: the task creates ≥1 new file (page, component, data entry, script)
- **B. Critical zone**: touches server/worker entry points, routed pages, shared components, `AGENTS.md`, build/config files, or the stack's equivalent
- **C. Cross-cutting**: modifies ≥3 files outside of `i18n/`

**Normal session if ALL are true:**
- Only editing existing files (no new files)
- Does not touch critical zones
- A point bug fix, copy tweak, or pure i18n change

The model evaluates the task at the start and proposes: *"This task triggers A — shall I launch develop-phase?"* The user approves or overrides.

Once decided to launch:

```
Launch the workflow .claude/workflows/develop-phase.js with:
{ task: "concrete task description", phase: N }
```

The Implementer → Reviewer → Preflight loop runs autonomously. Max 5 iterations by default (`maxIter` adjustable).

### Reading loop state

```bash
grep "PASS\|FAIL" harness-rubric.md   # current convergence state
./scripts/preflight.sh                 # verification gate
```

---

## 11. Conclusion

`harness-audit` applies the Loop Design paradigm to harness engineering for AI agents. Its contribution is not the audit report — it is the executable rubric that turns the harness from a static document into a convergence target for an autonomous loop.

Three invariants:

1. **The rubric is the artifact of value.** A report a human reads and executes is L0. A rubric a loop converges is L3.

2. **The verifier never knows the implementer's reasoning.** Reviewer independence is the necessary condition for the accuracy jump (its magnitude, ~62%→~89%, is the target still to be reproduced).

3. **The model is interchangeable; the harness is not.** The day a model is replaced by its successor, the loop keeps working. The harness is the intellectual property; the model is the engine that runs it.

> *"The model is the horse; the harness is the saddle."*
