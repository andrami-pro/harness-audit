#!/usr/bin/env node
// repeat-tool-guard — PreToolUse[.*] + UserPromptSubmit hook. A loop-hygiene guard, not a security one.
//
// A model stuck in a loop re-issues the same tool call with byte-identical arguments: re-running a
// failing grep, re-reading an unchanged file, polling a command that already gave its answer. Each
// round trip burns tokens and adds nothing, and nothing in the harness notices — the model escapes only
// when it happens to vary its own behaviour. This hook counts consecutive identical calls per session
// and, at 3, 5 and 8, injects an escalating reminder as `additionalContext`. It NEVER denies a call:
// a legitimately repeated call (polling a long job, re-checking a file the agent expects to change) is
// delayed by nothing and blocked by nothing. The decision — retry differently, gather more evidence, or
// finish — stays with the model.
//
// Identity is `sha256(tool_name + canonical(tool_input))`, canonical = recursive key-sort + JSON with
// the top-level `description` dropped first: Claude Code's Bash carries a free-text description the
// model rewrites on every call ("grep (1/3)", "grep (2/3)"), and a chain keyed on it never forms. A
// different call resets the chain to 1; a UserPromptSubmit deletes it — repetition across a human
// interjection is not a loop. State is one small file per session under REPEAT_TOOL_GUARD_DIR (default:
// the OS temp dir); files older than 24h are pruned opportunistically. The reminder rides
// `additionalContext`, which Claude Code records in the transcript, so what the model saw stays
// reconstructable from the session log.
//
// A subagent's calls carry `agent_id` (Claude Code adds it inside a subagent call), and it is folded
// into the state-file name, so a parent and its subagents keep separate chains. A payload without it
// shares the session's chain; an early reset there is a missed nudge, never a block.
//
// Any failure is swallowed and the hook still exits 0 — a nudge is never worth failing a turn over.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const THRESHOLDS = [3, 5, 8];
const PREVIEW_CHARS = 500;
const PRUNE_AFTER_MS = 24 * 60 * 60 * 1000;
const PRUNE_SCAN_MAX = 200;

// Deep key-sort then stringify: `{a:1,b:2}` and `{b:2,a:1}` are the same call. `undefined` (which
// JSON.stringify drops) is folded to null so a missing key and an explicit null compare equal too.
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  const s = JSON.stringify(v);
  return s === undefined ? 'null' : s;
}

function stateDir() {
  return process.env.REPEAT_TOOL_GUARD_DIR || path.join(os.tmpdir(), 'harness-audit', 'repeat-tool-guard');
}

function stateFile(p) {
  const id = String(p.session_id || 'unknown') + (p.agent_id ? `-${p.agent_id}` : '');
  return path.join(stateDir(), `${id.replace(/[^\w.-]/g, '_')}.json`);
}

function prune(dir, keep) {
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(dir).slice(0, PRUNE_SCAN_MAX)) {
      const f = path.join(dir, name);
      if (f === keep) continue;
      try {
        if (now - fs.statSync(f).mtimeMs > PRUNE_AFTER_MS) fs.unlinkSync(f);
      } catch { /* another session's file, or already gone — not ours to fix */ }
    }
  } catch { /* no dir, no prune */ }
}

function reminder(count, tool, args) {
  const head = `harness-audit repeat-tool-guard: ${count} consecutive identical \`${tool}\` calls.`;
  if (count === THRESHOLDS[0]) {
    return `${head} Stop repeating it — re-read the last result; if it already answered, change approach or conclude.`;
  }
  const preview = args.length > PREVIEW_CHARS ? `${args.slice(0, PREVIEW_CHARS)}…` : args;
  return `${head} The same arguments each time — these calls produced no new information, and repeating will not change the result. Re-read the last result and either change the arguments, change approach, or conclude with the evidence you already hold. Arguments (canonical, first ${PREVIEW_CHARS} chars): ${preview}`;
}

function main(raw) {
  let p;
  try { p = JSON.parse(raw); } catch { return; }
  if (!p || typeof p !== 'object') return;

  if (p.hook_event_name === 'UserPromptSubmit') {
    try { fs.rmSync(stateFile(p), { force: true }); } catch { /* nothing to reset */ }
    return;
  }
  if (p.hook_event_name !== 'PreToolUse') return;
  if (typeof p.tool_name !== 'string' || !p.tool_name) return;

  const tool = p.tool_name;
  const input = p.tool_input === undefined ? null : p.tool_input;
  const semantic = input && typeof input === 'object' && !Array.isArray(input)
    ? Object.fromEntries(Object.entries(input).filter(([k]) => k !== 'description'))
    : input;
  const args = canonical(semantic);
  const hash = crypto.createHash('sha256').update(`${tool}\n${args}`).digest('hex');
  const file = stateFile(p);

  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { prev = null; }
  const count = prev && prev.hash === hash ? (Number(prev.count) || 0) + 1 : 1;

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ hash, count, ts: Date.now() }));
  } catch { /* state lost: the worst case is one missed nudge */ }
  prune(path.dirname(file), file);

  if (!THRESHOLDS.includes(count)) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: reminder(count, tool, args),
    },
  }));
}

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  try { main(raw); } catch { /* a nudge is never worth failing a turn over */ }
  process.exit(0);
});
