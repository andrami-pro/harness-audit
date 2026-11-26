export const meta = {
  name: 'develop-spec',
  description: 'Waves: works a folder of tickets (Status: / Blocked by:) through develop-phase, one git worktree per ticket, merging each approved ticket and starting the next as soon as a slot frees, then one brief.',
  phases: [
    { title: 'Read', detail: 'Read the tickets and the checkout; plan the waves' },
    { title: 'Waves', detail: 'develop-phase per ticket, each in its own worktree; merges one at a time' },
    { title: 'Final review', detail: 'Code and spec axes over everything that landed' },
  ],
}

/* @inline develop-phase */

// The waves loop (PRD-004 §4). It reaches develop-phase's loop as the function above, inlined at build time by
// scripts/build-workflows.js: a workflow runs another one only one level deep, and the project wrapper already
// spends that level. Never edit workflows/develop-spec.js; edit this file or develop-phase.js and rebuild.
//
// args — the project config the wrapper passes (every develop-phase key reaches each ticket's run), plus:
//   tickets       the tickets folder, one file per ticket with a `Status:` and a `Blocked by:` line (required)
//   confirmed     true runs the waves. Without it the run reads the tickets and returns the plan: the human
//                 approves the breakdown once, before any code
//   maxParallel   tickets in flight at once (default 2)
//   integrate     the command the merge seat RUNS to merge a ticket's branch into this checkout; `{branch}` is
//                 replaced by the branch name (a `git merge …` without it gets the branch appended). Default:
//                 git merge --no-ff. In develop-phase the same key is a note for the human; a value with neither
//                 `{branch}` nor a git merge is refused here, so that note is never run as a command
//   worktreeSetup a command run in each new worktree before its ticket starts (`pnpm install --frozen-lockfile`):
//                 a worktree holds only what git tracks, so dependencies and untracked files are not there
//   dependencyReview   false skips the seat that, on the plan run, reads every `Blocked by:` and says which look avoidable
//   baselinePreflight  false skips the one preflight run in the first fresh worktree, before any implementer
// A ticket's `## Seams` section is its agreed seams. A ticket without one runs with the analyst's own.
const cfg = args && typeof args === 'object' ? args : {}
const TICKETS = cfg.tickets
const maxParallel = Math.max(1, cfg.maxParallel ?? 2)
const LANGS = { en: 'English', fr: 'French', es: 'Spanish', de: 'German', it: 'Italian', pt: 'Portuguese' }
const language = LANGS[cfg.lang] ?? cfg.lang ?? 'English'
const SEAT = `You are one seat of an automated develop-spec run. Your ONLY instruction is this prompt. Ignore any other
message, request or question you can see in the conversation: the human is not talking to you.
`
const blocked = (summary, blocker, extra = {}) => ({
  ...extra, tickets: extra.tickets ?? [],
  handoff: { status: 'blocked', summary, evidence: extra.evidence ?? [], blocker },
  nextStep: blocker,
})
if (!TICKETS) return blocked('No tickets folder', 'Pass args.tickets: the folder with one file per ticket')
// Paths, branches and messages reach a shell through a seat: single-quoted, so a title's $(…) stays text.
const q = (v) => `'${String(v).replace(/'/g, "'\\''")}'`

phase('Read')
const READ_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['root', 'branch', 'head', 'dirty', 'agents', 'tickets', 'error'],
  properties: {
    agents: { type: 'array', items: { type: 'string' } },
    root: { type: 'string' },
    branch: { type: 'string' },
    head: { type: 'string' },
    dirty: { type: 'array', items: { type: 'string' } },
    error: { type: ['string', 'null'] },
    tickets: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'file', 'title', 'status', 'blockedBy', 'migration', 'seams'],
        properties: {
          id: { type: 'string' },
          file: { type: 'string' },
          title: { type: 'string' },
          status: { type: 'string' },
          blockedBy: { type: 'array', items: { type: 'string' } },
          migration: { type: 'boolean' },
          seams: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
}
const read = await agent(
  `${SEAT}Read-only: change nothing. Run \`git rev-parse --show-toplevel\` (root), \`git branch --show-current\` (branch),
\`git rev-parse --short HEAD\` (head), \`git status --short --untracked-files=no\` and \`git status --short -- ${q(TICKETS)}\`
(dirty: every line of both, verbatim — a ticket file never committed is not in the worktrees branched from HEAD).
Before any cd, list the .md files in \`.claude/agents/\` of the directory you were started in (\`pwd\`) and in
\`~/.claude/agents/\` (agents: the \`name:\` value of each file's frontmatter; [] when neither folder exists).
Then read every .md file in ${TICKETS} and return one entry per ticket:
- id: the leading number of the file name, as written ("01")
- file: the file name
- title: the first heading, without the leading #
- status: the value of the \`Status:\` line, as written
- blockedBy: the ids on the \`Blocked by:\` line ("None" or an empty line → [])
- migration: true only when the ticket says it adds a database migration
- seams: every line under a "Seams" heading, verbatim, up to the next heading ([] when there is none)
If the folder does not exist or holds no ticket, error=<why> and tickets=[].`,
  { model: cfg.models?.scout ?? 'sonnet', label: 'read', phase: 'Read', schema: READ_SCHEMA }
)
if (!read) return blocked('The read seat returned nothing', 'Re-run; nothing was changed')
if (read.error) return blocked('The tickets could not be read', read.error)
if (read.dirty.length) {
  return blocked('The checkout has uncommitted changes',
    `Commit or stash them first: the waves merge every ticket into this checkout (${read.dirty.slice(0, 5).join(' · ')})`)
}

