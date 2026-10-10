# rubric-template — format of `harness-rubric.md`

The template `harness-audit` uses (Step 5) to emit the executable rubric. A rubric is honest only if **every criterion can say NO via a command**. If a criterion cannot fail objectively, it does not belong here.

## The 4 principles (from the Loop Design paradigm)

1. **Checkable by command** — every criterion carries a `Check:` any agent can run, plus a numeric or boolean threshold. Never a subjective judgment.
2. **Incremental validation** — criteria are ordered into checkpoints: cheap/structural first (`test -f`), then expensive (running preflight, tests). A loop attacks them in order.
3. **Explicit stop condition** — the whole rubric declares its stop condition: "all PASS **OR** N iterations". Without it, an infinite loop of cosmetic changes.
4. **Anti-false-convergence** — every criterion that measures the existence of verification (tests, preflight) carries a quality sub-check: that the verification FAILS when something breaks.

## Entry format

```markdown
## R<N> — <criterion in one line>
Check: `<exact command>` → <expected threshold>
State: PASS | FAIL (actual: <measured value>)
Pillar: <1-4> · Fix cost: <low|medium|high>
```

## Mandatory file header

```markdown
# harness-rubric — <project>
Generated: <date> by harness-audit
Stop: all checks PASS OR 10 iterations → escalate to the human with the list of remaining FAILs
Re-check: after each change, only the affected checks; every 3 iterations, the full rubric
```

## Good vs. bad examples

