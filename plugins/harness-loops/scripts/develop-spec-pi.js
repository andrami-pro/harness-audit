#!/usr/bin/env node
// develop-spec-pi.js — the waves loop (PRD-004 §4) for Pi: works a folder of tickets through develop-phase-pi.js,
// one git worktree per ticket, merging each approved ticket and starting the next as soon as a slot frees, then one
// brief. Same contract as plugins/harness-loops/workflow-src/develop-spec.js; what differs is who does the work:
//
//   - Reading the tickets, planning the waves, the worktrees, the merges and the status lines are code, not seats.
//     Pi runs a process with a cwd of its own, so each ticket's develop-phase-pi.js simply runs inside its worktree.
//   - The only models are the ones develop-phase-pi.js seats per ticket, and the final review's code and spec seats,
//     taken from the same `pi` line-up under the same D25a check.
//
// Usage (from the checkout the tickets merge into):
//   node develop-spec-pi.js --tickets <folder> [--confirmed] [--max-parallel 2] [--worktree-setup "<command>"]
//                           [--integrate "<command with {branch}>"] [--prd <path>] [--run-dir <path>]
//                           [any develop-phase-pi.js flag: --max-iter N --preflight "<cmd>" --allow-skipped "<s>"…
//                            --no-tdd --no-spec-review --no-jev --no-preparer --no-tmux]
//   --confirmed       run the waves. Without it the tickets are read and the plan printed: the human approves the
//                     breakdown once, before any code
//   --worktree-setup  run in each new worktree before its ticket starts (`pnpm install --frozen-lockfile`, or a `cp`
//                     of the gitignored files the preflight reads): a worktree holds only what git tracks
//   --integrate       the merge command; `{branch}` is replaced by the quoted branch, or the branch is appended.
//                     Default: git merge --no-ff
// A ticket is a .md file whose name starts with its id ("03-…md"), with a `Status:` line (ready-for-agent, claimed,
// done, blocked), a `Blocked by:` line (None, or ids), an optional `## Seams` section (the agreed seams) and an optional
// `Migration: yes` line (two tickets that add a migration never run at once).
// Progress goes to stderr, each ticket's lines prefixed [id]; the result (plan, brief, handoff) goes to stdout as JSON.
// Exit 0 — every ticket landed and the final review approved both axes. Exit 1 — anything else. Exit 2 — usage error.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const DONE = 'done';
const READY = 'ready-for-agent';
const PHASE_FLAGS = new Set(['--no-tdd', '--no-spec-review', '--no-jev', '--no-preparer', '--no-tmux']);
const PHASE_VALUES = new Set(['--max-iter', '--preflight', '--allow-skipped']);
const MAX_DIFF_BYTES = 300_000;

const log = (line) => process.stderr.write(`${line}\n`);

function parseArgs(argv) {
  const a = { tickets: '', confirmed: false, maxParallel: 2, worktreeSetup: null, integrate: null, prd: null, runDir: null, phase: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    if (k === '--tickets') a.tickets = argv[++i] || '';
    else if (k === '--confirmed') a.confirmed = true;
    else if (k === '--max-parallel') a.maxParallel = Number(argv[++i]);
    else if (k === '--worktree-setup') a.worktreeSetup = argv[++i] || null;
    else if (k === '--integrate') a.integrate = argv[++i] || null;
    else if (k === '--prd') a.prd = argv[++i] || null;
    else if (k === '--run-dir') a.runDir = argv[++i] || null;
    else if (PHASE_FLAGS.has(k)) a.phase.push(k);
    else if (PHASE_VALUES.has(k)) a.phase.push(k, argv[++i] || '');
    else if (k === '--seams' || k === '--task') throw new Error(`${k} is per ticket: a ticket's task is its file, its seams its ## Seams section`);
    else throw new Error(`unknown argument: ${k}`);
  }
  if (!a.tickets.trim()) throw new Error('--tickets is required');
  if (!Number.isInteger(a.maxParallel) || a.maxParallel < 1) throw new Error('--max-parallel must be a positive integer');
  return a;
}

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

