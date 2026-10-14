#!/usr/bin/env node
// develop-phase-pi.js — the develop-phase loop (scout → analyst → implementer ⇄ reviewer → preflight →
// commit) for Pi, where there is no Workflow runtime. Same contract as the Claude Code workflow the audit
// writes (.claude/workflows/develop-phase.js); what differs is who holds the loop:
//
//   - The loop is THIS file, not a prompt. A prompt template would ask a model to count iterations, parse
//     a verdict and read an exit code — the three things code does without being wrong. Each seat is one
//     `pi -p --no-session` call with its own model and its own tool allowlist; nothing else is a model.
//   - Every seat's model comes from the line-up (~/.agents/model-lineup.json, harness `pi`, merged with the
//     project's .agents/model-lineup.json) resolved at run time — there is no stamped copy to drift. The
//     analyst sits in the `architect` role. D25a is re-checked here: a line-up whose reviewer, or spec
//     reviewer, shares the implementer's family refuses to run.
//   - Two reviewers judge each diff in parallel (PRD-004 §3.2): the code reviewer against the rubric, the spec
//     reviewer against the task, the PRD, the plan and the seams. Approval needs both.
//   - Preflight is the project's own gate run through the shell. Its exit code and its SKIP lines are read
//     by code; a SKIP is not a PASS.
//   - Jev (scripts/jev.js), when a TypeSafe key is present, sizes the task before any seat runs:
//     `trivial` skips scout and analyst (the old preparer:false), `bounded` gives the analyst seat the
//     implementer's cheaper model, `complex` keeps the architect. No key, or a low-confidence answer →
//     the full pipeline with the architect, exactly as without Jev.
//
// Usage (from the session's worktree):
//   node develop-phase-pi.js --task "<task>" [--max-iter 5] [--no-preparer] [--no-commit]
//                            [--preflight "<command>"] [--no-jev] [--run-dir <path>] [--no-tmux]
//                            [--seams propose | --seams "<one per line>"] [--no-tdd] [--no-spec-review]
//                            [--allow-skipped "<substring>"]…
//   --seams propose   stop after the analyst and return its seams in the result, for the human to agree once
//   --seams "<list>"  the agreed seams: the analyst copies them or stops on BLOQUEO/BLOCKER; every seat gets them
//   --no-tdd          the implementer is not asked to work test-first (default: test-first, one test per seam)
//   --no-spec-review  no spec axis: the code reviewer alone approves (default: both axes, the spec model from
//                     harness.pi.spec or, unset, the reviewer's)
//   --allow-skipped   repeatable: a preflight SKIP line containing it (any case) is reported, not counted
// Progress goes to stderr, one line per event; the result (handoff JSON) goes to stdout. Every seat's
// prompt and full transcript are kept under the run dir printed at start:
//   <name>.live.log  — that seat's actions as they happen (tool calls, thinking, final answer)
//   bus.log          — only the hand-offs between seats (brief → plan → diff → verdict → preflight →
//                      commit), the "conversation" the loop actually has with itself
// Unless --no-tmux, a detached tmux session (never an existing pane — see scripts/dp-tmux.sh) opens a
// live view: bus.log on top, the currently active seat's log on the bottom. The attach command is
// printed once, at start. A missing tmux, or any failure starting it, is silent and never fails the run.
// Exit 0 — approved and preflight PASS. Exit 1 — anything else (blocked, rejected, crash, preflight not
// green). Exit 2 — line-up refused (D25a) or usage error.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const lineupMod = require('./model-lineup.js');

const SEAT_TIMEOUT_S = { scout: 900, analyst: 900, implementer: 2400, reviewer: 1200, commit: 300 };
const MAX_DIFF_BYTES = 300_000;
const MAX_UNTRACKED_BYTES = 20_000;
const JEV_MIN_CONFIDENCE = 0.5;
const READ_ONLY = 'read,grep,find,ls';

// ── args ─────────────────────────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { task: '', maxIter: 5, preparer: true, commit: true, preflight: null, jev: true, runDir: null, tmux: true, seams: null, tdd: true, allowSkipped: [], spec: true };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    if (k === '--task') a.task = argv[++i] || '';
    else if (k === '--max-iter') a.maxIter = Number(argv[++i]);
    else if (k === '--no-preparer') a.preparer = false;
    else if (k === '--no-commit') a.commit = false;
    else if (k === '--preflight') a.preflight = argv[++i] || null;
    else if (k === '--no-jev') a.jev = false;
    else if (k === '--run-dir') a.runDir = argv[i + 1] ? path.resolve(argv[++i]) : (i += 1, null); // before main() chdirs to the root
    else if (k === '--no-tmux') a.tmux = false;
    else if (k === '--seams') a.seams = argv[++i] || '';
    else if (k === '--no-tdd') a.tdd = false;
    else if (k === '--no-spec-review') a.spec = false;
    else if (k === '--allow-skipped') a.allowSkipped.push(argv[++i] || '');
    else throw new Error(`unknown argument: ${k}`);
  }
  if (!a.task.trim()) throw new Error('--task is required');
  if (!Number.isInteger(a.maxIter) || a.maxIter < 1) throw new Error('--max-iter must be a positive integer');
  if (a.allowSkipped.some((s) => !s.trim())) throw new Error('--allow-skipped needs a substring');
  if (a.seams === 'propose' && !a.preparer) throw new Error('--seams propose needs the analyst: drop --no-preparer');
  a.agreedSeams = a.seams === 'propose' ? [] : String(a.seams || '').split('\n').map((l) => l.trim()).filter(Boolean);
  return a;
}

