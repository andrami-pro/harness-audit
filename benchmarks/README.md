# benchmarks/ — reproducible A/B for the independent-verifier claim

> **Status: SCAFFOLD, NOT YET RUN at N≥30.** This directory is the harness that *measures* the
> WHITEPAPER §1.2 claim (self-critique ~62% → independent verifier ~89% precision; ~28% → ~7%
> false positives). Those numbers are **illustrative targets, not yet reproduced**. Running this
> scaffold is what turns them from hypothesis into measurement. Until then, cite them as direction,
> not evidence.

## What it measures

Does an **independent verifier** (fresh context, diff + rubric only, adversarial) actually catch more
real bugs and raise fewer false alarms than **self-critique** (the same model reviewing a diff it is
told it authored, with its own rationale in context)? This is the empirical core of Pillar 2 —
"the verifier never knows the implementer's reasoning."

The design is a **paired, fixed-corpus A/B**: the only variable between arms is the review
*protocol*, never the artifact. Design discipline inspired by [headroom](https://github.com/headroomlabs-ai/headroom)
(TOST-gated evals; no fabricated statistics).

| Arm | Protocol | Context anchoring | Model family |
|-----|----------|-------------------|--------------|
| **A — self-critique** | reviews a diff it is told it authored, WITH the author rationale | yes (reproduces §1.2 bias) | implementer (Opus) |
| **B — independent verifier** | fresh context, diff + rubric ONLY, default-REJECT mandate | no | cross-family (Fable 5) |

Positive class = *bad diff (should be REJECTED)*. The scorecard reports the full confusion matrix
per arm — **precision, recall (bug-detection), false-alarm rate, and miss rate (silent regressions)** —
because the WHITEPAPER's single "false positive" number actually conflates a false alarm (rejecting
good code) with a miss (approving a bug). Real data disambiguates it; that is part of the honesty fix.

## How to run

The runner is a Workflow script (it uses `agent()` for the two arms and scores in pure JS):

```
Workflow({ scriptPath: "benchmarks/verifier_ab.js", args: { kRuns: 30 } })
```

- `kRuns` — runs per (diff × arm). Default 5 = **smoke pilot**. A **publishable** claim needs
  `kRuns` ≥ 30 (agentic evals are noisy: single-run pass@1 swings several points even at temp 0).
- `selfCritiqueModel` / `verifierModel` — override the two arms' models (defaults: Opus / Fable 5).
- The runner emits a scorecard object; the script `status` field says `PILOT` or `RUN (K>=30)`.

**Before trusting any scorecard, validate the instruments** with [negative-control.md](negative-control.md):
a corpus where every arm approves a known-bad diff (or rejects a known-good one) is a broken
thermometer, not model signal.

## The corpus

`corpus/` holds the fixed labeled diffs (format in [corpus/SCHEMA.md](corpus/SCHEMA.md)). Seed = 8
(4 good / 4 bad); the bad diffs are drawn from the harness's own vocabulary — missing authz gate,
SQL injection, `dangerouslySetInnerHTML`, import-confinement break. Grow to ≥20 for a robust claim.

## Honesty contract (the ponytail / headroom standard)

1. **No fabricated statistics.** The scorecard reports raw rates + naive deltas and says so. TOST /
   paired-bootstrap arrive only when K≥30 — the same discipline behind headroom's TOST-gated evals.
2. **Frozen manifest.** Every real run pins its parameters in [MANIFEST.md](MANIFEST.md) (models,
   K, corpus SHA) so anyone can reproduce it.
3. **Self-verified instruments.** The negative control runs before scoring — same discipline as the
   `verifier-protocol.md` Step-6 negative control.
4. **The scaffold is committed; the claim is not made until the run exists.** This file will carry
   the raw numbers + the exact command once a K≥30 run has been executed. It does not yet.

## Jev evals

- `benchmarks/jev_dedupe_eval.js` measures whether loop-gate's dedupe tells a restatement from a new finding, and at which threshold, by re-thresholding one labelled corpus offline. Run `node benchmarks/jev_dedupe_eval.js [--corpus <path>] [--json <out>]`. Exit codes: 0 production thresholds hide no new blocker or major; 1 they hide at least one; 2 corpus malformed; 3 Jev off (no TYPESAFE_API_KEY), nothing measured.
- `benchmarks/jev_router_eval.js` measures whether the prompt-router picks the right skill and tier, and from which confidence its tier can be acted on, over hand-labelled operator prompts. Run `node benchmarks/jev_router_eval.js [--corpus <jsonl>] [--skills <json>] [--json <out>]`, or `--write-skills <out> [--cwd <dir>]` to rebuild the skill snapshot. It always runs the corpus twice and reports mean and range. Exit codes: 0 measured, a tier threshold exists and capped downgrades keep the precision bar, so routeByJev may be enabled; 1 measured, one of the two fails; 2 corpus or skill snapshot malformed; 3 Jev off (no TYPESAFE_API_KEY), nothing measured.