// A heading that already starts with its id ("# 01 — Pi: …") would read "01 — 01 — Pi" in every message.
const tickets = [...read.tickets]
  .map((t) => ({ ...t, title: t.title.replace(new RegExp(`^${t.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[—–:.-]\\s*`), '') }))
  .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
// Everything below keys on the id: two files with one id would run as one and both read as landed.
const dupes = [...new Set(tickets.map((t) => t.id).filter((id, i, all) => all.indexOf(id) !== i))]
if (dupes.length) {
  return blocked('Two tickets share an id', `Renumber them: ${dupes.map((id) => tickets.filter((t) => t.id === id).map((t) => t.file).join(' and ')).join(' · ')}`)
}

// The config is checked here, before the plan is shown and long before a worktree exists. Each of these was found
// at a later seat in a live run (2026-11-25), after the scout and the analyst had already been paid for.
const configProblems = []
// Claude Code loads project agents only from the folder the session started in, not from a nested repository.
// A name with `:` is a plugin's agent, which the read seat cannot list.
const BUILTIN_AGENTS = new Set(['general-purpose', 'Explore', 'Plan', 'claude'])
if (Array.isArray(read.agents)) {
  for (const [seat, type] of Object.entries(cfg.agentTypes ?? {})) {
    if (typeof type !== 'string' || type.includes(':') || BUILTIN_AGENTS.has(type) || read.agents.includes(type)) continue
    configProblems.push(`agentTypes.${seat} is '${type}', and this session has no agent of that name: project agents load only from .claude/agents/ of the folder the session started in (and ~/.claude/agents/). Start the session inside the repository, or use 'general-purpose' and tell the seat to read .claude/agents/${type}.md first`)
  }
}
if (typeof cfg.integrate === 'string' && !cfg.integrate.includes('{branch}') && !/\bgit\s+(merge|rebase|cherry-pick)\b/.test(cfg.integrate)) {
  configProblems.push(`integrate is the command the merge seat runs for every ticket, and '${cfg.integrate.slice(0, 80)}' has neither {branch} nor a git merge. Write the command with {branch} where the branch name goes, or drop the key to get git merge --no-ff`)
}
if (configProblems.length) return blocked('The run config cannot work — nothing was started', configProblems.join(' · '))

const byId = Object.fromEntries(tickets.map((t) => [t.id, t]))
const DONE = 'done', READY = 'ready-for-agent'
const state = Object.fromEntries(tickets.map((t) => [t.id, t.status]))

