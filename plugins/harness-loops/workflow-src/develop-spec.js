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
//   integrate     the command that merges a ticket's branch into this checkout; `{branch}` is replaced by the
//                 branch name, or the branch is appended. Default: git merge --no-ff
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

phase('Read')
const READ_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['root', 'branch', 'head', 'dirty', 'tickets', 'error'],
  properties: {
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
\`git rev-parse --short HEAD\` (head) and \`git status --short --untracked-files=no\` (dirty: every line, verbatim).
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

const tickets = [...read.tickets].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
const byId = Object.fromEntries(tickets.map((t) => [t.id, t]))
const DONE = 'done', READY = 'ready-for-agent'
const state = Object.fromEntries(tickets.map((t) => [t.id, t.status]))

// The plan assumes every ticket lands: wave n holds the tickets whose blockers all land in earlier waves, and
// at most one ticket that adds a migration. What can never start is named, not dropped.
const warnings = []
for (const t of tickets) {
  for (const b of t.blockedBy) if (!byId[b]) warnings.push(`${t.id} is blocked by ${b}, which is not a ticket in ${TICKETS}`)
}
const waves = []
{
  const landed = new Set(tickets.filter((t) => state[t.id] === DONE).map((t) => t.id))
  let pending = tickets.filter((t) => state[t.id] === READY)
  while (pending.length) {
    let migration = false
    const wave = pending.filter((t) => t.blockedBy.every((b) => landed.has(b)))
      .filter((t) => (t.migration ? (migration ? false : (migration = true)) : true))
    if (!wave.length) break
    waves.push(wave.map((t) => t.id))
    wave.forEach((t) => landed.add(t.id))
    pending = pending.filter((t) => !landed.has(t.id))
  }
  for (const t of pending) warnings.push(`${t.id} can never start: blocked by ${t.blockedBy.filter((b) => !landed.has(b)).join(', ')} (a cycle, a missing ticket, or one not ready-for-agent)`)
}
const notReady = tickets.filter((t) => state[t.id] !== READY && state[t.id] !== DONE).map((t) => `${t.id} (${state[t.id]})`)
log(`${tickets.length} ticket(s) · waves ${waves.map((w) => `[${w.join(', ')}]`).join(' ') || 'none'} · ${maxParallel} in flight`)

const plan = {
  root: read.root, branch: read.branch, head: read.head, waves, warnings, notReady,
  tickets: tickets.map((t) => ({ id: t.id, title: t.title, status: t.status, blockedBy: t.blockedBy, migration: t.migration, seams: t.seams.length })),
}
if (cfg.confirmed !== true) {
  return blocked('Waves planned — approve the ticket breakdown before any code',
    'Read the plan; fix the tickets if needed, then re-run with confirmed: true', { plan, tickets: plan.tickets })
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
const statusLine = (t, status, comment) => `In ${read.root}/${TICKETS}/${t.file}: set the \`Status:\` line to ${status}, and append under
\`## Comments\` (create the heading at the end if missing) one line "- <today's date, YYYY-MM-DD>: ${comment}", in ${language}.
Then \`git add -- ${TICKETS}/${t.file}\` and \`git commit -m "chore(tickets): ${t.id} ${status}"\` — stage that file by name only.`

const runTicket = async (t) => {
  const branch = `spec/${slug(t)}`
  const workdir = `${read.root}/.claude/worktrees/spec-${slug(t)}`
  const made = await agent(
    `${SEAT}Run exactly this and change nothing:
cd ${read.root} && git worktree add ${workdir} -b ${branch} ${read.branch} && grep -qxF '.claude/worktrees/' "$(git rev-parse --git-common-dir)/info/exclude" || echo '.claude/worktrees/' >> "$(git rev-parse --git-common-dir)/info/exclude"
done=true when the worktree exists afterwards; otherwise done=false and the error in note. hash=null.`,
    { model: 'haiku', label: `${t.id}:worktree`, phase: 'Waves', schema: MERGE_SCHEMA }
  )
  if (!made?.done) {
    const why = `worktree not created: ${made?.note ?? 'the seat returned nothing'}`
    await serial(() => agent(`${SEAT}${statusLine(t, 'blocked', `develop-spec: ${why}`)}\nReturn done, hash (git rev-parse --short HEAD), note.`,
      { model: 'sonnet', label: `${t.id}:mark`, phase: 'Waves', schema: MERGE_SCHEMA }))
    return { id: t.id, status: 'blocked', reason: why, workdir: null }
  }
  // The ticket's own seams are the agreed ones; a per-run seams or tickets key never reaches a ticket.
  const { tickets: _t, confirmed: _c, maxParallel: _m, seams: _s, integrate: _i, ...base } = cfg
  const res = await developPhase(
    { ...base,
      task: `Implement ticket ${t.id} — ${t.title}. The ticket is ${TICKETS}/${t.file}: read it whole (problem, what to do, acceptance criteria, out of scope). Its acceptance criteria are the spec; do only what it asks.`,
      seams: t.seams.length ? t.seams : undefined, workdir, commit: true, doneStep: undefined },
    (prompt, o) => agent(prompt, { ...o, label: `${t.id}:${o.label}`, phase: `Ticket ${t.id}` }),
    (m) => log(`[${t.id}] ${m}`),
    () => {}
  )
  if (res?.handoff?.status !== 'complete' || !res.commit?.committed) {
    const why = res?.handoff?.blocker || res?.nextStep || res?.handoff?.summary || 'develop-phase returned nothing'
    await serial(() => agent(`${SEAT}${statusLine(t, 'blocked', `develop-spec: ${String(why).slice(0, 300)} — worktree kept at ${workdir}`)}
Return done, hash (git rev-parse --short HEAD), note.`,
      { model: 'sonnet', label: `${t.id}:mark`, phase: 'Waves', schema: MERGE_SCHEMA }))
    return { id: t.id, status: 'blocked', reason: why, workdir, run: res }
  }
  const integrate = cfg.integrate
    ? (cfg.integrate.includes('{branch}') ? cfg.integrate.replaceAll('{branch}', branch) : `${cfg.integrate} ${branch}`)
    : `git merge --no-ff ${branch} -m "merge: ${t.id} — ${t.title.replace(/"/g, "'")}"`
  const merged = await serial(() => agent(
    `${SEAT}You are the merge seat of a waves run, the only seat that writes to ${read.branch}. Work in ${read.root}.
1. \`git -C ${read.root} branch --show-current\` must print ${read.branch}; otherwise done=false, say so in note, and stop.
2. Run: cd ${read.root} && ${integrate}
   On a conflict or a failure: \`git merge --abort\` if a merge is in progress, done=false, and name the files in note. Stop.
3. ${statusLine(t, DONE, `merged by develop-spec from ${branch}`)}
4. \`git worktree remove ${workdir}\` then \`git branch -d ${branch}\`.
Return done, hash (git rev-parse --short HEAD after step 3), note.`,
    { model: cfg.models?.commit ?? 'sonnet', label: `${t.id}:merge`, phase: 'Waves', schema: MERGE_SCHEMA }
  ))
  if (!merged?.done) {
    const why = `approved and committed on ${branch}, but not merged: ${merged?.note ?? 'the merge seat returned nothing'}`
    await serial(() => agent(`${SEAT}${statusLine(t, 'blocked', `develop-spec: ${why}`)}\nReturn done, hash (git rev-parse --short HEAD), note.`,
      { model: 'sonnet', label: `${t.id}:mark`, phase: 'Waves', schema: MERGE_SCHEMA }))
    return { id: t.id, status: 'blocked', reason: why, workdir, run: res }
  }
  return { id: t.id, status: DONE, hash: merged.hash, commit: res.commit.hash, axes: res.axes, run: res }
}

// The frontier is every ready ticket whose blockers are all done; a slot frees, the frontier is recomputed. A
// blocked ticket keeps its dependents waiting and the rest of the graph goes on.
const results = {}
const running = new Map()
const migrating = () => [...running.keys()].some((id) => byId[id].migration)
for (;;) {
  for (const t of tickets) {
    if (running.size >= maxParallel) break
    if (state[t.id] !== READY || running.has(t.id) || !t.blockedBy.every((b) => state[b] === DONE)) continue
    if (t.migration && migrating()) continue
    log(`▶ ${t.id} — ${t.title}`)
    running.set(t.id, runTicket(t).catch((e) => ({ id: t.id, status: 'blocked', reason: `the run threw: ${e.message}` })))
  }
  if (!running.size) break
  const r = await Promise.race(running.values())
  running.delete(r.id)
  state[r.id] = r.status === DONE ? DONE : 'blocked'
  results[r.id] = r
  log(r.status === DONE ? `✓ ${r.id} merged ${r.hash}` : `⛔ ${r.id} blocked — ${String(r.reason).slice(0, 160)}`)
}

const landed = tickets.filter((t) => results[t.id]?.status === DONE)
const stuck = tickets.filter((t) => results[t.id] && results[t.id].status !== DONE)
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
const decisions = [
  ...stuck.map((t) => `${t.id}: ${String(results[t.id].reason).slice(0, 300)}`),
  ...(finalReview ? [...finalReview.code.fails.map((f) => `final code review: ${f}`), ...finalReview.spec.fails.map((f) => `final spec review: ${f}`)] : []),
  ...(finalReview && !finalReview.code.returned ? ['the final code review returned nothing — review the merged range by hand'] : []),
  ...(finalReview && !finalReview.spec.returned ? ['the final spec review returned nothing — review the merged range by hand'] : []),
  ...warnings,
]
const brief = [
  `## Waves — ${TICKETS}`,
  `Landed (${landed.length}):`, ...landed.map((t) => line(t, `merged ${results[t.id].hash}`)),
  `Blocked (${stuck.length}):`, ...stuck.map((t) => line(t, `${String(results[t.id].reason).slice(0, 300)}${results[t.id].workdir ? ` — worktree ${results[t.id].workdir}` : ''}`)),
  `Waiting (${waiting.length}):`, ...waiting.map((t) => line(t, `blocked by ${t.blockedBy.filter((b) => state[b] !== DONE).map((b) => `${b} (${state[b] ?? 'missing'})`).join(', ')}`)),
  ...(finalReview ? [`Final review: code ${finalReview.code.approved ? 'APPROVED' : 'REJECTED'} · spec ${finalReview.spec.approved ? 'APPROVED' : 'REJECTED'} over ${read.head}..HEAD`] : []),
  `Decisions for you (${decisions.length}):`, ...decisions.map((d) => `- ${d}`),
].join('\n')
const allDone = !stuck.length && !waiting.length && finalReview?.code.approved && finalReview?.spec.approved

return {
  plan, brief, finalReview,
  tickets: tickets.map((t) => ({ id: t.id, title: t.title, status: state[t.id], ...(results[t.id] ? { hash: results[t.id].hash ?? null, reason: results[t.id].reason ?? null, workdir: results[t.id].workdir ?? null, axes: results[t.id].axes ?? results[t.id].run?.axes ?? null } : {}) })),
  handoff: allDone
    ? { status: 'complete', summary: `${landed.length} ticket(s) landed; final review approved on both axes`, evidence: landed.map((t) => `${t.id} merged ${results[t.id].hash}`) }
    : { status: 'blocked', summary: `${landed.length} landed, ${stuck.length} blocked, ${waiting.length} waiting`, evidence: landed.map((t) => `${t.id} merged ${results[t.id].hash}`), blocker: decisions.join(' · ') || 'see the brief' },
  nextStep: allDone ? `Read the brief; ${read.branch} holds the merged work` : 'Read the brief: each decision names what blocks it',
}
