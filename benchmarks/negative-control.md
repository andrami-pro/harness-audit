# Negative control — validate the instruments before scoring

Same discipline as `verifier-protocol.md` Step 6: *a check that can't say no is a broken thermometer.*
Before any A/B scorecard means anything, the corpus itself must be a valid instrument. Run this once
after editing `corpus/`, and re-run whenever you add diffs.

## The two failure modes it catches

1. **A known-bad diff that no arm can reject** → the bug is not actually detectable from the diff
   alone (missing context), so it measures the corpus's blind spot, not the model. Fix the diff or
   drop it.
2. **A known-good diff that every arm rejects** → the "good" diff actually has a defect, or the rubric
   is over-broad. The label is wrong, not the model. Fix the label or the diff.

## How to run

```
Workflow({ scriptPath: "benchmarks/verifier_ab.js", args: { kRuns: 3 } })
```

Then apply the gate to the returned scorecard **before** trusting any headline delta:

- For **Arm B** (the strong reviewer, no anchoring): on the bad diffs it must reject the clear ones
  (`004-bad-sql-injection`, `006-bad-xss-dangerous-html`) at least once across the K runs. If B
  approves an obvious injection/XSS every single run, the corpus or the rubric is broken — **the run
  is INVALID**, not "self-critique won."
- On the good diffs, at least the behavior-preserving refactor (`005-good-refactor-noop`) must be
  approved by B at least once. If B rejects a pure no-op refactor every run, the reviewer criteria
  are paranoid and every false-alarm number is meaningless.

## Why this protects the honesty fix

Without the negative control, a corpus that is secretly undetectable (all bad diffs need missing
context) would make **both** arms score ~0 recall, and a naive reader could still spin a delta out of
noise. The control forces the corpus to prove it can distinguish good from bad **at all** before the
A/B is allowed to attribute any gap to the review protocol. An instrument that passes its own
negative control is the precondition for the scorecard being about the model, not the thermometer.
