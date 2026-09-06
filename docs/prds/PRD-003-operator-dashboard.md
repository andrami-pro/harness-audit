---
id: PRD-003
title: The dashboard becomes an auditor, and gets a way in
status: done
created: 2026-09-06
updated: 2026-09-06
---

# PRD-003 — The dashboard becomes an auditor, and gets a way in

## 1. Executive summary

`scripts/loop-stats.js` reads the transcripts Claude Code writes and reports tokens. The transcripts
record much more than tokens: which tools ran and failed, which calls the operator refused and why,
which guards fired, which of the installed skills were ever invoked, and the shape of the driving.
None of it was read. The one part of this plugin that does audit the operator — `/session-review`,
Loop 6 — writes a report nothing ever reads back, so the cards it proposes have no lifecycle: a
promoted rule and an ignored one look identical a month later.

This PRD turns the dashboard into the auditor it was described as, and gives it a way in: `/dashboard`
and `bin/loop-stats`, because today the only invocation is `node scripts/loop-stats.js` typed from
this repository's checkout, which is the one directory the operator is not standing in.

Every requirement below is stated as the `scripts/validate.js` check that proves it.

## 2. Problem

The dashboard was reviewed into existence by `/review-loop` and scored 86/100; one of that run's ten
findings was that it had zero mentions in any `.md` of the plugin. The section that fixed that is
still the only user-facing documentation it has, and it documents an accountant.

- **It counts money, not practice.** Nothing in the report tells the operator anything they can act
  on about how they work. A cost table is a receipt, and a receipt is not an audit.
- **The loop that does audit the operator leaves no trace.** `/session-review` proposed five cards on
  2026-07-12. Two were promoted into `AGENTS.md` and one is still open. Nothing on any screen says so,
  and the only way to find out is to reread a seven-week-old markdown file by hand.
- **Two rules live in prose instead of in code.** The shape filter for user-role turns that a loop
  wrote to its own subagent, and the `(session, text, ±60s)` dedup behind "event count, not record
  count", are both prose instructions in `commands/session-review.md`. A rule applied by hand is a
  judgment call the next run has to make again, and it costs tokens each time.
- **`--project` refuses the value the operator has.** It accepted a directory name under the
  telemetry root and nothing else, so the path they would naturally type failed — and failed twice
  over where the project is reached through a symlinked parent, because Claude Code slugs the
  realpath while every record inside reports the symlink path as its cwd.
- **There is no way in.** No `bin`, no slash command, no default output path. `--html out.html`
  writes into whatever directory the operator happened to be in, and the report quotes their prompts
  and their denial reasons verbatim.

## 3. Solution

Four signal families, a rule engine over them, and two entry points.

**Signals** (`tools`, `guards`, `hygiene`, `skills`, `reviews` in the aggregate). Collected in the
single pass that already walks the transcripts, because a second walk over a gigabyte to count tool
calls costs more than it tells.

**Cards.** A rule engine over the finished aggregate, so a rule can cross fields — a role in
`.claude/agents` against the subagents that actually ran, a pending review card against the skills on
disk. Three properties are load-bearing:

1. A rule that finds no evidence prints **nothing**. There is no "all clear" card. The count of rules
   that stayed silent is printed instead.
2. Every card carries `doesNotProve`. A proxy says so next to itself.
3. No card edits anything. `/session-review` proposes and never applies; so does this.

**Lifecycle.** `AGENTS.md RULE` cards from the last `/session-review` are resolved by grepping this
repo's contract for the term the card quoted, and the line number is the evidence. `SKILL CANDIDATE`
cards are resolved against the installed skills. `DISPATCH` and `HABIT` cards leave nothing on disk to
grep, so they read `n/a` rather than `pending` — counting them pending would fill the open list with
cards that can never close.

**Entry points.** `/dashboard` (manual-only, for the same consent reason as `/session-review`: half of
what it renders is about the human) and `bin/loop-stats`. `--html` with no argument writes to
`${XDG_CACHE_HOME:-~/.cache}/harness-audit/dashboard/<slug>.html` — outside `~/.claude`, and outside
the repo, where a `git add -A` would publish a month of the operator's prompting.

## 4. Why a sixth command

`validate.js` caps this plugin at five commands, and the comment on that cap says a sixth file has to
argue for itself in a PRD before it argues for itself there. The argument:

- **It is not a sixth loop.** It iterates on nothing, converges against nothing, and costs zero
  tokens. The catalog stays at five loops; this is the observer they are watched through, and the
  README already calls it that.
- **The alternative is worse.** Folding it into `/session-review` would put a free report behind a
  model pass, and `/session-review` is deliberately infrequent — weekly at most, because its subject
  is the human. The thing you want to glance at after a rough session cannot be the thing you run
  every other week.
- **A bin alone does not reach the operator.** `bin/loop-stats` requires a checkout of this repository
  on `PATH`. The plugin install has no `bin`, and `${CLAUDE_PLUGIN_ROOT}` — the only path that
  resolves under a plugin install — is not a path anyone types.

The cap moves from five to six, and its comment names the sixth as an observer rather than a loop.

## 5. Requirements and acceptance criteria

Each requirement is the check that proves it. All are green as of 2026-09-06; each check carries its
own recorded negative controls in the comment above it.

