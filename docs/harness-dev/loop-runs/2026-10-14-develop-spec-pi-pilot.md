# develop-spec-pi pilot, live — 2026-10-14

The first real run of the waves loop on Pi (loops 1.5.0), on this repository, from a Claude Code session's shell. Two
tickets in `docs/tickets/pi-waves-pilot/`: 01, a `--prd` path for develop-phase-pi, and 02, the stop on a rejection
with no `[FAIL]` (blocked by 01). Flags: `--prd` PRD-004, `--preflight "node scripts/validate.js"`,
`--allow-skipped JEV_LIVE=1`, `--max-iter 3`, and `--worktree-setup` copying `private-terms.json`. Line-up `pi` column:
the scout is mimo-v2.6-flash, the analyst and implementer kimi-k2.7-code (Jev sized both tickets `bounded`), the code
and spec reviewers mimo-v2.6-pro, and the commit seat glm-5.3-flash, all through opencode-go.

| run | outcome |
|---|---|
| 1 | 01 approved by both axes in 1 round, preflight PASS, merged. 02 started, and every seat died: `Connection error.` |
| 2 | 02 set back to `ready-for-agent`, resumed in its kept worktree. Approved in 1 round, preflight PASS, merged. Final review: spec APPROVED, code REJECTED with 2 `[FAIL]` |

**What held.** The plan put 02 after 01, and 02 started only once 01 had merged. Each ticket ran
develop-phase-pi.js in its own worktree under `.pi/worktrees/`. The merges, the `Status:` lines and the cleanup ran as
code. When the provider dropped, nothing reported a pass: 02 was marked blocked and its worktree kept, and the brief
said that the final review had returned nothing. The final code review of run 2 found two real defects in what 02
landed, which its per-ticket review could not see.

**What it found, all fixed on the branch with a stub check and a negative control.**
- **A seat held a ticket for three hours.** 01's commit seat has a 300 s limit and ran from 16:51 to 19:51 UTC.
  pi's MCP helpers inherit its stdout, so the pipe never closed, and a SIGTERM to pi alone did nothing. Each seat
  now runs in a process group of its own. The group is killed at the limit, and a few seconds after pi exits.
- **pi exits 0 when its provider drops.** The crash said "empty output" and pointed at an `.err.txt` that did not
  exist. It now quotes the seat's `Connection error.` and points at its live log.
- **The fallback commit message was cut mid-word** ("…The ticket is docs/ti"), in commit `deb1d7f`, which is left as
  is. The fallback is now the task's first sentence.
- **A resumed ticket started from its old base.** 02's kept branch had to be fast-forwarded by hand. It now merges
  what landed on the run's branch before it resumes.
- **From the final review:**
  - develop-phase-pi's handoff dropped bulleted `- [FAIL]` lines, which its loop did count.
  - The no-`[FAIL]` stop's blocker did not name the axis.

**What to watch.** Each seat run here prints two pi warnings: the MCP adapter conflict and a failing Gmail MCP. They
are harmless, and they come from the user's pi config, not from the loop. tmux is not installed on this machine, so
there was no live view.

Wall time: about 20 minutes of work per ticket. Run 1 was about 3.5 hours, three of them the hung commit seat. Run 2
was 25 minutes, plus 6 minutes of final review.
