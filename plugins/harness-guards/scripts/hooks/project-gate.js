#!/usr/bin/env node
// project-gate — Stop hook. Runs the project's own verification gate before the agent may finish a turn, and sends
// it back to fix the tree (exit 2) when the gate fails.
//
// Which gate runs, first match wins:
//   1. <repo>/.claude/verify.sh        (executable; the project decides what "green" means)
//   2. package.json script "preflight" (run with the package manager the lockfile implies)
//   3. nothing: a project without a gate is left alone.
//
// The gate only runs when the working tree changed since its last green run, so a turn that only talks does not pay
// for it. It blocks only in a repository where the gate has passed at least once, so breakage that predates the
// session is reported, not enforced. It blocks at most once per reply, and after 3 consecutive failures on the same
// tree it lets the agent stop and tells the operator instead of looping.
//
// Every run appends one line to ~/.claude/gate-log.ndjson (HARNESS_GATE_LOG overrides): repo, gate, result, attempt,
// seconds. Results: green | blocked | red-unenforced (never green here) | still-red (blocked once in this reply and
// the fix did not turn it green) | gave-up. `repo` is the main checkout's name, so the worktrees of one project count
// as one. scripts/gate-stats.js and the harness panel read it; nothing leaves the machine.
//
// Until 2026-11 this was ~/.claude/hooks/verify-on-stop.sh, registered by hand in ~/.claude/settings.json. While that
// registration is still there this hook stays silent, so the gate never runs twice; `--standalone` (Pi, or a run by
// hand) skips that check.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const HOME = os.homedir();
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const git = (args, cwd) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }); return r.status === 0 ? r.stdout : null; };
const legacyRegistered = () => { try { return fs.readFileSync(path.join(HOME, '.claude', 'settings.json'), 'utf8').includes('verify-on-stop.sh'); } catch { return false; } };

function gateOf(root) {
  const own = path.join(root, '.claude', 'verify.sh');
  try { fs.accessSync(own, fs.constants.X_OK); return ['./.claude/verify.sh']; } catch { /* no own gate */ }
  const pkg = readJson(path.join(root, 'package.json'));
  if (!pkg || !pkg.scripts || !pkg.scripts.preflight) return null;
  const has = (f) => fs.existsSync(path.join(root, f));
  if (has('pnpm-lock.yaml')) return ['pnpm', '-s', 'preflight'];
  if (has('yarn.lock')) return ['yarn', '-s', 'preflight'];
  if (has('bun.lockb') || has('bun.lock')) return ['bun', 'run', 'preflight'];
  return ['npm', 'run', '-s', 'preflight'];
}

// HEAD, the diff against it, and name + mtime + size of every untracked file: any change to the tree changes it.
function fingerprintOf(root) {
  const untracked = (git(['ls-files', '-o', '--exclude-standard', '-z'], root) || '').split('\0').filter(Boolean).map((f) => {
    try { const s = fs.statSync(path.join(root, f)); return `${f} ${Math.floor(s.mtimeMs / 1000)} ${s.size}`; } catch { return f; }
  });
  return sha(`${git(['rev-parse', 'HEAD'], root) || ''}${git(['diff', 'HEAD'], root) || ''}${untracked.join('\n')}`);
}

