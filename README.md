# harness-audit

A Claude Code **plugin** (and portable **Agent Skill**) that audits a project's agent harness against four pillars — harness-in-code, multi-agent role separation, automatic verification, and loop design — and produces an **executable rubric** (`harness-rubric.md`) plus a stack-tailored remediation plan with stop conditions. The audit is not a static report a human reads and executes; it is a convergence target an autonomous implement-and-verify loop runs against. Its core principle: *the model is the horse, the harness is the saddle* — models change every few months, the harness stays.

Installed as a plugin, it also **protects** your sessions with three write-time security guards (see below).

## Install

### Option 1 — Claude Code plugin (recommended: audit + protection)

```
/plugin marketplace add andrami-pro/harness-audit
/plugin install harness-audit@harness-audit
```

This loads the skill **and** three security hooks that run on every session:

| Hook | What it blocks |
|---|---|
| `destructive-guard` | `rm -rf` against root/home, `git checkout --force`, `git clean -fdx`, `git reset --hard origin/*`, writes to block devices |
| `secret-scan` | Writing files that contain credential patterns (`sk-…`, `ghp_…`, `AKIA…`, PEM private keys, Slack tokens) |
| `block-no-verify` | `git commit/push --no-verify` — the pre-commit gate cannot be silently bypassed |

The guards are deliberately conservative (short, high-precision pattern lists — when in doubt they allow). To disable them, uninstall the plugin and use the skill-only install below.

### Option 2 — skill only (Claude Code, no hooks)

```bash
git clone https://github.com/andrami-pro/harness-audit.git /tmp/harness-audit
cp -R /tmp/harness-audit/skills/harness-audit ~/.claude/skills/harness-audit   # global
# or: cp -R /tmp/harness-audit/skills/harness-audit .claude/skills/harness-audit  # per project
```

### Option 3 — other coding agents (Cursor, Kilo Code, Antigravity, …)

The skill follows the open [Agent Skills](https://agentskills.io) standard. From the cloned repo:

```bash
./install.sh --target cursor        # .cursor/skills/  (project)
./install.sh --target kilo         # ~/.kilo/skills/  (user)
./install.sh --target antigravity  # .agents/skills/  (project)
```

The methodology is fully portable; the security hooks are Claude Code plugin-specific.

## Usage

Just ask in natural language. The skill triggers on phrases such as:

- "audit my harness" · "audita el harness"
- "AGENTS.md" · "preflight" · "reviewer subagent"
- "harness engineering" · "self-improving loop" · "loop design"
- "rubric" · "independent verifier" · "loop-readiness"
- "make this repo portable across Claude Code / Codex / Cursor"

It detects the stack automatically, audits the four pillars, grades loop-readiness (L0–L3) and memory maturity (M1–M5), writes an executable rubric, emits a role-differentiated develop-phase workflow (Implementer → adversarial Reviewer → Preflight, each on the model tier that fits the job), and runs an adversarial fresh-context verification of its own findings before delivering.

## The four pillars

1. **Harness in code** — `AGENTS.md` (≤ 200 lines) as the portable entry point, a single preflight gate, a memory convention, all versioned in the repo rather than in IDE config.
2. **Multi-agent role separation** — orchestrator / implementer / reviewer, where the reviewer receives only artifacts (diff + rubric), never the implementer's reasoning — and runs on a *different model family* than the implementer, on purpose. Independence is what lifts review accuracy (an independent verifier beats self-critique; the often-cited ~62%→~89% figures are directional targets, pending an in-house benchmark — see WHITEPAPER §8.1).
3. **Automatic verification** — lint, typecheck, tests with real assertions, a non-zero-on-failure preflight gate, pre-commit hooks, CI — and write-time security gates (secret scan, destructive-command guard, no-verify block). Verification a loop can read.
4. **Loop design** — an executable rubric every criterion of which is checkable by command, explicit stop conditions, and a memory that matures Fail → Investigate → Verify → Distill → Consult.

A minimal harness beats an inflated one: trimming tooling tends to make agents faster, not weaker.

## Repo layout

```
.claude-plugin/     plugin + marketplace manifests
skills/harness-audit/   SKILL.md + rubric-template.md + verifier-protocol.md (the portable part)
hooks/ + scripts/hooks/ security guards (plugin install only)
scripts/validate.js     this package's own preflight gate — run `node scripts/validate.js` before releasing
install.sh              multi-IDE skill installer
WHITEPAPER.md           full rationale, benchmarks provenance, and theory
```

## Learn more

Background article explaining the methodology:

- ES — https://andrami.pro/blog/auditoria-de-arnes-ia
- FR — https://andrami.pro/fr/blog/audit-harnais-ia

## Contributing

Issues and PRs welcome — new stack recipes, sharper rubric checks, additional anti-patterns, and (especially) an independent reproduction of the 62%→89% verifier benchmark.

## Attribution

By **Andrés Ramírez · andrami** — https://andrami.pro

Released under the [MIT License](LICENSE).
