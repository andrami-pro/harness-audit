export const meta = {
  name: 'develop-phase',
  description: 'Scout → Analyst → Implementer → Reviewer adversarial loop against harness-rubric.md, a Preflight gate, then an optional commit. Called through a project wrapper that passes its config.',
  phases: [
    { title: 'Scout', detail: 'Gather context into a short brief (read-only)', model: 'haiku' },
    { title: 'Plan', detail: 'Turn the brief into a short plan, or stop on a blocker', model: 'opus' },
    { title: 'Implement', detail: 'Write code against the PRD + brief + plan', model: 'opus' },
    { title: 'Review', detail: 'Find reasons to reject (independent verifier > self-critique)', model: 'fable' },
    { title: 'Preflight', detail: "Run the project's preflight gate", model: 'sonnet' },
    { title: 'Commit', detail: 'Commit on the current branch when approved and the gate is green', model: 'sonnet' },
  ],
}

// One script for every project. A project never forks it: its wrapper (.claude/workflows/develop-phase.js,
// written by the harness-audit skill) passes the project's config, and the caller's args override it.
//
// args (config and per-run, merged by the wrapper):
//   task            what to build (default: the active task in TASKS.md or equivalent)
//   phase           PRD phase number, for the default `prd` hint
//   maxIter         review rounds before giving up (default 5)
//   preparer        false skips Scout + Plan: on a one-file task they cost more than the implementation
//   lang            deliverable language: 'en' | 'fr' | 'es' | … — the commit message is written in it
//   models          { scout, analyst, implementer, reviewer, preflight, commit } — the line-up (Step 4a)
//   analystModel, reviewerModel   per-run shortcuts for models.analyst / models.reviewer
//   agentTypes      { scout, analyst, implementer, reviewer } — subagent types to run each seat as
//   context         what the scout reads (and the implementer, when there is no brief)
//   prd             where the active PRD is
//   preflight       the project's gate command (default 'npm run preflight')
//   forbidden       commands the implementer must never run (deploys, remote migrations, …)
//   analystRules, implementerRules, reviewerCriteria   extra lines for those three prompts
//   externalReview  the bridge a provider-qualified reviewer runs through (default scripts/external-review.sh)
//   commit          true: commit on the current branch when approved and the gate is green
//   commitRules     extra rules for the commit message
//   integrate       the command that integrates a committed branch, named in nextStep
//   doneStep        what the human does with an approved, green, uncommitted change (default: git add -p && git
//                   commit) — a project whose code git does not track names its own way to keep the change
const cfg = args && typeof args === 'object' ? args : { task: typeof args === 'string' ? args : undefined }
const task = cfg.task ?? 'implement the active task in TASKS.md or equivalent'
const maxIter = cfg.maxIter ?? 5
const preparer = cfg.preparer !== false
const doCommit = cfg.commit === true
const LANGS = { en: 'English', fr: 'French', es: 'Spanish', de: 'German', it: 'Italian', pt: 'Portuguese' }
const language = LANGS[cfg.lang] ?? cfg.lang ?? 'English'
const list = (v) => (Array.isArray(v) ? v : v ? [v] : [])

const MODELS = {
  scout: 'haiku', analyst: 'opus', implementer: 'opus', reviewer: 'fable', preflight: 'sonnet', commit: 'sonnet',
  ...(cfg.models ?? {}),
}
if (cfg.analystModel) MODELS.analyst = cfg.analystModel
if (cfg.reviewerModel) MODELS.reviewer = cfg.reviewerModel
const TYPES = cfg.agentTypes ?? {}
const seat = (name, extra) => ({ model: MODELS[name], ...(TYPES[name] ? { agentType: TYPES[name] } : {}), ...extra })

const prdHint = cfg.prd ?? (cfg.phase ? `docs/prd/prd-phase-${cfg.phase}-*.md` : 'the active phase in TASKS.md or equivalent')
// A project's context list and a per-run PRD both reach the seats: the PRD names this run's spec.
const readFirst = list(cfg.context).length
  ? [...list(cfg.context), ...(cfg.prd ? [cfg.prd] : [])].join(', ')
  : `memory/, ${prdHint}, TASKS.md or equivalent`
const PREFLIGHT_CMD = cfg.preflight ?? 'npm run preflight'
const BRIDGE = cfg.externalReview ?? 'scripts/external-review.sh'