// Read by code with the rules the Claude read seat is given: id is the file name's leading number, title the first
// heading (without a leading id), blockedBy the ids on the Blocked by: line, seams every line under a Seams heading.
function readTicket(dir, file) {
  const text = fs.readFileSync(path.join(dir, file), 'utf8');
  const lines = text.split('\n');
  const id = file.match(/^(\d+)/)[1];
  const field = (name) => (lines.find((l) => new RegExp(`^${name}:`, 'i').test(l.trim())) || '').trim().replace(new RegExp(`^${name}:\\s*`, 'i'), '');
  const heading = (lines.find((l) => /^#\s/.test(l)) || `# ${file}`).replace(/^#\s+/, '').trim();
  const title = heading.replace(new RegExp(`^${id}\\s*[—–:.-]\\s*`), '');
  const blockedLine = field('Blocked by');
  const blockedBy = /^none\b/i.test(blockedLine) ? [] : (blockedLine.match(/\b\d+\b/g) || []);
  const start = lines.findIndex((l) => /^#{1,6}\s+Seams\b/i.test(l));
  const seams = [];
  if (start >= 0) {
    for (const l of lines.slice(start + 1)) {
      if (/^#{1,6}\s/.test(l)) break;
      if (l.trim()) seams.push(l.trim());
    }
  }
  return { id, file, title, status: field('Status'), blockedBy, migration: /^(yes|true)\b/i.test(field('Migration')), seams };
}

function readTickets(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { error: `${dir} is not a folder`, tickets: [] };
  const files = fs.readdirSync(dir).filter((f) => /^\d+.*\.md$/.test(f));
  if (!files.length) return { error: `${dir} holds no ticket (a .md file whose name starts with its id)`, tickets: [] };
  return { error: null, tickets: files.map((f) => readTicket(dir, f)).sort((x, y) => x.id.localeCompare(y.id, undefined, { numeric: true })) };
}

// The plan assumes every ticket lands: wave n holds the tickets whose blockers all land in earlier waves, and at
// most one ticket that adds a migration. What can never start is named, not dropped.
function planWaves(tickets) {
  const byId = Object.fromEntries(tickets.map((t) => [t.id, t]));
  const warnings = [];
  for (const t of tickets) for (const b of t.blockedBy) if (!byId[b]) warnings.push(`${t.id} is blocked by ${b}, which is not a ticket in the folder`);
  const waves = [];
  const landed = new Set(tickets.filter((t) => t.status === DONE).map((t) => t.id));
  let pending = tickets.filter((t) => t.status === READY);
  while (pending.length) {
    let migration = false;
    const wave = pending.filter((t) => t.blockedBy.every((b) => landed.has(b)))
      .filter((t) => (t.migration ? (migration ? false : (migration = true)) : true));
    if (!wave.length) break;
    waves.push(wave.map((t) => t.id));
    wave.forEach((t) => landed.add(t.id));
    pending = pending.filter((t) => !landed.has(t.id));
  }
  for (const t of pending) warnings.push(`${t.id} can never start: blocked by ${t.blockedBy.filter((b) => !landed.has(b)).join(', ')} (a cycle, a missing ticket, or one not ready-for-agent)`);
  const notReady = tickets.filter((t) => t.status !== READY && t.status !== DONE).map((t) => `${t.id} (${t.status})`);
  return { waves, warnings, notReady };
}

// A `Status:` line rewritten and one line appended under `## Comments` (created at the end when missing).
function setStatus(file, status, comment) {
  const today = new Date().toISOString().slice(0, 10);
  let text = fs.readFileSync(file, 'utf8').replace(/^\s*Status:.*$/im, `Status: ${status}`);
  if (!/^## Comments\s*$/m.test(text)) text = `${text.replace(/\n*$/, '')}\n\n## Comments\n`;
  text = `${text.replace(/\n*$/, '')}\n- ${today}: ${comment}\n`;
  fs.writeFileSync(file, text);
}

const q = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;

async function main() {
  let a;
  try { a = parseArgs(process.argv.slice(2)); } catch (e) { log(`develop-spec-pi: ${e.message}`); return 2; }
  const top = git(['rev-parse', '--show-toplevel']);
  if (top.code !== 0) { log('develop-spec-pi: not inside a git repository'); return 2; }
  const root = top.out;
  const ticketsDir = path.resolve(a.tickets);
  const TICKETS = path.relative(root, ticketsDir) || '.';
  const branch = git(['branch', '--show-current'], root).out;
  const head = git(['rev-parse', '--short', 'HEAD'], root).out;
  // Absolute: each ticket's run dir is handed to a child that works in its worktree, where a relative one would be
  // created, then swept into the ticket's commit.
  const runDir = a.runDir ? path.resolve(a.runDir) : fs.mkdtempSync(path.join(os.tmpdir(), 'develop-spec-pi-'));
  fs.mkdirSync(runDir, { recursive: true });

  const print = (r) => { process.stdout.write(`${JSON.stringify(r, null, 2)}\n`); return r.handoff.status === 'complete' ? 0 : 1; };
  const blocked = (summary, blocker, extra = {}) => print({ ...extra, tickets: extra.tickets ?? [], handoff: { status: 'blocked', summary, evidence: [], blocker }, nextStep: blocker });

  const dirty = git(['status', '--short', '--untracked-files=no'], root).out.split('\n').filter(Boolean);
  if (dirty.length) return blocked('The checkout has uncommitted changes', `Commit or stash them first: the waves merge every ticket into this checkout (${dirty.slice(0, 5).join(' · ')})`);
  const read = readTickets(ticketsDir);
  if (read.error) return blocked('The tickets could not be read', read.error);
  const { tickets } = read;
  // A worktree is branched from HEAD: a ticket file that was never committed is not there for its seats to read.
  const untracked = tickets.filter((t) => git(['ls-files', '--error-unmatch', '--', path.join(ticketsDir, t.file)], root).code !== 0).map((t) => t.file);
  if (untracked.length) return blocked('Ticket files are not committed', `Commit them first: each ticket's worktree is branched from HEAD and would not hold ${untracked.join(', ')}`);
  // Everything below keys on the id: two files with one id would run as one and both read as landed.
  const dupes = [...new Set(tickets.map((t) => t.id).filter((id, i, all) => all.indexOf(id) !== i))];
  if (dupes.length) return blocked('Two tickets share an id', `Renumber them: ${dupes.map((id) => tickets.filter((t) => t.id === id).map((t) => t.file).join(' and ')).join(' · ')}`);

  const byId = Object.fromEntries(tickets.map((t) => [t.id, t]));
  const state = Object.fromEntries(tickets.map((t) => [t.id, t.status]));
  const { waves, warnings, notReady } = planWaves(tickets);
  log(`${tickets.length} ticket(s) · waves ${waves.map((w) => `[${w.join(', ')}]`).join(' ') || 'none'} · ${a.maxParallel} in flight · run dir ${runDir}`);
  const plan = {
    root, branch, head, waves, warnings, notReady,
    tickets: tickets.map((t) => ({ id: t.id, title: t.title, status: t.status, blockedBy: t.blockedBy, migration: t.migration, seams: t.seams.length })),
  };
  if (!a.confirmed) return blocked('Waves planned — approve the ticket breakdown before any code', 'Read the plan; fix the tickets if needed, then re-run with --confirmed', { plan, tickets: plan.tickets });
  if (!waves.length) return blocked('No ticket can start', warnings.join(' · ') || 'No ticket is ready-for-agent', { plan });

  // Every write to this checkout goes through one queue: two tickets that finish together never merge at once.
  let queue = Promise.resolve();
  const serial = (fn) => { const p = queue.then(fn); queue = p.catch(() => {}); return p; };
  const ticketPath = (t) => path.join(ticketsDir, t.file);
  const commitStatus = (t, status, comment) => {
    setStatus(ticketPath(t), status, comment);
    git(['add', '--', ticketPath(t)], root);
    const c = git(['commit', '-m', `chore(tickets): ${t.id} ${status}`], root);
    return c.code === 0 ? git(['rev-parse', '--short', 'HEAD'], root).out : null;
  };
  const mark = (t, why) => serial(() => commitStatus(t, 'blocked', `develop-spec-pi: ${why}`));
  const slug = (t) => `${TICKETS.replace(/\/+$/, '').split('/').pop()}-${t.id}`.replace(/[^A-Za-z0-9._-]+/g, '-');
  const exclude = path.resolve(root, git(['rev-parse', '--git-common-dir'], root).out, 'info', 'exclude');

  const runPhase = (t, workdir) => new Promise((resolve) => {
    const args = [path.join(__dirname, 'develop-phase-pi.js'),
      '--task', `Implement ticket ${t.id} — ${t.title}. The ticket is ${TICKETS}/${t.file}: read it whole (problem, what to do, acceptance criteria, out of scope). Its acceptance criteria are the spec; do only what it asks.`,
      ...(t.seams.length ? ['--seams', t.seams.join('\n')] : []), '--run-dir', path.join(runDir, `ticket-${t.id}`), ...a.phase,
      ...(a.prd ? ['--prd', a.prd] : [])];
    const child = spawn('node', args, { cwd: workdir, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let buf = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => {
      buf += c;
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const l of lines) if (l.trim()) log(`[${t.id}] ${l}`);
    });
    child.on('error', (e) => resolve({ code: null, res: null, error: e.message }));
    child.on('close', (code) => {
      let res = null;
      try { res = JSON.parse(out); } catch { /* a refused run (exit 2) prints no JSON */ }
      resolve({ code, res });
    });
  });

  const runTicket = async (t) => {
    const br = `spec/${slug(t)}`;
    const workdir = path.join(root, '.pi', 'worktrees', `spec-${slug(t)}`);
    // A ticket blocked earlier kept its worktree and branch for inspection; set back to ready-for-agent, it resumes there.
    if (!fs.existsSync(workdir)) {
      const made = git(['show-ref', '--verify', '--quiet', `refs/heads/${br}`], root).code === 0
        ? git(['worktree', 'add', workdir, br], root)
        : git(['worktree', 'add', workdir, '-b', br, branch], root);
      if (made.code !== 0) {
        const why = `worktree not ready: ${made.err.split('\n').pop()}`;
        await mark(t, why);
        return { id: t.id, status: 'blocked', reason: why, workdir: null };
      }
    }
    const ex = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
    if (!ex.split('\n').includes('.pi/worktrees/')) fs.appendFileSync(exclude, `${ex && !ex.endsWith('\n') ? '\n' : ''}.pi/worktrees/\n`);
    if (a.worktreeSetup) {
      const s = spawnSync('sh', ['-c', a.worktreeSetup], { cwd: workdir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      if (s.status !== 0) {
        const why = `worktree setup failed (exit ${s.status}): ${`${s.stderr || ''}${s.stdout || ''}`.trim().split('\n').pop() || a.worktreeSetup} — worktree kept at ${workdir}`;
        await mark(t, why);
        return { id: t.id, status: 'blocked', reason: why, workdir };
      }
      // develop-phase-pi commits with `git add -A`: a file the setup copied in that git does not ignore would ship.
      const left = git(['ls-files', '--others', '--exclude-standard'], workdir).out.split('\n').filter(Boolean);
      if (left.length) {
        const why = `worktree setup left files git does not ignore, which the ticket's commit would carry: ${left.slice(0, 5).join(', ')} — gitignore them — worktree kept at ${workdir}`;
        await mark(t, why);
        return { id: t.id, status: 'blocked', reason: why, workdir };
      }
    }
    const { code, res, error } = await runPhase(t, workdir);
    if (res?.handoff?.status !== 'complete' || !res.commit?.committed) {
      const why = String(res?.handoff?.blocker || res?.nextStep || res?.handoff?.summary
        || error || `develop-phase-pi.js exited ${code} with no result (line-up refused or usage error — see the [${t.id}] lines)`);
      await mark(t, `${why.slice(0, 300)} — worktree kept at ${workdir}`);
      return { id: t.id, status: 'blocked', reason: why, workdir, run: res };
    }
    // Landing and tidying are reported apart: a merge that landed is landed even when its worktree will not go.
    return serial(() => {
      if (git(['branch', '--show-current'], root).out !== branch) {
        const why = `approved and committed on ${br}, but not merged: the checkout is no longer on ${branch}`;
        commitStatus(t, 'blocked', `develop-spec-pi: ${why}`);
        return { id: t.id, status: 'blocked', reason: why, workdir, run: res };
      }
      const cmd = a.integrate
        ? (a.integrate.includes('{branch}') ? a.integrate.replaceAll('{branch}', q(br)) : `${a.integrate} ${q(br)}`)
        : `git merge --no-ff ${q(br)} -m ${q(`merge: ${t.id} — ${t.title}`)}`;
      const m = spawnSync('sh', ['-c', cmd], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      if (m.status !== 0) {
        const conflicts = git(['diff', '--name-only', '--diff-filter=U'], root).out.split('\n').filter(Boolean);
        if (fs.existsSync(path.resolve(root, git(['rev-parse', '--git-path', 'MERGE_HEAD'], root).out))) git(['merge', '--abort'], root);
        const why = `approved and committed on ${br}, but not merged: ${conflicts.length ? `conflict in ${conflicts.join(', ')} — resolve it by hand (merge ${branch} into ${br} in its worktree), then merge ${br}` : `${`${m.stderr || ''}${m.stdout || ''}`.trim().split('\n').pop()}`}`;
        commitStatus(t, 'blocked', `develop-spec-pi: ${why}`);
        return { id: t.id, status: 'blocked', reason: why, workdir, run: res };
      }
      const hash = commitStatus(t, DONE, `merged by develop-spec-pi from ${br}`) || git(['rev-parse', '--short', 'HEAD'], root).out;
      const rm = git(['worktree', 'remove', workdir], root);
      const bd = rm.code === 0 ? git(['branch', '-d', br], root) : rm;
      return { id: t.id, status: DONE, hash, commit: res.commit.hash, axes: res.axes, run: res,
        ...(bd.code === 0 ? {} : { tidy: `${workdir} or ${br} left in place: ${bd.err.split('\n').pop()}` }) };
    });
  };

  // The frontier is every ready ticket whose blockers are all done; a slot frees, the frontier is recomputed. A
  // blocked ticket keeps its dependents waiting and the rest of the graph goes on.
  const results = {};
  const running = new Map();
  const migrating = () => [...running.keys()].some((id) => byId[id].migration);
  for (;;) {
    for (const t of tickets) {
      if (running.size >= a.maxParallel) break;
      if (state[t.id] !== READY || running.has(t.id) || !t.blockedBy.every((b) => state[b] === DONE)) continue;
      if (t.migration && migrating()) continue;
      log(`▶ ${t.id} — ${t.title}`);
      running.set(t.id, runTicket(t).catch((e) => ({ id: t.id, status: 'blocked', reason: `the run threw: ${e.message}` })));
    }
    if (!running.size) break;
    const r = await Promise.race(running.values());
    running.delete(r.id);
    state[r.id] = r.status === DONE ? DONE : 'blocked';
    results[r.id] = r;
    log(r.status === DONE ? `✓ ${r.id} merged ${r.hash}` : `⛔ ${r.id} blocked — ${String(r.reason).slice(0, 160)}`);
  }

  const landed = tickets.filter((t) => results[t.id]?.status === DONE);
  const stuck = tickets.filter((t) => results[t.id] && results[t.id].status !== DONE);
  const waiting = tickets.filter((t) => state[t.id] === READY && !results[t.id]);

  // One two-axis review of everything that landed: each ticket was reviewed alone, and the sum can still miss the PRD.
  let finalReview = null;
  if (landed.length) {
    const phase = require('./develop-phase-pi.js');
    let seats = null;
    try { seats = phase.resolveSeats(root, { spec: !a.phase.includes('--no-spec-review') }); } catch (e) { log(`final review: line-up refused — ${e.message}`); }
    const diff = git(['diff', `${head}..HEAD`], root).out;
    const common = `Solo lectura: lee archivos del repositorio (read, grep, find, ls); no edites nada. El cambio a revisar es todo lo que
esta ejecución fusionó: \`git diff ${head}..HEAD\`. Tickets fusionados: ${landed.map((t) => `${TICKETS}/${t.file}`).join(', ')}.

## Cambios
\`\`\`diff
${diff.slice(0, MAX_DIFF_BYTES)}${diff.length > MAX_DIFF_BYTES ? '\n[diff truncated]' : ''}
\`\`\``;
    const seat = (name, model, ask) => (seats && model
      ? phase.runSeat({ name, model, tools: 'read,grep,find,ls', runDir, timeoutS: 1200, prompt: `${common}\n${ask}` }) : Promise.resolve(''));
    process.chdir(root);
    const [code, spec] = await Promise.all([
      seat('final-code', seats?.reviewer, `Juzga el cambio entero como código, contra harness-rubric.md y .pi/agents/reviewer.md (o .claude/agents/reviewer.md) si existen:
lo que la revisión de cada ticket no podía ver — duplicación entre tickets, un ticket que deshace otro, un seam en el que dos tickets no coinciden.
Formato: [PASS|FAIL] criterio — evidencia. Última línea, sola y sin texto extra: APROBADO o RECHAZADO`),
      seat('final-spec', seats?.spec || seats?.reviewer, `${a.prd ? `PRD: ${a.prd} (la parte que implementan estos tickets).\n` : ''}Juzga el cambio entero contra la spec: está cada requisito de los tickets fusionados, juntos; nada que nadie pidió.
Formato: [PASS|FAIL] criterio — evidencia que cita el ticket o el PRD. Última línea, sola y sin texto extra: APROBADO o RECHAZADO`),
    ]);
    const fails = (text) => String(text ?? '').split('\n').filter((l) => /^\s*(?:[-*]\s*)?\[FAIL\]/.test(l)).map((l) => l.trim().replace(/^[-*]\s*/, ''));
    finalReview = {
      code: { approved: Boolean(code) && phase.verdictOf(code), fails: fails(code), returned: Boolean(code) },
      spec: { approved: Boolean(spec) && phase.verdictOf(spec), fails: fails(spec), returned: Boolean(spec) },
    };
  }

  // The brief is built from what the seats returned, never written by one: what landed, what is blocked and why,
  // what waits on it, and the decisions that leaves the human.
  const line = (t, rest) => `- ${t.id} — ${t.title}${rest ? `: ${rest}` : ''}`;
  const decisions = [
    ...stuck.map((t) => `${t.id}: ${String(results[t.id].reason).slice(0, 300)}`),
    ...landed.filter((t) => results[t.id].tidy).map((t) => `${t.id} landed, tidy up by hand: ${results[t.id].tidy}`),
    ...(finalReview ? [...finalReview.code.fails.map((f) => `final code review: ${f}`), ...finalReview.spec.fails.map((f) => `final spec review: ${f}`)] : []),
    ...(finalReview && !finalReview.code.returned ? ['the final code review returned nothing — review the merged range by hand'] : []),
    ...(finalReview && !finalReview.spec.returned ? ['the final spec review returned nothing — review the merged range by hand'] : []),
    ...warnings,
  ];
  const brief = [
    `## Waves — ${TICKETS}`,
    `Landed (${landed.length}):`, ...landed.map((t) => line(t, `merged ${results[t.id].hash}`)),
    `Blocked (${stuck.length}):`, ...stuck.map((t) => line(t, `${String(results[t.id].reason).slice(0, 300)}${results[t.id].workdir ? ` — worktree ${results[t.id].workdir}` : ''}`)),
    `Waiting (${waiting.length}):`, ...waiting.map((t) => line(t, `blocked by ${t.blockedBy.filter((b) => state[b] !== DONE).map((b) => `${b} (${state[b] ?? 'missing'})`).join(', ')}`)),
    ...(finalReview ? [`Final review: code ${finalReview.code.approved ? 'APPROVED' : 'REJECTED'} · spec ${finalReview.spec.approved ? 'APPROVED' : 'REJECTED'} over ${head}..HEAD`] : []),
    `Decisions for you (${decisions.length}):`, ...decisions.map((d) => `- ${d}`),
  ].join('\n');
  log(brief);
  const allDone = !stuck.length && !waiting.length && finalReview?.code.approved && finalReview?.spec.approved;
  return print({
    plan, brief, finalReview, runDir,
    tickets: tickets.map((t) => ({ id: t.id, title: t.title, status: state[t.id], ...(results[t.id] ? { hash: results[t.id].hash ?? null, reason: results[t.id].reason ?? null, workdir: results[t.id].workdir ?? null, axes: results[t.id].axes ?? results[t.id].run?.axes ?? null } : {}) })),
    handoff: allDone
      ? { status: 'complete', summary: `${landed.length} ticket(s) landed; final review approved on both axes`, evidence: landed.map((t) => `${t.id} merged ${results[t.id].hash}`) }
      : { status: 'blocked', summary: `${landed.length} landed, ${stuck.length} blocked, ${waiting.length} waiting`, evidence: landed.map((t) => `${t.id} merged ${results[t.id].hash}`), blocker: decisions.join(' · ') || 'see the brief' },
    nextStep: allDone ? `Read the brief; ${branch} holds the merged work` : 'Read the brief: each decision names what blocks it',
  });
}

if (require.main === module) {
  main().then((code) => process.exit(code), (e) => { log(`develop-spec-pi: ${e.stack || e}`); process.exit(1); });
}

module.exports = { parseArgs, readTicket, readTickets, planWaves, setStatus };
