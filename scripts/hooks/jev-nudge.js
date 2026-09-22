#!/usr/bin/env node
// jev-nudge — SessionStart hook. One line, once a day, only while Jev is off.
//
// A Claude Code plugin install cannot ask a question, so the one moment an operator would have said
// "yes, I have a key" passes in silence, and the dedupe and the router stay off in every project
// without anyone deciding that. This says so — once per day, as `additionalContext`, naming the
// command that turns it on — and says nothing at all once a key is present. It never decides anything
// and any failure exits 0.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const jev = require('../jev.js');

const EVERY_MS = 24 * 60 * 60 * 1000;

function stamp() {
  return path.join(process.env.JEV_NUDGE_DIR || path.join(os.tmpdir(), 'harness-audit', 'jev-nudge'), 'last');
}

function main(raw) {
  let p;
  try { p = JSON.parse(raw); } catch { return; }
  if (!p || p.hook_event_name !== 'SessionStart') return;
  if (jev.isEnabled()) return;
  const file = stamp();
  try {
    if (Date.now() - fs.statSync(file).mtimeMs < EVERY_MS) return;
  } catch { /* never nudged */ }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, String(Date.now()));
  } catch { /* stamp lost: worst case, one extra line tomorrow */ }
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: 'harness-audit: TypeSafe Jev is off (no TYPESAFE_API_KEY). Optional — run `bin/jev-setup` from the plugin directory to enable finding dedupe in /orchestrate and /review-loop and the prompt router. This note appears once a day.',
    },
  }));
}

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  try { main(raw); } catch { /* a nudge is never worth failing a session start over */ }
  process.exit(0);
});
