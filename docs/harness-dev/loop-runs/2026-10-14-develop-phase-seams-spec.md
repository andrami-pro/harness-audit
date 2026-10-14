# develop-phase seams + spec axis, live — 2026-10-14

The first real run of PRD-004 step 3 (loops 1.3.0), on this repository, with the loop file as the task's subject:
make every early exit carry `axes` and `seams`. Preflight `node scripts/validate.js`, `maxIter: 2`, line-up defaults
(analyst and implementer opus, code and spec reviewers fable).

| run | args | seats | outcome |
|---|---|---|---|
| `wf_c1471171-9c9` | `seams: 'propose'` | scout, analyst | `blocked` with 3 seams, 0 implementer tokens |
| `wf_c4a5ac1b-81d` | `seams: [the 3, unchanged]` | scout, analyst, implementer, code + spec reviewers, preflight | both axes APPROVED in 1 round; preflight NOT VERIFIED (the 3 `JEV_LIVE` checks) |

**What held.** The analyst wrote a `SEAMS:` … `END SEAMS` block on its own, and the parser read all three. The two
review seats ran in parallel (journal order `review:iter1`, `spec:iter1`, then preflight). The spec seat quoted the task
sentence by sentence and checked each seam through the returned result. Its lines reached the handoff prefixed `spec: `,
next to the code reviewer's. The code reviewer replayed the implementer's negative controls and added one the
implementer had not run (`knownSeams = seams` deleted). The commit, made by hand afterwards, re-ran two of them: both exit 1.

**What to watch.**
- This repo has no `harness-rubric.md` and no `.claude/agents/reviewer.md`, so the code axis judged one criterion
  (test-first). In a project with a rubric it judges the rubric.
- To replay controls, the code reviewer edited files and restored them (`cmp` after each restore). Its prompt forbids git
  writes but not file edits. The tree came back identical, but a reviewer that edits is a seat acting outside its role.
- The preflight seat counted the gate's summary line as a fourth skip. That is harmless: a skip already means NOT VERIFIED.

Cost: 6 seats, 307k subagent tokens, 20.5 minutes for run 2.
