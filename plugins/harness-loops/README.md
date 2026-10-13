# harness-loops — build

The loops that build against a harness rubric, the agents they dispatch, and the deterministic gate that
checks every seat's output. Paths like `scripts/…` are relative to this plugin's folder.

```
/plugin marketplace add andrami-pro/harness-audit
/plugin install harness-loops@harness-audit
```

## The loops — which one do you need?

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
[Watch them run](../harness-guards/README.md#watch-them-run--dashboard-harness).

**Honesty rule for this table:** a loop only gets a row once it has at least one real, recorded run — a findings
JSON (or, for the process loop, a settled prediction) in the operating repo's `docs/harness-dev/loop-runs/`.
Loops that are specified but never run do not appear here. [docs/loops.md](../../docs/loops.md) names the run that backs each one.

Every loop, what it writes and when it stops, in full: [docs/loops.md](../../docs/loops.md).

## develop-phase — one loop, every project

`workflows/develop-phase.js` is one global script. Each project calls it through a wrapper the
`harness-audit` skill writes (`.claude/workflows/develop-phase.js`) that holds only the project's config:
`lang`, `models`, `preflight`, `forbidden`, `context`, `commit`… (the script's header lists every key).
The `sync-workflows` hook keeps a readable copy current, so an improvement here reaches every project's
next run.

`/develop-phase <task>` runs: a cheap **scout** reads the repo (code graph first) → an **analyst** plans
and names the **seams** to test, or stops on a `BLOCKER:` (`seams: 'propose'` stops here so you agree them,
then you re-run with them) → the **implementer** builds test-first → two reviewers in parallel, both from
another model family: **code** against the rubric (a provider-qualified `reviewerModel` goes through
`scripts/external-review.sh`) and **spec** against the task, PRD and seams; approval needs both → the
project's **preflight** decides by exit code, and a `SKIP` is not a pass → an optional **commit** that
stages the run's files by name, never your uncommitted work.
It returns a `handoff` (`complete | continue | blocked`) that is what the seats report, labelled as such.
On Pi the same loop is `scripts/develop-phase-pi.js`, with a tmux live view — see
[docs/loops.md](../../docs/loops.md#develop-phase-scout-analyst-and-a-reviewer-from-another-vendor).

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

## Hooks this plugin installs

| Hook | Event | What it does |
|---|---|---|
| `prompt-router` | `UserPromptSubmit` | Off without a TypeSafe key. One advisory line: which skill and which subagent tier (haiku/sonnet/opus/fable) fit the prompt |
| `jev-nudge` | `SessionStart` | While no key is present, says once a day that Jev is off. Silent with a key |
| `sync-workflows` | `SessionStart` | Copies `develop-phase.js` to `~/.claude/harness/` and to `.claude/harness/` (git-ignored) of a project with a wrapper, only when it changed |

## Jev — the optional System One classifier

[TypeSafe's Jev](https://docs.typesafe.ai) answers three shapes only — a yes-probability, one option
out of a map, a position on a scale — over the text you hand it, in well under a second, for a few
cents per million input tokens. It reads no file and runs no tool. That makes it the right party for
exactly two calls in this package that a frontier model was making by judgment and code should own:

- **`loop-gate.js dedupe`** — is this round's finding a restatement of last round's? ([docs/loops.md](../../docs/loops.md#the-one-step-in-a-loop-no-agent-wrote--scriptsloop-gatejs))
- **`prompt-router`** — which installed skill fits this prompt, and which subagent tier does it
  deserve? One advisory line per prompt; the model still decides. The tier criterion Jev reads:
  - **haiku** — the prompt carries no task of its own (ok, go on, retry), or it is a lookup or a command to run
  - **sonnet** — explain, answer about the state of something, write a message, give instructions, verify
  - **opus** — build or fix code or UI
  - **fable** — architecture, product, business, pricing or a plan

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
| develop-phase `routeByJev` | The first 1500 characters of the task |

**Calibrate before you trust it.** `node benchmarks/jev_dedupe_eval.js` runs a labelled corpus
(`benchmarks/jev-dedupe/corpus.json` — paraphrases, cross-language restatements, and hard negatives
that share a file, a line or most of their words with an old finding and are still new) through the
production `dedupe()`, then prices every threshold from that one request. The two errors are not
symmetric: a restatement read as new costs a redundant fix round; a new blocker or major read as a
restatement is hidden from the stop rule, and any of those at the shipped thresholds exits 1. The
0.85 / 0.95 thresholds were chosen, not measured, until the first live run ([2026-10-11](../../docs/harness-dev/loop-runs/2026-10-11-jev-dedupe-live.md)):
nothing hidden, recall 41% (47% and 41% on two reruns). The dedupe reads more than half of the
restatements as new, so loops run extra rounds. Next step: recalibrate both against that corpus.

**Jev is not deterministic:** the same request moves p by up to 0.08, so `benchmarks/jev_router_eval.js`
always runs twice and reports mean and [range]. Measured on 64 of the author's prompts, anonymized and labelled by
hand, one operator, mostly Spanish ([2026-10-11](../../docs/harness-dev/loop-runs/2026-10-11-jev-router.md)):
skill top-1 77.3% [76.6–78.1], 80.5% [79.7–81.3] counting an accepted alternative; tier top-1 73.4%.
Where Jev rates its tier at p ≥ 0.80 (52% of the prompts) it is right 91.0% of the time. Down costs quality
where up costs money, and Jev called one opus task haiku at p = 0.99, so develop-phase's `routeByJev`
moves the implementer down one tier at most and never below sonnet. Replayed on the corpus from opus,
those downgrades were right 95.3% [95.2–95.5]. It stays off by default; a wrapper may turn it on. The one
real run with it predates the threshold and routed nothing. Fixing 26 skill descriptions read as `">-"`
moved no score beyond run-to-run noise.

**What never leaves, key or no key:** transcripts. `/session-review` and `/dashboard-harness` keep
their promise — no API call, nothing leaves the machine — and `scripts/validate.js` holds them to it.
The security guards are unchanged and never call anything.

Where it goes (from TypeSafe's legal pages, read 2026-09-22 — re-check them, they are theirs to
change): the service is hosted in the United States; their DPA incorporates the EU Standard
Contractual Clauses (SCCs, 2021/914) and the UK addendum, with the customer as controller; they state they
do not train on inputs; retention is "as long as necessary", zero-data-retention is an enterprise
option. If your projects carry EU client data, the router is the path to think about — it sends
prompt text — and the honest setting for such a machine is no key at all.
