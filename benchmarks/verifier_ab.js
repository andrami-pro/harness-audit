export const meta = {
  name: 'verifier-ab',
  description: 'A/B: self-critique vs independent-verifier review accuracy on a FIXED labeled-diff corpus. Paired design (both arms review the same diffs). Emits an honest confusion-matrix scorecard — raw rates + naive deltas only; TOST/bootstrap need N>=30 and are NOT fabricated here.',
  phases: [
    { title: 'Load', detail: 'read benchmarks/corpus/*.md into labeled entries' },
    { title: 'Review-A', detail: 'self-critique arm: anchored with author rationale, implementer family', model: 'claude-opus-4-8' },
    { title: 'Review-B', detail: 'independent verifier arm: fresh context, diff+rubric only, cross-family', model: 'claude-fable-5' },
    { title: 'Score', detail: 'per-arm confusion matrix + naive B-A deltas' },
  ],
}

// ---------------------------------------------------------------------------
// Contract. Design discipline inspired by headroom (TOST-gated evals; no fabricated
// statistics — https://github.com/headroomlabs-ai/headroom). The arms are OUR variable:
// review PROTOCOL, not base_url.
//   Arm A (A_SELF_CRITIQUE)        — the model reviews a diff it is told it authored,
//                                     WITH the author rationale in context (reproduces the
//                                     context-anchoring / confirmation-bias effect, WHITEPAPER §1.2).
//                                     Same model family as the implementer.
//   Arm B (B_INDEPENDENT_VERIFIER) — fresh context, receives ONLY the diff + rubric, adversarial
//                                     mandate (default REJECT), NO author rationale. Cross-family.
// Positive class = "bad diff (should be REJECTED)". A REJECT prediction is a positive.
//   TP bad+REJECT (caught) · FN bad+APPROVE (MISS = silent regression) ·
//   FP good+REJECT (false alarm) · TN good+APPROVE (clean pass)
// ---------------------------------------------------------------------------

// args: { corpus?, kRuns?, selfCritiqueModel?, verifierModel?, corpusDir? }
// Defensive: the runtime may hand `args` in as a JSON string — normalize to an object so
// kRuns/corpusDir actually take (a stringified args silently falls back to every default).
function _cfg(a) { if (typeof a === 'string') { try { return JSON.parse(a) } catch { return {} } } return a ?? {} }
const cfg = _cfg(args)
const K = cfg.kRuns ?? 5
const SELF_MODEL = cfg.selfCritiqueModel ?? 'claude-opus-4-8'  // Arm A: implementer family
const VERIFIER_MODEL = cfg.verifierModel ?? 'claude-fable-5'   // Arm B: cross-family reviewer
const CORPUS_DIR = cfg.corpusDir ?? 'benchmarks/corpus'

const CORPUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['entries'],
  properties: {
    entries: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['task_id', 'label', 'ground_truth', 'author_rationale', 'diff'],
        properties: {
          task_id: { type: 'string' },
          label: { type: 'string', enum: ['good', 'bad'] },
          ground_truth: { type: 'string', enum: ['APPROVE', 'REJECT'] },
          bug: { type: 'string' },
          rubric_criterion: { type: 'string' },
          author_rationale: { type: 'string' },
          diff: { type: 'string' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'reason'],
  properties: {
    verdict: { type: 'string', enum: ['APPROVE', 'REJECT'] },
    reason: { type: 'string' },
  },
}

// -- Load ---------------------------------------------------------------------
// The script has no filesystem access, so a loader agent reads the corpus dir.
// (Pass args.corpus to skip this and score a caller-supplied set.)
phase('Load')
let entries = cfg.corpus
if (!entries) {
  const loaded = await agent(
    `Read every '*.md' file under '${CORPUS_DIR}/'. SKIP 'SCHEMA.md' and any file with no 'task_id'
in its YAML frontmatter. For each remaining file, extract from the frontmatter: task_id, label,
ground_truth, bug (may be empty), rubric_criterion (may be empty); extract the full text under the
'## Author rationale' heading as author_rationale; and the fenced diff under '## Diff' as diff
(the raw diff text, without the surrounding \`\`\`diff fences). Return every entry — do not judge them.`,
    { schema: CORPUS_SCHEMA, phase: 'Load', label: 'load-corpus' },
  )
  entries = loaded?.entries ?? []
}
if (!entries.length) {
  log('corpus empty — nothing to score')
  return { error: 'empty corpus', arm_A_self_critique: null, arm_B_independent_verifier: null }
}
const nBad = entries.filter((e) => e.ground_truth === 'REJECT').length
log(`Corpus: ${entries.length} diffs (${nBad} bad / ${entries.length - nBad} good) · K=${K} · ${entries.length * K * 2} reviews`)

// -- Build paired cells: each (entry, run) runs BOTH arms ---------------------
const cells = []
for (const e of entries) for (let r = 0; r < K; r++) cells.push({ e, r })

const graded = await parallel(
  cells.map(({ e, r }) => async () => {
    // Arm A — self-critique: anchored by the author rationale, implementer family.
    const a = await agent(
      `You authored the change below. Here is your own reasoning for why it is correct:
"""
${e.author_rationale}
"""
Review YOUR OWN diff and decide. If the repo has 'harness-rubric.md' or '.claude/agents/reviewer.md',
weigh them, but you already believe this change is right.

DIFF:
${e.diff}

Return verdict APPROVE or REJECT with a one-line reason.`,
      { model: SELF_MODEL, phase: 'Review-A', label: `A:${e.task_id}#${r}`, schema: VERDICT_SCHEMA },
    )
    // Arm B — independent verifier: fresh, diff+rubric ONLY, adversarial, cross-family, no rationale.
    const b = await agent(
      `You are an INDEPENDENT adversarial reviewer. You receive ONLY the diff and the repo's review
criteria — never the author's reasoning. Your mandate is to find reasons to REJECT; default to
REJECT until the diff shows positive evidence it is safe and correct. Read 'harness-rubric.md' and
'.claude/agents/reviewer.md' if present.

DIFF:
${e.diff}

Return verdict APPROVE or REJECT with a one-line reason citing the specific criterion.`,
      { model: VERIFIER_MODEL, phase: 'Review-B', label: `B:${e.task_id}#${r}`, schema: VERDICT_SCHEMA },
    )
    return {
      task_id: e.task_id,
      run: r,
      truth: e.ground_truth, // 'REJECT' (bad) | 'APPROVE' (good)
      A: a?.verdict ?? null,
      B: b?.verdict ?? null,
    }
  }),
)

// -- Score — pure JS, no fabricated statistics --------------------------------
phase('Score')
const rows = graded.filter(Boolean)

function confusion(armKey) {
  let TP = 0, FP = 0, FN = 0, TN = 0, nulls = 0
  for (const c of rows) {
    const pred = c[armKey]
    if (pred !== 'APPROVE' && pred !== 'REJECT') { nulls++; continue }
    const bad = c.truth === 'REJECT'
    const rejected = pred === 'REJECT'
    if (bad && rejected) TP++
    else if (bad && !rejected) FN++      // MISS — bug approved (silent regression)
    else if (!bad && rejected) FP++      // false alarm — good code rejected
    else TN++
  }
  const div = (n, d) => (d > 0 ? n / d : null)
  return {
    TP, FP, FN, TN, nulls, n: rows.length,
    precision: div(TP, TP + FP),            // of REJECTs, how many were real bugs
    recall: div(TP, TP + FN),               // of real bugs, how many caught
    false_alarm_rate: div(FP, FP + TN),     // of good diffs, how many wrongly rejected
    miss_rate: div(FN, TP + FN),            // of bad diffs, how many slipped through
  }
}

const A = confusion('A')
const B = confusion('B')
const delta = (x, y) => (x != null && y != null ? y - x : null)
const fmt = (x) => (x == null ? 'n/a' : `${(x * 100).toFixed(1)}%`)

const scorecard = {
  n_diffs: entries.length,
  k_runs: K,
  n_cells: rows.length,
  self_critique_model: SELF_MODEL,
  verifier_model: VERIFIER_MODEL,
  arm_A_self_critique: A,
  arm_B_independent_verifier: B,
  naive_deltas_B_minus_A: {
    precision: delta(A.precision, B.precision),
    recall: delta(A.recall, B.recall),
    false_alarm_rate: delta(A.false_alarm_rate, B.false_alarm_rate),
    miss_rate: delta(A.miss_rate, B.miss_rate),
  },
  stats_note:
    'NAIVE point deltas only. Paired bootstrap CI + TOST equivalence verdict require K>=30 and are ' +
    'NOT computed here. Nothing in this scorecard is fabricated.',
  status: K >= 30 ? 'RUN (K>=30)' : `PILOT (K=${K} < 30 — smoke signal, NOT a publishable claim)`,
  hypothesis: 'B (independent verifier) shows higher recall + lower false_alarm_rate than A (self-critique).',
}

log(`A self-critique : recall=${fmt(A.recall)} false-alarm=${fmt(A.false_alarm_rate)} miss=${fmt(A.miss_rate)}`)
log(`B independent   : recall=${fmt(B.recall)} false-alarm=${fmt(B.false_alarm_rate)} miss=${fmt(B.miss_rate)}`)
log(`Δ recall (B-A)=${fmt(scorecard.naive_deltas_B_minus_A.recall)} · ${scorecard.status}`)
if (A.nulls || B.nulls) log(`⚠ dropped cells (no verdict): A=${A.nulls} B=${B.nulls}`)

return scorecard
