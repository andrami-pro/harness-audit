---
description: "The observer, not a loop. Renders the zero-token dashboard for this project out of the transcripts Claude Code already wrote on this machine: rule-based cards with their evidence and their limits, the lifecycle of what the last /session-review proposed, session hygiene, tool failures and the calls you refused, which guards fired, and which of your installed skills were ever invoked. One self-contained HTML file plus a terminal summary. It iterates on nothing, costs zero tokens, edits nothing, and nothing leaves the machine."
argument-hint: "[--since 30d] [--all] [--open] [--project <path|slug>]"
allowed-tools: Bash(node:*), Bash(mkdir:*)
disable-model-invocation: true
---

# /dashboard-harness — the observer

Loops 1–6 change something: a skill, a diff, an app, the process, the operator. This changes nothing.
It reads the transcripts on this disk and tells you what they say about how the last month went.

**Manual-only** (`disable-model-invocation: true`), for the same reason `/session-review` is: it is
cheap, and that is not the point. Half of what it renders — continuations, interrupts, corrections,
the reasons you refused a call — is about you, and an agent that decides on its own to analyse how
you work has not saved you a step.

**Nothing leaves this machine.** No upload, no network call, no telemetry. The script reads
`~/.claude/projects/`, writes one HTML file to your cache, and that is the whole data flow.

## 1. Run the script. Do not read the corpus.

```bash
node "${CLAUDE_PLUGIN_ROOT:-.claude}/scripts/loop-stats.js" --repo "$PWD" --since 30d --html --open $ARGUMENTS
```

Pass `$ARGUMENTS` straight through — every flag it may carry (`--since`, `--all`, `--open`,
`--project`, `--top`) is the script's, and a later `--since` overrides the default above.
`--project` defaults to the current directory and resolves a path as readily as a slug.

`${CLAUDE_PLUGIN_ROOT}` is how the script is found: it ships with the plugin, not with the repository
you are standing in. The `:-.claude` fallback covers the copied-scripts install that
`install.sh --target claude` produces.

**Do not parse a `.jsonl` yourself, and do not summarise the output.** Everything countable is counted
by a `for` loop. Reading a corpus of transcripts into a context window to count what a script already
counted is the most expensive way to be wrong, and it is the whole reason this command is free.

If the script is missing, say so and stop. There is no fallback path.

## 2. Report

Print the terminal block the script produced, verbatim, then the line naming the file it wrote.
Then one sentence: which card you would act on first, and why. Nothing else.

Do not restate the cards in prose. Each one already carries its evidence, the field it came from, and
what it does not prove; a summary of a card is a card with its limits stripped off.

## 3. What it will not do

- **It does not score you.** No composite number, no ranking of sessions, no "23% more effective".
- **It does not apply anything.** Every card is a proposal. You promote.
- **It does not invent a number.** A model with no list price renders `n/a`, a proxy says the word
  proxy next to itself, and a rule that found no evidence prints nothing at all — the count of rules
  that stayed silent is printed instead.

## 4. Where it goes

The report is written to `${XDG_CACHE_HOME:-~/.cache}/harness-audit/dashboard/<project>.html` unless
you pass a path to `--html`. It is deliberately not written into the repository: the cards quote your
prompts and your denial reasons verbatim, and a report that lands in `docs/` is one `git add -A` away
from being published.

`--open` opens it in your browser; on a machine with no display it prints the path instead.

## 5. What to do with it

The cards are inputs to the loops that do change something:

| Card type | Where it goes |
|---|---|
| `SKILL CANDIDATE` | a new skill, or a `/skill-loop` target |
| `AGENTS.md RULE` | a line in the contract — **you** add it |
| `DISPATCH` | a dispatch criterion in `AGENTS.md` |
| `HABIT` | usually a setting, sometimes a conversation with yourself |
| `LIFECYCLE` | a card from the last `/session-review` that is still open |

When a `LIFECYCLE` card has been open for weeks, the answer is usually `/session-review` — it now
starts from these cards rather than from the raw corpus, which is what makes it cheaper than it was.