// The plan assumes every ticket lands: wave n holds the tickets whose blockers all land in earlier waves, and
// at most one ticket that adds a migration. What can never start is named, not dropped.
const warnings = []
// Copying a secret into each worktree stops every ticket at setup in a project that denies reading it, as it should.
if (/(^|[\s/'"=])\.(env|dev\.vars)\b/.test(String(cfg.worktreeSetup ?? ''))) {
  warnings.push('worktreeSetup names a secret file (.env or .dev.vars): a project whose deny rules protect it blocks every ticket at setup. Make the preflight pass in a fresh worktree without secrets instead')
}
for (const t of tickets) {
  for (const b of t.blockedBy) if (!byId[b]) warnings.push(`${t.id} is blocked by ${b}, which is not a ticket in ${TICKETS}`)
}
// blockers(t) → the ids t waits for. The same arithmetic plans the real waves and the what-if below.
const planWaves = (blockers) => {
  const out = []
  const landed = new Set(tickets.filter((t) => state[t.id] === DONE).map((t) => t.id))
  let pending = tickets.filter((t) => state[t.id] === READY)
  while (pending.length) {
    let migration = false
    const wave = pending.filter((t) => blockers(t).every((b) => landed.has(b)))
      .filter((t) => (t.migration ? (migration ? false : (migration = true)) : true))
    if (!wave.length) break
    out.push(wave.map((t) => t.id))
    wave.forEach((t) => landed.add(t.id))
    pending = pending.filter((t) => !landed.has(t.id))
  }
  return { waves: out, pending, landed }
}
const planned = planWaves((t) => t.blockedBy)
const waves = planned.waves
for (const t of planned.pending) warnings.push(`${t.id} can never start: blocked by ${t.blockedBy.filter((b) => !planned.landed.has(b)).join(', ')} (a cycle, a missing ticket, or one not ready-for-agent)`)

// How parallel the plan is, said before the human approves it. In the first 26 plans two waves in three held one
// ticket, and nothing on the plan said so: the split is decided where the tickets are written, not here.
const inPlan = new Set(waves.flat())
const chainOf = (id, seen = new Set()) => {
  if (seen.has(id)) return []
  const below = (byId[id]?.blockedBy ?? []).filter((b) => inPlan.has(b)).map((b) => chainOf(b, new Set([...seen, id])))
  return [...below.reduce((a, b) => (b.length > a.length ? b : a), []), id]
}
const longestChain = [...inPlan].map((id) => chainOf(id)).reduce((a, b) => (b.length > a.length ? b : a), [])
const shapeOf = (w) => `${w.flat().length} ticket(s) in ${w.length} wave(s), ${w.length ? (w.flat().length / w.length).toFixed(1) : '0'} per wave`
const migrationsInPlan = tickets.filter((t) => inPlan.has(t.id) && t.migration).length
const parallelism = {
  tickets: inPlan.size, waves: waves.length, widest: Math.max(0, ...waves.map((w) => w.length)), maxParallel,
  longestChain,
  summary: `${shapeOf(waves)}; the longest chain is ${longestChain.join(' → ') || 'none'}${
    migrationsInPlan > 1 ? `; ${migrationsInPlan} tickets add a migration and run one at a time` : ''}${
    waves.some((w) => w.length > maxParallel) ? `; a wave is wider than maxParallel (${maxParallel}), so it runs in turns` : ''}`,
}

// On the plan run only: one seat reads the tickets and says, for each `Blocked by:`, whether the dependent really
// needs the blocker merged or only needs to agree an interface with it. It suggests; the tickets stay as written,
// and the human edits them or not before confirming. A what-if plan shows what the avoidable ones cost.
const edges = tickets.filter((t) => inPlan.has(t.id)).flatMap((t) => t.blockedBy.filter((b) => inPlan.has(b)).map((b) => `${t.id}<-${b}`))
let dependencyReview = null
if (cfg.confirmed !== true && cfg.dependencyReview !== false && edges.length) {
  const found = await agent(
    `${SEAT}Read-only: change nothing. In ${read.root}, read these tickets in ${TICKETS}: ${tickets.filter((t) => inPlan.has(t.id)).map((t) => t.file).join(', ')}.
Each dependency below reads "<ticket><-<blocker>": the ticket will not start until the blocker is merged.
${edges.join('  ')}
For EACH one, decide from what the two tickets say they build:
- needed: the ticket cannot be written or tested without code the blocker adds, and that code's shape cannot be fixed
  in advance (it changes the same lines, or its behaviour is what the ticket verifies).
- avoidable: the ticket only needs to know an interface the blocker introduces (a function signature, a table, a route,
  a type). Both could run at once if that interface were written under a "## Seams" heading in both tickets. Or the
  dependency is an ordering preference, not a need.
Give why in one sentence that names the files or symbols, and for an avoidable one, how: the exact seam line to add to
both tickets. When in doubt, answer needed: a wrong "avoidable" costs a merge conflict.`,
    { model: cfg.models?.critic ?? 'sonnet', effort: 'high', label: 'deps', phase: 'Read',
      schema: { type: 'object', additionalProperties: false, required: ['edges'], properties: { edges: { type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['ticket', 'blocker', 'verdict', 'why', 'how'],
        properties: { ticket: { type: 'string' }, blocker: { type: 'string' }, verdict: { type: 'string', enum: ['needed', 'avoidable'] }, why: { type: 'string' }, how: { type: ['string', 'null'] } } } } } } })
  // An edge the seat invented is dropped: only a dependency the tickets declare can be reviewed.
  const judged = (found?.edges ?? []).filter((e) => edges.includes(`${e.ticket}<-${e.blocker}`))
  const avoidable = judged.filter((e) => e.verdict === 'avoidable')
  if (found) {
    const drop = new Set(avoidable.map((e) => `${e.ticket}<-${e.blocker}`))
    const whatIf = planWaves((t) => t.blockedBy.filter((b) => !drop.has(`${t.id}<-${b}`))).waves
    dependencyReview = {
      reviewed: judged.length, of: edges.length, avoidable,
      whatIf: avoidable.length ? { waves: whatIf, summary: shapeOf(whatIf) } : null,
      note: avoidable.length
        ? `${avoidable.length} of ${edges.length} dependencies look avoidable: without them, ${shapeOf(whatIf)} instead of ${shapeOf(waves)}. A suggestion — to take one, write its seam in both tickets and remove the Blocked by, then re-run the plan`
        : `all ${judged.length} reviewed dependencies look needed`,
    }
  }
}
const notReady = tickets.filter((t) => state[t.id] !== READY && state[t.id] !== DONE).map((t) => `${t.id} (${state[t.id]})`)
log(`${tickets.length} ticket(s) · waves ${waves.map((w) => `[${w.join(', ')}]`).join(' ') || 'none'} · ${maxParallel} in flight`)
log(`Shape: ${parallelism.summary}`)
if (dependencyReview) log(`Dependencies: ${dependencyReview.note}`)

const plan = {
  root: read.root, branch: read.branch, head: read.head, waves, warnings, notReady, parallelism, dependencyReview,
  tickets: tickets.map((t) => ({ id: t.id, title: t.title, status: t.status, blockedBy: t.blockedBy, migration: t.migration, seams: t.seams.length })),
}
if (cfg.confirmed !== true) {
  return blocked('Waves planned — approve the ticket breakdown before any code',
    `Read the plan (${parallelism.summary}${dependencyReview?.avoidable.length ? `; ${dependencyReview.note}` : ''}); fix the tickets if needed, then re-run with confirmed: true`, { plan, tickets: plan.tickets })
}
if (!waves.length) return blocked('No ticket can start', warnings.join(' · ') || 'No ticket is ready-for-agent', { plan })

phase('Waves')
const slug = (t) => `${TICKETS.replace(/\/+$/, '').split('/').pop()}-${t.id}`.replace(/[^A-Za-z0-9._-]+/g, '-')
const MERGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['done', 'hash', 'note'],
  properties: { done: { type: 'boolean' }, hash: { type: ['string', 'null'] }, note: { type: 'string' } },
}
// Every write to this checkout goes through one queue: two tickets that finish together never merge at once.
let queue = Promise.resolve()
const serial = (fn) => { const p = queue.then(fn); queue = p.catch(() => {}); return p }
const ticketPath = (t) => `${TICKETS}/${t.file}`
const statusLine = (t, status, comment) => `In ${read.root}, edit ${ticketPath(t)}: set the \`Status:\` line to ${status}, and append under
\`## Comments\` (create the heading at the end if missing) one line "- <today's date, YYYY-MM-DD>: ${comment}", in ${language}.
Then \`git add -- ${q(ticketPath(t))}\` and \`git commit -m ${q(`chore(tickets): ${t.id} ${status}`)}\` — stage that file by name only.`
const mark = (t, why) => serial(() => agent(`${SEAT}${statusLine(t, 'blocked', `develop-spec: ${why}`)}
Return done, hash (git rev-parse --short HEAD), note.`, { model: 'sonnet', label: `${t.id}:mark`, phase: 'Waves', schema: MERGE_SCHEMA }))
const LAND_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['merged', 'hash', 'cleaned', 'note'],
  properties: { merged: { type: 'boolean' }, hash: { type: ['string', 'null'] }, cleaned: { type: 'boolean' }, note: { type: 'string' } },
}

