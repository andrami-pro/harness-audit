# What's new

Every change to the harness that an operator can notice, newest first. Each entry says what it does,
not how it is built. Minor internal fixes live in the commits; they make the list only when they
change behavior.

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
