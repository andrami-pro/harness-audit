#!/usr/bin/env node
// Reads the log verify-on-stop.sh writes and counts, per repository, what the gate did.
// A "catch" is a blocked run: the agent was about to finish a turn on a tree that failed the
// project's own checks. A catch is "fixed" when the next run of that repository is green.
//
//   node baseline/gate-stats.js [--since 30d] [--json]
//
// What it does not show: whether a session without the harness would have left the same failure.
// It counts failures that reached the end of a turn, which is the moment a session without a gate stops.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
const days = Number.parseInt(flag('--since') || '30', 10);
const file = process.env.HARNESS_GATE_LOG || path.join(os.homedir(), '.claude', 'gate-log.ndjson');

let text = '';
try { text = fs.readFileSync(file, 'utf8'); } catch { /* no log yet */ }
const cutoff = Date.now() - days * 86400000;
const runs = text.split('\n').filter(Boolean).flatMap((line) => {
  try { const r = JSON.parse(line); return Date.parse(r.ts) >= cutoff ? [r] : []; } catch { return []; }
});

const repos = new Map();
for (const r of runs) {
  const s = repos.get(r.root) || { repo: r.repo, runs: 0, green: 0, catches: 0, fixed: 0, gaveUp: 0, unenforced: 0, seconds: 0, open: false };
  s.runs += 1;
  s.seconds += r.seconds || 0;
  if (r.result === 'green') { s.green += 1; if (s.open) { s.fixed += 1; s.open = false; } }
  // Consecutive blocked runs are one catch: the agent tried a fix and the gate was still red.
  else if (r.result === 'blocked') { if (!s.open) s.catches += 1; s.open = true; }
  else if (r.result === 'gave-up') { s.gaveUp += 1; s.open = false; }
  else if (r.result === 'red-unenforced') s.unenforced += 1;
  repos.set(r.root, s);
}

const rows = [...repos.values()].sort((a, b) => b.catches - a.catches || b.runs - a.runs);
if (args.includes('--json')) {
  console.log(JSON.stringify({ file, days, rows }, null, 2));
  process.exit(0);
}
if (rows.length === 0) {
  console.log(`No gate runs in the last ${days} days (${file}).`);
  process.exit(0);
}
const pad = (v, n) => String(v).padStart(n);
console.log(`Gate runs, last ${days} days`);
console.log(`${'repo'.padEnd(28)}${pad('runs', 6)}${pad('green', 7)}${pad('catches', 9)}${pad('fixed', 7)}${pad('gave up', 9)}${pad('never green', 13)}${pad('avg s', 7)}`);
for (const s of rows) {
  console.log(`${s.repo.slice(0, 27).padEnd(28)}${pad(s.runs, 6)}${pad(s.green, 7)}${pad(s.catches, 9)}${pad(s.fixed, 7)}${pad(s.gaveUp, 9)}${pad(s.unenforced, 13)}${pad(Math.round(s.seconds / s.runs), 7)}`);
}
const total = (k) => rows.reduce((n, s) => n + s[k], 0);
console.log(`\n${total('catches')} catches, ${total('fixed')} fixed before the turn ended, ${total('gaveUp')} left to the human.`);
