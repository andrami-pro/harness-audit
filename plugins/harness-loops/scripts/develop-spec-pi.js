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
//                           [--no-baseline-preflight] [--no-dependency-review]
//                           [any develop-phase-pi.js flag: --max-iter N --preflight "<cmd>" --allow-skipped "<s>"…
//                            --no-tdd --no-spec-review --no-jev --no-preparer --no-tmux --ui-check ["<cmd>"]]
//   --ui-check        reaches every ticket. Tickets run side by side, so the project's ui-check config should use {port}
//                     in url and serve: a second ticket would otherwise find the first one's server and stop NOT VERIFIED
//   --confirmed       run the waves. Without it the tickets are read and the plan printed: the human approves the
//                     breakdown once, before any code
//   --worktree-setup  run in each new worktree before its ticket starts (`pnpm install --frozen-lockfile`, or a `cp`
//                     of the gitignored files the preflight reads): a worktree holds only what git tracks
//   --integrate       the merge command; `{branch}` is replaced by the quoted branch (a `git merge …` without it gets
//                     the branch appended). Default: git merge --no-ff. A value with neither is refused before the plan
//   --no-baseline-preflight   skip the one preflight run in the first fresh worktree, before any implementer: a gate that
//                     is red there is red for every ticket, so the run stops with every ticket still ready-for-agent
//   --no-dependency-review    skip the seat (the architect's model) that, on the plan run, reads every `Blocked by:` and
//                     says which look avoidable. It suggests; the tickets stay as written
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
  const a = { tickets: '', confirmed: false, maxParallel: 2, worktreeSetup: null, integrate: null, prd: null, runDir: null, baseline: true, depReview: true, phase: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    if (k === '--tickets') a.tickets = argv[++i] || '';
    else if (k === '--confirmed') a.confirmed = true;
    else if (k === '--max-parallel') a.maxParallel = Number(argv[++i]);
    else if (k === '--worktree-setup') a.worktreeSetup = argv[++i] || null;
    else if (k === '--integrate') a.integrate = argv[++i] || null;
    else if (k === '--prd') a.prd = argv[++i] || null;
    else if (k === '--run-dir') a.runDir = argv[++i] || null;
    else if (k === '--no-baseline-preflight') a.baseline = false;
    else if (k === '--no-dependency-review') a.depReview = false;
    else if (PHASE_FLAGS.has(k)) a.phase.push(k);
    else if (PHASE_VALUES.has(k)) a.phase.push(k, argv[++i] || '');
    // Its command is optional, as in develop-phase-pi.js: the next argument is it unless it is another flag.
    else if (k === '--ui-check') a.phase.push(k, ...(argv[i + 1] && !argv[i + 1].startsWith('--') ? [argv[++i]] : []));
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
function planWaves(tickets, blockers = (t) => t.blockedBy) {
  const byId = Object.fromEntries(tickets.map((t) => [t.id, t]));
  const warnings = [];
  for (const t of tickets) for (const b of t.blockedBy) if (!byId[b]) warnings.push(`${t.id} is blocked by ${b}, which is not a ticket in the folder`);
  const waves = [];
  const landed = new Set(tickets.filter((t) => t.status === DONE).map((t) => t.id));
  let pending = tickets.filter((t) => t.status === READY);
  while (pending.length) {
    let migration = false;
    const wave = pending.filter((t) => blockers(t).every((b) => landed.has(b)))
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

// How parallel the plan is, said before the human approves it: the split is decided where the tickets are written.
const shapeOf = (w) => `${w.flat().length} ticket(s) in ${w.length} wave(s), ${w.length ? (w.flat().length / w.length).toFixed(1) : '0'} per wave`;
function parallelismOf(tickets, waves, maxParallel) {
  const byId = Object.fromEntries(tickets.map((t) => [t.id, t]));
  const inPlan = new Set(waves.flat());
  const chainOf = (id, seen = new Set()) => {
    if (seen.has(id)) return [];
    const below = (byId[id]?.blockedBy ?? []).filter((b) => inPlan.has(b)).map((b) => chainOf(b, new Set([...seen, id])));
    return [...below.reduce((x, y) => (y.length > x.length ? y : x), []), id];
  };
  const longestChain = [...inPlan].map((id) => chainOf(id)).reduce((x, y) => (y.length > x.length ? y : x), []);
  const migrations = tickets.filter((t) => inPlan.has(t.id) && t.migration).length;
  return {
    tickets: inPlan.size, waves: waves.length, widest: Math.max(0, ...waves.map((w) => w.length)), maxParallel, longestChain,
    summary: `${shapeOf(waves)}; the longest chain is ${longestChain.join(' → ') || 'none'}${
      migrations > 1 ? `; ${migrations} tickets add a migration and run one at a time` : ''}${
      waves.some((w) => w.length > maxParallel) ? `; a wave is wider than --max-parallel (${maxParallel}), so it runs in turns` : ''}`,
  };
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

  // The config is checked here, before the plan is shown and long before a worktree exists.
  if (a.integrate && !a.integrate.includes('{branch}') && !/\bgit\s+(merge|rebase|cherry-pick)\b/.test(a.integrate)) {
    return blocked('The run config cannot work — nothing was started', `--integrate is the command run to merge every ticket, and '${a.integrate.slice(0, 80)}' has neither {branch} nor a git merge. Write the command with {branch} where the branch name goes, or drop the flag to get git merge --no-ff`);
  }

  const phase = require('./develop-phase-pi.js');
  const byId = Object.fromEntries(tickets.map((t) => [t.id, t]));
  const state = Object.fromEntries(tickets.map((t) => [t.id, t.status]));
  const { waves, warnings, notReady } = planWaves(tickets);
  // Copying a secret into each worktree stops every ticket at setup in a project that denies reading it, as it should.
  if (/(^|[\s/'"=])\.(env|dev\.vars)\b/.test(String(a.worktreeSetup ?? ''))) {
    warnings.unshift('--worktree-setup names a secret file (.env or .dev.vars): a project whose deny rules protect it blocks every ticket at setup. Make the preflight pass in a fresh worktree without secrets instead');
  }
  const parallelism = parallelismOf(tickets, waves, a.maxParallel);
  log(`${tickets.length} ticket(s) · waves ${waves.map((w) => `[${w.join(', ')}]`).join(' ') || 'none'} · ${a.maxParallel} in flight · run dir ${runDir}`);
  log(`Shape: ${parallelism.summary}`);
  // The line-up is read once: the dependency review, the conflict resolution and the final review seat from it.
  let seats = null;
  try { seats = phase.resolveSeats(root, { spec: !a.phase.includes('--no-spec-review') }); } catch (e) { log(`line-up refused — ${e.message}`); }

  // On the plan run only: one seat reads the tickets and says, for each `Blocked by:`, whether the dependent really
  // needs the blocker merged or only needs to agree an interface with it. An edge the seat invented is dropped.
  const inPlan = new Set(waves.flat());
  const edges = tickets.filter((t) => inPlan.has(t.id)).flatMap((t) => t.blockedBy.filter((b) => inPlan.has(b)).map((b) => `${t.id}<-${b}`));
  let dependencyReview = null;
  if (!a.confirmed && a.depReview && edges.length && seats) {
    const text = await phase.runSeat({
      name: 'deps', model: seats.architect, tools: 'read,grep,find,ls', runDir, timeoutS: 900, cwd: root,
      prompt: `Solo lectura: no edites nada. Lee estos tickets en ${TICKETS}: ${tickets.filter((t) => inPlan.has(t.id)).map((t) => t.file).join(', ')}.
Cada dependencia se escribe "<ticket><-<bloqueador>": el ticket no arranca hasta que el bloqueador esté fusionado.
${edges.join('  ')}
Para CADA una decide, por lo que los dos tickets dicen que construyen:
- needed: el ticket no se puede escribir ni probar sin código que añade el bloqueador, y la forma de ese código no se
  puede fijar de antemano (cambia las mismas líneas, o su comportamiento es lo que el ticket verifica).
- avoidable: el ticket solo necesita conocer una interfaz que el bloqueador introduce (una firma, una tabla, una ruta,
  un tipo). Los dos podrían correr a la vez si esa interfaz estuviera escrita bajo "## Seams" en ambos tickets. O la
  dependencia es una preferencia de orden, no una necesidad.
En la duda, needed: un "avoidable" equivocado cuesta un conflicto de merge.
Una línea por dependencia, exactamente así, y nada más:
<ticket><-<bloqueador> | needed o avoidable | por qué, en una frase que nombra archivos o símbolos | la línea de seam a añadir a ambos tickets, o -`,
    });
    const judged = text.split('\n').map((l) => l.split('|').map((x) => x.trim())).filter((c) => c.length >= 3)
      .map(([edge, verdict, why, how]) => {
        const m = edge.match(/(\d+)\s*<-\s*(\d+)/);
        const v = verdict.toLowerCase().replace(/[^a-z]/g, '');
        return m && ['needed', 'avoidable'].includes(v) ? { ticket: m[1], blocker: m[2], verdict: v, why, how: how && how !== '-' ? how : null } : null;
      }).filter((e) => e && edges.includes(`${e.ticket}<-${e.blocker}`));
    if (text) {
      const avoidable = judged.filter((e) => e.verdict === 'avoidable');
      const drop = new Set(avoidable.map((e) => `${e.ticket}<-${e.blocker}`));
      const whatIf = planWaves(tickets, (t) => t.blockedBy.filter((b) => !drop.has(`${t.id}<-${b}`))).waves;
      dependencyReview = {
        reviewed: judged.length, of: edges.length, avoidable,
        whatIf: avoidable.length ? { waves: whatIf, summary: shapeOf(whatIf) } : null,
        note: avoidable.length
          ? `${avoidable.length} of ${edges.length} dependencies look avoidable: without them, ${shapeOf(whatIf)} instead of ${shapeOf(waves)}. A suggestion — to take one, write its seam in both tickets and remove the Blocked by, then re-run the plan`
          : `all ${judged.length} reviewed dependencies look needed`,
      };
      log(`Dependencies: ${dependencyReview.note}`);
    }
  }
  const plan = {
    root, branch, head, waves, warnings, notReady, parallelism, dependencyReview,
    tickets: tickets.map((t) => ({ id: t.id, title: t.title, status: t.status, blockedBy: t.blockedBy, migration: t.migration, seams: t.seams.length })),
  };
  if (!a.confirmed) return blocked('Waves planned — approve the ticket breakdown before any code', `Read the plan (${parallelism.summary}${dependencyReview?.avoidable.length ? `; ${dependencyReview.note}` : ''}); fix the tickets if needed, then re-run with --confirmed`, { plan, tickets: plan.tickets });
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

  // A ticket that stops before any implementer wrote a line leaves nothing worth keeping: its empty worktree and branch
  // go, and its ticket stays ready-for-agent. A worktree made by this run is empty by construction; a kept one goes only
  // when its branch has no commit of its own and nothing is uncommitted in it.
  const notStarted = (t, br, workdir, fresh, why) => {
    const has = fs.existsSync(workdir);
    const hasBranch = () => git(['show-ref', '--verify', '--quiet', `refs/heads/${br}`], root).code === 0;
    const empty = fresh || (hasBranch() && git(['rev-list', '--count', `${branch}..${br}`], root).out === '0' && (!has || !git(['status', '--short'], workdir).out));
    let kept = has;
    if (empty) {
      if (has) kept = git(['worktree', 'remove', '--force', workdir], root).code !== 0;
      if (!kept && hasBranch()) git(['branch', '-D', br], root);
    }
    return { id: t.id, status: 'not-started', reason: why, workdir: kept ? workdir : null };
  };
  // One preflight in the first fresh worktree, before any implementer: a gate that is red or skips checks there is red
  // for every ticket, whatever they write. Eleven tickets were blocked that way on Claude, each after a full review.
  const flagValue = (flag) => { const i = a.phase.lastIndexOf(flag); return i >= 0 ? a.phase[i + 1] : null; };
  const allowSkipped = a.phase.flatMap((k, i) => (k === '--allow-skipped' ? [a.phase[i + 1]] : []));
  const preflightIn = (workdir, name) => {
    const dir = path.join(runDir, name);
    fs.mkdirSync(dir, { recursive: true });
    const cmd = flagValue('--preflight') || phase.preflightCommand(workdir, null);
    return { cmd, ...phase.runPreflight(cmd, dir, allowSkipped, workdir) };
  };
  let baselineChecked = false;
  let baselineProblem = null;
  const checkBaseline = (workdir) => {
    baselineChecked = true;
    const b = preflightIn(workdir, 'baseline');
    if (!b.cmd) return 'the repository has no preflight (a `preflight` script in package.json, or scripts/preflight.sh) and none was passed with --preflight, so no ticket could finish';
    if (b.exitCode !== 0) return `the preflight (${b.cmd}) fails in a fresh worktree, before any ticket changed a line (${b.state}): ${b.tail.split('\n').slice(-3).join(' / ').slice(0, 300)}. Make it pass in a clean checkout (--worktree-setup installs what git does not track; a check that needs a secret should skip and be named with --allow-skipped)`;
    if (b.skipped.length) return `the preflight skips checks in a fresh worktree that --allow-skipped does not name, so no ticket could finish: ${b.skipped.slice(0, 4).join(' · ')}. Supply what they need in --worktree-setup, or name them with --allow-skipped`;
    return null;
  };

  // Two tickets in flight can touch the same file; the second to finish used to stop at the conflict. One attempt in the
  // ticket's own worktree: bring the base in, a seat resolves, and code checks the markers, runs the preflight and commits.
  // The resolution is not reviewed per ticket — the final review reads the whole merged range — and the brief says so.
  const resolveConflict = async (t, br, workdir) => {
    if (!seats) return false;
    const before = git(['rev-parse', 'HEAD'], workdir).out;
    const merging = () => git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], workdir).code === 0;
    const undo = (why) => {
      if (merging()) git(['merge', '--abort'], workdir);
      git(['reset', '--hard', before], workdir);
      log(`[${t.id}] conflict not resolved: ${why}`);
      return false;
    };
    const m = git(['merge', '--no-edit', branch], workdir);
    const files = git(['diff', '--name-only', '--diff-filter=U'], workdir).out.split('\n').filter(Boolean);
    if (m.code !== 0 && !files.length) return undo((m.err || m.out).split('\n').pop());
    if (files.length) {
      log(`[${t.id}] conflict with ${branch} in ${files.join(', ')} — one resolution attempt`);
      const out = await phase.runSeat({
        name: `resolve-${t.id}`, model: seats.implementer, tools: 'read,bash,edit,write,grep,find,ls', runDir, timeoutS: 1200, cwd: workdir,
        prompt: `Eres el asiento que resuelve un conflicto de merge en un loop de desarrollo. La rama de este ticket (${br}) ya no se
fusiona en ${branch}: otros tickets aterrizaron allí mientras se escribía. Estás en el worktree del ticket, con el merge
de ${branch} en curso.
Archivos en conflicto: ${files.join(', ')}
Para cada uno conserva LAS DOS intenciones: el cambio de este ticket (${TICKETS}/${t.file}) y lo que aterrizó en ${branch}.
Nunca descartes un lado para que el conflicto desaparezca; lee ambos antes de editar. Quita todas las marcas de conflicto.
PROHIBIDO: git commit, git merge --abort, cambiar de rama, push, tocar archivos que no están en conflicto.
El loop comprueba las marcas, ejecuta el preflight y hace el commit del merge.
Al terminar: una línea por archivo con lo que conservaste de cada lado.`,
      });
      if (!out) return undo('the resolve seat returned nothing');
      const marked = files.filter((f) => { try { return /^(<{7}|>{7}) /m.test(fs.readFileSync(path.join(workdir, f), 'utf8')); } catch { return false; } });
      if (marked.length) return undo(`conflict markers left in ${marked.join(', ')}`);
    }
    const pf = preflightIn(workdir, `resolve-${t.id}`);
    if (!pf.passed) return undo(`the preflight is not green after the resolution (${pf.state})`);
    if (merging()) {
      git(['add', '-A', '--', ...files], workdir);
      const c = git(['commit', '--no-edit'], workdir);
      if (c.code !== 0) return undo((c.err || c.out).split('\n').pop());
    }
    return true;
  };

  const runTicket = async (t) => {
    const br = `spec/${slug(t)}`;
    const workdir = path.join(root, '.pi', 'worktrees', `spec-${slug(t)}`);
    if (baselineProblem) return { id: t.id, status: 'not-started', reason: baselineProblem, workdir: null };
    // A ticket blocked earlier kept its worktree and branch for inspection; set back to ready-for-agent, it resumes there.
    let fresh = false;
    if (!fs.existsSync(workdir)) {
      const keptBranch = git(['show-ref', '--verify', '--quiet', `refs/heads/${br}`], root).code === 0;
      const made = keptBranch ? git(['worktree', 'add', workdir, br], root) : git(['worktree', 'add', workdir, '-b', br, branch], root);
      fresh = !keptBranch;
      if (made.code !== 0) return notStarted(t, br, workdir, fresh, `worktree not ready: ${made.err.split('\n').pop()}`);
    }
    // A kept branch was cut from an older HEAD: what landed since (its blockers, a fix) is brought in before it resumes.
    if (git(['merge-base', '--is-ancestor', branch, br], root).code !== 0) {
      const up = git(['merge', '--no-edit', branch], workdir);
      if (up.code !== 0) {
        git(['merge', '--abort'], workdir);
        return notStarted(t, br, workdir, false, `the kept worktree could not take ${branch} (${(up.err || up.out).split('\n').pop()}) — merge it by hand in ${workdir}; the ticket stays ready-for-agent`);
      }
    }
    const ex = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
    if (!ex.split('\n').includes('.pi/worktrees/')) fs.appendFileSync(exclude, `${ex && !ex.endsWith('\n') ? '\n' : ''}.pi/worktrees/\n`);
    if (a.worktreeSetup) {
      const s = spawnSync('sh', ['-c', a.worktreeSetup], { cwd: workdir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      if (s.status !== 0) {
        return notStarted(t, br, workdir, fresh, `worktree setup failed (exit ${s.status}): ${`${s.stderr || ''}${s.stdout || ''}`.trim().split('\n').pop() || a.worktreeSetup}`);
      }
      // develop-phase-pi commits with `git add -A`: a file the setup copied in that git does not ignore would ship.
      const left = fresh ? git(['ls-files', '--others', '--exclude-standard'], workdir).out.split('\n').filter(Boolean) : [];
      if (left.length) {
        return notStarted(t, br, workdir, fresh, `worktree setup left files git does not ignore, which the ticket's commit would carry: ${left.slice(0, 5).join(', ')} — gitignore them`);
      }
    }
    if (a.baseline && !baselineChecked && fresh) {
      baselineProblem = checkBaseline(workdir);
      if (baselineProblem) return notStarted(t, br, workdir, fresh, baselineProblem);
    }
    const { code, res, error } = await runPhase(t, workdir);
    if (res?.handoff?.status !== 'complete' || !res.commit?.committed) {
      const why = String(res?.handoff?.blocker || res?.nextStep || res?.handoff?.summary
        || error || `develop-phase-pi.js exited ${code} with no result (line-up refused or usage error — see the [${t.id}] lines)`);
      await mark(t, `${why.slice(0, 300)} — worktree kept at ${workdir}`);
      return { id: t.id, status: 'blocked', reason: why, workdir, run: res };
    }
    // Landing and tidying are reported apart: a merge that landed is landed even when its worktree will not go.
    const tryLand = () => serial(() => {
      if (git(['branch', '--show-current'], root).out !== branch) {
        return { merged: false, conflicts: [], why: `approved and committed on ${br}, but not merged: the checkout is no longer on ${branch}` };
      }
      const cmd = a.integrate
        ? (a.integrate.includes('{branch}') ? a.integrate.replaceAll('{branch}', q(br)) : `${a.integrate} ${q(br)}`)
        : `git merge --no-ff ${q(br)} -m ${q(`merge: ${t.id} — ${t.title}`)}`;
      const m = spawnSync('sh', ['-c', cmd], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      if (m.status !== 0) {
        const conflicts = git(['diff', '--name-only', '--diff-filter=U'], root).out.split('\n').filter(Boolean);
        if (fs.existsSync(path.resolve(root, git(['rev-parse', '--git-path', 'MERGE_HEAD'], root).out))) git(['merge', '--abort'], root);
        return { merged: false, conflicts, why: `approved and committed on ${br}, but not merged: ${conflicts.length ? `conflict in ${conflicts.join(', ')} — resolve it by hand (merge ${branch} into ${br} in its worktree), then merge ${br}` : `${`${m.stderr || ''}${m.stdout || ''}`.trim().split('\n').pop()}`}` };
      }
      const hash = commitStatus(t, DONE, `merged by develop-spec-pi from ${br}`) || git(['rev-parse', '--short', 'HEAD'], root).out;
      const rm = git(['worktree', 'remove', workdir], root);
      const bd = rm.code === 0 ? git(['branch', '-d', br], root) : rm;
      return { merged: true, hash, ...(bd.code === 0 ? {} : { tidy: `${workdir} or ${br} left in place: ${bd.err.split('\n').pop()}` }) };
    });
    let land = await tryLand();
    let resolved = false;
    if (!land.merged && land.conflicts.length && await resolveConflict(t, br, workdir)) {
      resolved = true;
      land = await tryLand();
    }
    if (!land.merged) {
      await mark(t, land.why);
      return { id: t.id, status: 'blocked', reason: land.why, workdir, run: res };
    }
    return { id: t.id, status: DONE, hash: land.hash, commit: res.commit.hash, axes: res.axes, run: res, resolved, ...(land.tidy ? { tidy: land.tidy } : {}) };
  };

  // The frontier is every ready ticket whose blockers are all done; a slot frees, the frontier is recomputed. A
  // blocked ticket keeps its dependents waiting and the rest of the graph goes on.
  const results = {};
  const running = new Map();
  const migrating = () => [...running.keys()].some((id) => byId[id].migration);
  for (;;) {
    for (const t of tickets) {
      if (running.size >= a.maxParallel || baselineProblem) break;
      if (state[t.id] !== READY || running.has(t.id) || !t.blockedBy.every((b) => state[b] === DONE)) continue;
      if (t.migration && migrating()) continue;
      log(`▶ ${t.id} — ${t.title}`);
      running.set(t.id, runTicket(t).catch((e) => ({ id: t.id, status: 'blocked', reason: `the run threw: ${e.message}` })));
    }
    if (!running.size) break;
    const r = await Promise.race(running.values());
    running.delete(r.id);
    state[r.id] = r.status === DONE ? DONE : r.status === 'not-started' ? 'not-started' : 'blocked';
    results[r.id] = r;
    log(r.status === DONE ? `✓ ${r.id} merged ${r.hash}` : `⛔ ${r.id} ${r.status === 'not-started' ? 'not started' : 'blocked'} — ${String(r.reason).slice(0, 160)}`);
  }

  const landed = tickets.filter((t) => results[t.id]?.status === DONE);
  const stuck = tickets.filter((t) => results[t.id]?.status === 'blocked');
  // Stopped before any implementer wrote a line: the ticket file still says ready-for-agent, nothing was left behind.
  const notRun = tickets.filter((t) => results[t.id]?.status === 'not-started');
  const waiting = tickets.filter((t) => state[t.id] === READY && !results[t.id]);

  // One two-axis review of everything that landed: each ticket was reviewed alone, and the sum can still miss the PRD.
  let finalReview = null;
  if (landed.length) {
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
  const decisions = [...new Set([
    ...(baselineProblem ? [`nothing ran: ${baselineProblem}`] : []),
    ...notRun.filter((t) => results[t.id].reason !== baselineProblem).map((t) => `${t.id} did not start: ${String(results[t.id].reason).slice(0, 300)}`),
    ...stuck.map((t) => `${t.id}: ${String(results[t.id].reason).slice(0, 300)}`),
    ...landed.filter((t) => results[t.id].resolved).map((t) => `${t.id} landed after a seat resolved a merge conflict with ${branch}: no ticket review saw that resolution, read it in the merged range`),
    ...landed.filter((t) => results[t.id].tidy).map((t) => `${t.id} landed, tidy up by hand: ${results[t.id].tidy}`),
    ...(finalReview ? [...finalReview.code.fails.map((f) => `final code review: ${f}`), ...finalReview.spec.fails.map((f) => `final spec review: ${f}`)] : []),
    ...(finalReview && !finalReview.code.returned ? ['the final code review returned nothing — review the merged range by hand'] : []),
    ...(finalReview && !finalReview.spec.returned ? ['the final spec review returned nothing — review the merged range by hand'] : []),
    ...warnings,
  ])];
  const brief = [
    `## Waves — ${TICKETS}`,
    `Landed (${landed.length}):`, ...landed.map((t) => line(t, `merged ${results[t.id].hash}`)),
    `Blocked (${stuck.length}):`, ...stuck.map((t) => line(t, `${String(results[t.id].reason).slice(0, 300)}${results[t.id].workdir ? ` — worktree ${results[t.id].workdir}` : ''}`)),
    ...(notRun.length ? [`Not started (${notRun.length}) — still ready-for-agent, nothing left behind:`, ...notRun.map((t) => line(t, `${String(results[t.id].reason).slice(0, 200)}${results[t.id].workdir ? ` — worktree kept, it holds work: ${results[t.id].workdir}` : ''}`))] : []),
    `Waiting (${waiting.length}):`, ...waiting.map((t) => line(t, t.blockedBy.some((b) => state[b] !== DONE)
      ? `blocked by ${t.blockedBy.filter((b) => state[b] !== DONE).map((b) => `${b} (${state[b] ?? 'missing'})`).join(', ')}` : 'the run stopped before its turn')),
    ...(finalReview ? [`Final review: code ${finalReview.code.approved ? 'APPROVED' : 'REJECTED'} · spec ${finalReview.spec.approved ? 'APPROVED' : 'REJECTED'} over ${head}..HEAD`] : []),
    `Decisions for you (${decisions.length}):`, ...decisions.map((d) => `- ${d}`),
  ].join('\n');
  log(brief);
  const allDone = !stuck.length && !notRun.length && !waiting.length && finalReview?.code.approved && finalReview?.spec.approved;
  return print({
    plan, brief, finalReview, runDir,
    tickets: tickets.map((t) => ({ id: t.id, title: t.title, status: state[t.id], ...(results[t.id] ? { hash: results[t.id].hash ?? null, reason: results[t.id].reason ?? null, workdir: results[t.id].workdir ?? null, axes: results[t.id].axes ?? results[t.id].run?.axes ?? null } : {}) })),
    handoff: allDone
      ? { status: 'complete', summary: `${landed.length} ticket(s) landed; final review approved on both axes`, evidence: landed.map((t) => `${t.id} merged ${results[t.id].hash}`) }
      : { status: 'blocked', summary: `${landed.length} landed, ${stuck.length} blocked, ${waiting.length} waiting${notRun.length ? `, ${notRun.length} not started` : ''}`, evidence: landed.map((t) => `${t.id} merged ${results[t.id].hash}`), blocker: decisions.join(' · ') || 'see the brief' },
    nextStep: allDone ? `Read the brief; ${branch} holds the merged work` : 'Read the brief: each decision names what blocks it',
  });
}

if (require.main === module) {
  main().then((code) => process.exit(code), (e) => { log(`develop-spec-pi: ${e.stack || e}`); process.exit(1); });
}

module.exports = { parseArgs, readTicket, readTickets, planWaves, parallelismOf, setStatus };
