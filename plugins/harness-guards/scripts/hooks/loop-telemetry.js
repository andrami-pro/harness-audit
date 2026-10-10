#!/usr/bin/env node
// loop-telemetry — SubagentStop|Stop hook. Appends one ndjson line per agent boundary.
// It runs on every subagent finish, so it reads nothing and parses nothing beyond its own stdin
// payload: the line it writes IS the job. Everything downstream (joins, tokens, costs) is the
// dashboard's problem, offline.
//
// Any failure is swallowed and the hook still exits 0 — a dashboard is never worth failing a turn over.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EVENTS = new Set(['SubagentStop', 'Stop']);

function main(raw) {
  let p;
  try { p = JSON.parse(raw); } catch { return; }
  if (!p || !EVENTS.has(p.hook_event_name)) return;

  const line = {
    event: p.hook_event_name,
    ts: new Date().toISOString(),
    sessionId: String(p.session_id || 'unknown'),
  };
  // Present on SubagentStop payloads that carry the spawning Task call; absent on Stop. Optional by
  // schema — an absent agentType is a fact about the event, not a hole to fill with a guess.
  const agentType = p.agent_type || p.subagent_type || (p.tool_input && p.tool_input.subagent_type);
  if (agentType) line.agentType = String(agentType);

  const file = process.env.LOOP_TELEMETRY_FILE
    || path.join(os.homedir(), '.claude', 'loop-telemetry.ndjson');
  try {
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`);
  } catch (e) {
    if (e.code !== 'ENOENT') return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify(line)}\n`);
    } catch { /* give up silently */ }
  }
}

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => { main(raw); process.exit(0); });