const WORKTREE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['done', 'fresh', 'note'],
  properties: { done: { type: 'boolean' }, fresh: { type: 'boolean' }, note: { type: 'string' } },
}
// A ticket that stops before any implementer wrote a line leaves nothing worth keeping: its empty worktree and branch
// go, and its ticket stays ready-for-agent. After one config error there used to be three empty worktrees, three
// branches and two tickets committed as blocked to undo by hand (2026-11-25).
const tidy = (t, branch, workdir) => agent(
  `${SEAT}Clean up after a ticket that did not start. Work in ${q(read.root)}; run each command as written.
1. \`git rev-list --count ${q(read.branch)}..${q(branch)}\` — if it prints anything other than 0, or
   \`git -C ${q(workdir)} status --short\` prints a line, there is work here: change nothing, done=false, say which in note.
2. Otherwise \`git worktree remove --force ${q(workdir)}\`, then \`git branch -D ${q(branch)}\`.
done=true when both are gone. hash=null.`,
  { model: 'haiku', label: `${t.id}:tidy`, phase: 'Waves', schema: MERGE_SCHEMA })
const notStarted = async (t, branch, workdir, why) => {
  const gone = await tidy(t, branch, workdir)
  return { id: t.id, status: 'not-started', reason: why, workdir: gone?.done ? null : workdir }
}
// One preflight in the first fresh worktree, before any implementer: a gate that is red or skips checks there is red
// for every ticket, whatever they write. Eleven tickets were blocked that way, each after a full implement-and-review.
const PREFLIGHT_CMD = cfg.preflight ?? 'npm run preflight'
const ALLOWED = (Array.isArray(cfg.allowSkipped) ? cfg.allowSkipped : cfg.allowSkipped ? [cfg.allowSkipped] : []).map((a) => String(a).toLowerCase())
let baseline = null, baselineProblem = null
const checkBaseline = (t, workdir) => (baseline ??= agent(
  `${SEAT}Run exactly this and change nothing: cd ${q(workdir)} && ${PREFLIGHT_CMD}; echo "EXIT=$?"
Report, without interpreting:
- exitCode: the number printed after EXIT=
- skipped: every output line that reports a check as skipped or not run (SKIP, skipped, ⊘, "not verified"), verbatim
- failedCheck: the check that failed, or null when exitCode is 0
- tail: the last 30 lines of output, verbatim
Do not fix anything.`,
  { model: cfg.models?.preflight ?? 'sonnet', label: `${t.id}:baseline`, phase: 'Waves',
    schema: { type: 'object', additionalProperties: false, required: ['exitCode', 'skipped', 'failedCheck', 'tail'],
      properties: { exitCode: { type: 'integer' }, skipped: { type: 'array', items: { type: 'string' } }, failedCheck: { type: ['string', 'null'] }, tail: { type: 'string' } } } }
).then((b) => {
  // A seat that returned nothing proves nothing either way: the tickets run, as before.
  if (!b) return null
  const skips = b.skipped.filter((l) => !ALLOWED.some((a) => l.toLowerCase().includes(a)))
  if (b.exitCode !== 0) baselineProblem = `the preflight (${PREFLIGHT_CMD}) fails in a fresh worktree, before any ticket changed a line${b.failedCheck ? ` — ${b.failedCheck}` : ''}: ${b.tail.trim().split('\n').slice(-3).join(' / ').slice(0, 300)}. Make it pass in a clean checkout (worktreeSetup installs what git does not track; a check that needs a secret should skip and be named in allowSkipped)`
  else if (skips.length) baselineProblem = `the preflight skips checks in a fresh worktree that allowSkipped does not name, so no ticket could finish: ${skips.slice(0, 4).join(' · ')}. Supply what they need in worktreeSetup, or name them in allowSkipped`
  return b
}))

