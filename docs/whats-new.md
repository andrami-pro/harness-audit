# What's new

Every change to the harness that an operator can notice, newest first. Each entry says what it does,
not how it is built. Minor internal fixes live in the commits; they make the list only when they
change behavior.

## 2026-11-26 · The plan says how parallel it is, and questions its dependencies (harness-loops 1.9.0)

**Two waves in three held a single ticket.** In the first 26 plans, 50 of 78 waves had one ticket and 86 of 116
tickets waited on another. develop-spec only schedules what each ticket's `Blocked by:` declares, and no plan said
how serial the result was.

- **The shape, before you approve.** Tickets per wave, the longest chain, and whether migrations or `maxParallel`
  are what keep it serial.
- **A dependency review on the plan run.** One seat reads the tickets and marks each `Blocked by:` needed or
  avoidable, with the seam to write in both tickets, and the plan shows the waves you would get without the
  avoidable ones. It never changes the real waves: you edit the tickets, or not.

## 2026-11-26 · Waves stop losing tickets to plumbing (harness-loops 1.8.0)

**Of 36 tickets blocked in six weeks of waves runs, about 30 were not blocked by their code.** Counted from the
results of 41 develop-spec runs on four projects: 11 on a preflight that was red or skipped checks in the worktree,
8 on setup, 6 on an implementer seat that died, 5 on a merge conflict. The reviewers stopped 8.

- **A red preflight goes back to the implementer.** After the reviews approve, a preflight that fails returns its
  output to the implementer, and the fix is reviewed again, inside `maxIter`. It used to end the ticket.
- **One preflight before any ticket.** develop-spec runs it once in the first fresh worktree. Red, or skipping a
  check you did not declare, stops the run before an implementer is paid for.
- **A dead implementer is retried once**, told to look at what the first attempt left.
- **One attempt at a merge conflict**, in the ticket's worktree, proved by the preflight. The brief says which
  tickets landed that way: no ticket review saw the resolution.
- **A ticket that never started leaves nothing behind.** No empty worktree, no branch, no `blocked` commit.
- **Not on Pi yet.** `develop-phase-pi.js` and `develop-spec-pi.js` keep the old behaviour.

**Sonnet or Fable as the reviewer: a tie on this corpus.** 15 labelled diffs (7 new: four subtle bugs, three safe
changes that look unsafe), each reviewed three times by each model with the same prompt. Both caught 24 of 24 bugs
with 0 false alarms in 21. The diffs are short and synthetic; a difference may only show on large real changes.

## 2026-11-26 · The harness starts counting what it catches; waves refuse a config that cannot work

**Nothing said whether the harness helps.** The Stop gate sent the agent back on a failing tree and kept no record.

- **The gate keeps a log.** Each run of a project's gate is one line on your machine: project, green or red, attempt,
  seconds. `node baseline/gate-stats.js` counts, per project, the turns the gate stopped on a failing tree and how
  many were fixed before the turn ended. Nothing leaves the machine.
- **The user-level baseline lives in this repository** (`baseline/`): the `/arnes-al-dia` command, the deny list, the
  SessionStart and Stop hooks, the Pi extension. `baseline/install.sh` copies them to `~/.claude` and `~/.pi`.
- **develop-spec checks the config before the plan** (harness-loops 1.7.1). An agent type the session cannot run, or
  an `integrate` that is a note and not a merge command, stops the run before any worktree exists. A
  `worktreeSetup` that copies `.env` is a warning. In a live run the first of these cost about 400k tokens.

## 2026-11-17 · 3.2 — the loop opens the interface in a real browser

**Unit tests never draw the screen, so a broken layout stayed green.** In Tama OS every test passed while the
project room's conversation was squeezed to 64 px and 12 buttons answered nothing (`PRD-006`).

- **ui-check.** One command opens the app in Chromium and checks rules that hold for any web app: nothing scrolls
  sideways, a conversation keeps room in its panel, text is not cut or printed over other text, controls stay in the
  window and do not hide each other, phone tap targets, accessibility (axe-core), console and network errors. With
  `interactions` on, it presses every button and reports the ones that answer nothing, change the screen without
  saying so, shove the layout, or show an error as loose red text. Destructive labels are never pressed.
- **In develop-phase, after every implementation** (`uiCheck: true` in the wrapper). A rule set to `block` sends the
  change back before any reviewer token; a `warn` rule reaches the code reviewer as evidence. A run that could not
  open the app is NOT VERIFIED, never a pass.
- **On Pi too.** `develop-phase-pi.js --ui-check` runs it in code after every implementation, with the same rules,
  and `develop-spec-pi.js` passes the flag to every ticket.
- **Every rule starts as a warning.** They were calibrated on one project (571 alarms → 9). Promote a rule once it
  stays quiet on yours.
- **Measured, then decided:** Bombadil saw none of these bugs with its defaults, and Jev, asked about screenshots,
  scored the squeezed room like a healthy screen. Both stay out of the per-change gate.
## 2026-11-12 · The advisor stops recommending models you do not pay for that way

The daily line-up report had stopped being usable: almost every suggestion was an OpenRouter or
Anthropic model, priced per token, when the harness runs on the OpenCode Go quota.

