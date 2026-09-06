---
description: Loop 6 — the operator loop. Every other loop improves the work; this one improves the person driving it. It reads the transcripts Claude Code already writes on this machine, finds the prompt you keep retyping, the correction you keep issuing, and the dispatch you keep doing by hand, and returns them as growth-edge cards — a skill you should be building, a rule your AGENTS.md is missing, a criterion your dispatcher is missing. Nothing leaves the machine. Suggest this to the human when a session felt repetitive, before a harness review, or on a weekly cadence — but never launch it yourself, because the subject of this review is the human, and reviewing someone without being asked is not a favor.
argument-hint: "[--since 30d] [--top 20]"
allowed-tools: Task, Read, Write, Grep, Glob, Bash(node:*), Bash(mkdir:*), Bash(date:*), Bash(git log:*), Bash(grep:*)
disable-model-invocation: true
---

# /session-review — the operator loop (Loop 6)

Loops 1–5 take the work as their subject: the task, the skill, the content, the code, the process.
None of them look at **how you drive**. This one does, and it is the loop that closes the system —
its outputs are inputs to the others: a recurring prompt becomes a `/skill-loop` target, a recurring
correction becomes an `AGENTS.md` rule, a recurring manual launch becomes a dispatch criterion.

**Nothing leaves this machine.** No upload, no account, no proxy, no API call, no telemetry. The
transcripts are already on your disk; this command reads them there and writes one markdown file back.
That is the whole data flow, and it is the difference between this and every hosted session-analytics
product: your prompts are the rawest artifact you own — half-formed strategy, client names, salary
figures — and they are not worth trading for a dashboard.

This command is **manual-only** (`disable-model-invocation: true`). A model may notice a session went
in circles and say, in one line, that this loop exists. A model may not decide on its own to analyze
its operator. You fire it, or a schedule you set fires it.

## 0. Announce — one line, before anything else

```
→ /session-review: reading <N> local sessions over the last <window>, top <K> sampled
```

## 1. The free statistics — zero tokens

Everything countable is counted by a script, not by you. Reading a corpus of transcripts into a
context window to count things a `for` loop can count is the most expensive way to be wrong.

```bash
node "${CLAUDE_PLUGIN_ROOT:-.claude}/scripts/loop-stats.js" --repo "$PWD" --since <window> --top <K> --json --brief
```

`${CLAUDE_PLUGIN_ROOT}` is mandatory: the script ships with the plugin, not with the repo you are
standing in, and `node scripts/loop-stats.js` would resolve against the user's cwd and fail. The
`:-.claude` fallback covers the copied-scripts install `install.sh --target claude` produces.

`$ARGUMENTS` may carry `--since 30d` (default `30d` for this loop — a week is too few sessions to see
a pattern) and `--top 20` (default `20`). Pass both straight through. `--project` defaults to the
current directory and accepts a path as readily as a slug.

`--brief` is what keeps this loop cheap: it drops the accounting (the agent×model table, the timeline,
the workflow history, the savings ledger) and returns only what a judgment pass can use.

What you get back, free:

| Field | What it carries |
|---|---|
| `prompts.top`, `prompts.total`, `prompts.avgWords`, `prompts.sessionsPerDay`, `prompts.followUpRate` | the K most recurrent prompts, normalized to eight significant words, each with a count and a verbatim sample |
| `hygiene.*` | continuations, interrupts, compactions, `/model` switches, correction-shaped turns — **and** `droppedAgentShaped` and `dedupedRecords`, the two numbers §2 used to make you compute |
| `tools.denials.reasons` | **the only quotes in this JSON that are corrections and not proxies** — a reason the operator typed while refusing a call |
| `tools.errorClusters` | failures that repeated, with a verbatim sample and the sessions they spanned |
| `skills.installedNotUsed`, `skills.usedNotInstalled`, `skills.roles` | what is installed against what was invoked, and the roles this repo defines |
| `cards` | the script's own rule-based cards, each already carrying its evidence and its limits |
| `reviews.latest` | what the previous run of this loop proposed, and which of those cards the repo now contains |

**Read those fields. Do not read the corpus.** If you find yourself opening session `.jsonl` files to
"get more context", you have turned a cheap loop into an expensive one. Pull the full text of a
specific prompt only when a card needs a verbatim quote you do not already have.

## 2. Clean the sample — agent turns look exactly like human turns

The transcript records a **user-role turn** for anything that isn't the assistant. That includes turns
no human typed:

- prompts the loops write to their own subagents (`Round 1. Review these artifacts: …`, `You are the …`)
- prompts an eval harness writes (`Eres un agente plano, sin skills…`)
- IDE and system injections (`<task-notification>`, `<ide_opened_file>`)

These carry **no marker** distinguishing them from a keystroke — same `userType`, same `promptSource`,
same everything. There is no structural discriminator; there is only shape. A "top prompt" that turns
out to be your own orchestrator talking to its critics is not a growth edge, it is a parsing bug
wearing one.

**The script now does this filtering, and the ±60s dedup with it.** `hygiene.humanPrompts` is the
count after both; `hygiene.droppedAgentShaped` and `hygiene.dedupedRecords` say how much each removed.
Your job is no longer to apply the rule but to check it: report both numbers, and spot-check at most
**two** entries of `prompts.top` for agent authorship — that field is deliberately unfiltered, because
it is also how you would notice the filter missing a new shape.