// The test-first rule, word for word the one workflows/develop-phase.js gives its implementer.
const TDD_RULES = `Work test-first, one vertical slice at a time. For each seam (none listed: each public interface the task
touches), write one test that exercises it through that interface, run it and watch it fail for the expected reason,
then write the least code that makes it pass; refactor only on green. If ~/.agents/skills/tdd/SKILL.md exists, read it first and follow it.
In your report, name per seam the test and the command that ran it red, then green.`;

const log = (line) => process.stderr.write(`${line}\n`);

// ── line-up ──────────────────────────────────────────────────────────────────────────────────────────
function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function resolveSeats(root, { spec = true } = {}) {
  const global = readJson(process.env.MODEL_LINEUP_PATH || path.join(os.homedir(), '.agents', 'model-lineup.json'));
  const project = readJson(path.join(root, '.agents', 'model-lineup.json'));
  if (!global && !project) throw Object.assign(new Error('no line-up found (~/.agents/model-lineup.json)'), { code: 2 });
  const merged = lineupMod.mergeLineups(global, project);
  const { resolved } = lineupMod.resolveLineup(merged, 'pi');
  const hard = lineupMod.hardViolation(resolved);
  if (hard) throw Object.assign(new Error(hard), { code: 2 });
  const need = ['scout', 'architect', 'implementer', 'reviewer', 'orchestrator'];
  const missing = need.filter((r) => !resolved[r]);
  if (missing.length) throw Object.assign(new Error(`line-up has no model for: ${missing.join(', ')}`), { code: 2 });
  // On Pi every seat must be pinned in the `pi` column. A role missing there falls back to `defaults`,
  // which holds Claude ids — and `pi --model claude-…` can still reach Claude through OpenRouter. So a
  // fallback, or any Claude/Anthropic id, refuses the run instead of silently spending on Claude.
  const claude = need.filter((r) => !resolved[r].provider || /claude|anthropic/i.test(`${resolved[r].provider}/${resolved[r].model}`));
  if (claude.length) throw Object.assign(new Error(`seat(s) not pinned to a non-Claude model in harness.pi: ${claude.map((r) => `${r}=${resolved[r].stamp}`).join(', ')}`), { code: 2 });
  const seats = Object.fromEntries(Object.entries(resolved).map(([role, e]) => [role, e.stamp]));
  // The spec reviewer is a second reviewer, so D25a binds it too. ROLES in model-lineup.js has no `spec` (that file
  // is shared by both plugins and the line-up UI), so the role is read from the `pi` column directly — never from
  // `defaults` — under the same non-Claude rule; with no `spec` pinned it takes the reviewer's model.
  seats.spec = null;
  if (spec) {
    const entry = merged.harness?.pi?.spec;
    const stamp = entry ? `${String(entry.provider || '').trim()}/${String(entry.model || '').trim()}` : seats.reviewer;
    if (entry && (!entry.provider || !entry.model || /claude|anthropic/i.test(stamp))) {
      throw Object.assign(new Error(`seat(s) not pinned to a non-Claude model in harness.pi: spec=${stamp}`), { code: 2 });
    }
    const family = entry ? lineupMod.familyOf(entry) : resolved.reviewer.family;
    if (family === resolved.implementer.family) {
      throw Object.assign(new Error(`spec reviewer (${stamp}, family ${family}) and implementer (${resolved.implementer.model}, family `
        + `${resolved.implementer.family}) share a model family — the independence property (D25a) forbids this. Pin another `
        + 'family in harness.pi.spec, or run with --no-spec-review.'), { code: 2 });
    }
    seats.spec = stamp;
  }
  return seats;
}

// ── Jev sizing ───────────────────────────────────────────────────────────────────────────────────────
const SIZES = {
  trivial: 'one mechanical change whose location is already named in the task: a rename, a copy fix, a constant, one obvious line',
  bounded: 'one feature or one bug with clear acceptance, a few files, no design decision left open',
  complex: 'several modules, an ambiguous requirement, or a design or data decision where the wrong call is expensive',
};

async function sizeTask(task) {
  let jev;
  try { jev = require('./jev.js'); } catch { return { size: null, note: 'jev.js missing' }; }
  if (!jev.isEnabled()) return { size: null, note: 'Jev off (no TYPESAFE_API_KEY)' };
  try {
    const r = await jev.choice({ task: task.slice(0, 1500) }, 'How big is this development task for a coding agent?', SIZES, { timeoutMs: 8000, waits: [2000] });
    const p = Number(r.probabilities?.[r.choice] ?? r.confidence);
    if (!SIZES[r.choice] || !(p >= JEV_MIN_CONFIDENCE)) return { size: null, note: `Jev unsure (${r.choice}, p=${p.toFixed(2)})` };
    return { size: r.choice, note: `Jev: ${r.choice} (p=${p.toFixed(2)})` };
  } catch (e) {
    return { size: null, note: `Jev unavailable: ${String(e.message).split('\n')[0]}` };
  }
}

// ── seats ────────────────────────────────────────────────────────────────────────────────────────────
// One seat = one ephemeral pi run, in --mode json so its actions can be shown live instead of only its
// final answer. The prompt travels as a file (@path) because a diff does not fit in argv. HARNESS_SEAT
// tells this package's own Pi extensions (the Jev router) that the session is a seat, not a human: no
// advisory line, no API call per seat.
const TRUNC = (s, n = 200) => (s.length > n ? `${s.slice(0, n)}…` : s);