log(`Task: "${task}" · max ${maxIter} iter · ${preparer ? `Scout=${MODELS.scout} · Analyst=${MODELS.analyst} · ` : ''}Implementer=${MODELS.implementer} · Reviewer=${MODELS.reviewer}`)

// Every early exit is a 'blocked' handoff, never an exception: the caller reads one contract.
const stop = (summary, blocker, iterations = 0, evidence = []) => ({
  task, iterations, approved: false, preflightPassed: false, commit: null,
  handoff: { status: 'blocked', summary, evidence, blocker },
  nextStep: blocker,
})
// agent() returns null when a seat dies (network, API) or the human skips it: never interpolate that
// "null" into the next prompt, never call .trim() on it.
const crash = (who, iteration) => stop(
  `The ${who} returned nothing in iteration ${iteration} (seat died or was skipped)`,
  'Run git status before re-running: the implementer may have left half-finished changes', iteration)

// D25a at run time: reviewer and implementer must not share a model family, or "independent review" is
// self-critique. Crude on purpose (an alias, or the vendor segment of a provider-qualified id);
// scripts/model-lineup.js is the full check.
const familyOf = (m) => {
  const id = String(m).replace(/^[^/]+\//, '')
  const claude = id.match(/(?:^|\/)(?:claude-)?(opus|fable|sonnet|haiku|mythos)/)
  return claude ? `claude-${claude[1]}` : id.split('/')[0]
}
if (familyOf(MODELS.reviewer) === familyOf(MODELS.implementer)) {
  return stop('Reviewer and implementer share a model family',
    `Both resolve to "${familyOf(MODELS.reviewer)}" — change reviewerModel to another family (D25a has no override)`)
}

// Scout and Plan run once, outside the loop. They are a cost optimisation, not a gate: if a seat dies the
// run continues without it and the implementer explores on its own.
let brief = '', plan = ''
if (preparer) {
  phase('Scout')
  brief = await agent(
    `You are the scout of a development loop. Read-only: do not edit or create files, run nothing that writes.
If a code graph exists (graphify-out/graph.json), query it first (\`graphify query "<question>"\`); otherwise use Grep/Glob.
Open raw files only afterwards, for specific lines.
Read only what is relevant of: ${readFirst}.
TASK: ${task}
Return a brief of at most 400 words, no filler:
- Relevant files: path:line + one sentence (what it does, why it matters)
- Rules from the PRD and project docs that apply (short quotes)
- Existing tests in that area (paths)
- Open questions or ambiguities a human should settle
Do not propose the solution.`,
    seat('scout', { label: 'scout', phase: 'Scout' })
  ) ?? ''
  if (!brief) log('⚠ Scout returned nothing — the implementer explores on its own')

  if (brief) {
    phase('Plan')
    plan = await agent(
      `You are the analyst of a development loop. Read-only: edit nothing.
You receive the task and a scout's brief. Verify in the code only what you doubt in the brief
(open the cited files; query the code graph before grepping).
TASK: ${task}
BRIEF:
${brief}
Return a plan of at most 300 words:
1. Ordered steps, each with the file it touches.
2. Tests to add or adjust (the reviewer demands regression coverage when existing logic changes).
3. Risks, and what NOT to touch (out of the PRD's scope). Every risk you name is binding on the implementer.
If the brief is not enough or an ambiguity blocks the work, the FIRST line is "BLOCKER: <reason>" and nothing else.
No full code: the implementer writes it.${list(cfg.analystRules).map((r) => `\n${r}`).join('')}`,
      seat('analyst', { label: 'analyst', phase: 'Plan' })
    ) ?? ''
    if (!plan) log('⚠ Analyst returned nothing — the implementer works from the brief alone')
    else if (plan.trimStart().startsWith('BLOCKER:')) {
      log('⛔ The analyst found a blocker — stopping before the implementer runs')
      return stop('The analyst needs a decision before implementation', plan.trim(), 0, [brief])
    }
  }
}
const context = brief
  ? `A scout and an analyst prepared the context: start from it, open the original only when something does not add up
or to write code, and do not re-explore the repo. The plan's risks are binding.
BRIEF:
${brief}
${plan ? `\nPLAN:\n${plan}\n` : ''}
Read: harness-rubric.md, .claude/agents/implementer.md.`
  : `Read: ${readFirst}, harness-rubric.md, .claude/agents/implementer.md.`
const forbidden = list(cfg.forbidden)
const implementerRules = [
  ...(forbidden.length ? [`FORBIDDEN, never run: ${forbidden.join(', ')}.`] : []),
  ...list(cfg.implementerRules),
].join('\n')

// The verdict is the LAST line, compared whole. A substring test reads "[FAIL] … not APPROVED" as an
// approval, and one stray word opens the loop. A project's own bridge may answer in its language.
const APPROVE = new Set(['APPROVED', 'APROBADO', 'APPROUVÉ', 'APPROUVE'])
const verdictOf = (review) => APPROVE.has(review.trim().split('\n').pop().replace(/[*`_\s]/g, ''))

let approved = false, lastImpl = '', lastReview = '', iteration = 0

while (!approved && iteration < maxIter) {
  iteration++
  log(`── Iteration ${iteration}/${maxIter} ──`)

  phase('Implement')
  const correctionCtx = iteration > 1
    ? `\n\n⚠ Reviewer REJECTED. Reasons:\n${lastReview}\n\nFix ONLY the [FAIL] items.`
    : ''

  lastImpl = await agent(
    `Act as the implementer defined in .claude/agents/implementer.md.
${implementerRules ? `${implementerRules}\n` : ''}${context}
TASK: ${task}${correctionCtx}
When done: list created/modified files + a description of each change.`,
    seat('implementer', { label: `impl:iter${iteration}`, phase: 'Implement' })
  )
  if (!lastImpl) return crash('implementer', iteration)

  phase('Review')
  if (MODELS.reviewer.includes('/')) {
    // Provider-qualified id: agent() dispatches Anthropic models only, so a cheap seat runs the bridge in
    // ONE foreground call and relays its stdout untouched.
    const r = await agent(
      `Run exactly this and change nothing: ${BRIDGE} ${MODELS.reviewer}
Run it ONCE, in the foreground, with the maximum Bash timeout (timeout: 600000); it takes 2-4 minutes. Do not background it or poll it.
Return in "output" the COMPLETE stdout, character for character, without summarising or commenting.
If the command fails, return the error in "output" followed by a last line REJECTED.`,
      { model: MODELS.scout, label: `review:iter${iteration}`, phase: 'Review',
        schema: { type: 'object', additionalProperties: false, required: ['output'], properties: { output: { type: 'string' } } } }
    )
    lastReview = r?.output ?? ''
  } else {
    lastReview = await agent(
      `Act as the adversarial reviewer defined in .claude/agents/reviewer.md.
You receive ONLY artifacts — never the implementer's reasoning.
Mandate: find reasons to REJECT. Default = FAIL until there is evidence of PASS.

Implementation received:
${lastImpl}

Read harness-rubric.md and .claude/agents/reviewer.md from the repo.
Evaluate the reviewer's mandatory criteria.${list(cfg.reviewerCriteria).map((c) => `\n${c}`).join('')}
Format: [PASS|FAIL] criterion — concrete evidence
Last line (no extra text): APPROVED or REJECTED`,
      seat('reviewer', { label: `review:iter${iteration}`, phase: 'Review' })
    )
  }
  if (!lastReview) return crash('reviewer', iteration)

  approved = verdictOf(lastReview)
  log(approved ? `✓ APPROVED iter ${iteration}` : `✗ REJECTED — correcting`)
}

if (!approved) log(`⚠ Did not converge after ${maxIter} iter — escalate to the human`)

phase('Preflight')
// The runtime has no shell, so a seat runs the gate — and reports FIELDS, not prose. A substring test
// for "pass" turns "3 passed, 2 failed", "bypass", or a SKIP followed by the gate's closing PASS
// banner into a green preflight. An exit code and a list of skipped checks cannot be misread that way.
const PREFLIGHT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['exitCode', 'skipped', 'failedCheck', 'tail'],
  properties: {
    exitCode: { type: 'integer' },
    skipped: { type: 'array', items: { type: 'string' } },
    failedCheck: { type: ['string', 'null'] },
    tail: { type: 'string' },
  },
}
const preflight = await agent(
  `Run exactly this and change nothing: ${PREFLIGHT_CMD}; echo "EXIT=$?"
Report, without interpreting:
- exitCode: the number printed after EXIT=
- skipped: every output line that reports a check as skipped or not run (SKIP, skipped, ⊘, "not verified"), verbatim
- failedCheck: the check that failed, or null when exitCode is 0
- tail: the last 60 lines of output, verbatim
Do not fix anything.`,
  { model: MODELS.preflight, label: 'preflight', phase: 'Preflight', schema: PREFLIGHT_SCHEMA }
)

// A skipped check is not a passed one: exit 0 with a SKIP is NOT VERIFIED, and the handoff says so.
const skipped = preflight?.skipped ?? []
const preflightPassed = preflight?.exitCode === 0 && skipped.length === 0
const preflightState = preflightPassed ? 'PASS'
  : preflight?.exitCode === 0 ? `NOT VERIFIED (${skipped.length} skipped)`
  : `FAIL (exit ${preflight?.exitCode ?? '?'}${preflight?.failedCheck ? ` · ${preflight.failedCheck}` : ''})`
log(`Preflight: ${preflightState}`)

// The commit stays on the current branch and holds only what this run changed. The run may be launched from
// the project's main checkout, where the user keeps uncommitted work of their own: `git add -A` would sweep it
// into the loop's commit, so the seat stages the implementer's files by name, and refuses a file whose diff
// carries changes the task did not make. The message is a deliverable, written in the project's language.
const COMMIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['committed', 'hash', 'message', 'note'],
  properties: {
    committed: { type: 'boolean' },
    hash: { type: ['string', 'null'] },
    message: { type: ['string', 'null'] },
    note: { type: 'string' },
  },
}
let commit = null
if (approved && preflightPassed && doCommit) {
  phase('Commit')
  commit = await agent(
    `In the current checkout, without switching branches. The working tree may also hold the user's own
uncommitted work: it must stay out of this commit.
1. From the implementer's report below, list the files this run created or modified. Run \`git status --short\`.
   If none of them has changes, committed=false and say why in note.
2. For each of those files, read \`git diff -- <file>\` (or the whole file when it is new). If a file carries
   changes the task did not make, commit nothing: committed=false, and name the file in note.
3. \`git add -- <those files>\` (by name; NEVER \`git add -A\`, \`git add .\` or \`git commit -a\`), then
   \`git commit -m "<message>"\`. The message is ONE line in ${language}, conventional format
   (feat:/fix:/chore:), ≤ 90 characters, describing what was done for: ${task}
   Never use --no-verify.${list(cfg.commitRules).map((r) => `\n   ${r}`).join('')}
4. Return hash (git rev-parse --short HEAD), message and a short note naming the files committed.

IMPLEMENTER'S REPORT:
${lastImpl}`,
    { model: MODELS.commit, label: 'commit', phase: 'Commit', schema: COMMIT_SCHEMA }
  )
  log(commit?.committed ? `✓ commit ${commit.hash} — ${commit.message}` : `⚠ no commit: ${commit?.note ?? 'the seat returned nothing'}`)
}

// The handoff is what the seats REPORT: the reviewer's [PASS|FAIL] lines are its evidence, the open
// [FAIL] lines are its blocker. Nothing in this runtime can re-run them, so the label says so.
const verdictLines = lastReview.split('\n').filter((l) => /^\[(PASS|FAIL)\]/.test(l))
const openFails = verdictLines.filter((l) => l.startsWith('[FAIL]'))
const handoff = {
  status: approved && preflightPassed ? 'complete' : approved ? 'continue' : 'blocked',
  summary: approved
    ? `Reviewer approved after ${iteration} iteration(s); preflight ${preflightState}${commit?.committed ? `; commit ${commit.hash}` : ''}`
    : `Reviewer still rejects after ${maxIter} iteration(s)`,
  evidence: [...verdictLines, `preflight: ${preflightState}`, ...skipped.map((l) => `preflight skipped: ${l}`)],
  ...(approved ? {} : { blocker: openFails.join(' · ') || 'reviewer returned REJECTED with no [FAIL] line' }),
}
const LABEL = 'Reported by the implementer/reviewer seats — not independently certified: '
const integrate = cfg.integrate ? `, then ${cfg.integrate}` : ''

return {
  task, iterations: iteration, approved, preflightPassed, commit, handoff,
  nextStep: LABEL + (approved && preflightPassed
    ? (commit?.committed ? `committed ${commit.hash}${integrate}` : `${cfg.doneStep ?? 'git add -p && git commit'}${integrate}`)
    : approved && preflight?.exitCode === 0 ? 'Preflight skipped checks — supply what they need and re-run; a SKIP is not a PASS'
    : approved ? 'Preflight failed — fix before commit'
    : `Did not converge — review remaining [FAIL] after ${maxIter} iter and report to the human`),
}