Interrupt markers (`[Request interrupted…]`) are not prompts either — their count arrives as
`hygiene.interrupts` and is a signal worth carrying into the HABIT card.

## 3. One pass of judgment — over the sample, never the corpus

Now, and only now, spend tokens. Send **one** `Task` to a single agent with the brief JSON and the
project's `AGENTS.md`. One pass. Not one per card, not one per prompt.

Statistics find what **recurs**. They cannot tell you what a recurrence *means* — whether "commit and
push" ×6 is a skill waiting to be written or just what work sounds like. That judgment is the only
thing worth paying a model for here, and it is worth exactly one pass.

**Start from `cards`, not from zero.** The script has already found what recurs and attached the
evidence. The pass is for the three things a rule cannot do:

1. **Accept, sharpen, or reject each script card, with a reason.** A rejected card is a result — say
   why it does not apply here rather than dropping it silently.
2. **Turn `tools.denials.reasons` into `AGENTS.md RULE` cards.** These are the corrections that are
   not proxies. The grep proof stays mandatory: a rule already in the contract is not a candidate.
3. **Settle the previous run's cards** from `reviews.latest`: each is `promoted`, `pending` or `n/a`
   already, and your job is to say whether a pending card is still worth promoting or should be
   recorded as rejected so it stops surfacing. Do not ask the human; if the contract carries no trace
   and the report carries no rejection, it is still pending.

Ask for five things, and demand evidence for each:

| Card | The question it answers | Evidence it must carry |
|---|---|---|
| `SKILL CANDIDATE` | Which prompt do I keep retyping that a skill should already know? | count + verbatim prompt |
| `AGENTS.md RULE` | Which correction do I keep issuing that the contract should carry? | count + verbatim correction + proof the rule is absent (`grep` the contract) |
| `DISPATCH` | What do I keep launching by hand that a criterion should launch? | count + what was launched + in what context |
| `HABIT` | What does the shape of my prompting reveal? | the statistic, and what it does *not* prove |
| `LIFECYCLE` | What did the last review propose, and where is it now? | the card verbatim + its state from `reviews.latest` + what settled it |

**Every count is an event count, not a record count.** The same message sent twice eight seconds apart
is one correction, not two. Deduplicate by (session, text, ±60s) before you write a number down. A loop
whose whole pitch is honest measurement cannot inflate its own headline.

**Every quote is verbatim.** If you cannot quote it, you cannot claim it. A card with a paraphrase in
the quote slot is a fabrication with good manners.

## 4. The cards

```
## Growth edge — <date> (last <N>d, <M> sessions)
▸ SKILL CANDIDATE   «<normalized prompt>» ×N → propose /skill-loop <existing skill> or a new skill
▸ AGENTS.md RULE    you corrected «<pattern>» ×N after agent turns → candidate rule (you promote it)
▸ DISPATCH          you launched <command/workflow> by hand ×N in <context> → candidate D23 criterion
▸ HABIT             <statistical pattern> → <interpretation>
▸ LIFECYCLE         «<card from <date>>» → promoted (AGENTS.md:<line>) / still pending / rejected: <why>
```

**Keep this line format exactly.** `loop-stats` parses these `▸ **TYPE**` lines back on every
`/dashboard` run — that is how a card gets a lifecycle instead of disappearing into a markdown file.
Restyling them is not a formatting choice; it is deleting the lifecycle.

One line per card, more than one card per type when the evidence supports it, **zero cards of a type
when it does not**. A window with no recurring correction in it should print no `AGENTS.md RULE` card.
Padding this report to four lines because the format has four rows is how an honest instrument becomes
a horoscope — and the empty slot is itself the finding: nothing recurred, nothing needs a rule.

Where the numbers refuse to support the story, **say the numbers**. A hypothesis this loop was built on
("short prompts get corrected more") that the data flattens is a result, and reporting it is the
difference between an instrument and a mirror.

## 5. Propose. Never apply.

This command **proposes; it never applies**. It does not edit `AGENTS.md`. It does not edit a skill. It
does not add a dispatch criterion. It writes one report and stops.

**The human promotes.** Same contract the reviewer has with `AGENTS.md`, and for the same reason: a
rule the operator did not choose is a rule the operator will not keep — and an agent that rewrites its
own contract on the strength of its own analysis has closed a loop that was never supposed to close.

Every card is an argument addressed to a person, and the person is free to reject it. A rejected card
that comes back next week with a higher count is the loop working, not the loop failing.

## 6. Write the report

Write `docs/harness-dev/loop-runs/<YYYY-MM-DD>-session-review.md` (create the directory if needed):
the cards, the evidence behind each one, the window, the sample size, how many agent-authored turns
were dropped, and what you deliberately did **not** conclude.

Then report to the human in three lines: the cards, the file path, and the single card you would act on
first.

The report is also an input: `/dashboard` reads its card lines back and reports each one as promoted,
pending or n/a until you settle it.

## Cadence

Weekly or fortnightly. Daily is noise — a growth edge needs enough sessions to be an edge and not a bad
afternoon. A scheduled weekly run is a reasonable thing to set up, and setting it up is the human's
call, not this command's.

## What this is not

It is not a productivity score. It does not rank your sessions, grade your prompting, or tell you that
you are 23% more effective than last week. There is no counterfactual behind a number like that, and
this repo does not print numbers it cannot defend.

It counts what you repeat, and repetition is the only honest signal a transcript carries.
