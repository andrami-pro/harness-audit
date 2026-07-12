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

## The golden rule

Before closing the rubric, run this meta-check on each entry: *"Can an agent with no context run the Check and reach the same verdict I did?"* If the answer is no, rewrite the criterion or drop it.