const runTicket = async (t) => {
  const branch = `spec/${slug(t)}`
  const workdir = `${read.root}/.claude/worktrees/spec-${slug(t)}`
  if (baselineProblem) return { id: t.id, status: 'not-started', reason: baselineProblem, workdir: null }
  // A ticket blocked earlier kept its worktree and branch for inspection; set back to ready-for-agent, it resumes there.
  const made = await agent(
    `${SEAT}Prepare this ticket's worktree. Run each command as written; change nothing else.
1. cd ${q(read.root)}
2. If the directory ${q(workdir)} exists, reuse it and bring it up to date: \`git -C ${q(workdir)} merge ${q(read.branch)}\`
   (a kept branch was cut before other tickets landed). If that merge conflicts, run \`git -C ${q(workdir)} merge --abort\`,
   done=false, and name the conflicted files in note: the human resolves a kept branch. Otherwise, if \`git show-ref --verify --quiet refs/heads/${branch}\` succeeds,
   run \`git worktree add ${q(workdir)} ${q(branch)}\`; otherwise run \`git worktree add ${q(workdir)} -b ${q(branch)} ${q(read.branch)}\`.
3. Make sure the line .claude/worktrees/ is in "$(git rev-parse --git-common-dir)/info/exclude" (append it if missing).${cfg.worktreeSetup ? `
4. cd ${q(workdir)} && ${cfg.worktreeSetup}` : ''}
done=true when every step succeeded; otherwise done=false and the failing step's error in note.
fresh=true when step 2 created the worktree on a new branch; false when the directory or the branch already existed.`,
    { model: 'haiku', label: `${t.id}:worktree`, phase: 'Waves', schema: WORKTREE_SCHEMA }
  )
  if (!made?.done) return notStarted(t, branch, workdir, `worktree not ready: ${made?.note ?? 'the seat returned nothing'}`)
  if (cfg.baselinePreflight !== false && (baseline || made.fresh)) {
    await checkBaseline(t, workdir)
    if (baselineProblem) return notStarted(t, branch, workdir, baselineProblem)
  }
  // The ticket's own seams are the agreed ones; a per-run seams or tickets key never reaches a ticket.
  const { tickets: _t, confirmed: _c, maxParallel: _m, seams: _s, integrate: _i, worktreeSetup: _w, ...base } = cfg
  const res = await developPhase(
    { ...base,
      task: `Implement ticket ${t.id} — ${t.title}. The ticket is ${ticketPath(t)}: read it whole (problem, what to do, acceptance criteria, out of scope). Its acceptance criteria are the spec; do only what it asks.`,
      seams: t.seams.length ? t.seams : undefined, workdir, commit: true, doneStep: undefined },
    (prompt, o) => agent(prompt, { ...o, label: `${t.id}:${o.label}`, phase: `Ticket ${t.id}` }),
    (m) => log(`[${t.id}] ${m}`),
    () => {}
  )
  if (res?.handoff?.status !== 'complete' || !res.commit?.committed) {
    const why = String(res?.handoff?.blocker || res?.nextStep || res?.handoff?.summary || 'develop-phase returned nothing')
    await mark(t, `${why.slice(0, 300)} — worktree kept at ${workdir}`)
    return { id: t.id, status: 'blocked', reason: why, workdir, run: res }
  }
  const integrate = cfg.integrate
    ? (cfg.integrate.includes('{branch}') ? cfg.integrate.replaceAll('{branch}', q(branch)) : `${cfg.integrate} ${q(branch)}`)
    : `git merge --no-ff ${q(branch)} -m ${q(`merge: ${t.id} — ${t.title}`)}`
  // Landing and tidying are reported apart: a merge that landed is landed even when its worktree will not go.
  const tryLand = () => serial(() => agent(
    `${SEAT}You are the merge seat of a waves run, the only seat that writes to ${read.branch}. Work in ${q(read.root)}.
1. \`git -C ${q(read.root)} branch --show-current\` must print ${read.branch}; otherwise merged=false, say so in note, and stop.
2. Run: cd ${q(read.root)} && ${integrate}
   On a conflict or a failure: \`git merge --abort\` if a merge is in progress, merged=false, and name the files in note. Stop.
   merged=true once the merge commit is on ${read.branch}, whatever happens after.
3. ${statusLine(t, DONE, `merged by develop-spec from ${branch}`)}
4. Tidy up: \`git worktree remove ${q(workdir)}\`, then \`git branch -d ${q(branch)}\`. cleaned=false and why in note if either refuses.
Return merged, hash (git rev-parse --short HEAD after step 3), cleaned, note.`,
    { model: cfg.models?.commit ?? 'sonnet', label: `${t.id}:merge`, phase: 'Waves', schema: LAND_SCHEMA }
  ))
  let land = await tryLand()
  // Two tickets in flight can touch the same file; the second to finish used to stop at the conflict (5 tickets). One
  // attempt in the ticket's own worktree: bring the base in, resolve, prove it with the preflight, then merge again.
  // The resolution is not reviewed per ticket — the final review reads the whole merged range — and the brief says so.
  let resolved = false
  if (land && !land.merged) {
    const fix = await agent(
      `${SEAT}A ticket's branch no longer merges into ${read.branch}: other tickets landed there while it was being written.
Work only in ${q(workdir)} (branch ${branch}).
1. \`cd ${q(workdir)} && git merge ${q(read.branch)}\`
2. For every conflicted file, keep BOTH intents: this ticket's change (${ticketPath(t)}) and what landed on ${read.branch}.
   Never drop either side to make the conflict go away; read both before editing.
3. Run \`${PREFLIGHT_CMD}\`. It must exit 0.
4. \`git add\` the files you resolved by name, then \`git commit --no-edit\`.
done=true only when the merge is committed and step 3 exited 0. Otherwise \`git merge --abort\`, done=false, and name the
files and the reason in note. hash=null.`,
      { model: cfg.models?.implementer ?? 'opus', label: `${t.id}:resolve`, phase: `Ticket ${t.id}`, schema: MERGE_SCHEMA })
    if (fix?.done) { resolved = true; land = await tryLand() }
  }
  if (!land?.merged) {
    const why = `approved and committed on ${branch}, but not merged: ${land?.note ?? 'the merge seat returned nothing'}`
    await mark(t, why)
    return { id: t.id, status: 'blocked', reason: why, workdir, run: res }
  }
  return { id: t.id, status: DONE, hash: land.hash, commit: res.commit.hash, axes: res.axes, run: res, resolved,
    ...(land.cleaned ? {} : { tidy: `${workdir} or ${branch} left in place: ${land.note}` }) }
}