| # | Requirement | Check in `scripts/validate.js` |
|---|---|---|
| R1 ✅ | `--project` resolves a slug, a path, and a path behind a symlink; a miss names the candidates tried | `loop-stats resolves --project from a slug, a path and a symlinked path` |
| R2 ✅ | The aggregate round-trips through `--json-out` / `--from-json` without touching the transcripts | `loop-stats round-trips its aggregate through --json-out / --from-json` |
| R3 ✅ | Tools, guards and hygiene are read from the pinned signals fixture, and a guard merely *named* — in a prompt, or inside a failed grep of the logs — is not a fire | `loop-stats mines tools, guards and hygiene from the signals fixture` |
| R4 ✅ | The shape filter and the ±60s dedup run in the script, and both counts are printed | same check (`droppedAgentShaped`, `dedupedRecords`) |
| R5 ✅ | The installed-skill inventory, the review lifecycle, and the rule engine — and the rules below their thresholds stay silent | `loop-stats reads the skill inventory, the review lifecycle, and fires cards only on evidence` |
| R6 ✅ | `/dashboard` runs the script with the `${CLAUDE_PLUGIN_ROOT:-.claude}` fallback, is manual-only, and never reads a transcript itself | `dashboard runs the script and never parses transcripts itself` |
| R7 ✅ | Six commands, each with a description and an argument-hint | `exactly 6 commands — 5 loops and 1 observer` |
| R8 ✅ | `/dashboard` is withheld from the Pi port for the same reason `/session-review` is | `install.sh --target pi installs templates Pi can actually load` (3 of 6) |
| R9 ✅ | `--all` aggregates every project under the telemetry root and reports the ones it could not read | `loop-stats aggregates every project under --all, and --brief withholds the accounting` |
| R10 ✅ | `--brief` emits exactly the fields the model pass needs, and no more | same check |
| R11 ✅ | `/session-review` consumes the new fields and keeps the `▸ **TYPE**` card format the parser reads back | `loop-stats aggregates every project under --all, and --brief withholds the accounting` (the command's half) |

## 6. Out of scope

- **Pricing `claude-fable-5-1`.** The `unpriced-model` card names it; the price is not added from
  memory. An invented price is worse than none in a dashboard whose whole claim is that it does not
  invent numbers.
- **A second harness's dashboard.** Unchanged from the README's position: hooks and this dashboard are
  Claude Code-only by design.
- **Any card that edits anything.** Not in this PRD and not in a later one; the human promotes.
- **A productivity score.** `/session-review` refuses to rank sessions, and so does this. There is no
  composite number, and there will not be one.

## 7. Risks

| Risk | Mitigation |
|---|---|
| The transcript format is internal and undocumented | Every shape is pinned in `scripts/fixtures/telemetry/demo-signals/`; a rename breaks CI rather than silently zeroing a column |
| The correction heuristic has false positives (`no olvides…` matches) | Labelled `proxy: true` everywhere it surfaces, requires the turn to follow an agent turn, and **fires no card on its own** — only the explicit denial reasons do |
| Turns a loop wrote to its own subagent inflate every prompt-derived number | Shape filter plus dedup, both counted and printed; `prompts.total` keeps its old meaning so the pinned fixture and the README stay true |
| A guard's name appears in a prompt, or inside a grep of the logs | The matcher is anchored at the start of an `is_error` result; the fixture pins both non-fires |
| The HTML quotes prompts verbatim | Default path is the user's cache, never the repo; `/dashboard` never passes a repo path to `--html` |
| A rule engine that fires on everything | The silent-rule list is asserted, not just the fired one; three rules sit below their thresholds in the fixture and none may fire |

## 8. Verification

```bash
node scripts/validate.js                                     # every check above
node scripts/loop-stats.js --root scripts/fixtures/telemetry \
  --project demo-signals --repo scripts/fixtures/repo        # the fixture, rendered
bin/loop-stats --project <a real path> --since 30d --html --open
sh install.sh --target pi --skip-graphify --skip-subagent-check   # 4 templates, not 6
```

## 9. First real run — 2026-09-06

`--all` over 34 projects on this machine took 10 s and priced $10 784 across 135 sessions. The
per-project run on `andrami-pro` (30 d, 22 sessions, 209 human prompts, 58 agent-shaped turns dropped)
fired 12 cards and left one rule silent — `denials-as-rules`, because the nine refused calls carry only
two distinct typed reasons and the threshold is three.

The lifecycle read what it was built for: the 2026-07-12 report's five cards resolve as 2 promoted
(`AGENTS.md:46` and `:93`), 1 pending (`/commit`, still not installed after 56 days) and 2 n/a. The
promoted `/humanizer` rule shows up independently in the cross-project view as the most-invoked skill
on the machine — 34 calls across 8 projects — which is the rule being kept rather than merely written.

## 10. Open questions

- Do the thresholds hold on a second project? They were read off one corpus, and a rule that fires on
  every project is as useless as one that never does. The honest answer arrives with the second
  `--all` run, not before.
- `skill-shelfware` cannot see a skill that auto-triggered on its description alone. If that turns out
  to be most invocations, the card is measuring the Skill tool rather than the skills, and it should
  say that instead of what it says now.
