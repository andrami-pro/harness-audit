# verifier-protocol — adversarial verification of the audit (Step 6)

Why it exists: self-critique by the same agent that generated the audit catches ~62% of errors (confirmation bias + anchoring to its own reasoning); a verifier with fresh context catches ~89%. Separating generation from evaluation is the Dev/QA equivalent of Loop Design.

## Isolation rules (non-negotiable)

The verifier subagent **ONLY receives**:
1. The path of the audited repo (read-only access)
2. The emitted rubric (`harness-rubric.md` or its proposed contents)
3. The list of sampled items to verify

The verifier subagent **NEVER receives**:
- The auditor's reasoning ("I think it passes because…")
- The human-readable audit report
- The session conversation

If the verifier sees the generator's reasoning, it stops being a verifier and becomes self-critique with extra steps.

## Sampling

- Verify **3–5 items** of the rubric, not all of them (cost/benefit).
- **Always include**: any item marked PASS whose command output was not pasted as evidence (PASS without evidence is where confirmation bias lives).
- Fill the rest by varying pillars (don't sample 4 items from the same pillar).

## Verifier prompt (template)

```
You are an independent verifier. Your job is to REFUTE, not confirm.
Repo (read-only): <path>
Rubric: <contents of the sampled items, only ID + criterion + Check + declared State>

For each item:
1. Run the `Check:` command literally.
2. Compare your result with the declared State.
3. Verdict: CONFIRMED | REFUTED, with the raw command output as evidence.
4. If the command is ambiguous or cannot run, verdict: UNCHECKABLE (that is
   also a rubric failure — a check that cannot run cannot say no).

Return only the table: ID | declared | measured | verdict | evidence.
Do not explain why the auditor might have erred; only report what you measured.
```

Launch with the Agent tool, type `Explore` (read-only) or the repo's `reviewer` if one exists.

## What to do with the verdicts

| Verdict | Action |
|---|---|
| CONFIRMED | Nothing — count it toward the summary's `verified: N/M` |
| REFUTED | Fix the item in the rubric AND the report; re-sample 1 extra item from the same pillar (if there was one error, there may be more) |
| UNCHECKABLE | Rewrite the item's `Check:` so it is executable; re-verify |

If ≥ 2 items come back REFUTED: the whole audit is suspect — re-run Step 2 of the affected pillar before delivering, and distill into memory which check failed and why (rule M4: one check corrected per audit).

## Close

The audit's final summary must include `verified: N/M sampled checks confirmed`. Never deliver an audit with an uncorrected REFUTED, nor with the `verified:` line missing.
