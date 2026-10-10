# harness-audit — diagnose

The audit skill. It reads a repository the way a coding agent will, grades its harness against four
pillars, and writes what a loop needs to converge: an **executable rubric**, a stack-tailored plan with
stop conditions, and a config-only `develop-phase` wrapper. Paths like `scripts/…` are relative to this
plugin's folder.

```
/plugin marketplace add andrami-pro/harness-audit
/plugin install harness-audit@harness-audit
```

## Usage

Just ask in natural language. The skill triggers on phrases such as:

- "audit my harness" · "audita el harness"
- "AGENTS.md" · "preflight" · "reviewer subagent"
- "harness engineering" · "self-improving loop" · "loop design"
- "rubric" · "independent verifier" · "loop-readiness"
- "make this repo portable across Claude Code / Codex / Cursor"

It detects the stack automatically, audits the four pillars, grades loop-readiness (L0–L3) and memory maturity (M1–M5), writes an executable rubric, writes a `develop-phase` wrapper that runs the global loop from `harness-loops` with this project's config, and runs an adversarial fresh-context verification of its own findings before delivering.

What it writes into the project:

| File | What it is |
|---|---|
| `harness-rubric.md` | One row per criterion: a `Check:` command, a threshold, the current state. A re-audit re-runs every check and annotates what moved (`run N`) |
| `.claude/workflows/develop-phase.js` | A wrapper holding only the project's config (language, models, preflight, forbidden commands, commit rules). The loop itself ships with `harness-loops`; a forked copy found by a re-audit is migrated to a wrapper, with the mapping shown first |

## The four pillars

1. **Harness in code** — `AGENTS.md` (≤ 200 lines) as the portable entry point, a single preflight gate, a memory convention, all versioned in the repo rather than in IDE config.
2. **Multi-agent role separation** — orchestrator / implementer / reviewer, where the reviewer receives only artifacts (diff + rubric), never the implementer's reasoning — and runs on a *different model family* than the implementer, on purpose. Independence is what lifts review accuracy (an independent verifier beats self-critique; the often-cited ~62%→~89% figures are directional targets, pending an in-house benchmark — see WHITEPAPER §8.1).
3. **Automatic verification** — lint, typecheck, tests with real assertions, a non-zero-on-failure preflight gate, pre-commit hooks, CI — and write-time security gates (secret scan, destructive-command guard, no-verify block) plus a loop-hygiene guard (a repeat-call reminder). Verification a loop can read.
4. **Loop design** — an executable rubric every criterion of which is checkable by command, explicit stop conditions, and a memory that matures Fail → Investigate → Verify → Distill → Consult — with a shape on disk the audit can grade: decisions with a lifecycle (`proposed/ implemented/ rejected/`, every implemented one stating the alternatives it beat), postmortems that say why the safety nets missed the bug, standing docs under a word ceiling, and a gate proven by mutation.

A minimal harness beats an inflated one: trimming tooling tends to make agents faster, not weaker.

## The default model line-up (and why you can't just delete `model:`)

Every agent in `harness-loops` (`plugins/harness-loops/agents/`) ships with a `model:` field — `sonnet` on the four critics
(`correctness-critic.md`, `domain-critic.md`, `safety-critic.md`, `style-critic.md`), `fable` on the
scorer. Those are not a preference baked in for convenience; they are this repo's **default** line-up,
checked into the template so the plugin works the moment you install it, before it knows anything about
your harness or your provider.

**Why not just delete the field and let every agent inherit whatever model your session happens to be
running?** Because a single HARD guardrail (D25a) stands on it: the reviewer/critic role must never
share a model family with the implementer role, or "independent review" collapses into self-critique
wearing a different badge — Pillar 2 (multi-agent role separation) falls apart in silence, not with an
error. Delete `model:` everywhere and every agent — the shipped critics and scorer, and whatever
`implementer.md` / `reviewer.md` your own project defines in its `.claude/agents/` — runs in whatever
model expanded it, the same "no field, no opinion" behavior the 5 loop commands already rely on (none of
them carries a `model:` field either — see [Compatibility across harnesses](../../docs/compatibility.md)).
Push that same default-to-the-session behavior onto the agents that are supposed to check each other's
work, and a reviewer stops being a second pair of eyes: it becomes a mirror of the implementer, because
both just became the one model your session is running.

**How to change the defaults for your context** (three ways, one shared schema):

1. `./install.sh --target <name> --lineup` — resolves `~/.agents/model-lineup.json` (global) merged with
   `.agents/model-lineup.json` (this project) and re-stamps every `model:` field before copying the files.
2. The `harness-audit` skill's own onboarding step (SKILL.md Step 4a) — the first time it audits a project
   with no `model-lineup.json` anywhere, it proposes a default line-up, states the independence rule above
   in one line, and writes `~/.agents/model-lineup.json` only with your explicit consent (never silently).
   On every audit after that, it re-stamps your project's own `.claude/agents/*.md` from whatever line-up
   already exists — the path that covers a plugin install (`/plugin marketplace add` + `/plugin install`),
   which never runs `install.sh` at all.
3. `./bin/lineup` (or `node scripts/model-lineup.js ui`) — a terminal editor for the role x harness
   matrix. Every value is picked from the live catalog (`pi --list-models`), never typed, and a save is
   refused while either gate below is red. Without a TTY the same command prints the matrix, validates it
   and exits — usable in a pipe or a subagent. `node scripts/model-lineup.js ollama-sync` refreshes the
   `ollama` block of `~/.pi/agent/models.json` from `ollama list`, so the catalog matches what the local
   server actually serves.
4. Edit `~/.agents/model-lineup.json` by hand — `scripts/model-lineup.js` (`resolveLineup`, `familyOf`,
   `hardViolation`, `softViolations`) is the one place that schema is read and validated; nothing else in
   this repo reimplements the resolution.

Whichever path you use, `scripts/model-lineup.js` rejects (exit `2`, not confirmable) any line-up where
the reviewer/critic and the implementer resolve to the same model family.

A second gate catches the other way a line-up breaks: `node scripts/model-lineup.js check` matches every
provider-qualified entry against the live catalog and exits `1` when one names a model nothing serves —
naming the corrected id. The failure it exists for is silent: a line-up reading
`nvidia-nim/zai/glm-5.2` (the real pair is `nvidia/z-ai/glm-5.2`) is valid JSON, passes every other check,
and surfaces only as a dispatch that hangs and exits 1 with no mention of the model. On a machine without
`pi` installed the check reports SKIPPED rather than failing a line-up it cannot verify.

The weekly line-up advisor (rankings × price × data policy, `bin/lineup-advise`) is described in
[docs/lineup-advisor.md](../../docs/lineup-advisor.md).
