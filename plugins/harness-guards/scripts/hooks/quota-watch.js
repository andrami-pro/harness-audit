#!/usr/bin/env node
// quota-watch — SessionStart hook, and a three-word CLI. It compares how much of the weekly quota is used with
// how much of the week has gone, from a snapshot file the operator's statusline already writes. When usage runs
// ahead of the days, it says so and has the session propose economy mode; it never switches anything itself.
//
//   node quota-watch.js --economy on|off|status
//
// Economy mode is a note on disk (~/.claude/harness-economy.json) that ends when the week resets. While it is
// on, each session is told to pass `economy: true` to the develop-phase and develop-spec loops, which then run
// their Claude-tier reviewers on sonnet and the implementer at medium effort.
//
// Config, shared with weekly-review: ~/.claude/harness-weekly.json — "quotaFile" (required for this hook to say
// anything), "quotaAhead" (points of lead that trigger the warning, default 10), "lang", "quota": false to
// silence it. No model call, no network, nothing written outside the one state file.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = os.homedir();
const CFG = process.env.HARNESS_WEEKLY_FILE || path.join(HOME, '.claude', 'harness-weekly.json');
const STATE = process.env.HARNESS_ECONOMY_FILE || path.join(HOME, '.claude', 'harness-economy.json');
const WEEK = 7 * 86400000;
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const writeState = (s) => { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, `${JSON.stringify(s, null, 2)}\n`); };

// { used, elapsed, ahead, resetsAt } or null when there is no usable snapshot: a window that already reset, or a
// file older than two days, describes a week that is over.
function readQuota(cfg, now) {
  const snap = readJson(String(cfg.quotaFile || process.env.HARNESS_QUOTA_FILE || ''));
  const w = snap && snap.rate_limits && snap.rate_limits.seven_day;
  if (!w || typeof w.used_percentage !== 'number' || typeof w.resets_at !== 'number') return null;
  const resetsAt = w.resets_at * 1000;
  const at = Date.parse(snap.at || '');
  if (resetsAt <= now || resetsAt - now > WEEK || (Number.isFinite(at) && now - at > 2 * 86400000)) return null;
  const used = Math.round(w.used_percentage);
  const elapsed = Math.round((1 - (resetsAt - now) / WEEK) * 100);
  return { used, elapsed, ahead: used - elapsed, resetsAt };
}

function cli(args) {
  const now = Date.now();
  const cfg = readJson(CFG) || {};
  const want = args[args.indexOf('--economy') + 1];
  const state = readJson(STATE) || {};
  if (want === 'on') {
    const q = readQuota(cfg, now);
    const until = new Date(q ? q.resetsAt : now + WEEK).toISOString();
    writeState({ ...state, on: true, since: new Date(now).toISOString(), until });
    console.log(`economy mode on until ${until}`);
  } else if (want === 'off') {
    writeState({ ...state, on: false });
    console.log('economy mode off');
  } else {
    const on = state.on === true && Date.parse(state.until) > now;
    console.log(on ? `economy mode on until ${state.until}` : 'economy mode off');
  }
}

function hook(raw) {
  let p;
  try { p = JSON.parse(raw); } catch { return; }
  if (!p || p.hook_event_name !== 'SessionStart' || (p.source && p.source !== 'startup')) return;
  const cfg = readJson(CFG) || {};
  if (cfg.quota === false) return;
  const now = Date.now();
  const es = cfg.lang === 'es';
  const state = readJson(STATE) || {};
  const self = `node "${__filename}"`;
  const out = (systemMessage, additionalContext) => process.stdout.write(JSON.stringify({ systemMessage, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } }));

  if (state.on === true) {
    const until = Date.parse(state.until);
    if (!(until > now)) {
      writeState({ ...state, on: false });
      return out(es ? 'La semana se reinició: el modo economía se apagó solo.' : 'The week reset: economy mode turned itself off.',
        'Economy mode ended with the weekly quota reset. Run the loops with their usual line-up again; do not pass economy: true.');
    }
    const day = new Date(until).toISOString().slice(0, 10);
    return out(es ? `Modo economía activo hasta el ${day}.` : `Economy mode is on until ${day}.`,
      `Economy mode is ON until ${day}: the operator chose it because their weekly quota was running ahead of the week. In every develop-phase or develop-spec run you start, pass \`economy: true\` in the args (reviewers on sonnet, implementer at medium effort). Do not mention it again unless they ask. To end it early: \`${self} --economy off\`.`);
  }

  const q = readQuota(cfg, now);
  if (!q) return;
  const threshold = Number.isFinite(Number(cfg.quotaAhead)) ? Number(cfg.quotaAhead) : 10;
  const today = new Date(now).toISOString().slice(0, 10);
  if (q.ahead <= threshold || state.lastWarn === today) return;
  writeState({ ...state, on: false, lastWarn: today });
  const left = Math.round(((q.resetsAt - now) / 86400000) * 10) / 10;
  out(es
    ? `Cuota semanal: ${q.used} % usado con el ${q.elapsed} % de la semana transcurrido (${q.ahead} puntos por delante). Quedan ${String(left).replace('.', ',')} días.`
    : `Weekly quota: ${q.used}% used with ${q.elapsed}% of the week gone (${q.ahead} points ahead). ${left} days left.`,
  `The operator's weekly quota is running ahead of the week: ${q.used}% used, ${q.elapsed}% of the week elapsed, ${left} days left. In your first reply, tell them in one line and propose economy mode with a single yes/no question: until the week resets, the develop-phase and develop-spec loops run their Claude-tier reviewers on sonnet and the implementer at medium effort; nothing else changes and it turns itself off at the reset. If they say yes, run \`${self} --economy on\` and from then on pass \`economy: true\` in the args of every develop-phase or develop-spec run. If they say no, do not raise it again today.`);
}

if (process.argv.includes('--economy')) {
  try { cli(process.argv.slice(2)); } catch (e) { console.error(`quota-watch: ${e.message}`); process.exit(1); }
} else {
  let raw = '';
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => { try { hook(raw); } catch { /* never fail a session start */ } process.exit(0); });
}
