# Run manifest — the reproducibility contract

Design discipline inspired by [headroom](https://github.com/headroomlabs-ai/headroom) (TOST-gated
evals; no fabricated statistics): a frozen, pinned description of one experiment so a run is
reproducible by anyone. **Fill and commit one block per real (K≥30) run.** The scaffold below is
the template; it carries NO results yet.

```yaml
experiment_id: verifier-ab-<UTC timestamp>   # e.g. verifier-ab-20260706T000000Z
status: TEMPLATE                              # TEMPLATE | PILOT | RUN
created_at: <UTC ISO-8601>                    # stamped by the human running it (script has no clock)

# --- pinned so the run reproduces ---
harness_version: harness-audit-v2
corpus_sha: <git rev-parse HEAD:benchmarks/corpus>   # or `git hash-object` over the corpus
n_diffs: 8
k_runs: <K>                                   # >=30 for a publishable claim; <30 = PILOT

arms:
  A_self_critique:
    model: claude-opus-4-8                    # implementer family; anchored with author rationale
  B_independent_verifier:
    model: claude-fable-5                      # cross-family; diff+rubric only, adversarial

temperature: <provider default>               # NOTE: agent() does not expose temperature; runs vary
                                              # only by model sampling. True seed control needs
                                              # API-level access — documented limitation.
alpha: 0.05                                   # for the eventual TOST (not computed at K<30)
margin_pp: 5                                  # pre-registered non-inferiority margin, percentage points

# --- results (leave empty until the run exists — DO NOT fabricate) ---
results:
  arm_A: { precision: null, recall: null, false_alarm_rate: null, miss_rate: null }
  arm_B: { precision: null, recall: null, false_alarm_rate: null, miss_rate: null }
  naive_delta_recall_B_minus_A: null
  tost_verdict: null                          # equivalent | inferior | inconclusive | superior
reproduce_command: 'Workflow({ scriptPath: "benchmarks/verifier_ab.js", args: { kRuns: 30 } })'
```

## Known limitations (state them, don't hide them)

- **No temperature/seed pinning.** The `agent()` layer does not expose sampling controls, so runs are
  not bit-reproducible — only distribution-reproducible at large K. A fully-pinned version needs a
  direct-API runner, which this scaffold does not yet have.
- **Arm A anchoring is simulated.** Real self-critique carries the *actual* generation trace; here we
  inject a plausible author rationale to reproduce the anchoring mechanism (§1.2). This is a faithful
  proxy, not the identical causal path — note it when reporting.
- **Small corpus.** Seed = 8 diffs. Precision/recall on 8×K cells is directional; grow the corpus to
  ≥20 before treating any delta as robust.
