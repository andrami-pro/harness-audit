# Line-up advisor — rankings × price × data policy, daily

Model catalogs rot in both directions: ids die without notice (NIM served 410 for `z-ai/glm-5.2` while
still listing it), and better or cheaper models appear without anyone telling you. The advisor turns that
into one daily file instead of a habit:

```
plugins/harness-audit/bin/lineup-advise              # → ~/.agents/lineup-advice.md + .json
plugins/harness-audit/bin/lineup-advise --offline    # same, from the last cached snapshots (no network)
```

It joins four sources — [Artificial Analysis](https://artificialanalysis.ai) (intelligence + coding
indices, prices; free key in `~/.agents/secrets.env` as `ARTIFICIAL_ANALYSIS_API_KEY`),
[LMArena](https://lmarena.ai) (coding, hard prompts, webdev, agent), SWE-bench Verified, and OpenRouter's
`/api/v1/models` (prices, free models, supported parameters, and for free models which provider actually
serves them) — against `pi --list-models`, the only ids a line-up can name. Per role it applies a profile
(`PROFILES` in `plugins/harness-audit/scripts/lineup-advise.js`: which metrics count, minimum context / output, whether strict
JSON or tools are required, how much price weighs) and prints the top three plus a diff against the
current line-up. The design seat `creativo` is ranked primarily on LMArena WebDev (`lm_webdev`), with
intelligence and coding as support — “best at coding” and “best at UI” are not the same leaderboard. Two
things it refuses on principle:

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
  `plugins/harness-audit/scripts/lineup-aliases.json` (`providers.<x>.roles`, `freeTierRoles`).

Names differ per source (`claude-opus-5-high` / `Claude Opus 5 (High)` / `anthropic/claude-opus-5`);
`normalize()` reduces them to one key and `plugins/harness-audit/scripts/lineup-aliases.json` catches the rest. Whatever still
does not map is listed under **No pude mapear** — a model the advisor cannot see is exactly the model you
do not know exists, so it is never dropped silently. The report also carries the OpenRouter free-tier
limits (20 rpm; 50/day, or 1,000/day once $10 has ever been bought) because a free model that 429s on the
second call is not free.

Nothing is applied automatically. In Pi, `/line-up advise` reads the report and lets you apply a role's
suggestion through the same validation and re-stamp path as the editor; `/line-up probe` calls every model
in the line-up, because the catalog is a claim and only a request is a fact. The confirmed mission router
(PRD-005) also reads the SAVED line-up, never an unreviewed daily suggestion: it proposes a route, the
operator approves it, and only `/line-up advise` applies anything the advisor ranked. A user-level systemd
timer (`~/.config/systemd/user/lineup-advise.timer`, daily 09:00, `Persistent=true`; the service runs
`plugins/harness-audit/bin/lineup-advise --no-probe`) regenerates the report and
the Pi extension mentions it at session start until it has been opened.