| ❌ Bad (cannot say no) | ✅ Good (checkable) |
|---|---|
| "AGENTS.md should be concise" | `wc -l < AGENTS.md` → ≤ 200 |
| "There should be good verification" | `pnpm preflight; echo $?` → exit 0, and exit ≠ 0 when a deliberate type error is introduced |
| "Tests should be high quality" | `grep -rL "expect\|assert" tests/ \| wc -l` → 0 test files without assertions |
| "Memory should be up to date" | `grep -c "\[VERIFIED" docs/decisions/*.md` → ≥ 1, and `du -s docs/decisions \| cut -f1` → ≤ 200 (KB) |
| "The reviewer should be independent" | `grep -ciE "refut\|reject\|evidence" .claude/agents/reviewer.md` → ≥ 1 |
| "The model line-up should keep reviewer and implementer independent" | `node "${CLAUDE_PLUGIN_ROOT}/scripts/model-lineup.js" resolve --target claude --global ~/.agents/model-lineup.json --project .agents/model-lineup.json; echo $?` → exit `0` (exit `2` = P2-8 FAIL: reviewer shares the implementer's model family, D25a) |
| "Docs should stay short" | `node "${CLAUDE_PLUGIN_ROOT:-.claude}/scripts/check-doc-budgets.js" --manifest docs/doc-budgets.json; echo $?` → 0 (every standing doc listed in the manifest is under its word ceiling; exit `2` = no manifest, which is N/A, not PASS) |

## Complete example (excerpt)

```markdown
# harness-rubric — example-project
Generated: 2026-06-12 by harness-audit
Stop: all checks PASS OR 10 iterations → escalate to the human

## R1 — AGENTS.md exists at the root
Check: `test -f AGENTS.md && echo PASS` → PASS
State: PASS
Pillar: 1 · Fix cost: low

## R2 — AGENTS.md ≤ 200 lines
Check: `wc -l < AGENTS.md` → ≤ 200
State: FAIL (actual: 245)
Pillar: 1 · Fix cost: medium

## R3 — Preflight is the loop gate (honest exit code)
Check: `pnpm preflight >/dev/null 2>&1; echo $?` → 0
State: PASS
Pillar: 4 · Fix cost: —
```

## Criteria for a multi-agent harness

Emit these when the project runs more than one agent against the same repo — a panel, a pipeline, a
loop with a reviewer seat. Each one exists because a real swarm design either got it right or got
bitten by it, and each is checkable the same way everything else here is.

```markdown
## R<N> — An agent that finds the harness broken STOPS; it never repairs it
Check: `grep -ciE "stop and report|do not (repair|rebuild|re-?launch) (the )?(harness|swarm|scripts)" AGENTS.md .claude/agents/*.md` → ≥ 1
State: FAIL (actual: 0)
Pillar: 2 · Fix cost: low

## R<N+1> — A blocked agent escalates to the human, not sideways to another agent
Check: `grep -ciE "stop and ask|escalate to the human|ask for clarification" AGENTS.md .claude/agents/*.md` → ≥ 1
State: PASS
Pillar: 2 · Fix cost: low

## R<N+2> — The harness can tell slow work from hung work
Check: `grep -crE "timeout|SIGTERM|--max-time" .github/workflows/ package.json scripts/ | awk -F: '{s+=$2} END {print s+0}'` → ≥ 1
State: FAIL (actual: 0)
Pillar: 3 · Fix cost: medium

## R<N+3> — No lock a dead process can hold forever
Check: `grep -rlE "\.lock|mkdir .*lock" scripts/ | xargs -r grep -LiE "stale|ttl|mtime|kill -0" | wc -l` → 0
State: PASS (actual: 0 lock sites without a stale path)
Pillar: 3 · Fix cost: medium

## R<N+4> — Agent-authored commits say which role wrote them
Check: `git log --no-merges -n 50 --format=%B | grep -ciE "^(By|Agent|Co-Authored-By) " ` → ≥ 1
State: FAIL (actual: 0)
Pillar: 4 · Fix cost: low
```

Why each one is a criterion and not a preference:

- **Self-repair** — an agent that notices its own helper scripts are missing and rebuilds them is an
  agent editing the thing that judges it. The failure is silent by construction: the harness comes
  back up, and nobody learns it was ever down. Stop and report is the only safe move, and it has to be
  written where the agent reads it.
- **Sideways escalation** — a free channel between agents fills with negotiation, and two agents that
  can talk each other out of a finding are one agent. Bound the channel (a schema, a severity ladder,
  a length cap) and route ambiguity to the human, who is the only party with the authority to change
  the task.
- **Slow vs hung** — the failure nobody instruments. A stalled agent produces exactly what a working
  one produces while it thinks: nothing. Without a timeout or a progress signal, the loop waits
  forever and the run is scored as if it had merely been thorough.
- **Stale locks** — a lock with no TTL and no liveness check turns one crashed process into a
  permanently wedged queue. If the project holds locks at all, each site needs a way out that does not
  require a human noticing.
- **Commit byline** — the cheapest provenance there is. Without it, `git log` cannot answer which role
  wrote a line, and no dashboard can join a commit to the loop that produced it. Only score this one
  when agents in the project actually commit; where a human commits every change, mark it
  `applies: false` rather than handing it a free pass.

## Criteria for the memory that outlives a run

Emit these when the project keeps any decision record at all — an `ADR` folder, a `docs/decisions/`, a
postmortem or two. Each one gives the M-scale (SKILL.md, Pillar 4) a shape on disk it can be graded
against, instead of a judgment call over a handful of notes. The first two are **⚠ aspirational** when
the directory does not exist: report them, do not fabricate decisions or incidents to satisfy them.

```markdown
## R<N> — Decisions have a lifecycle, and every implemented one says what it beat  (⚠ aspirational)
Check: `D=$(ls -d docs/decisions/implemented docs/adr 2>/dev/null | head -1); [ -n "$D" ] && grep -rL "## Alternatives considered" "$D" --include='*.md' | wc -l` → 0
State: FAIL (actual: 3 implemented notes without an "Alternatives considered" section)
Pillar: 4 · Fix cost: low

## R<N+1> — Every postmortem says why the safety nets missed it  (⚠ aspirational)
Check: `ls docs/postmortems/*.md 2>/dev/null | xargs -r grep -Li "why the safety nets missed it" | wc -l` → 0 (N/A when the directory is absent)
State: PASS (actual: 0 of 2)
Pillar: 4 · Fix cost: low

## R<N+2> — Standing docs stay under a word ceiling
Check: `node "${CLAUDE_PLUGIN_ROOT:-.claude}/scripts/check-doc-budgets.js" --manifest docs/doc-budgets.json; echo $?` → 0
State: FAIL (actual: exit 2 — no docs/doc-budgets.json; generalizes R2, which stays)
Pillar: 4 · Fix cost: low

## R<N+3> — The gate is proven by mutation, in a versioned test
Check: `test -f scripts/preflight-mutation.sh && sh scripts/preflight-mutation.sh >/dev/null 2>&1; echo $?` → 0
State: FAIL (actual: no such script)
Pillar: 3 · Fix cost: medium
```

Why each one is a criterion and not a preference:

- **Decision lifecycle** — `proposed/`, `implemented/`, `rejected/` as folders, so a note's status is
  its path and cannot silently rot. The mandatory `## Alternatives considered` is the part that earns
  the row: a decision recorded without what it beat invites re-litigation, which is the failure a
  decision record exists to prevent. An implemented note is kept current with what shipped (paths,
  names, defaults) but never rewritten into a different decision — that takes a new note.
- **Postmortems that name the gap** — a postmortem that records only the fix repeats the class. The
  section that matters is the one that says why every safety net missed the bug, and which guardrail
  (a test, a hook, a rule in `AGENTS.md`) was added so the same class fails loudly next time. Postmortems
  are not decision records: one looks back at a failure, the other forward at a choice.
- **Word ceilings** — standing docs grow by accretion, and review alone does not stop it. A budget forces
  the relocation decision at the moment content is added, when the author still knows where it belongs.
  When the gate goes red: relocate, then condense, and raise the ceiling only with a written reason.
  The manifest is `docs/doc-budgets.json`, `{ "<path>": <maxWords> }`, `wc -w` semantics.
- **Proven by mutation** — a gate that has never been seen to fail is a thermometer nobody has held to a
  flame. The row wants the proof *versioned*: a script that breaks a component, asserts the preflight
  exits non-zero, and reverts, so the next person can re-run the proof instead of trusting the last one.
  The Good column above already asks for this in prose; this row asks for the file.

## The golden rule

Before closing the rubric, run this meta-check on each entry: *"Can an agent with no context run the Check and reach the same verdict I did?"* If the answer is no, rewrite the criterion or drop it.