function main(raw) {
  let p = {};
  try { p = JSON.parse(raw) || {}; } catch { /* a run by hand may pass nothing */ }
  if (!process.argv.includes('--standalone') && legacyRegistered()) return 0;
  const dir = p.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const top = git(['rev-parse', '--show-toplevel'], dir);
  if (!top) return 0;
  const root = top.trim();
  const gate = gateOf(root);
  if (!gate) return 0;

  const es = (readJson(process.env.HARNESS_WEEKLY_FILE || path.join(HOME, '.claude', 'harness-weekly.json')) || {}).lang === 'es';
  const stateDir = process.env.HARNESS_VERIFY_STATE || path.join(HOME, '.cache', 'claude-verify');
  const gateLog = process.env.HARNESS_GATE_LOG || path.join(HOME, '.claude', 'gate-log.ndjson');
  fs.mkdirSync(stateDir, { recursive: true });
  const key = sha(root).slice(0, 16);
  const okFile = path.join(stateDir, `${key}.ok`);
  const failFile = path.join(stateDir, `${key}.fail`);
  const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
  const name = gate.join(' ');
  const say = (en, esText) => process.stdout.write(JSON.stringify({ systemMessage: `project-gate: ${es ? esText : en}` }));
  const logRun = (result, attempt, seconds) => {
    const common = git(['rev-parse', '--git-common-dir'], root);
    const main_ = common ? path.dirname(path.resolve(root, common.trim())) : root;
    try {
      fs.mkdirSync(path.dirname(gateLog), { recursive: true });
      fs.appendFileSync(gateLog, `${JSON.stringify({ ts: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), repo: path.basename(main_), root, gate: name, result, attempt, seconds })}\n`);
    } catch { /* a log that cannot be written never fails the gate */ }
  };

  const fingerprint = fingerprintOf(root);
  if (read(okFile) === fingerprint) return 0;

  const started = Date.now();
  const r = spawnSync(gate[0], gate.slice(1), { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 280000 });
  const took = Math.round((Date.now() - started) / 1000);
  const out = `${r.stdout || ''}${r.stderr || ''}${r.error ? `${r.error.message}\n` : ''}`;
  if (r.status === 0) {
    fs.writeFileSync(okFile, fingerprint);
    fs.rmSync(failFile, { force: true });
    logRun('green', 1, took);
    return 0;
  }

  // Block at most once per reply. When a background agent keeps editing the tree the fingerprint changes every time
  // and the 3-failure brake never fires: each re-run blocked again (2026-11-16, 9 blocks in a row). The gate still
  // ran this second time, so the log and the message say whether the fix worked.
  if (p.stop_hook_active === true) {
    logRun('still-red', 1, took);
    say(`\`${name}\` is still red after this reply's fix; it will not block again until the next reply.`,
      `\`${name}\` sigue en rojo tras el arreglo de esta respuesta; no vuelvo a bloquear hasta la siguiente.`);
    return 0;
  }
  if (read(okFile) === null) {
    logRun('red-unenforced', 1, took);
    say(`\`${name}\` fails and has never passed in this repository, so it does not block: the failure may predate this session. Once it has been green, every regression sends the agent back.`,
      `\`${name}\` falla y nunca ha pasado en verde en este repo, así que no bloqueo: el fallo puede ser anterior a esta sesión. Cuando esté en verde una vez, cada regresión hará volver a Claude.`);
    return 0;
  }
  const [lastFp, lastCount] = (read(failFile) || '').trim().split(' ');
  const count = lastFp === fingerprint ? Number(lastCount) + 1 : 1;
  fs.writeFileSync(failFile, `${fingerprint} ${count}\n`);
  if (count >= 3) {
    logRun('gave-up', count, took);
    say(`\`${name}\` still fails after 3 attempts on the same tree; the agent stops. Look at it by hand.`,
      `\`${name}\` sigue fallando tras 3 intentos sobre el mismo árbol; Claude se detiene. Revísalo a mano.`);
    return 0;
  }
  logRun('blocked', count, took);
  const code = r.status ?? (r.signal || 'timeout');
  process.stderr.write(`${es
    ? `La verificación del proyecto falló (\`${name}\`, exit ${code}). Arregla lo que la rompe antes de terminar; si el fallo no tiene que ver con tu cambio, dilo en vez de taparlo.\n--- últimas líneas ---`
    : `The project's verification failed (\`${name}\`, exit ${code}). Fix what breaks it before you finish; if the failure has nothing to do with your change, say so instead of hiding it.\n--- last lines ---`}\n${out.trimEnd().split('\n').slice(-40).join('\n')}\n`);
  return 2;
}

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => { let code = 0; try { code = main(raw); } catch { /* a broken hook never holds a turn */ } process.exit(code); });