// Translates one `pi --mode json` line into a human line for <name>.live.log, or null for events with
// nothing worth showing (session/turn boundaries, partial tool-output streaming). Returns the event's
// assistant text too, when there is one — the caller keeps only the LAST one as the seat's final answer,
// exactly as plain-text mode's stdout used to be (final answer only, no tool calls, no thinking).
function translateEvent(d) {
  if (d.type === 'tool_execution_start') {
    return { line: `🔧 ${d.toolName}${d.input ? ` ${TRUNC(JSON.stringify(d.input), 160)}` : ''}` };
  }
  if (d.type === 'tool_execution_end') {
    const r = d.result?.content?.[0]?.text ?? d.result?.content?.[0]?.type ?? '';
    return { line: `   ↳ ${TRUNC(String(r).replace(/\n/g, ' '), 160)}` };
  }
  if (d.type === 'message_end' && d.message?.role === 'assistant') {
    // errorMessage rides an otherwise-empty assistant message (stopReason: "error") — checked first,
    // since an empty content array would otherwise fall through silently and the error never surfaces.
    if (d.message.errorMessage) return { line: `✗ ${d.message.errorMessage}` };
    const parts = Array.isArray(d.message.content) ? d.message.content : [];
    const thinking = parts.filter((p) => p.type === 'thinking').map((p) => p.thinking).join(' ');
    const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
    const lines = [];
    if (thinking) lines.push(`💭 ${TRUNC(thinking, 200)}`);
    if (text) lines.push(`💬 ${TRUNC(text, 400)}`);
    return { line: lines.join('\n') || null, text: text || null };
  }
  return { line: null };
}

function runSeat({ name, model, tools, prompt, runDir, timeoutS }) {
  const promptFile = path.join(runDir, `${name}.prompt.md`);
  const liveFile = path.join(runDir, `${name}.live.log`);
  fs.writeFileSync(promptFile, prompt);
  fs.writeFileSync(liveFile, `── ${name} (${model}) ──\n`);
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn('pi', ['-p', '--mode', 'json', '--no-session', '--model', model, '--tools', tools, `@${promptFile}`, 'Haz la tarea descrita arriba.'],
      { cwd: process.cwd(), env: { ...process.env, HARNESS_SEAT: name }, stdio: ['ignore', 'pipe', 'pipe'] });
    let raw = '';
    let jsonSeen = false;
    let lastText = '';
    let buf = '';
    let err = '';
    child.stdout.on('data', (c) => {
      raw += c;
      buf += c;
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let d;
        try { d = JSON.parse(line); } catch { continue; } // non-JSON stdout (a non-pi `pi` on PATH): raw is the fallback
        jsonSeen = true;
        const t = translateEvent(d);
        if (t.line) fs.appendFileSync(liveFile, `${t.line}\n`);
        if (t.text) lastText = t.text; // overwritten on every assistant turn; the LAST one wins, as before
      }
    });
    child.stderr.on('data', (c) => { err += c; });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutS * 1000);
    child.on('error', (e) => { err += String(e.message); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      // A binary on PATH that isn't pi (a test double, most often) never emits parseable JSON: fall back
      // to the old contract, the whole of stdout, so nothing here depends on --mode json existing.
      const out = jsonSeen ? lastText : raw;
      fs.writeFileSync(path.join(runDir, `${name}.out.md`), out);
      if (err.trim()) fs.writeFileSync(path.join(runDir, `${name}.err.txt`), err);
      const secs = Math.round((Date.now() - started) / 1000);
      if (code !== 0 || !out.trim()) {
        const line = `✗ murió: ${signal ? `killed ${signal} after ${secs}s` : `exit ${code}`} — ${err.trim().split('\n').pop() || 'empty output'}`;
        fs.appendFileSync(liveFile, `${line}\n`);
        log(`  ${line.replace('✗ murió', `✗ ${name} (${model}) murió`)}`);
        return resolve('');
      }
      fs.appendFileSync(liveFile, `── fin (${secs}s) ──\n`);
      log(`  ✓ ${name} (${model}) ${secs}s`);
      resolve(out.trim());
    });
  });
}

function firstExisting(root, files) {
  return files.map((f) => path.join(root, f)).find((f) => fs.existsSync(f)) || null;
}

const stripFrontmatter = (text) => text.replace(/^---\n[\s\S]*?\n---\n/, '');

