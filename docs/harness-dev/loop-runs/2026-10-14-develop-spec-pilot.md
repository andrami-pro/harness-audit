# develop-spec pilot, live — 2026-10-14

The first real run of PRD-004 step 4 (loops 1.4.0), on this repository. Three tickets in
`docs/tickets/prd-004-waves-pilot/`: 01 Pi seams + test-first, 02 the four §5 rubric criteria, 03 the Pi spec axis
(blocked by 01). Preflight `node scripts/validate.js`, `allowSkipped: ['JEV_LIVE=1', '3 NOT VERIFIED']`, `maxIter: 3`,
line-up defaults (code and spec reviewers fable).

| run | args | outcome |
|---|---|---|
| `wf_d8162b97-4c6` | no `confirmed` | plan only: waves `[["01","02"],["03"]]`, no warnings, seams read 3/1/2 |
| `wf_7e6efbb6-227` | `confirmed: true` | 01 and 02 approved on both axes in their worktrees, then **blocked** at preflight; 03 waited |
| (by hand) | — | 01 and 02 committed in their worktrees, merged `--no-ff` (`1def897`, `1bb94c3`), marked done |
| `wf_0a4d6bc0-375` | `confirmed: true`, `worktreeSetup: "cp …/private-terms.json ."` | 03 approved, merged by the merge seat (`d028d44`), worktree and branch removed; final review APPROVED on both axes |

**What held.** The frontier ran 01 and 02 in parallel and held 03 until 01 was done. Each ticket worked in its own
worktree, and every seat `cd`'d into it. When a ticket blocked, the run marked it `blocked` with the reason and kept its
worktree. In run 3 the merge seat landed 03, set its status to `done`, and cleaned up. The final review then covered
`514d0ce..HEAD`. 01 and 02 had no conflict in `scripts/validate.js`: they touched different regions of it.

**What blocked, and what changed.**
- `private-terms.json` is gitignored, so the worktrees did not have it. Its scan skipped, the gate printed
  `4 NOT VERIFIED`, and neither that line nor the scan's matched `allowSkipped`. The gate did its job: an undeclared
  skip blocks. The brief, though, said only "Preflight skipped checks", so the line had to be dug out of the journal.
  Fixed in `c9ace14`: `nextStep` names every skip outside `allowSkipped`, and docs/loops.md tells `worktreeSetup` to
  copy the gitignored files the preflight reads.
- A ticket whose heading carries its id read "03 — 03 — Pi…" in merge commits and the brief. Fixed: the read titles
  drop a leading id.
- Both fixes have a stub check in `validate.js`, and each check's negative control is recorded in the code.
- Resuming run 2 would not have helped: the preflight seat's prompt was unchanged, so its blocked result would come
  back from the cache. Landing by hand cost nothing. Re-running everything would have cost about 1.2M tokens.

**What to watch.**
- The final code review flagged a single overlong line in docs/loops.md. Rewrapped.
- The accepted risks from the build still stand: a hung merge seat stalls the queue, because `agent()` has no
  timeout, and a ticket started during another merge branches from the pre-merge HEAD. Run 3 had one ticket, so it
  exercised neither.
- Pi now mirrors seams, test-first, declared skips, the read-only reviewer and the spec axis. None of it has had a
  live Pi run.

Cost: run 2 was 20 seats, 1.17M subagent tokens, 42.5 minutes. Run 3 was 12 seats, 686k tokens, 27.9 minutes.
