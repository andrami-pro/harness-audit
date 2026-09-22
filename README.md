# harness-audit

A Claude Code **plugin** (and portable **Agent Skill**) that audits a project's agent harness against four pillars — harness-in-code, multi-agent role separation, automatic verification, and loop design — and produces an **executable rubric** (`harness-rubric.md`) plus a stack-tailored remediation plan with stop conditions. The audit is not a static report a human reads and executes; it is a convergence target an autonomous implement-and-verify loop runs against. Its core principle: *the model is the horse, the harness is the saddle* — models change every few months, the harness stays.

Installed as a plugin, it also **protects** your sessions with four write-time guards — three security guards and one loop-hygiene guard (see below).

## Install

### Option 1 — Claude Code plugin (recommended: audit + protection)

```
/plugin marketplace add andrami-pro/harness-audit
/plugin install harness-audit@harness-audit
```

This loads the skill **and** four guards that run on every session:

| Hook | What it blocks |
|---|---|
| `destructive-guard` | `rm -rf` against root/home, `git checkout --force`, `git clean -fdx`, `git reset --hard origin/*`, writes to block devices |
| `secret-scan` | Writing files that contain credential patterns (`sk-…`, `ghp_…`, `AKIA…`, PEM private keys, Slack tokens) |
| `block-no-verify` | `git commit/push --no-verify` — the pre-commit gate cannot be silently bypassed |
| `repeat-tool-guard` | Nothing — it is advisory. After 3, 5 and 8 consecutive byte-identical tool calls (same tool, same canonical arguments) it injects an escalating reminder to re-read the last result and change approach or conclude; it never denies a call, and a human prompt resets the count |

The guards are deliberately conservative (short, high-precision pattern lists — when in doubt they allow). The repeat guard is advisory by design: a polling loop that repeats a call on purpose still gets the nudge, and the model decides. To disable them, uninstall the plugin and use the skill-only install below.

Three more hooks ride the same install. None of them blocks anything:

| Hook | Event | What it does |
|---|---|---|
| `loop-telemetry` | `SubagentStop`, `Stop` | Appends one ndjson line per agent boundary for `/dashboard-harness`. Local file, never sent anywhere |
| `prompt-router` | `UserPromptSubmit` | **Off unless a TypeSafe key is present.** Asks Jev which installed skill fits the prompt and which subagent tier (haiku/sonnet/opus) it deserves; injects one advisory line. Sends the first 1500 chars of the prompt and the installed skill names + descriptions — see [§Jev](#jev--the-optional-system-one-classifier) |
| `jev-nudge` | `SessionStart` | While no key is present, says once a day that Jev is off and names `bin/jev-setup`. Silent with a key |

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

### Option 4 — the loop commands + agents themselves (OpenCode, Kilo Code, Pi)

The skill is one thing; the 5 loop commands and 7 agents that dispatch them are another. OpenCode and
Kilo Code both have a native Task tool and share one frontmatter schema, so the port is a mechanical
transform — the same file, a different folder:

```bash
./install.sh --target opencode              # .opencode/{commands,agents}/
./install.sh --target kilo-loops            # .kilo/{commands,agents}/  (separate from --target kilo)
./install.sh --target opencode --lineup     # …and stamp real model ids while you're at it (below)
```

**Run it with `--lineup`.** Each agent ships with a Claude Code model alias (`model: fable`,
`model: sonnet`) that **neither OpenCode nor Kilo Code can resolve** — they want a `provider/model` id.
The port carries the line over verbatim, so without `--lineup` you get an unresolvable placeholder that
your harness will fall back from (silently, to its own default). `--lineup` re-stamps every one of them
from your [model line-up](#watch-them-run) file. If you skip it, edit the `model:` lines by hand.

**Two guardrails do not survive the crossing** — the manual-only veto on the three expensive/consent-
gated loops, and `SKILL.md`'s `allowed-tools`. Read
[Compatibility across harnesses](#compatibility-across-harnesses) before you rely on either.

Pi is a different story, but not the one an earlier version of this README told: **4 of the 5 loop
commands do port to Pi**, as Pi's own prompt templates — gated on the same third-party
[`pi-subagents`](https://github.com/nicobailon/pi-subagents) extension the 7 agents already require.
`/session-review` and `/dashboard-harness` are the exceptions and do not port at all. Read the
[Pi section](#compatibility-across-harnesses) before reaching for this:

```bash
pi install npm:pi-subagents   # required — .pi/prompts/ and .pi/agents/ dispatch nothing without it
./install.sh --target pi      # 4 prompts + 7 agents. Refuses to write anything if the check above fails.
```

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
3. **Automatic verification** — lint, typecheck, tests with real assertions, a non-zero-on-failure preflight gate, pre-commit hooks, CI — and write-time security gates (secret scan, destructive-command guard, no-verify block) plus a loop-hygiene guard (a repeat-call reminder). Verification a loop can read.
4. **Loop design** — an executable rubric every criterion of which is checkable by command, explicit stop conditions, and a memory that matures Fail → Investigate → Verify → Distill → Consult — with a shape on disk the audit can grade: decisions with a lifecycle (`proposed/ implemented/ rejected/`, every implemented one stating the alternatives it beat), postmortems that say why the safety nets missed the bug, standing docs under a word ceiling, and a gate proven by mutation.

A minimal harness beats an inflated one: trimming tooling tends to make agents faster, not weaker.

## The default model line-up (and why you can't just delete `model:`)

Every file in `agents/` ships with a `model:` field — `sonnet` on the four critics
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
them carries a `model:` field either — see [Compatibility across harnesses](#compatibility-across-harnesses)).
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

## Line-up advisor — rankings × price × data policy, weekly

Model catalogs rot in both directions: ids die without notice (NIM served 410 for `z-ai/glm-5.2` while
still listing it), and better or cheaper models appear without anyone telling you. The advisor turns that
into one weekly file instead of a habit:

```
bin/lineup-advise              # → ~/.agents/lineup-advice.md + .json
bin/lineup-advise --offline    # same, from the last cached snapshots (no network)
```

It joins four sources — [Artificial Analysis](https://artificialanalysis.ai) (intelligence + coding
indices, prices; free key in `~/.agents/secrets.env` as `ARTIFICIAL_ANALYSIS_API_KEY`),
[LMArena](https://lmarena.ai) (coding, hard prompts, webdev, agent), SWE-bench Verified, and OpenRouter's
`/api/v1/models` (prices, free models, supported parameters, and for free models which provider actually
serves them) — against `pi --list-models`, the only ids a line-up can name. Per role it applies a profile
(`PROFILES` in `scripts/lineup-advise.js`: which metrics count, minimum context / output, whether strict
JSON or tools are required, how much price weighs) and prints the top three plus a diff against the
current line-up. Two things it refuses on principle:

- **A provider that retains prompts is never suggested for a role that sees code** while the repo's
  `sensitivity` is `client` (the default; set `"sensitivity": "personal"` in `.agents/model-lineup.json`
  to lift it). `stealth/ox-alpha` is the live example: free, 1M context, anonymous, and explicit about
  retention — it lands in the free-models table with that note, not in the implementer column.
- **Seats are independent across families** — reviewer ≠ implementer (D25a), judge ≠ implementer and
  reviewer, critic and scorer ≠ implementer — so "kimi-k3 on a cheaper provider" is never the reviewer
  answer to "kimi-k3 as implementer", and one free frontier model cannot fill every chair at once.
- **Free quotas only get short roles.** NVIDIA NIM (40 rpm, finite credits) is eligible for `explainer`
  only; OpenRouter's free tier (20 rpm, 50-1,000/day) for `explainer` and `preflight`; ollama only for
  models actually pulled. A free model is not a free afternoon of implementation. The lists live in
  `scripts/lineup-aliases.json` (`providers.<x>.roles`, `freeTierRoles`).

Names differ per source (`claude-opus-5-high` / `Claude Opus 5 (High)` / `anthropic/claude-opus-5`);
`normalize()` reduces them to one key and `scripts/lineup-aliases.json` catches the rest. Whatever still
does not map is listed under **No pude mapear** — a model the advisor cannot see is exactly the model you
do not know exists, so it is never dropped silently. The report also carries the OpenRouter free-tier
limits (20 rpm; 50/day, or 1,000/day once $10 has ever been bought) because a free model that 429s on the
second call is not free.

Nothing is applied automatically. In Pi, `/line-up advise` reads the report and lets you apply a role's
suggestion through the same validation and re-stamp path as the editor; `/line-up probe` calls every model
in the line-up, because the catalog is a claim and only a request is a fact. A user-level systemd timer
(`~/.config/systemd/user/lineup-advise.timer`, Mondays 09:00, `Persistent=true`) regenerates the report and
the Pi extension mentions it at session start until it has been opened.

## Compatibility across harnesses

This methodology has four layers, and they cross to Claude Code / OpenCode / Kilo Code / Pi at four
different rates. Read this before assuming a layer "just works" on a harness you didn't test it on.

| Layer | Claude Code | OpenCode | Kilo Code | Pi |
|---|---|---|---|---|
| `AGENTS.md` + executable rubric | ✅ native | ✅ native | ✅ native | ✅ native — Pi reads `AGENTS.md` directly |
| Skill (`SKILL.md` + templates) | ✅ native | ✅ native | ✅ native | ✅ native |
| The 5 loop commands + `/dashboard-harness` | ✅ native (Task tool) | ✅ native (Task tool) | ✅ native (Task tool) | ⚠️ **4 of 6** as prompt templates, via a third-party extension — `/session-review` and `/dashboard-harness` do not port, see below |
| The 7 agents | ✅ native | ✅ native | ✅ native | ✅ via the same third-party extension |
| Manual-only guardrail (`disable-model-invocation`) | ✅ enforced | ❌ **no equivalent — dropped** | ❌ **no equivalent — dropped** | ✅ **preserved by construction — see below** |
| Deterministic loop gate (`loop-gate.js`) | ✅ native | ⚠️ **degraded to a hand-check** | ⚠️ **degraded to a hand-check** | ⚠️ **degraded to a hand-check** |
| Hooks + dashboard (`/dashboard-harness`, `loop-stats.js`) | ✅ native | 📖 documented, not automated | 📖 documented, not automated | 📖 documented, not automated |

**Loops on Pi, in full — read this before you install:** Pi's core ships with no sub-agent support at
all — per [pi.dev](https://pi.dev)'s own docs, *"Pi ships with powerful defaults but skips features like
sub-agents."* The third-party [`pi-subagents`](https://github.com/nicobailon/pi-subagents) extension
(`pi install npm:pi-subagents`) adds subagent dispatch, and that is what `--target pi` ports both the 7
agents **and** the 5 loop commands into — not first-party, not bundled, a real dependency this repo is
naming rather than hiding.

Pi's own slash commands genuinely **are** prompt templates (`.pi/prompts/*.md`), and a prompt template
cannot dispatch anything **by itself** — an earlier version of this README read that fact as "the loop
commands cannot port to Pi" and said so, in the matrix and in `install.sh`'s own output. That was wrong,
and the error was stopping one layer too early: a loop command in this repo does not dispatch anything
by itself either. Its body is instructions telling whichever session expands it to call a dispatch tool
— Task on Claude Code. With pi-subagents installed, Pi's parent session has the equivalent tool,
`subagent`, and a prompt template whose body says "dispatch via `subagent`" works exactly like
pi-subagents' own bundled `/review-loop` template (`prompts/review-loop.md` in that package) — the
reference this port's Pi transform follows. `--target pi` ports 4 of this repo's 6 commands to
`.pi/prompts/` on that basis — rounds, stop conditions, findings aggregation and all. `.pi/prompts/` is
a native discovery location: nothing has to be registered anywhere, and no `.pi/settings.json` is
written. Type `/orchestrate`, `/skill-loop`, `/review-loop`, `/iterate` exactly as in Claude Code.

Every claim in this section was checked by running Pi (`pi --mode rpc`, `get_commands`) against a freshly
installed project and reading back which commands it actually registered — not by reading the docs. The
first draft of this port passed its own test suite while Pi silently discarded three of the five
templates it had written.

**`/session-review` and `/dashboard-harness` do not port to Pi, and will not.** Both shell out to
`node "${CLAUDE_PLUGIN_ROOT}/scripts/loop-stats.js"` — a variable that exists only inside the Claude Code
plugin runtime, pointing at a script `--target pi` does not install — and both read *the transcripts
Claude Code writes*, not Pi's sessions, which live elsewhere in a different format. Ported, each would be
a template that looks like it works and dies on its first command. `--target pi` withholds them and says
why. Run them from Claude Code; they read your local transcripts either way.

**Pi loads project `.pi/` resources only after you TRUST the project.** Interactive Pi asks on first start
(or use `/trust`); the non-interactive modes (`-p`, `--mode json`, `--mode rpc`) never ask and skip project
resources entirely unless `defaultProjectTrust` is `always` or you pass `--approve`. Until then the ported
templates and agents are on disk and invisible — which looks exactly like a failed install and is not one.

**This repo's `/review-loop` shadows the `/review-loop` that pi-subagents itself ships.** Project prompts
win over package prompts, so after `--target pi` that name resolves to this repo's Loop 4 (deep verification,
token-hungry), not the extension's lighter review/fix loop. If you were using the extension's, rename one of
the two files.

**The manual-only veto is preserved on Pi — by construction, not by a matching field.** In Claude Code,
`/review-loop` and `/iterate` (the two of the three manual-only loops that reach Pi at all) ship with
`disable-model-invocation: true`, and Pi's prompt-template frontmatter has no equivalent field — which
reads like the same loss OpenCode and Kilo Code take, below. It is not. A Pi prompt template only ever
expands when something types `/name` in the editor or passes it through the SDK/RPC `prompt` path
(`docs/usage.md`, `docs/rpc.md`); nothing exposed to the model — no builtin tool, no pi-subagents tool —
lets it invoke a prompt template on its own (verified against Pi's builtin tool list and the full
pi-subagents tool-call surface, 2026-07-13). So the veto holds on Pi with no field at all to carry it: the
model can still only *suggest* these loops, never fire them, because nothing lets it try.

One agent is degraded on Pi even so: **`correctness-critic` loses `WebSearch`** — pi-subagents exposes
no verified equivalent builtin — while its prompt still promises to check every figure and claim
against the web. That is its entire job. Install
[`pi-web-access`](https://github.com/nicobailon/pi-web-access) and add its tools to that agent's
frontmatter, or do not trust that seat on this target.

**The `model:` line is still a Claude Code alias on Pi, the same trap as OpenCode/Kilo Code below.**
None of this repo's commands carry a `model:` field — they run in whatever model expanded them, by design —
but all 7 ported agents do, and pi-subagents cannot resolve `sonnet`/`fable`/`opus` any better than
OpenCode or Kilo Code can. Re-run `--lineup` to stamp real provider/model ids, or edit the files by hand.

**The manual-only guardrail does not cross to OpenCode or Kilo Code.** In Claude Code, `/review-loop`,
`/iterate` and `/session-review` ship with `disable-model-invocation: true`: the model may *suggest*
them, never *fire* them. Two of the three are token-hungry, and the third takes **you** as its subject.
Neither OpenCode nor Kilo Code has any equivalent frontmatter field, so the port **drops it** — and
after the port, all three are auto-dispatchable by the model on those harnesses, with no local veto.
`install.sh` warns about this per file at install time. Your only remaining enforcement is a rule in
your own `AGENTS.md`, and a rule nothing checks is a wish; if the cost or the consent matters to you,
verify that rule actually holds.

**The `allowed-tools` trap (silent on two of these harnesses):** `SKILL.md`'s `allowed-tools` field —
the guardrail that scopes what a skill's own instructions are allowed to ask the model to do — is part
of the Agent Skills standard, but **OpenCode and Kilo Code both ignore it without a warning.** Any
skill whose safety story leans on that field loses the guardrail silently the moment it crosses to
either harness; there is no error, no log line, nothing to grep for. Pi, via the separate
[`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-permission-system) extension, is the
one target that actually enforces a tool-permission field at runtime — but that is a different,
non-bundled piece from `pi-subagents`, and this repo does not depend on it.

**The deterministic loop gate degrades on every target but Claude Code.** `/orchestrate`,
`/review-loop` and `/iterate` shell out to this plugin's `scripts/loop-gate.js` every round: to refuse a
critic's findings that anchor at a file which is not in the repo or at a line past the end of a real
one, or that carry a severity outside the fixed ladder — and once per run to refuse to *guess* the state
of a half-written run rather than reconciling it silently. On the scorer's scorecard the same call also
recomputes `SCORE` and `BLOCKERS` from the criteria table, so the number the gate opens on is produced
by arithmetic instead of by whichever model is holding the chair; on `/iterate`'s builder handoff it
refuses a status with no evidence behind it. None of these targets installs this
repo's `scripts/`, and `${CLAUDE_PLUGIN_ROOT}` expands to nothing outside the Claude Code plugin
runtime, so the port rewrites both steps into hand-checks the chair performs **on itself** — which is
precisely the party the gate exists to be independent of. The rounds, the stop conditions and the
findings aggregation are unaffected; what is lost is the only step in the loop that no agent wrote.

**Hooks and the dashboard are Claude Code-only by design** — they are ~20 lines of hook glue per
harness, each with a different plugin API (Claude Code's hooks are an external command reading JSON
from stdin; OpenCode and Kilo Code use in-process JS/TS plugin modules instead). The recipe is
documented, not automated: nobody has needed a second harness's dashboard badly enough yet to justify
writing and maintaining three more integrations against APIs this repo doesn't otherwise touch.

## The six loops — which one do you need?

| Your situation | Loop | Command | Cost | Stops when |
|---|---|---|---|---|
| "Every commit verified, no babysitting" | 1 · Stateless | smoke tests + `wip-green` (pattern, no command) | free | tests green |
| "My skills should improve weekly, with proof" | 2 · Learning | `/skill-loop <skill>` | med-high | A/B gain ≤ +1 for 2 rounds (max 4) |
| "Four specialist reviewers on this draft/PR" | 3 · Multi-agent review | `/orchestrate <paths>` | medium | no new blocker/major (max 3) |
| "Deep audit of the whole app — rare, token-hungry" | 4 · Verification | `/review-loop [max-iter]` · plus the `develop-phase` workflow the audit generates per repo | high | score ≥ 90 ∧ 0 blockers (max 5) |
| "Improve the *process* that builds the product" | 5 · Workflow improvement | `/iterate <task>` | high | score ≥ 90 ∧ optimizer out of proposals (max 5) |
| "Improve how *I* drive the agent — fully local" | 6 · Operator | `/session-review [--since 30d]` | med-low | single pass; re-run weekly |

Plus one thing that is not a loop: **`/dashboard-harness`**, the free observer the six are watched through.
It reads your local transcripts and reports how the driving went. See
[Watch them run](#watch-them-run--dashboard-harness).

**Honesty rule for this table:** a loop only gets a row once it has at least one real, recorded run — a findings
JSON (or, for the process loop, a settled prediction) in the operating repo's `docs/harness-dev/loop-runs/`.
Loops that are specified but never run do not appear here. Each subsection below names the run that backs it.

### Prerequisites

Loops 2–5 run their critics, scorers, and optimizers through **[Graphify](https://github.com/Graphify-Labs/graphify)**
instead of grepping the repo cold — a scoped subgraph of what-calls-what is cheaper and more accurate
than raw-text search, and it's the difference between a critic that reasons about structure and one that
burns its context window re-deriving it from grep. Install it once per machine:

```bash
uv tool install graphifyy          # preferred — package is `graphifyy` (double y), CLI is `graphify`
# fallback if uv is unavailable:
pipx install graphifyy             # or: pip install graphifyy
```

Then bootstrap the graph in any repo you're about to audit or run a loop against:

```bash
graphify extract . --code-only     # local AST parse, no API key, no network
```

`install.sh` offers to do both automatically. `--skip-graphify` continues in a degraded mode where the
audit marks the Graphify criterion FAIL but does not abort the install.

### Loop 1 · Stateless — the hard verifier

A gate, not a conversation: a small set of end-to-end smoke tests plus a `wip-green` checkpoint commit the
agent can roll back to. It **writes** nothing but a green/red exit code and the checkpoint commit; there is
no journal and no memory — that is what "stateless" means. Stops the moment the tests pass.
*Recorded:* it is the gate every other recorded run had to clear (`preflightPassed: true` in the
verification runs), and it is the one gate that was verified by mutation — break the component under test,
the suite must exit non-zero.

### Loop 2 · Learning — `/skill-loop <skill>`

Runs the same eval task through two arms — with the skill and without it — has a **blind** judge score both
on a fixed rubric, and lets a `skill-improver` agent edit the skill using the gap. It **writes** a
`LEARNINGS.md` inside the skill's own folder (one entry per round: what changed, why, how to apply) and a
findings JSON for the run. Stops when the with-skill gain over the without-skill arm is ≤ +1 for two
consecutive rounds, or at 4 rounds.
*Recorded:* one real run on a content skill — 4 rounds (the gap trend kept moving, so it ran to the round
ceiling rather than the ≤ +1 stop condition), blind A/B, judge on a different model family than the arms.

### Loop 3 · Multi-agent review — `/orchestrate <paths>`

Four orthogonal critics — correctness (checks every figure and claim against sources), domain (your project's
contract), safety (secrets, risky claims), style (tone, no AI-speak) — run in parallel on the artifacts each
round; any `blocker` triggers a fix round by the implementer. It **writes** a findings JSON per run
(`id`, `critic`, `severity`, `file`, `line`, `summary`, `fix`). Stops when a round produces no new
blocker/major, or at 3 rounds.
*Recorded:* one real run against a seeded fixture, which caught the planted blockers in round 1 — including
a fabricated regulatory figure.

### Loop 4 · Verification — `/review-loop [max-iter]`

The deep pass: the same four critics plus a `scorer` that grades the artifacts against an executable rubric
and returns a score out of 100 with a blocker count. Token-hungry by construction. It **writes** a findings
JSON with the score and blocker trend per iteration. Stops at score ≥ 90 **and** zero blockers, or at 5
iterations. Per-feature, the audit also generates a `develop-phase` workflow (Implementer → adversarial
Reviewer → Scorer → Preflight) that gates a single change on the same arithmetic — a fraction of the cost.
*Recorded:* two real `develop-phase` runs (one passing gate, one round-ceiling reject) with a score per
iteration, plus one real `/review-loop` run — a `MAX_ITERATIONS=1` deep pass over `scripts/loop-stats.js`
itself: score 86/100, 10 findings, stopped at the round ceiling (`RECHAZADO`). One of those findings —
this dashboard had zero mentions in any `.md` of the plugin — is what the section you're reading now
exists to fix.

### Loop 5 · Workflow improvement — `/iterate <task>`

The meta-loop. Each round: the implementer builds the next requirement, the scorer grades the app, and a
`process-optimizer` reads the run's own telemetry — never the diff — and makes **one** bounded change to the
spec of the process that built it, with a falsifiable prediction. It **writes** the process spec (versioned,
`docs/process.md` by default) and a `process-log.md` of predictions, each settled by the *next* run, not this
one. Stops only when both subjects are still: score ≥ 90, zero blockers, and the optimizer proposing nothing
— or at 5 rounds. Each round is gated by `loop-gate.js` like Loops 3–4, and the builder's end-of-round
handoff (`complete | continue | blocked`, with evidence) is shape-checked by `check-handoff` — and reported
as the builder's claim, never as a certificate.
*Recorded:* one settled entry in `process-log.md` — the optimizer's first bounded change to a real process
spec, its prediction graded ✅ verified by the following phase.

### Loop 6 · Operator — `/session-review [--since 30d] [--top 20]`

Loops 1–5 improve the work. This one improves the person driving it — the loop the other five leave open.
It reads the transcripts Claude Code already writes on your disk, counts what recurs (free — a script, not
a context window), then spends **one** agent pass on the sampled top-N to say what the recurrence *means*.
It returns **growth-edge cards**: the prompt you keep retyping (→ a skill), the correction you keep issuing
(→ an `AGENTS.md` rule), the dispatch you keep doing by hand (→ a dispatch criterion). Its outputs are the
other loops' inputs. It **proposes and never applies** — you promote, same contract the reviewer has with
your `AGENTS.md`. Single pass; re-run it weekly.

**Nothing leaves your machine.** No upload, no account, no proxy — the analysis runs where the transcripts
already are. Your prompts are the rawest artifact you own; a dashboard is not worth trading them for.

*Recorded:* a real 30-day run over 27 sessions / 165 human prompts — 5 cards, each with a verbatim quote
and an event-deduplicated count. Two findings from that run are now rules of the command itself: prompts a
loop writes to its own subagents are **byte-identical** to human keystrokes in the transcript (filter them
by shape, or your top card is the harness admiring its reflection), and counts are **event** counts, not
record counts (the same message sent twice in eight seconds is one correction).

### When NOT to use each one

Loops are not free, and the wrong one is worse than none.

| Loop | Cost class | Do not run it for |
|---|---|---|
| `/orchestrate` (4 critics × ≤ 3 rounds) | medium | typos, or code-only changes — that is what the develop-phase gate is for |
| `/skill-loop` (2 arms × 2 runs × ≤ 4 rounds + judge) | med-high | a skill you use less than once a week |
| `/review-loop` (critic fan-out × ≤ 5) | high · token-hungry | every commit. Only a large app or corpus, and rarely |
| `/iterate` (builder + scorer + optimizer × ≤ 5) | high | bug fixes, one-file changes — a feature that converges in round 1 teaches the process nothing |
| `/session-review` (free stats + 1 pass over top-N) | med-low | daily runs — a growth edge needs enough sessions to be an edge and not a bad afternoon |
| `/dashboard-harness` · `bin/loop-stats` | free (local script, zero tokens) | — run it as often as you like |

### How loops activate

Three levels, and the difference between them is who is allowed to spend your budget.

1. **Deterministic — no judgment, no tokens.** Preflight and smoke tests on a `pre-push` hook, the
   `wip-green` checkpoint. They run themselves, every time. Nothing decides whether they apply.
2. **Model-dispatched — auto, but announced.** `/orchestrate` and the per-feature `develop-phase` workflow
   carry a rich `description` with their triggers, and the dispatch criteria live in `AGENTS.md` ("which
   change goes through the gate, which is a normal session"). The agent may launch them on its own — and
   when it does it **must announce it in one line**: `→ /orchestrate: the diff touches both locales`.
   Live visibility at dispatch; `loop-stats` gives it in retrospect.
3. **Scheduled — optional.** `/skill-loop` on a weekly schedule, once a skill earns it.

Three loops are **manual-only**, shipping with `disable-model-invocation: true`. A model may notice that a
task is the right shape for one and say so in a line; it may never fire one.

- `/review-loop` and `/iterate`, because of **cost**. An auto-dispatched deep review burns a real budget
  without consent, and the guardrail is cheaper than the apology.
- `/session-review`, because of **consent**. It is cheap; that is not the point. Its subject is the human,
  and an agent that decides on its own to analyze how you work has not saved you a step — it has reviewed
  you without asking.

**`disable-model-invocation` itself is Claude Code's field.** OpenCode and Kilo Code have no equivalent,
so a ported copy of these three loses the veto and becomes auto-dispatchable. Pi has no equivalent
field either, but keeps the veto anyway — invocation there is always a typed `/name`, never a tool call
the model can make on its own. See [Compatibility across harnesses](#compatibility-across-harnesses).

### Watch them run — `/dashboard-harness`

`/dashboard-harness` is the observer the six loops are watched through. It reads the transcripts Claude Code
already wrote on this machine and reports what they say — not just what they cost. It iterates on
nothing, costs zero tokens, edits nothing, and never leaves your machine.

```bash
/dashboard-harness                       # inside Claude Code — this project, last 30 days
/dashboard-harness --since 7d --open     # …and open the HTML report in a browser
/dashboard-harness --lang es             # the report's own words in es or fr; quotes stay verbatim
bin/loop-stats --project ~/code/my-app --since 30d --html   # or from any shell
```

What it audits, on top of the accounting that was always there:

| Block | What it answers |
|---|---|
| **Cards** | The recommendations. Rule-based, zero tokens; each carries its evidence, the field it came from, and what it does not prove |
| **Session-review lifecycle** | What Loop 6 last proposed, and whether the repo now contains it — a promoted rule is shown with the `AGENTS.md` line that proves it |
| **Session hygiene** | Bare continuations, interrupts, compactions, `/model` switches typed by hand — every proxy labelled as one |
| **Tools & failures** | Which tools ran, which failure kept coming back, and every call you refused with the reason you typed |
| **Guards & hooks** | Which guards actually fired, and which hooks merely ran |
| **Skills & commands** | Which of your installed skills were ever invoked, and which sat on the shelf |

Two properties make this a report rather than a horoscope. **A rule that finds no evidence prints
nothing** — the count of rules that stayed silent is printed instead of a reassuring card. And **no
card edits anything**: same contract `/session-review` has with `AGENTS.md`, for the same reason.

```bash
node scripts/loop-stats.js                        # the same report, straight from a checkout
node scripts/loop-stats.js --project <path|slug>  # another project — a path works, symlinks and all
node scripts/loop-stats.js --root <dir>           # telemetry root (default: ~/.claude/projects)
node scripts/loop-stats.js --repo <path>          # read loop-runs/, LEARNINGS.md, AGENTS.md elsewhere
node scripts/loop-stats.js --since 7d             # window the report to the last N days
node scripts/loop-stats.js --top 20               # how many recurring prompts to surface (default 3)
node scripts/loop-stats.js --html [out] --open    # CRT report; no path = ~/.cache/harness-audit/
node scripts/loop-stats.js --all                  # every project on this machine, cost and cards
node scripts/loop-stats.js --lang en|es|fr        # report language (default: the shell's LANG)
node scripts/loop-stats.js --json [--brief]       # the aggregate; --brief drops the accounting
```

The HTML report defaults to your cache, not the repository: it quotes your prompts and your denial
reasons verbatim, and a file like that landing in `docs/` is one `git add -A` away from being public.

**Reading the `est.$` column (D17):** it is list price × **measured** tokens for that run — never a
multiplier, never a heuristic. A model absent from the price table renders `n/a` instead of a guess —
an invented price is worse than none in a dashboard whose whole claim is that it doesn't invent numbers.
Claude Sonnet 5 carries a dated introductory rate; a run priced during that window is footnoted
`priced at introductory rate` rather than silently re-priced at today's rate.

### Anatomy of a loop

Every loop above is the same four-part shape, just applied to a different subject (a skill, a diff, an
app, the process itself):

**goal** — the one thing this round is trying to move (a skill's eval score, a draft's blocker count, an
app's rubric score, the process's own waste) → **rubric** — a fixed, checkable target the round is graded
against, never redefined mid-run → **verifier** — an agent that did not write the artifact grades it
(a blind judge, an independent critic panel, a scorer with no edit tools) → **memory** — what survives the
round in a file, not a chat turn (`LEARNINGS.md`, a findings JSON, `process.md` + `process-log.md`).

Full rationale for why the verifier has to be independent and why memory has to mature past raw notes:
[WHITEPAPER.md — Pillar 4, Loop Design](WHITEPAPER.md#pillar-4--loop-design-rubrics--continuous-memory).

### The one step in a loop no agent wrote — `scripts/loop-gate.js`

Every loop above has the same costume seam: a seat emits JSON, and a chair — a model — reads it,
trusts it, and aggregates it. Nothing between the two can say no. A finding that anchors at a file
which is not in the repo, or at line 900 of a 40-line file, is indistinguishable from a real one once
it is inside the findings JSON, and it will be reported to a human as evidence. That is what a
fabricated finding looks like from the inside, and it is invisible to a chair reading JSON as prose.

`/orchestrate`, `/review-loop` and `/iterate` call the gate every round. It costs zero tokens.

```bash
node scripts/loop-gate.js check-findings <seat.json> --root . --seat correctness
node scripts/loop-gate.js check-handoff <builder.json> --seat builder
node scripts/loop-gate.js resume docs/harness-dev/loop-runs/<run-slug>/
```

**`check-findings`** refuses the defect classes the seats' own agent files already forbid but nothing
measured: an anchor at a file that does not exist or a line past the end of a real one, a severity
outside the fixed ladder, a key the contract does not have, a seat that assigned its own `id`/`critic`,
and — on the scorer's scorecard — a criterion parked at `applies: false` with no justification, or a
failed criterion with no finding behind it. Exit `2` means repair and retry: the errors are numbered
and written to be acted on by the seat itself, so the chair re-dispatches with the list appended
verbatim instead of paraphrasing what it thinks went wrong.

On a scorecard the same call also prints `SCORE: <n>/100 · BLOCKERS: <m>`, computed from the criteria
table with the weights the scorer's own file states. **Arithmetic is the one part of a gate that never
needed judgment**, and until now it was being done by whichever model happened to be holding the chair.
The gate still decides nothing — `score ≥ 90 ∧ blockers = 0` remains the chair's call, on two numbers
it no longer produces itself.

**`resume`** makes a run's rounds files instead of conversation. Each round writes
`docs/harness-dev/loop-runs/<run-slug>/round-<n>.json` as it closes, so a chair that dies in round 2 of
a five-seat deep read does not re-pay for round 1. It answers `NO_RUN`, `RESUME_FROM: <n>`, or
`RUN_COMPLETE` — and when the state is not one of those three (a gap in the sequence, an unreadable
round file), it answers **`AMBIGUOUS_RUN_STATE`, lists the files, and exits 2**. It never reconciles.
A loop that repairs its own half-written state resumes into a round nobody chose and reports the
result as though someone had.

**`check-handoff`** gates the one seat output that is about the seat's own work: the builder's
end-of-round `{ status, summary, evidence, blocker? }`. It refuses a status outside
`complete | continue | blocked`, empty evidence, a `blocked` with no blocker named and a blocker on a
status that is not blocked — the shapes that let a claim hide. It certifies nothing: a handoff that
clears it is what the builder reported, and `/iterate` says so wherever it quotes one. The independent
read is the scorer's scorecard, not the handoff.

From round 2 on, the same script decides which of a round's findings **restate** the previous
round's — the call the stop rule of `/orchestrate` hangs on, and until now the one call left to the
chair, the party holding every fix it applied:

```bash
node scripts/loop-gate.js dedupe round-<n-1>.json raw/<n>-aggregate.json --out dedupe-<n>.json
```

Same critic, same file, normalized summary identical → restated, no model involved. The pairs that
survive that go to Jev (below) as one request, one yes-probability per pair, thresholded in code:
0.85, and **0.95 for a blocker** — deduping away a real new blocker opens a gate on a defect nobody
fixed, so the bar is higher on the side where the mistake costs more. The output is three lines the
chair reads and a JSON it never has to: `DEDUPE:` (`jev` or `exact-only`), `NEW: blocker n major m
minor k` — the stop arithmetic — and `CARRIED:` with every carried blocker and major printed by id.
Nothing is deduped silently. Without a key, or when the API fails, the first line says `exact-only`,
`UNJUDGED:` counts the pairs left, and the chair compares those by meaning and reports the round as
ungated — announced, never hidden.

The gate is Claude Code-only; every other target degrades it to a hand-check the chair performs on
itself. See [Compatibility across harnesses](#compatibility-across-harnesses).

## Jev — the optional System One classifier

[TypeSafe's Jev](https://docs.typesafe.ai) answers three shapes only — a yes-probability, one option
out of a map, a position on a scale — over the text you hand it, in well under a second, for a few
cents per million input tokens. It reads no file and runs no tool. That makes it the right party for
exactly two calls in this package that a frontier model was making by judgment and code should own:

- **`loop-gate.js dedupe`** — is this round's finding a restatement of last round's? (above)
- **`prompt-router`** — which installed skill fits this prompt, and which subagent tier does it
  deserve? One advisory line per prompt; the model still decides.

**Off by default, on by one key.** Every Jev path checks `TYPESAFE_API_KEY` — the environment, or a
`TYPESAFE_API_KEY=` line in `~/.agents/secrets.env` (the file the line-up advisor already reads,
mode 0600, outside every repo). No key: `isEnabled()` is false, the dedupe prints `exact-only`, the
router and the nudge stay silent, and the loops run exactly as they did in 2.7. `TYPESAFE_API_KEY=off`
pauses it without deleting the key. The switch is global: one machine, every project.

```bash
bin/jev-setup            # asks for the key on a TTY, stores it, pings api.typesafe.ai
bin/jev-setup --status   # exit 0 = on, 3 = off
bin/jev-setup --ping     # one round trip, never writes
./install.sh --target …  # asks the same question once, interactively; --yes and --skip-jev never ask
```

**What leaves the machine, only while a key is present:**

| Path | Sent to `api.typesafe.ai` |
|---|---|
| `dedupe` | For each pair: the two findings' `id`, `critic`, `severity`, `file`, `line`, `summary`, `fix` |
| `prompt-router` | The first 1500 characters of the prompt you just typed; the names and 120-char descriptions of your installed skills |

**What never leaves, key or no key:** transcripts. `/session-review` and `/dashboard-harness` keep
their promise — no API call, nothing leaves the machine — and `scripts/validate.js` holds them to it.
The security guards are unchanged and never call anything.

Where it goes (from TypeSafe's legal pages, read 2026-09-22 — re-check them, they are theirs to
change): the service is hosted in the United States; their DPA incorporates the EU Standard
Contractual Clauses (SCCs, 2021/914) and the UK addendum, with the customer as controller; they state they
do not train on inputs; retention is "as long as necessary", zero-data-retention is an enterprise
option. If your projects carry EU client data, the router is the path to think about — it sends
prompt text — and the honest setting for such a machine is no key at all.

## Repo layout

```
.claude-plugin/     plugin + marketplace manifests
skills/harness-audit/   SKILL.md + rubric-template.md + verifier-protocol.md (the portable part)
hooks/ + scripts/hooks/ three security guards + the repeat-tool guard + telemetry + the Jev router/nudge (plugin install only)
scripts/loop-gate.js    the deterministic seam inside a loop — see below
scripts/jev.js          the one door to TypeSafe Jev, and the one switch (TYPESAFE_API_KEY) — see §Jev
bin/jev-setup           store the key, ping the API, report status
scripts/check-doc-budgets.js  word-ceiling gate for standing docs (docs/doc-budgets.json)
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
