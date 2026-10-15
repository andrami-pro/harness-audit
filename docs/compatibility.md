# Compatibility across harnesses

The `harness-loops` commands and agents are written for Claude Code and port to OpenCode, Kilo Code and
Pi through `install.sh`. This page is what crosses, what does not, and what you lose on the way. Paths
like `scripts/…` are relative to the plugin that ships the file.

## Installing the loops on OpenCode, Kilo Code and Pi

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
from your [model line-up](../plugins/harness-audit/README.md#the-default-model-line-up-and-why-you-cant-just-delete-model) file. If you skip it, edit the `model:` lines by hand.

**Two guardrails do not survive the crossing** — the manual-only veto on the three expensive/consent-
gated loops, and `SKILL.md`'s `allowed-tools`. Read
[Compatibility across harnesses](compatibility.md) before you rely on either.

Pi is a different story, but not the one an earlier version of this README told: **4 of the 5 loop
commands do port to Pi**, as Pi's own prompt templates — gated on the same third-party
[`pi-subagents`](https://github.com/nicobailon/pi-subagents) extension the 7 agents already require.
`/session-review` and `/dashboard-harness` are the exceptions and do not port at all. Read the
[Pi section](compatibility.md) before reaching for this:

```bash
pi install npm:pi-subagents   # required — .pi/prompts/ and .pi/agents/ dispatch nothing without it
./install.sh --target pi      # 4 prompts + 7 agents. Refuses to write anything if the check above fails.
```

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
| `develop-phase` and `develop-spec` (waves) | ✅ native (Workflow) | ❌ not ported (no Workflow runtime) | ❌ not ported (no Workflow runtime) | ✅ as Node scripts: `develop-phase-pi.js`, `develop-spec-pi.js` (seats through `pi -p`, merges in code) — see [docs/loops.md](loops.md#develop-spec-waves) |
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