- **A paid-for quota is not billed twice.** `providers.opencode-go` is marked
  `billing: "subscription"` in `lineup-aliases.json`: the advisor no longer charges its per-token price
  in the score, so the Go models compete on quality instead of losing to whichever outsider is
  superficially cheaper. `prefer: 1.0` gives the Go side a one-standard-deviation margin, which is
  enough for roughly nine seats in ten while still letting a clearly better outsider win and say so.
- **The report says who it prefers and why**, from the same alias table, so the rule cannot drift from
  the ranking it explains. A suggestion from outside the quota is marked `fuera de la cuota`.
- **`--only opencode-go`** (or a comma list) writes a report closed to those providers, with no foreign
  candidates and no OpenRouter free-tier table, for when the operator wants the list without noise.
- **`critic` is no longer empty.** Its profile ranked only on the AA coding index, which the retired AA
  endpoint returns empty, so the seat had no candidate at all; it now falls back to LMArena coding.
- **`model-lineup.js advise` actually runs.** It loaded the advisor with `require`, which skipped the
  `require.main` guard, so the CLI printed nothing and exited 0 — silence that read as success. The
  extension path was unaffected.

## 2026-10-28 · 3.1 — confirmed mission routing (Pi) and a daily design line-up

**The operator no longer routes missions by hand on Pi.** Three changes, one design rule:
*everything is proposed, nothing is decided for you* (`PRD-005`).

- **Confirmed mission routing.** Type the task normally; the router classifies it (question,
  bounded development, complex development, design — in the same Jev call that already suggests
  skills and tiers, no extra API call) and shows the proposed path and line-up model before
  anything switches. Approve → the loop or model runs for that mission only, and one-shot chat
  routes restore your session model at the end. Decline → nothing happens, the prompt stays an
  ordinary chat. Escape, low confidence, no TUI, an explicit model ("con kimi-k3.1-pro"), a slash
  command, a short follow-up, or a loop seat all keep the routing off automatically.
- **develop-spec keeps its two human checkpoints.** With a ticket folder the router proposes the
  plan first; executing it needs one short confirmation and then the plan's own `--confirmed`
  dialog. Without tickets, complex work goes to the architect seat to produce the PRD/tickets —
  no waves run is invented.
- **The design seat has a daily candidate list.** `creativo` joined the line-up roles and the
  advisor ranks it from LMArena WebDev plus intelligence/coding evidence, under the same
  privacy (nothing that retains prompts sees code) and free-quota rules as every other seat.
- **The advisor is daily, not weekly**, and deterministic: rankings × price × data policy,
  computed in code with **zero LLM calls** and no background model probes. Its report is a
  suggestion only: nothing is applied except through `/line-up advise`.
- **Consent is enforced by tests, not by promise.** 20 mission fixtures in the repo's own gate
  prove every route, every bypass, model restore, and that a confirmed dispatch never re-runs
  the task in the main chat. Outcome: the wrong-provider incidents of late October 2027 can't
  recur by auto-routing.

Operated on Pi via `/mission` (status, off/on this session) and `/jev` (classifier status).
Later a wrong Anthropic credit state also blocks that provider from routing proposals until reset.

## 2026-10-27 · Credit-incident hardening (writer-route)

After a silent model switch spent Anthropic credit on a non-writing task: the writer-route
extension now **asks before switching models**, uses a strict detector (imperative + deliverable,
no loose infinitives), and blocks a provider whose last run died on a credit error until
`/writer-route reset`. Same rule as above: propose, never decide.

## 2026-10-14 · 3.0 — three plugins, one global loop, waves

- `harness-audit` split into **three plugins** in one marketplace: audit, loops, guards
  (independent semver, changesets).
- `develop-phase` is **one global script** called through a per-project wrapper; a fix lands
  once and reaches every project.
- **Spec axis + test-first + seams**: approval needs code review against the rubric *and* spec
  review against the task/PRD, side by side; the implementer works red before green.
- **develop-spec**: a folder of tickets (`Status:`, `Blocked by:`) worked in waves — two
  tickets at a time, each in its own git worktree, merged on approval, frontier recomputed
  per merge, migration-conflict rule enforced, final code+spec review of everything landed.
- **Pi port**: both loops run as plain Node scripts (`develop-phase-pi.js`, `develop-spec-pi.js`)
  with a tmux live view; every seat pinned to a non-Claude model from the line-up.

## 2026-10-10 · D25 — the line-up becomes a product

- One `model-lineup.json` resolves every harness's seat→model assignment at run time;
  **family independence** (reviewer ≠ implementer; judge/critic spec neither) enforced as a
  hard gate; **catalog + probe checks** ("listed" vs "actually answers").
- **`lineup-advise`**: rankings (Artificial Analysis, LMArena, SWE-bench, OpenRouter) × price ×
  data policy, per seat profile; suggestions never auto-apply — `/line-up advise` reads and
  applies, `/line-up probe` pings every model.

## Reading order for new operators

1. Root README → which plugin do you need.
2. `docs/loops.md` → what each loop does, the runs that back the table.
3. `plugins/harness-guards/README.md#watch-them-run--dashboard-harness` → what got run before you invite anyone in.