// The frontier is every ready ticket whose blockers are all done; a slot frees, the frontier is recomputed. A
// blocked ticket keeps its dependents waiting and the rest of the graph goes on.
const results = {}
const running = new Map()
const migrating = () => [...running.keys()].some((id) => byId[id].migration)
for (;;) {
  for (const t of tickets) {
    if (running.size >= maxParallel || baselineProblem) break
    if (state[t.id] !== READY || running.has(t.id) || !t.blockedBy.every((b) => state[b] === DONE)) continue
    if (t.migration && migrating()) continue
    log(`▶ ${t.id} — ${t.title}`)
    running.set(t.id, runTicket(t).catch((e) => notStarted(t, `spec/${slug(t)}`, `${read.root}/.claude/worktrees/spec-${slug(t)}`, `the run threw: ${e.message}`)))
  }
  if (!running.size) break
  const r = await Promise.race(running.values())
  running.delete(r.id)
  state[r.id] = r.status === DONE ? DONE : r.status === 'not-started' ? 'not-started' : 'blocked'
  results[r.id] = r
  log(r.status === DONE ? `✓ ${r.id} merged ${r.hash}` : `⛔ ${r.id} ${r.status === 'not-started' ? 'not started' : 'blocked'} — ${String(r.reason).slice(0, 160)}`)
}

