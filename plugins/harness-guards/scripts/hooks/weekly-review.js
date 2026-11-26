#!/usr/bin/env node
// weekly-review — SessionStart hook. Once a week it rebuilds the harness panel (free: a script counts local
// files) and invites the operator to open it, with a link. A dashboard nobody is invited to is not opened:
// the first one shipped in 2.7 and was never run in two months.
//
// Config, all optional: ~/.claude/harness-weekly.json
//   { "enabled": true, "everyDays": 7, "lang": "en"|"es", "webFonts": false, "quotaFile": "<json>", "coach": false }
// "coach": true is the only part that costs tokens, and it is off unless the operator turns it on: the hook
// then asks the session to run ONE background agent that reads the week's evidence and rewrites the coach
// notes the panel shows. The hook itself never calls a model and sends nothing anywhere.
//
// Silent when there is nothing to review (no transcripts), when the week has not passed, on a resumed or
// compacted session, and on any error: an invitation is never worth failing a session start over.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function main(raw) {
  let p;
  try { p = JSON.parse(raw); } catch { return; }
  if (!p || p.hook_event_name !== 'SessionStart' || (p.source && p.source !== 'startup')) return;

  const home = os.homedir();
  const file = process.env.HARNESS_WEEKLY_FILE || path.join(home, '.claude', 'harness-weekly.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* no config: the defaults */ }
  if (cfg.enabled === false) return;
  const projects = process.env.HARNESS_PROJECTS_DIR || path.join(home, '.claude', 'projects');
  try { if (!fs.readdirSync(projects).length) return; } catch { return; }

  const every = Number(cfg.everyDays) > 0 ? Number(cfg.everyDays) : 7;
  const last = Date.parse(cfg.lastRun || '');
  if (Number.isFinite(last) && Date.now() - last < every * 86400000) return;

  const es = cfg.lang === 'es';
  const panel = path.join(__dirname, '..', 'harness-panel.js');
  const out = path.join(process.env.XDG_CACHE_HOME || path.join(home, '.cache'), 'harness-audit', 'panel', 'index.html');
  const args = [panel, '--out', out, ...(es ? ['--lang', 'es'] : []), ...(cfg.webFonts ? ['--web-fonts'] : []), ...(cfg.quotaFile ? ['--quota-file', String(cfg.quotaFile)] : [])];
  const link = `file://${out.split(path.sep).map(encodeURIComponent).join('/')}`;

  // The week is marked first: a panel that fails to build must not bring the invitation back every session.
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ ...cfg, lastRun: new Date().toISOString() }, null, 2)}\n`);
  } catch { return; }
  if (!process.env.HARNESS_WEEKLY_DRY) {
    try { spawn(process.execPath, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref(); } catch { /* the link below then opens last week's page */ }
  }

  const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
  const cmd = args.map((a, i) => (i === 0 ? `node ${q(a)}` : /^--/.test(a) ? a : q(a))).join(' ');
  const invite = es
    ? `Tu resumen semanal del arnés está listo. Ven a revisar tu panel: ${link}`
    : `Your weekly harness review is ready. Come and look at your panel: ${link}`;
  const context = cfg.coach === true
    ? `The operator's weekly harness review is due, and they turned the coach on (${file}). Do this once, without asking, alongside whatever they request:
1. Start ONE background agent (model sonnet, high effort) with exactly this task: "Run \`node ${q(panel)} --coach-brief${es ? ' --lang es' : ''}\` and do what it prints."
2. When that agent finishes, run \`${cmd}\` and tell the operator, in their language and in at most three lines, the two notes that matter most, then this link on its own line: ${link}
If the agent fails, say so in one line and still give the link.`
    : `The operator's weekly harness panel was just rebuilt. In your first reply, invite them to open it in one line, in their language, with this link on its own line: ${link}`;
  process.stdout.write(JSON.stringify({ systemMessage: invite, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }));
}

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => { try { main(raw); } catch { /* never fail a session start */ } process.exit(0); });