function git(args) {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

function changeSet() {
  const diff = git(['diff', 'HEAD']).out;
  const untracked = git(['ls-files', '--others', '--exclude-standard']).out.split('\n').filter(Boolean);
  let text = `\`\`\`diff\n${diff.slice(0, MAX_DIFF_BYTES)}${diff.length > MAX_DIFF_BYTES ? '\n[diff truncated]' : ''}\n\`\`\`\n`;
  for (const f of untracked) {
    let body = '';
    try { body = fs.readFileSync(f, 'utf8').slice(0, MAX_UNTRACKED_BYTES); } catch { body = '[unreadable]'; }
    text += `\n### ${f} (nuevo)\n\`\`\`\n${body}\n\`\`\`\n`;
  }
  return { text, empty: !diff.trim() && !untracked.length };
}

// The verdict is the last line that is a verdict and nothing else, whole. includes() would read
// "[FAIL] … no APROBADO" as an approval; notes a reviewer adds after its verdict must not hide it.
const APROBADOS = ['APROBADO', 'APPROVED', 'APPROUVÉ', 'APPROUVE'];
const VERDICTOS = [...APROBADOS, 'RECHAZADO', 'REJECTED', 'REJETÉ', 'REJETE'];
function verdictOf(review) {
  const v = review.trim().split('\n').map((l) => l.replace(/[*`_\s#:.]/g, '').toUpperCase()).reverse().find((l) => VERDICTOS.includes(l));
  return APROBADOS.includes(v);
}

// The seams are read from the plan with the rules of seamsOf() in workflows/develop-phase.js: a marker line is
// read without its markdown (**SEAMS**:, - SEAMS:, > SEAMS (one per line):, END SEAMS:), and with no END line the
// block ends at the first blank line, so the risks section is never read as seams.
const marker = (l) => l.replace(/[*`_#>\s:-]/g, '').toUpperCase();
function seamsOf(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^SEAMS(\(.*\))?$/.test(marker(l)));
  if (start < 0) return [];
  const out = [];
  for (const l of lines.slice(start + 1)) {
    if (marker(l) === 'ENDSEAMS' || (!l.trim() && out.length)) break;
    if (l.trim()) out.push(l.trim());
  }
  return out;
}

// ── preflight ────────────────────────────────────────────────────────────────────────────────────────
function preflightCommand(root, explicit) {
  if (explicit) return explicit;
  const pkg = readJson(path.join(root, 'package.json'));
  if (pkg && pkg.scripts && pkg.scripts.preflight) {
    if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm preflight';
    if (fs.existsSync(path.join(root, 'yarn.lock'))) return 'yarn preflight';
    return 'npm run preflight';
  }
  if (fs.existsSync(path.join(root, 'scripts', 'preflight.sh'))) return 'sh scripts/preflight.sh';
  return null;
}

// A SKIP is not a PASS: a line starting with SKIP, or with ⊘ (the mark this repository's validate.js prints). The one exception is a skip the project declared with --allow-skipped (a live check with
// no key here): a line containing one of those substrings, any case, is reported in allowedSkips, not counted.
function runPreflight(cmd, runDir, allow = []) {
  if (!cmd) return { state: 'NO VERIFICADO (sin preflight en el repo)', passed: false, exitCode: null, skipped: [], allowedSkips: [] };
  const r = spawnSync('sh', ['-c', cmd], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60 * 1000 });
  const output = `${r.stdout || ''}${r.stderr || ''}`;
  fs.writeFileSync(path.join(runDir, 'preflight.out.txt'), output);
  const allowed = allow.map((s) => String(s).toLowerCase());
  const isAllowed = (l) => allowed.some((s) => l.toLowerCase().includes(s));
  const skips = output.split('\n').map((l) => l.trim()).filter((l) => /^(SKIP\b|⊘)/.test(l));
  const skipped = skips.filter((l) => !isAllowed(l));
  const allowedSkips = skips.filter(isAllowed);
  const exitCode = r.status;
  const passed = exitCode === 0 && !skipped.length;
  const state = passed ? 'PASS'
    : exitCode === 0 ? `NO VERIFICADO (${skipped.length} SKIP)`
      : `FAIL (exit ${exitCode ?? r.signal ?? '?'})`;
  return { state, passed, exitCode, skipped, allowedSkips };
}

// ── commit ───────────────────────────────────────────────────────────────────────────────────────────
// The message is the one thing a model writes here; the git calls are code. A message that does not
// look like one conventional line is replaced, not trusted.
async function commitChanges(task, model, runDir) {
  if (!git(['status', '--short']).out.trim()) return { committed: false, hash: null, message: null, note: 'sin cambios que commitear' };
  const recent = git(['log', '--oneline', '-8']).out;
  const stat = git(['diff', 'HEAD', '--stat']).out.slice(0, 4000);
  const raw = await runSeat({
    name: 'commit', model, tools: 'read', runDir, timeoutS: SEAT_TIMEOUT_S.commit,
    prompt: `Escribe UN mensaje de commit de una línea para este cambio. Formato conventional (feat:/fix:/chore:/refactor:/docs:/test:,
con scope opcional), ≤ 90 caracteres, en el MISMO idioma que los commits recientes. Sin Co-Authored-By, sin mencionar
modelos ni asistentes. Responde solo con la línea, sin comillas ni explicación.

Tarea: ${task}

Commits recientes:
${recent}
Archivos:
${stat}`,
  });
  const line = raw.split('\n').map((l) => l.trim().replace(/^["'`]+|["'`]+$/g, '')).find(Boolean) || '';
  const message = /^(feat|fix|chore|refactor|docs|test|perf|style|build|ci)(\([^)]+\))?!?: .{3,}/.test(line) && line.length <= 100
    ? line : `chore: ${task.replace(/\s+/g, ' ').slice(0, 80)}`;
  const add = git(['add', '-A']);
  if (add.code !== 0) return { committed: false, hash: null, message, note: `git add falló: ${add.err.trim()}` };
  const c = git(['commit', '-m', message]);
  if (c.code !== 0) return { committed: false, hash: null, message, note: `git commit falló: ${(c.err || c.out).trim().split('\n').pop()}` };
  return { committed: true, hash: git(['rev-parse', '--short', 'HEAD']).out.trim(), message, note: 'ok' };
}

// ── the loop ─────────────────────────────────────────────────────────────────────────────────────────
async function main() {
  let a;
  try { a = parseArgs(process.argv.slice(2)); } catch (e) { log(`develop-phase-pi: ${e.message}`); return 2; }

  const top = git(['rev-parse', '--show-toplevel']);
  if (top.code !== 0) { log('develop-phase-pi: not inside a git repository'); return 2; }
  const root = top.out.trim();
  process.chdir(root);

  let seats;
  try { seats = resolveSeats(root, { spec: a.spec }); } catch (e) { log(`develop-phase-pi: line-up refused — ${e.message}`); return e.code || 2; }

  const runDir = a.runDir ? path.resolve(a.runDir) : fs.mkdtempSync(path.join(os.tmpdir(), 'develop-phase-pi-'));
  fs.mkdirSync(runDir, { recursive: true });
  const busPath = path.join(runDir, 'bus.log');
  const bus = (line) => fs.appendFileSync(busPath, `[${new Date().toISOString().slice(11, 19)}] ${line}\n`);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).out.trim();
  const { task } = a;

  // Best-effort live view: a detached tmux session, bus.log on top and the active seat's log on the
  // bottom (scripts/dp-tmux.sh — never touches an existing session or pane). Missing tmux, or anything
  // going wrong starting it, is silent: a live view is a convenience, never a reason to fail the run.
  let tmuxSession = null;
  if (a.tmux) {
    try {
      const r = spawnSync(path.join(__dirname, 'dp-tmux.sh'), [runDir], { encoding: 'utf8', timeout: 5000 });
      if (r.status === 0 && r.stdout.trim()) tmuxSession = r.stdout.trim();
      else if (r.stderr?.trim()) log(`(${r.stderr.trim()})`);
    } catch { /* tmux is a convenience: never block the run */ }
  }

  let preparer = a.preparer;
  let analystSeat = seats.architect;
  if (preparer && a.jev) {
    const s = await sizeTask(task);
    log(`sizing: ${s.note}`);
    if (s.size === 'trivial' && a.seams !== 'propose') preparer = false;
    else if (s.size === 'bounded') analystSeat = seats.implementer;
  }

  log(`Task: "${task}" · branch ${branch} · max ${a.maxIter} iter · run dir ${runDir}`);
  log(`Seats: ${preparer ? `scout=${seats.scout} · analyst=${analystSeat} · ` : ''}implementer=${seats.implementer} · reviewer=${seats.reviewer}${a.spec ? ` · spec=${seats.spec}` : ''}`);
  if (tmuxSession) log(`Vista en vivo: tmux attach -t ${tmuxSession}`);
  bus(`Tarea: ${task}`);

  let seamsOut = { agreed: false, list: [] };
  const result = (fields) => ({ task, branch, runDir, seats: { ...seats, analyst: preparer ? analystSeat : null }, seams: seamsOut, ...fields });
  const crash = (who, iteration) => result({
    iterations: iteration, approved: false, preflightPassed: false, commit: null,
    handoff: { status: 'crash', summary: `El ${who} no devolvió resultado en la iteración ${iteration}`, evidence: [], blocker: `Ver ${runDir}/${who}*.err.txt` },
    nextStep: 'Cambios del implementer posiblemente a medias: git status antes de relanzar',
  });
  const finish = (r) => { process.stdout.write(`${JSON.stringify(r, null, 2)}\n`); return r.approved && r.preflightPassed ? 0 : 1; };

  const implementerRole = firstExisting(root, ['.pi/agents/implementer.md', '.claude/agents/implementer.md']);
  const reviewerRole = firstExisting(root, ['.pi/agents/reviewer.md', '.claude/agents/reviewer.md']);
  const rubric = firstExisting(root, ['harness-rubric.md']);
  const ponytail = firstExisting(os.homedir(), ['.agents/skills/ponytail/SKILL.md']);
  const rel = (p) => path.relative(root, p);

  // Scout and analyst run once, outside the loop: a cost optimisation, not a gate. If either dies the
  // run carries on without it and the implementer explores on its own.
  let brief = '';
  let plan = '';
  if (preparer) {
    log('── Scout');
    brief = await runSeat({
      name: 'scout', model: seats.scout, tools: `${READ_ONLY},bash`, runDir, timeoutS: SEAT_TIMEOUT_S.scout,
      prompt: `Eres el explorador de un loop de desarrollo. Solo lectura: no edites, no crees archivos, y en bash solo
comandos que leen (graphify, git log/diff/show, cat, ls). Nada que escriba.
Antes de leer código consulta el grafo si existe graphify-out/graph.json: \`graphify query "<pregunta>"\`
(o \`graphify explain\` / \`graphify path\`); lee archivos crudos solo después, para líneas concretas.
Lee lo justo de: STATUS.md, AGENTS.md, docs/client-context/ (solo lo relacionado), docs/prds/ (PRD activo), TASKS.md
— los que existan.
TAREA: ${task}
Devuelve un brief de ≤ 400 palabras, sin relleno:
- Archivos relevantes: ruta:línea + una frase (qué hace, por qué importa)
- Reglas del PRD y de docs/client-context/ que aplican (citas cortas)
- Tests existentes en esa zona (rutas)
- Preguntas abiertas o ambigüedades que un humano debería resolver
No propongas la solución.`,
    });
    if (!brief) { log('⚠ Scout sin resultado — el implementer explora solo'); bus('Scout: sin resultado'); }
    else bus(`Scout → brief (${brief.length} car.): ${TRUNC(brief.replace(/\n+/g, ' '), 300)}`);

    if (brief) {
      log('── Plan');
      plan = await runSeat({
        name: 'analyst', model: analystSeat, tools: `${READ_ONLY},bash`, runDir, timeoutS: SEAT_TIMEOUT_S.analyst,
        prompt: `Eres el analista de un loop de desarrollo. Solo lectura: no edites nada; en bash solo comandos que leen.
Recibes la tarea y el brief de un explorador. Verifica en el código solo lo que dudes del brief
(abre los archivos citados; \`graphify query\` antes de grepear).
TAREA: ${task}
BRIEF:
${brief}
Devuelve un plan de ≤ 300 palabras:
1. Pasos ordenados, cada uno con el archivo que toca.
2. Tests a añadir o ajustar (el reviewer exige regresión si cambia lógica existente).
3. Riesgos y qué NO tocar (fuera del alcance). Cada riesgo que nombres obliga al implementer.
4. Seams: las interfaces públicas que ejercitan los tests (una función, un endpoint, un comando CLI, las props de un
   componente), una por línea como "- <interfaz> — <comportamiento que fija el test>", entre una línea SEAMS: y una
   línea END SEAMS.
${a.agreedSeams.length ? `El humano acordó estos seams antes de la ejecución: cópialos sin cambios en tu bloque SEAMS. Si la tarea no
se puede construir detrás de ellos, la PRIMERA línea es "BLOQUEO: <por qué los seams acordados no encajan>".
AGREED SEAMS:
${a.agreedSeams.join('\n')}
` : ''}Si el brief no basta o hay una ambigüedad que bloquea, la PRIMERA línea es "BLOQUEO: <motivo>" y nada más.
Sin código completo: lo escribe el implementer.`,
      });
      if (!plan) { log('⚠ Analista sin resultado — el implementer parte solo del brief'); bus('Analista: sin resultado'); }
      else if (/^\W*(BLOQUEO|BLOCKER):/.test(plan.trimStart())) {
        log('⛔ El analista detectó un bloqueo — se corta antes del implementer');
        bus(`Analista → ${TRUNC(plan.trim(), 300)}`);
        return finish(result({
          iterations: 0, approved: false, preflightPassed: false, commit: null,
          handoff: { status: 'blocked', summary: 'El analista pidió una decisión antes de implementar', evidence: [brief], blocker: plan.trim() },
          nextStep: 'Resolver el bloqueo con el humano y relanzar (o --no-preparer si la tarea ya es clara)',
        }));
      } else bus(`Analista → plan: ${TRUNC(plan.replace(/\n+/g, ' '), 300)}`);
    }
  }

  // The seams are agreed once, before any code: a `--seams propose` run ends here and hands them to the human,
  // who re-runs with the list they accept.
  const proposedSeams = seamsOf(plan);
  if (a.seams === 'propose') {
    seamsOut = { agreed: false, list: proposedSeams };
    const why = !plan ? 'El explorador o el analista no devolvió nada — relanzar, o pasar --seams con la lista'
      : !proposedSeams.length ? 'El analista no propuso seams — leer el plan y relanzar con --seams "<uno por línea>"'
        : 'Editar los seams si hace falta y relanzar con --seams "<uno por línea>"';
    log(proposedSeams.length ? `Seams propuestos (${proposedSeams.length}) — se para para que el humano los acuerde` : '⛔ Sin seams propuestos');
    bus(`Seams propuestos: ${proposedSeams.length}`);
    return finish(result({
      iterations: 0, approved: false, preflightPassed: false, commit: null,
      handoff: { status: 'blocked', summary: proposedSeams.length ? 'Seams propuestos — acordarlos antes de que corra el implementer' : 'No hay seams propuestos', evidence: plan ? [plan] : brief ? [brief] : [], blocker: why },
      nextStep: why,
    }));
  }
  const seams = a.agreedSeams.length ? a.agreedSeams : proposedSeams;
  seamsOut = { agreed: a.agreedSeams.length > 0, list: seams };
  if (plan && !seams.length) log('⚠ El plan no nombra seams — el implementer prueba las interfaces públicas que toca');
  const seamsBlock = seams.length
    ? `SEAMS (${a.agreedSeams.length ? 'acordados por el humano — vinculantes' : 'propuestos por el analista'}):\n${seams.join('\n')}\n`
    : '';

  const reads = [rubric && rel(rubric), implementerRole && rel(implementerRole)].filter(Boolean).join(', ');
  const context = brief
    ? `Un explorador y un analista prepararon el contexto: parte de aquí, abre el original solo si algo no cuadra
o para escribir código, y no re-explores el repo.
BRIEF:
${brief}
${plan ? `\nPLAN:\n${plan}\n` : ''}
${reads ? `Lee: ${reads}.` : ''}`
    : `Lee: STATUS.md, AGENTS.md, docs/client-context/, docs/prds/ (PRD activo)${reads ? `, ${reads}` : ''} — los que existan.`;

  let approved = false;
  let lastImpl = '';
  let lastReview = '';
  let lastSpec = '';
  let axes = null;
  let iteration = 0;

  while (!approved && iteration < a.maxIter) {
    iteration += 1;
    log(`── Iteración ${iteration}/${a.maxIter} · Implement`);
    // Each rejected axis reaches the implementer as its own section; an approved one is left out.
    const correction = iteration > 1
      ? `\n\n⚠ La revisión RECHAZÓ. Corrige SOLO los [FAIL].${!axes || !axes.code.approved ? `\n\n## El code reviewer RECHAZÓ (rúbrica). Razones:\n${lastReview}` : ''}${
        axes && axes.spec && !axes.spec.approved ? `\n\n## El spec reviewer RECHAZÓ (tarea, PRD, seams). Razones:\n${lastSpec}` : ''}`
      : '';
    lastImpl = await runSeat({
      name: `implementer-${iteration}`, model: seats.implementer, tools: 'read,bash,edit,write,grep,find,ls', runDir, timeoutS: SEAT_TIMEOUT_S.implementer,
      prompt: `${implementerRole ? `${stripFrontmatter(fs.readFileSync(implementerRole, 'utf8'))}\n\n---\n\n` : ''}Eres el implementer de un loop de desarrollo.
PROHIBIDO: desplegar, migraciones remotas, escribir o consultar en bucle la base de producción, cambiar de rama,
hacer commit o push. La sesión principal integra y despliega después de la revisión.
${ponytail ? `Antes de escribir, lee ${ponytail} y aplícala (nivel full): el diff más corto que funcione,
reutilizar lo que ya existe, sin dependencia nueva sin justificación.\n` : ''}${context}
${seamsBlock}${a.tdd ? `${TDD_RULES}\n` : ''}TAREA: ${task}${correction}
Al terminar: lista archivos creados/modificados + descripción de cada cambio.`,
    });
    if (!lastImpl) { bus(`Implementer iter ${iteration}: sin resultado`); return finish(crash('implementer', iteration)); }

    log(`── Iteración ${iteration}/${a.maxIter} · Review`);
    const changes = changeSet();
    if (changes.empty) {
      lastReview = '[FAIL] diff — el implementer no dejó ningún cambio en el worktree\nRECHAZADO';
      lastSpec = '';
      axes = null; // no review ran: the correction carries the diff [FAIL] as the code section
      log('  ✗ sin cambios en el worktree — cuenta como RECHAZADO');
      bus(`Implementer iter ${iteration} → sin cambios en el worktree (RECHAZADO)`);
      continue;
    }
    const touched = git(['diff', '--name-only', 'HEAD']).out.trim().split('\n').filter(Boolean);
    bus(`Implementer iter ${iteration} → diff (${touched.length} archivo(s)): ${touched.join(', ')}`);
    const codeReview = runSeat({
      name: `reviewer-${iteration}`, model: seats.reviewer, tools: READ_ONLY, runDir, timeoutS: SEAT_TIMEOUT_S.reviewer,
      prompt: `${reviewerRole ? `${stripFrontmatter(fs.readFileSync(reviewerRole, 'utf8'))}\n\n---\n\n` : ''}Eres el revisor adversarial de un loop de desarrollo.
Recibes SOLO artefactos — nunca el razonamiento del implementer. Mandato: busca razones para RECHAZAR.
Default = FAIL hasta evidencia de PASS.
${rubric ? `\n## ${rel(rubric)}\n\n${fs.readFileSync(rubric, 'utf8')}\n` : '\n(No hay harness-rubric.md: juzga corrección, tests de regresión, alcance y diff mínimo.)\n'}
## Tarea
${task}
${seamsBlock ? `\n${seamsBlock}` : ''}
## Lo que el implementer dice que hizo (afirmación a verificar, no evidencia)
${lastImpl.slice(0, 6000)}

## Cambios (git diff HEAD + archivos nuevos)
${changes.text}
Solo lectura: lee archivos del repositorio (read, grep, find, ls) para verificar una afirmación; no edites nada, no ejecutes nada que escriba.
Un control que necesite editar (un control negativo) va en tu informe como sugerencia para el implementer.
Prohibido: leer fuera del repositorio, .env*, *secret*, y cualquier archivo ignorado por git.${a.tdd ? '\nEvalúa también:\n[PASS|FAIL] test-first — every seam the report names has a test that exercises it through its public interface' : ''}
Formato: [PASS|FAIL] criterio — evidencia concreta
Última línea, sola y sin texto extra: APROBADO o RECHAZADO`,
    });
    // The spec axis (PRD-004 §3.2): the code reviewer judges the diff against the rubric; this seat, in parallel,
    // judges only whether the change does what was asked — the intent of SPEC_PROMPT in workflows/develop-phase.js.
    const specReview = a.spec ? runSeat({
      name: `spec-${iteration}`, model: seats.spec, tools: READ_ONLY, runDir, timeoutS: SEAT_TIMEOUT_S.reviewer,
      prompt: `Eres el spec reviewer de un loop de desarrollo. Juzgas si el cambio hace lo que se pidió — no la calidad del
código, eso lo juzga otro asiento. Mandato: encuentra dónde el cambio se aparta de la spec.
Default = FAIL hasta evidencia de PASS.
LA SPEC — cítala en tu evidencia:
TAREA: ${task}
PRD: docs/prds/ (el PRD activo; lee la parte que esta tarea implementa)
${plan ? `PLAN:\n${plan}\n` : ''}${seamsBlock}
## Lo que el implementer dice que hizo (afirmación a verificar, no evidencia)
${lastImpl.slice(0, 6000)}

## Cambios (git diff HEAD + archivos nuevos)
${changes.text}
Solo lectura: lee archivos del repositorio (read, grep, find, ls) para verificar una afirmación; no edites nada, no ejecutes nada que escriba.
Prohibido: leer fuera del repositorio, .env*, *secret*, y cualquier archivo ignorado por git.
Una línea por criterio, como [PASS|FAIL] criterio — evidencia que cita la spec y el código:
- cada requisito de la tarea y de la parte del PRD que implementa está (una línea por requisito)
- ningún comportamiento que la spec no pidió
- nada implementado en contra de la spec${seams.length ? '\n- cada seam existe como está listado y un test lo ejercita por esa interfaz' : ''}
Última línea, sola y sin texto extra: APROBADO o RECHAZADO`,
    }) : null;
    [lastReview, lastSpec] = await Promise.all([codeReview, specReview]);
    lastSpec = lastSpec || '';
    if (!lastReview) { bus(`Reviewer iter ${iteration}: sin resultado`); return finish(crash('reviewer', iteration)); }
    if (a.spec && !lastSpec) { bus(`Spec reviewer iter ${iteration}: sin resultado`); return finish(crash('spec', iteration)); }
    axes = {
      code: { approved: verdictOf(lastReview), model: seats.reviewer },
      spec: a.spec ? { approved: verdictOf(lastSpec), model: seats.spec } : null,
    };
    approved = axes.code.approved && (!axes.spec || axes.spec.approved);
    const fails = `${lastReview}\n${lastSpec}`.split('\n').filter((l) => /^\s*\[FAIL\]/.test(l)).length;
    log(approved ? `✓ APROBADO iter ${iteration}` : `✗ RECHAZADO (code ${axes.code.approved ? '✓' : '✗'}${axes.spec ? ` · spec ${axes.spec.approved ? '✓' : '✗'}` : ''}) — corrigiendo`);
    bus(`Review iter ${iteration} → ${approved ? 'APROBADO' : `RECHAZADO (code ${axes.code.approved ? '✓' : '✗'}${axes.spec ? ` · spec ${axes.spec.approved ? '✓' : '✗'}` : ''} · ${fails} FAIL)`}`);
  }
  if (!approved) { log(`⚠ No convergió tras ${a.maxIter} iter — escalar al humano`); bus(`No convergió tras ${a.maxIter} iteración(es)`); }

  log('── Preflight');
  const cmd = preflightCommand(root, a.preflight);
  const pf = runPreflight(cmd, runDir, a.allowSkipped);
  log(`Preflight${cmd ? ` (${cmd})` : ''}: ${pf.state}`);
  bus(`Preflight${cmd ? ` (${cmd})` : ''} → ${pf.state}`);

  let commit = null;
  if (approved && pf.passed && a.commit) {
    log('── Commit');
    commit = await commitChanges(task, seats.orchestrator, runDir);
    log(commit.committed ? `✓ commit ${commit.hash} — ${commit.message}` : `⚠ sin commit: ${commit.note}`);
    bus(commit.committed ? `Commit → ${commit.hash} — ${commit.message}` : `Commit → no hecho: ${commit.note}`);
  }

  // The two axes stay side by side: the spec lines carry a "spec: " prefix, and the blocker names the FAILs of both.
  const linesOf = (text) => text.split('\n').filter((l) => /^\s*\[(PASS|FAIL)\]/.test(l)).map((l) => l.trim());
  const verdictLines = linesOf(lastReview);
  const specLines = a.spec ? linesOf(lastSpec).map((l) => `spec: ${l}`) : [];
  const openFails = [...verdictLines, ...specLines].filter((l) => /^(spec: )?\[FAIL\]/.test(l));
  const LABEL = 'Reportado por implementer/reviewer — no certificado de forma independiente: ';
  const status = approved && pf.passed ? 'complete' : approved ? 'continue' : 'blocked';
  bus(`Fin: ${status}`);
  return finish(result({
    iterations: iteration, approved, preflightPassed: pf.passed, commit, axes,
    handoff: {
      status,
      summary: approved
        ? `${a.spec ? 'Code y spec reviewer aprobaron' : 'Reviewer aprobó'} tras ${iteration} iteración(es); preflight ${pf.state}${commit && commit.committed ? `; commit ${commit.hash}` : ''}`
        : `Reviewer sigue rechazando tras ${a.maxIter} iteración(es)`,
      evidence: [...verdictLines, ...specLines, `preflight: ${pf.state}`, ...pf.skipped.map((l) => `preflight skip: ${l}`),
        ...pf.allowedSkips.map((l) => `preflight skip (declarada): ${l}`)],
      ...(approved ? {} : { blocker: openFails.join(' · ') || 'reviewer devolvió RECHAZADO sin línea [FAIL]' }),
    },
    nextStep: LABEL + (approved && pf.passed
      ? (commit && commit.committed ? 'integrar la rama y desplegar desde el checkout principal' : 'git add -A && git commit en este worktree')
      : approved && pf.exitCode === 0 ? `Preflight con SKIP fuera de --allow-skipped: ${pf.skipped.join(' · ')} — falta un requisito; un SKIP no es un PASS`
        : approved ? 'Preflight falló o no existe — corregir antes de commit'
          : `No convergió — revisar los [FAIL] restantes tras ${a.maxIter} iter y reportar al humano`),
  }));
}

if (require.main === module) {
  main().then((code) => process.exit(code), (e) => { log(`develop-phase-pi: ${e.stack || e}`); process.exit(1); });
}

module.exports = { parseArgs, verdictOf, seamsOf, preflightCommand, runPreflight, resolveSeats, runSeat, SIZES };
