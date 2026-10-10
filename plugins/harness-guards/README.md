# harness-guards — protect and observe

Guards that run on every Claude Code session, and the two ways to see how those sessions actually went.
Everything here reads and writes your machine only. Paths like `scripts/…` are relative to this plugin's
folder.

```
/plugin marketplace add andrami-pro/harness-audit
/plugin install harness-guards@harness-audit
```

## The guards

| Hook | What it blocks |
|---|---|
| `destructive-guard` | `rm -rf` against root/home, `git checkout --force`, `git clean -fdx`, `git reset --hard origin/*`, writes to block devices |
| `secret-scan` | Writing files that contain credential patterns (`sk-…`, `ghp_…`, `AKIA…`, PEM private keys, Slack tokens) |
| `block-no-verify` | `git commit/push --no-verify` — the pre-commit gate cannot be silently bypassed |
| `repeat-tool-guard` | Nothing — it is advisory. After 3, 5 and 8 consecutive byte-identical tool calls (same tool, same canonical arguments) it injects an escalating reminder to re-read the last result and change approach or conclude; it never denies a call, and a human prompt resets the count |

The guards are deliberately conservative (short, high-precision pattern lists — when in doubt they allow). The repeat guard is advisory by design: a polling loop that repeats a call on purpose still gets the nudge, and the model decides. To disable them, uninstall this plugin.

`loop-telemetry` (`SubagentStop`, `Stop`) appends one ndjson line per agent boundary to
`~/.claude/loop-telemetry.ndjson` for the dashboard. It blocks nothing and sends nothing.

## Watch them run — `/dashboard-harness`

`/dashboard-harness` is the observer the loops are watched through. It reads the transcripts Claude Code
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
node scripts/loop-stats.js                        # the same report, from this plugin's folder
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

## Loop 6 · Operator — `/session-review [--since 30d] [--top 20]`

The other loops improve the work. This one improves the person driving it — the loop the other five leave open.
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
