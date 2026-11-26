#!/usr/bin/env node
// baseline-check — SessionStart hook. Two jobs, both silent when there is nothing to say:
//
// 1. It tells the operator and the agent when this repository's harness baseline (the version stamped in
//    <repo>/.claude/harness-baseline) is older than the one this plugin ships (baseline/VERSION), and offers
//    /harness-guards:catch-up. It never runs it.
// 2. It keeps a copy of the baseline under ~/.claude/harness-baseline/ (VERSION, CHANGELOG.md, deny.json and the two
//    hook scripts), because a command and Pi need a path that does not move with the plugin's version. When Pi is
//    installed it also copies the Pi extension and the catch-up prompt. A copy is rewritten only when it differs.
//
// Until 2026-11 the baseline was installed by hand (~/.claude/hooks/*.sh, registered in ~/.claude/settings.json).
// While that registration is still there this hook leaves the notice to the old one and says, once a day, how to
// retire it. `--standalone` (Pi) skips that.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOME = os.homedir();
const PLUGIN = path.join(__dirname, '..', '..');
const DEST = path.join(HOME, '.claude', 'harness-baseline');
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };

function sync() {
  if (path.resolve(__dirname) === path.join(DEST, 'hooks')) return; // this is the copy
  const pairs = [
    ['baseline/VERSION', path.join(DEST, 'VERSION')],
    ['baseline/CHANGELOG.md', path.join(DEST, 'CHANGELOG.md')],
    ['baseline/deny.json', path.join(DEST, 'deny.json')],
    ['scripts/hooks/baseline-check.js', path.join(DEST, 'hooks', 'baseline-check.js')],
    ['scripts/hooks/project-gate.js', path.join(DEST, 'hooks', 'project-gate.js')],
  ];
  const pi = path.join(HOME, '.pi', 'agent');
  if (fs.existsSync(path.join(pi, 'extensions'))) pairs.push(['pi/harness-baseline.ts', path.join(pi, 'extensions', 'harness-baseline.ts')]);
  if (fs.existsSync(path.join(pi, 'prompts'))) pairs.push(['commands/catch-up.md', path.join(pi, 'prompts', 'catch-up.md')]);
  for (const [from, to] of pairs) {
    const want = read(path.join(PLUGIN, from));
    if (want === null || read(to) === want) continue;
    try { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.writeFileSync(to, want); } catch { /* a copy that cannot be written is not worth a failed session start */ }
  }
}

// 2026.11.13 against 2026.2.1: part by part as numbers, the way `sort -V` reads them.
const newer = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};

function main(raw) {
  let p = {};
  try { p = JSON.parse(raw) || {}; } catch { return; }
  const standalone = process.argv.includes('--standalone');
  if (!standalone && p.hook_event_name !== 'SessionStart') return;
  sync();
  const es = ((() => { try { return JSON.parse(read(process.env.HARNESS_WEEKLY_FILE || path.join(HOME, '.claude', 'harness-weekly.json'))); } catch { return null; } })() || {}).lang === 'es';
  const out = (systemMessage, additionalContext) => process.stdout.write(JSON.stringify({ systemMessage, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } }));

  const settings = read(path.join(HOME, '.claude', 'settings.json')) || '';
  if (!standalone && /baseline-check\.sh|verify-on-stop\.sh/.test(settings)) {
    const today = new Date().toISOString().slice(0, 10);
    const mark = path.join(DEST, '.legacy-notice');
    if (read(mark) === today) return;
    try { fs.mkdirSync(DEST, { recursive: true }); fs.writeFileSync(mark, today); } catch { return; }
    return out(es
      ? 'El baseline del arnés ya viene en el plugin harness-guards. Quedan registrados a mano los hooks antiguos (baseline-check.sh, verify-on-stop.sh) en ~/.claude/settings.json: mientras sigan ahí, mandan ellos.'
      : 'The harness baseline now ships in the harness-guards plugin. The old hooks (baseline-check.sh, verify-on-stop.sh) are still registered by hand in ~/.claude/settings.json: while they are, they are the ones that run.',
    'The harness baseline moved into the harness-guards plugin, which now runs the project gate (Stop) and the baseline notice (SessionStart) itself. The operator\'s ~/.claude/settings.json still registers the old hand-installed hooks ~/.claude/hooks/baseline-check.sh and ~/.claude/hooks/verify-on-stop.sh; while it does, the plugin\'s two hooks stay silent so nothing runs twice. In your first reply, tell them in one line and offer to remove those two hook entries from ~/.claude/settings.json (keep a backup, touch nothing else there) and the old command ~/.claude/commands/arnes-al-dia.md, which /harness-guards:catch-up replaces. Do it only if they say yes.');
  }

  const dir = p.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const top = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (top.status !== 0) return;
  const root = top.stdout.trim();
  if (root === HOME) return;
  const current = (read(path.join(PLUGIN, 'baseline', 'VERSION')) ?? read(path.join(DEST, 'VERSION')) ?? '').trim();
  if (!current) return;
  const have = (read(path.join(root, '.claude', 'harness-baseline')) || '').trim();
  if (have === current || (have && newer(have, current))) return;
  const name = path.basename(root);
  const state = have || (es ? 'ninguno' : 'none');
  out(es
    ? `Arnés de ${name}: baseline ${state}, el actual es ${current}. Ponlo al día con /harness-guards:catch-up.`
    : `Harness of ${name}: baseline ${state}, the current one is ${current}. Bring it up to date with /harness-guards:catch-up.`,
  `This repository's harness baseline (${have || 'none'}) is older than the current one (${current}). In your first reply, tell the operator in one line, in their language, and offer /harness-guards:catch-up; do not run it unless they ask. What each version brings is in ~/.claude/harness-baseline/CHANGELOG.md.`);
}

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => { try { main(raw); } catch { /* never fail a session start */ } process.exit(0); });
