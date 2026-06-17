# harness-audit

A Claude Code skill that audits a project's **agent harness** against four pillars — harness-in-code, multi-agent role separation, automatic verification, and loop design — and produces an **executable rubric** (`harness-rubric.md`) plus a stack-tailored remediation plan with stop conditions. The audit is not a static report a human reads and executes; it is a convergence target an autonomous implement-and-verify loop runs against. Its core principle: *the model is the horse, the harness is the saddle* — models change every few months, the harness stays.

## Install

Drop the folder into a skills directory wherever Agent Skills are supported:

- **Per project**: copy it to `.claude/skills/harness-audit/` in the repo you want to audit.
- **Global (all projects)**: copy it to `~/.claude/skills/harness-audit/`.

```bash
git clone https://github.com/<your-org>/harness-audit.git ~/.claude/skills/harness-audit
```

That's it — the skill is self-contained. `SKILL.md` carries the methodology; `WHITEPAPER.md`, `rubric-template.md`, and `verifier-protocol.md` are bundled references the skill points to.

## Usage

Just ask in natural language. The skill triggers on phrases such as:

- "audit my harness" · "audita el harness"
- "AGENTS.md" · "preflight" · "reviewer subagent"
- "harness engineering" · "self-improving loop" · "loop design"
- "rubric" · "independent verifier" · "loop-readiness"
- "make this repo portable across Claude Code / Codex / Cursor"

It detects the stack automatically, audits the four pillars, grades loop-readiness (L0–L3) and memory maturity (M1–M5), writes an executable rubric, and runs an adversarial fresh-context verification of its own findings before delivering.

## The four pillars

1. **Harness in code** — `AGENTS.md` (≤ 200 lines) as the portable entry point, a single preflight gate, a memory convention, all versioned in the repo rather than in IDE config.
2. **Multi-agent role separation** — orchestrator / implementer / reviewer, where the reviewer receives only artifacts (diff + rubric), never the implementer's reasoning. Independence is what lifts review accuracy (an independent verifier beats self-critique; the often-cited ~62%→~89% figures are directional targets, pending an in-house benchmark — see WHITEPAPER §8.1).
3. **Automatic verification** — lint, typecheck, tests with real assertions, a non-zero-on-failure preflight gate, pre-commit hooks, and CI. Verification a loop can read.
4. **Loop design** — an executable rubric every criterion of which is checkable by command, explicit stop conditions, and a memory that matures Fail → Investigate → Verify → Distill → Consult.

A minimal harness beats an inflated one: trimming tooling tends to make agents faster, not weaker.

## Learn more

Background article explaining the methodology:

- ES — https://andrami.pro/blog/auditoria-de-arnes-ia
- FR — https://andrami.pro/fr/blog/audit-harnais-ia

## Contributing

Issues and PRs welcome — new stack recipes, sharper rubric checks, and additional anti-patterns are especially useful.

## Attribution

By **Andrés Ramírez · andrami** — https://andrami.pro

Released under the [MIT License](LICENSE).