const landed = tickets.filter((t) => results[t.id]?.status === DONE)
const stuck = tickets.filter((t) => results[t.id]?.status === 'blocked')
// Stopped before any implementer wrote a line: the ticket file still says ready-for-agent, nothing was left behind.
const notRun = tickets.filter((t) => results[t.id]?.status === 'not-started')
const waiting = tickets.filter((t) => state[t.id] === READY && !results[t.id])

// One two-axis review of everything that landed: each ticket was reviewed alone, and the sum can still miss the PRD.
let finalReview = null
if (landed.length) {
  phase('Final review')
  const reviewer = String(cfg.models?.reviewer ?? cfg.reviewerModel ?? 'fable')
  const model = reviewer.includes('/') ? (String(cfg.models?.implementer ?? 'opus').includes('fable') ? 'opus' : 'fable') : reviewer
  const RANGE = `git diff ${read.head}..HEAD`
  const common = `${SEAT}Read-only: read files and run the tests, edit nothing. Work in ${read.root}. The change under review is
everything this run merged: \`${RANGE}\`. Tickets that landed: ${landed.map((t) => `${TICKETS}/${t.file}`).join(', ')}.`
  const [code, spec] = await Promise.all([
    agent(`${common}
Judge the whole change as code, against harness-rubric.md and .claude/agents/reviewer.md when they exist: what each ticket's
review could not see — duplication across tickets, one ticket undoing another, a seam two tickets disagree on.
Format: [PASS|FAIL] criterion — evidence. Last line (no extra text): APPROVED or REJECTED`,
      { model, label: 'final:code', phase: 'Final review' }),
    agent(`${common}${cfg.prd ? `\nPRD: ${cfg.prd} (the part these tickets implement).` : ''}
Judge the whole change against the spec: is every requirement of the landed tickets there, together; anything nobody asked for.
Format: [PASS|FAIL] criterion — evidence quoting the ticket or the PRD. Last line (no extra text): APPROVED or REJECTED`,
      { model, label: 'final:spec', phase: 'Final review' }),
  ])
  const verdict = (text) => {
    const v = String(text ?? '').trim().split('\n').map((l) => l.replace(/[*`_\s#:.]/g, '').toUpperCase())
      .reverse().find((l) => ['APPROVED', 'REJECTED', 'APROBADO', 'RECHAZADO', 'APPROUVÉ', 'APPROUVE', 'REJETÉ', 'REJETE'].includes(l))
    return ['APPROVED', 'APROBADO', 'APPROUVÉ', 'APPROUVE'].includes(v)
  }
  const fails = (text) => String(text ?? '').split('\n').filter((l) => /^\s*(?:[-*]\s*)?\[FAIL\]/.test(l)).map((l) => l.trim().replace(/^[-*]\s*/, ''))
  finalReview = {
    code: { approved: verdict(code), fails: fails(code), returned: Boolean(code) },
    spec: { approved: verdict(spec), fails: fails(spec), returned: Boolean(spec) },
  }
}

// The brief is built from what the seats returned, never written by one: what landed, what is blocked and why,
// what waits on it, and the decisions that leaves the human.
const line = (t, rest) => `- ${t.id} — ${t.title}${rest ? `: ${rest}` : ''}`
const decisions = [...new Set([
  ...(baselineProblem ? [`nothing ran: ${baselineProblem}`] : []),
  ...notRun.filter((t) => results[t.id].reason !== baselineProblem).map((t) => `${t.id} did not start: ${String(results[t.id].reason).slice(0, 300)}`),
  ...stuck.map((t) => `${t.id}: ${String(results[t.id].reason).slice(0, 300)}`),
  ...landed.filter((t) => results[t.id].resolved).map((t) => `${t.id} landed after a seat resolved a merge conflict with ${read.branch}: no ticket review saw that resolution, read it in the merged range`),
  ...landed.filter((t) => results[t.id].tidy).map((t) => `${t.id} landed, tidy up by hand: ${results[t.id].tidy}`),
  ...(finalReview ? [...finalReview.code.fails.map((f) => `final code review: ${f}`), ...finalReview.spec.fails.map((f) => `final spec review: ${f}`)] : []),
  ...(finalReview && !finalReview.code.returned ? ['the final code review returned nothing — review the merged range by hand'] : []),
  ...(finalReview && !finalReview.spec.returned ? ['the final spec review returned nothing — review the merged range by hand'] : []),
  ...warnings,
])]
const brief = [
  `## Waves — ${TICKETS}`,
  `Landed (${landed.length}):`, ...landed.map((t) => line(t, `merged ${results[t.id].hash}`)),
  `Blocked (${stuck.length}):`, ...stuck.map((t) => line(t, `${String(results[t.id].reason).slice(0, 300)}${results[t.id].workdir ? ` — worktree ${results[t.id].workdir}` : ''}`)),
  ...(notRun.length ? [`Not started (${notRun.length}) — still ready-for-agent, nothing left behind:`, ...notRun.map((t) => line(t, `${String(results[t.id].reason).slice(0, 200)}${results[t.id].workdir ? ` — worktree kept, it holds work: ${results[t.id].workdir}` : ''}`))] : []),
  `Waiting (${waiting.length}):`, ...waiting.map((t) => line(t, t.blockedBy.some((b) => state[b] !== DONE)
    ? `blocked by ${t.blockedBy.filter((b) => state[b] !== DONE).map((b) => `${b} (${state[b] ?? 'missing'})`).join(', ')}` : 'the run stopped before its turn')),
  ...(finalReview ? [`Final review: code ${finalReview.code.approved ? 'APPROVED' : 'REJECTED'} · spec ${finalReview.spec.approved ? 'APPROVED' : 'REJECTED'} over ${read.head}..HEAD`] : []),
  `Decisions for you (${decisions.length}):`, ...decisions.map((d) => `- ${d}`),
].join('\n')
const allDone = !stuck.length && !notRun.length && !waiting.length && finalReview?.code.approved && finalReview?.spec.approved

return {
  plan, brief, finalReview,
  tickets: tickets.map((t) => ({ id: t.id, title: t.title, status: state[t.id], ...(results[t.id] ? { hash: results[t.id].hash ?? null, reason: results[t.id].reason ?? null, workdir: results[t.id].workdir ?? null, axes: results[t.id].axes ?? results[t.id].run?.axes ?? null } : {}) })),
  handoff: allDone
    ? { status: 'complete', summary: `${landed.length} ticket(s) landed; final review approved on both axes`, evidence: landed.map((t) => `${t.id} merged ${results[t.id].hash}`) }
    : { status: 'blocked', summary: `${landed.length} landed, ${stuck.length} blocked, ${waiting.length} waiting${notRun.length ? `, ${notRun.length} not started` : ''}`, evidence: landed.map((t) => `${t.id} merged ${results[t.id].hash}`), blocker: decisions.join(' · ') || 'see the brief' },
  nextStep: allDone ? `Read the brief; ${read.branch} holds the merged work` : 'Read the brief: each decision names what blocks it',
}
