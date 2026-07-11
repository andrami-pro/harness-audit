# Corpus entry schema

Each `NNN-<label>-<slug>.md` file is one labeled diff — a fixed instrument the A/B harness
reviews. The corpus is **paired**: both arms review the exact same diffs, so the only variable
is the review protocol (self-critique vs independent verifier), never the artifact.

Format (YAML frontmatter + two markdown sections):

```md
---
task_id: "002-bad-missing-authz"   # stable id; matches filename
label: bad                          # good | bad
ground_truth: REJECT                # REJECT (bad diff must be caught) | APPROVE (good diff)
bug: "one-line description of the defect (empty for good diffs)"
rubric_criterion: "which review criterion catches it (empty for good diffs)"
---

## Author rationale
<A confident, plausible justification the "author" gives. Shown ONLY to Arm A
 (self-critique) to reproduce the context-anchoring / confirmation-bias effect the
 WHITEPAPER §1.2 names. For bad diffs this is confident-but-wrong; for good diffs it is truthful.
 Arm B (independent verifier) NEVER sees this — it receives only the diff + rubric.>

## Diff
```diff
<a unified diff, ~10–25 lines>
```
```

## Design rules

- **Balanced classes.** Keep good ≈ bad so precision/false-alarm rates are meaningful.
- **Bugs come from the harness's own vocabulary** (import confinement, missing approval/authz
  gate, `dangerouslySetInnerHTML`, SQL injection) so the corpus tests exactly the failure modes
  the reviewer is meant to catch.
- **Good diffs include at least one behavior-preserving refactor** — a rubber-stamp reviewer that
  approves everything scores high recall but terrible false-alarm rate; a paranoid one that rejects
  everything scores the inverse. Only balanced judgement wins on both axes.
- **Ground truth is the label, not any model's opinion.** Validate the corpus with
  `../negative-control.md` before trusting any scorecard: a bad diff every arm approves and a good
  diff every arm rejects are broken instruments, not model signal.

## Growth target

Seed = 8 diffs. For a **publishable** claim, grow to ≥20 diffs and run K≥30 (see `../MANIFEST.md`).
