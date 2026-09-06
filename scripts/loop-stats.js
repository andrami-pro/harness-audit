#!/usr/bin/env node
// loop-stats.js — read-only dashboard over the transcripts Claude Code already writes.
// Node >= 18, zero dependencies. It never writes to ~/.claude and never touches the network.
//
// The transcript format is internal and undocumented — a Claude Code update can change it without
// notice. Every unreadable line is skipped with a warning instead of aborting, and the shapes this
// parser depends on are pinned in scripts/fixtures/telemetry/ so validate.js sees the break.
//
//   node scripts/loop-stats.js [--project <slug>] [--root <dir>] [--repo <path>]
//                              [--since 7d] [--top 3] [--html <out>] [--json]

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// ─────────────────────────────────────────────────────────────────────────────
// PARSE
// ─────────────────────────────────────────────────────────────────────────────

// USD per million tokens. Cache reads bill at 0.1x input, cache writes at 1.25x (5-minute TTL) and
// 2x (1-hour TTL). A model id absent from this map renders `n/a` — an invented price is worse than
// no price in a dashboard whose whole claim is that it doesn't invent numbers.
const PRICE_PER_MTOK = {
  'claude-opus-5': { in: 5, out: 25 },
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-opus-4-7': { in: 5, out: 25 },
  'claude-opus-4-6': { in: 5, out: 25 },
  'claude-fable-5': { in: 10, out: 50 },
  'claude-mythos-5': { in: 10, out: 50 },
  'claude-opus-4-5': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 3, out: 15, intro: { in: 2, out: 10, until: '2026-08-31' } },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-sonnet-4-5': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
};

const ROLE_ALIAS = { impl: 'implementer', review: 'reviewer', score: 'scorer' };

const warnings = [];
const warn = (m) => { warnings.push(m); process.stderr.write(`warn: ${m}\n`); };
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
// `claude-opus-4-8[1m]` and `claude-haiku-4-5-20251001` are the same models as their bare ids:
// the context suffix carries no long-context premium and the date suffix is a pinned snapshot.
const baseModel = (m) => String(m || 'unknown').replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '');

// Claude Code slugs the *real* path of the cwd: a project reached through a symlinked parent lands
// under the realpath slug while every record inside still says cwd=<symlink path>. Both candidates
// are returned, realpath first, so `--project <path>` finds the directory either way. A value that
// already looks like a slug (leading dash, no slash) is passed through untouched.
const slugOf = (p) => p.replace(/[/.]/g, '-');
function slugCandidates(p) {
  if (!p) return [];
  // No separator means it is already a directory name under --root (`demo`, `-home-user-repo`),
  // not a path to slug. Only a real path gets converted.
  if (!p.includes('/')) return [p];
  const abs = path.resolve(p);
  const out = [slugOf(abs)];
  try {
    const real = fs.realpathSync(abs);
    if (real !== abs) out.unshift(slugOf(real));
  } catch { /* nonexistent path: the resolved slug is still a legitimate guess */ }
  return out;
}

function parseArgs(argv) {
  const a = {
    root: path.join(os.homedir(), '.claude', 'projects'),
    project: null, repo: null, sinceMs: null, html: null, json: false, top: 3, lineup: null,
    jsonOut: null, fromJson: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--project') a.project = argv[++i];
    else if (flag === '--root') a.root = argv[++i];
    else if (flag === '--repo') a.repo = argv[++i];
    else if (flag === '--html') a.html = argv[++i];
    else if (flag === '--json') a.json = true;
    else if (flag === '--json-out') a.jsonOut = argv[++i];
    else if (flag === '--from-json') a.fromJson = argv[++i];
    else if (flag === '--lineup') a.lineup = argv[++i];
    else if (flag === '--top') {
      const n = Number.parseInt(argv[++i], 10);
      if (Number.isInteger(n) && n > 0) a.top = n;
      else warn('--top expects a positive integer — ignored, using 3');
    }
    else if (flag === '--since') {
      const m = /^(\d+)d$/.exec(argv[++i] || '');
      if (m) a.sinceMs = Date.now() - Number(m[1]) * 864e5;
      else warn('--since expects <N>d (e.g. 7d) — ignored, showing all history');
    } else warn(`unknown flag ${flag} — ignored`);
  }
  a.root = path.resolve(a.root);
  if (a.repo) a.repo = path.resolve(a.repo);
  a.projectCandidates = slugCandidates(a.project || process.cwd());
  a.project = a.projectCandidates[0];
  return a;
}

function readJsonl(file) {
  const out = [];
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { warn(`${file}: ${e.code}`); return out; }
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try { out.push(JSON.parse(line)); }
    catch { warn(`${path.basename(file)}:${i + 1} unreadable line — skipped`); }
  });
  return out;
}

// Run records and metas are optional: a workflow still in flight has a journal but no record yet.
// Absence is normal and silent; a file that exists but does not parse is a format break and warns.
function readJson(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { warn(`${path.basename(file)}: ${e.code || 'unparseable'} — skipped`); return null; }
}

const ls = (dir) => {
  try { return fs.readdirSync(dir); }
  catch (e) { if (e.code !== 'ENOENT') warn(`${dir}: ${e.code}`); return []; }
};

// Zero-token records are Claude Code's synthetic placeholders, not model calls.
function usageOf(rec) {
  const u = rec && rec.message && rec.message.usage;
  if (!u) return null;
  const c = u.cache_creation || {};
  const cw1 = num(c.ephemeral_1h_input_tokens);
  const cw5 = cw1 + num(c.ephemeral_5m_input_tokens) > 0
    ? num(c.ephemeral_5m_input_tokens)
    : num(u.cache_creation_input_tokens);
  const usage = {
    in: num(u.input_tokens), out: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens), cw5, cw1,
  };
  usage.tokens = usage.in + usage.out + usage.cacheRead + usage.cw5 + usage.cw1;
  return usage.tokens > 0 ? usage : null;
}

// Priced by the record's own timestamp, not today's — an intro-window run still bills at intro rate late.
function priceFor(model, ts) {
  const p = PRICE_PER_MTOK[baseModel(model)];
  if (!p || !p.intro) return p || null;
  const when = Number.isFinite(Date.parse(ts)) ? Date.parse(ts) : Date.now();
  return when <= Date.parse(`${p.intro.until}T23:59:59Z`) ? { ...p.intro, isIntro: true } : p;
}

function costOf(price, u) {
  if (!price) return null;
  return (u.in * price.in + u.out * price.out + u.cacheRead * price.in * 0.1
    + u.cw5 * price.in * 1.25 + u.cw1 * price.in * 2) / 1e6;
}

// Tool results, meta caveats, slash-command wrappers and injected reminders all arrive under the same
// `type: "user"` and are dropped here. What survives is every *user-role turn* — which is not the same
// as "typed by a human": a command or a loop that re-prompts its own session writes a user turn that
// carries no marker distinguishing it from a keystroke. The counts below say so rather than guess.
function promptText(rec) {
  if (rec.isMeta || rec.isSidechain) return null;
  const c = rec.message && rec.message.content;
  let text = null;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    const parts = c.filter((b) => b && b.type === 'text' && b.text).map((b) => b.text);
    if (!parts.length) return null;
    text = parts.join('\n');
  }
  if (!text) return null;
  const t = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!t) return null;
  if (/^<(command-|local-command|user-memory-input|bash-)/.test(t)) return null;
  if (/^\[Request interrupted/.test(t)) return null;
  return t;
}

const isToolResult = (rec) => {
  const c = rec.message && rec.message.content;
  return Array.isArray(c) && c.some((b) => b && b.type === 'tool_result');
};

const signature = (t) => t.toLowerCase().replace(/\s+/g, ' ').replace(/[^\p{L}\p{N} ]/gu, '')
  .trim().split(' ').filter(Boolean).slice(0, 8).join(' ');

// ─────────────────────────────────────────────────────────────────────────────
// SIGNALS — what the transcripts record besides tokens
// ─────────────────────────────────────────────────────────────────────────────

// A tool_result's content is a string on some tools and a block array on others. Both are flattened
// to the text a human would have read, because every matcher below keys on that text.
function resultText(block) {
  const c = block && block.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n');
  return '';
}

// A guard FIRE is a blocked tool call — the guard's own prefix inside an is_error result. The same
// words typed into a prompt are a mention, not a fire, and the anchored prefix is what keeps the two
// apart: this repo discusses its guards constantly in the very sessions it measures.
const GUARD_FIRE = /^harness-audit ([a-z-]+): blocked/;
const DENIAL = /^The user doesn't want to proceed with this tool use/;
const DENIAL_REASON = /The user provided the following reason for the rejection:\s*([\s\S]*)$/;
const STALE_EDIT = /File has been modified since read/;

// Bare continuation tokens: a whole turn spent saying "keep going". Anchored and length-capped so
// "continue with the second half but skip the tests" is a prompt, not a continuation.
const CONTINUATION = /^(continu[aeé]r?|continúa|sigue|dale|adelante|ok|okay|go on|go ahead|proceed|next)[\s.!]*$/i;
// Correction-SHAPED, and labelled a proxy everywhere it surfaces: a prompt opening with a negation
// after the agent handed the floor back. "no olvides…" matches too, which is why no card fires on
// this number alone — tools.denials carries the corrections that are explicit.
const CORRECTION = /^(no|nop|nope|non|espera|para|stop|wait|mal|así no|asi no|eso no|no es eso|no era|revierte|deshaz|undo)\b/i;

// A user-role turn written by a loop to its own subagent carries no structural marker — same
// userType, same promptSource, same shape as a keystroke (session-review.md §2). Only its wording
// gives it away, so these are matched by shape and the count of what was dropped is always printed.
const AGENT_SHAPED = [
  /^Round \d+\./,
  /^You are (the|an?|our) /i,
  /^Eres (un|una|el|la) /i,
  /^<task-notification>/,
  /^<ide_opened_file>/,
  /^# (Findings|Handoff|Review|Scorecard)\b/,
  /^Review these artifacts\b/i,
];
const looksAgentAuthored = (t) => AGENT_SHAPED.some((re) => re.test(t));

// Kinds of user-role record. Everything the dashboard counts about the human's side of the session
// is decided here, once, so the prompt path and the hygiene path cannot drift apart.
function classifyUserRecord(rec) {
  if (rec.isCompactSummary) return { kind: 'compact_summary' };
  const c = rec.message && rec.message.content;
  if (Array.isArray(c)) {
    const results = c.filter((b) => b && b.type === 'tool_result');
    if (results.length) {
      return {
        kind: 'tool_result',
        results: results.map((b) => ({ toolUseId: b.tool_use_id, isError: !!b.is_error, text: resultText(b) })),
      };
    }
  }
  const flat = typeof c === 'string' ? c : Array.isArray(c)
    ? c.filter((b) => b && b.type === 'text' && b.text).map((b) => b.text).join('\n') : '';
  const t = String(flat).trim();
  if (/^\[Request interrupted/.test(t)) return { kind: 'interrupt' };
  // The wrapper's tags arrive in either order: built-ins lead with <command-name>, skill-backed
  // commands lead with <command-message>. Anchoring on the opening tag keeps a prompt that merely
  // quotes one of these tags from being counted as an invocation.
  if (/^<command-/.test(t)) {
    const cmd = /<command-name>([^<]*)<\/command-name>/.exec(t);
    if (cmd) {
      const argm = /<command-args>([\s\S]*?)<\/command-args>/.exec(t);
      return { kind: 'command', name: cmd[1].trim(), args: (argm ? argm[1] : '').trim() };
    }
  }
  const text = promptText(rec);
  if (text === null) return { kind: 'meta' };
  return { kind: 'prompt', text };
}

function parseSession(projectDir, sessionId) {
  const turns = [];
  const prompts = [];
  const taskLabels = new Map();
  // Everything the session records besides token usage. Collected in the same single pass, because
  // a second walk over a gigabyte of transcripts to count tool calls would cost more than it tells.
  const ev = {
    sessionId,
    toolUses: [],
    toolResults: [],
    commands: [],
    interrupts: [],
    compactions: [],
    hooks: [],
    apiErrors: 0,
    planMode: false,
    lastTs: null,
  };
  const toolOf = new Map();
  const hookRuns = new Map();
  let prevKind = null;
  for (const r of readJsonl(path.join(projectDir, `${sessionId}.jsonl`))) {
    if (r.timestamp) ev.lastTs = r.timestamp;
    if (r.type === 'assistant') {
      const u = usageOf(r);
      if (u) turns.push({ agentType: 'main', model: r.message.model, ts: r.timestamp, usage: u });
      for (const b of (r.message && r.message.content) || []) {
        if (!b || b.type !== 'tool_use') continue;
        // The subagent tool was renamed Task → Agent; both spawn the same subagents/agent-*.jsonl.
        if (b.name === 'Task' || b.name === 'Agent') taskLabels.set(b.id, b.input || {});
        toolOf.set(b.id, b.name);
        ev.toolUses.push({ id: b.id, name: b.name, input: b.input || {}, ts: r.timestamp });
      }
      prevKind = 'assistant';
    } else if (r.type === 'system') {
      if (r.subtype === 'api_error') ev.apiErrors++;
      if (r.subtype === 'compact_boundary') {
        const m = r.compactMetadata || {};
        ev.compactions.push({ ts: r.timestamp, trigger: m.trigger || 'unknown', preTokens: num(m.preTokens) });
      }
    } else if (r.type === 'attachment') {
      // PreToolUse hooks that are not this plugin's guards (graphify's, a project's own) surface as
      // attachments rather than tool results. Counted separately: a hook that ran is not a block.
      // One hook run writes two attachments: hook_success carries the command and exit code,
      // hook_additional_context carries the text it injected. They share a toolUseID, and counting
      // them apart doubles every hook in the table.
      const a = r.attachment || {};
      if (a.hookEvent !== 'PreToolUse') continue;
      const key = `${a.toolUseID || r.uuid}|${a.hookName || 'PreToolUse'}`;
      const row = hookRuns.get(key) || { ts: r.timestamp, hookName: a.hookName || 'PreToolUse', command: null, exitCode: null, injected: false };
      if (a.command) row.command = String(a.command).replace(/^\S*\//, '');
      if (typeof a.exitCode === 'number') row.exitCode = a.exitCode;
      if (a.type === 'hook_additional_context' || /additionalContext/.test(String(a.stdout || ''))) row.injected = true;
      hookRuns.set(key, row);
    } else if (r.type === 'user') {
      if (r.permissionMode === 'plan') ev.planMode = true;
      const c = classifyUserRecord(r);
      if (c.kind === 'tool_result') {
        for (const res of c.results) ev.toolResults.push({ ...res, ts: r.timestamp, tool: toolOf.get(res.toolUseId) || null });
        prevKind = 'tool';
        continue;
      }
      if (c.kind === 'command') { ev.commands.push({ ts: r.timestamp, name: c.name, args: c.args }); continue; }
      if (c.kind === 'interrupt') { ev.interrupts.push({ ts: r.timestamp }); continue; }
      // Caveats, memory input and the compaction summary are bookkeeping the human never typed.
      if (c.kind !== 'prompt') continue;
      // Proxy for "I had to correct it": the agent had ended its turn and the human typed again.
      prompts.push({ ts: r.timestamp, sessionId, text: c.text, isFollowUp: prevKind === 'assistant' });
      prevKind = 'user';
    }
  }
  ev.hooks = [...hookRuns.values()];
  return { turns, prompts, taskLabels, events: ev };
}

function parseAgentFile(file, agentType) {
  const turns = [];
  for (const r of readJsonl(file)) {
    if (r.type !== 'assistant') continue;
    const u = usageOf(r);
    if (u) turns.push({ agentType, model: r.message.model, ts: r.timestamp, usage: u });
  }
  return turns;
}

// JOIN 1 — meta.toolUseId ↔ tool_use.id in the session: the Task call names the agent it spawned.
function parseTaskAgents(sessionDir, taskLabels) {
  const dir = path.join(sessionDir, 'subagents');
  const turns = [];
  for (const f of ls(dir).filter((f) => /^agent-.*\.jsonl$/.test(f))) {
    const meta = readJson(path.join(dir, f.replace(/\.jsonl$/, '.meta.json'))) || {};
    const spawn = taskLabels.get(meta.toolUseId) || {};
    turns.push(...parseAgentFile(path.join(dir, f), meta.agentType || spawn.subagent_type || 'subagent'));
  }
  return turns;
}

// JOIN 2 — journal.agentId ↔ agent-<id>.jsonl in the same wf_ dir: the journal says which agents ran,
// the transcripts say what they cost. The run record (workflows/wf_<id>.json) adds name, labels and
// verdict; without it the workflow still reports from the journal alone.
function parseWorkflows(sessionDir) {
  const wfRoot = path.join(sessionDir, 'subagents', 'workflows');
  const runs = [];
  const turns = [];
  for (const wfId of ls(wfRoot).filter((d) => d.startsWith('wf_'))) {
    const wfDir = path.join(wfRoot, wfId);
    const journal = readJsonl(path.join(wfDir, 'journal.jsonl'));
    if (!journal.length) continue;

    const record = readJson(path.join(sessionDir, 'workflows', `${wfId}.json`)) || {};
    const progress = (record.workflowProgress || []).filter((p) => p && p.type === 'workflow_agent');
    const labelOf = new Map(progress.map((p) => [p.agentId, p.label || '']));

    const seen = new Set();
    const agents = [];
    let stamps = [];
    let tokens = 0;
    let resultLine = null;
    for (const ev of journal) {
      if (!ev || !ev.agentId) continue;
      if (ev.type === 'result' && typeof ev.result === 'string') {
        const first = ev.result.split('\n').map((l) => l.trim()).find(Boolean);
        if (first) resultLine = first;
      }
      if (seen.has(ev.agentId)) continue;
      seen.add(ev.agentId);

      const label = labelOf.get(ev.agentId) || '';
      const role = label.split(':')[0];
      const meta = readJson(path.join(wfDir, `agent-${ev.agentId}.meta.json`)) || {};
      const agentType = ROLE_ALIAS[role] || role || meta.agentType || 'workflow-subagent';
      const agentTurns = parseAgentFile(path.join(wfDir, `agent-${ev.agentId}.jsonl`), agentType);
      if (!agentTurns.length) continue;

      turns.push(...agentTurns);
      stamps = stamps.concat(agentTurns.map((t) => Date.parse(t.ts)).filter(Number.isFinite));
      tokens += agentTurns.reduce((n, t) => n + t.usage.tokens, 0);
      agents.push({ agentId: ev.agentId, label, agentType, model: agentTurns[0].model });
    }
    if (!stamps.length) continue;

    const startedAt = Math.min(...stamps);
    const iterations = num(record.result && record.result.iterations);
    const fromLabels = agents
      .map((a) => Number((/:iter(\d+)$/.exec(a.label) || [])[1]))
      .filter(Number.isFinite);
    const rounds = iterations || (fromLabels.length ? Math.max(...fromLabels) : null);

    let verdict = null;
    if (record.result && typeof record.result.approved === 'boolean') {
      verdict = record.result.approved ? 'APROBADO' : 'RECHAZADO';
    }
    // A run status ("completed") is not a verdict — kept apart and lowercased, never APROBADO/RECHAZADO.
    const state = !verdict && record.status ? String(record.status).toLowerCase() : null;

    runs.push({
      runId: wfId,
      name: record.workflowName || wfId,
      startedAt: new Date(startedAt).toISOString(),
      durationMs: Math.max(...stamps) - startedAt,
      rounds,
      verdict,
      state,
      tokens,
      resultLine,
      agents,
    });
  }
  return { runs, turns };
}

// D17 — a "saving" exists only where a counterfactual was actually measured. Exactly three sources
// qualify: (a) the two arms of a skill-loop A/B, both of which ran; (b) the optimizer's falsifiable
// predictions, resolved in process-log.md; (c) rounds-to-green, and only as a labelled proxy. A
// multiplier ("this saved you 3 hours", "2x productivity") is never one of them. A figure with no
// counterfactual behind it gets no row — the block prints why it cannot show one instead.

const mean = (xs) => xs.reduce((n, x) => n + x, 0) / xs.length;

// An arm is recorded as the harness reported it: `in`/`out` where it splits the usage, `{total}` where
// it only returns one number (commands/skill-loop.md §8). Both shapes are the same measurement; the
// split is not reconstructed from a total, because a reconstructed split is a guess wearing two fields.
const armTotal = (x) => (x && (x.total != null || x.in != null || x.out != null)
  ? (x.total != null ? num(x.total) : num(x.in) + num(x.out))
  : null);

// Both arms ran the same eval-task, same model, same tools; the only difference is the skill. The
// arithmetic is redone here from the raw arm scores rather than trusted from the record's own `gap`
// field: a gate that believes a number it was handed is not a gate.
function abRuns(records) {
  const out = [];
  for (const j of records) {
    if (j.loop !== 'skill-loop' || !Array.isArray(j.rounds)) continue;
    const rounds = j.rounds.filter((r) => r && r.arms
      && Array.isArray(r.arms.withSkill) && r.arms.withSkill.length
      && Array.isArray(r.arms.withoutSkill) && r.arms.withoutSkill.length);
    if (!rounds.length) continue;

    const last = rounds[rounds.length - 1];
    const scoreMax = Number((/\/(\d+)/.exec((j.setup && j.setup.rubric) || '') || [])[1]) || null;

    // Only per-arm totals are a token counterfactual. A round's own `tokens` is the two arms already
    // collapsed into one number, so splitting it across the arms would fabricate a Δ of 0 — "the skill
    // was free" — out of a quantity nobody measured. The three ways of having no Δ are reported apart,
    // because a block whose contract is "show why it cannot measure" may not print a false why.
    const t = last.armTokens || {};
    const withSkill = armTotal(t.withSkill);
    const withoutSkill = armTotal(t.withoutSkill);
    const armTokens = withSkill !== null && withoutSkill !== null ? { withSkill, withoutSkill } : null;
    const metered = rounds.some((r) => r.tokens && (r.tokens.in != null || r.tokens.out != null));
    const tokensReason = armTokens ? null
      : withSkill !== null || withoutSkill !== null ? 'only one arm metered — a Δ needs both'
        : metered ? 'metered per round, not per arm'
          : 'no tokens recorded on this run';

    out.push({
      run: j.run,
      subject: j.skill || j.task || j.run,
      rounds: rounds.length,
      deltaScore: mean(last.arms.withSkill) - mean(last.arms.withoutSkill),
      scoreMax,
      deltaTokens: armTokens ? armTokens.withSkill - armTokens.withoutSkill : null,
      tokensReason,
    });
  }
  return out;
}

// The ledger is the table at the top of process-log.md, and only the table. The prose below it may
// still carry the superseded "verified" of a prediction the ledger records as falsified — kept
// unedited on purpose, because the mis-measurement is the finding. Reading the body would count that
// falsification as a success, which is the exact dishonesty D17 exists to forbid. Falsification wins
// any row that carries both markers.
//
// Outcomes are read in English and in Spanish: the plugin is English (D14), but the process-log it
// reads is written by whoever runs the loop, in their language. An outcome in neither is `unknown` and
// is rendered as such — a row this parser cannot read must never fall into the silent 0 of "falsified".
const OUTCOME = [
  ['falsified', /falsad|falsifi|❌/i],
  ['verified', /verificad|verified|✅/i],
  ['pending', /pendiente|pending|⏳/i],
];
//
// Absent and unreadable are two different facts and get two different returns. Collapsing them into
// one `null` makes the render state "the loop never ran here" about a file that exists and may carry
// a falsification — a block whose contract is to show why it cannot measure may not print a false why.
function parsePredictions(repo) {
  const file = path.join(repo, 'docs', 'harness-dev', 'loop-runs', 'process-log.md');
  const unreadable = (why) => ({ unreadable: why, verified: 0, falsified: 0, pending: 0, unknown: 0, rows: [] });
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return null;
    warn(`${file}: ${e.code}`);
    return unreadable(e.code);
  }

  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 6 || !/^v\d+$/.test(cells[0])) continue;
    const result = cells[5];
    const outcome = (OUTCOME.find(([, re]) => re.test(result)) || ['unknown'])[0];
    rows.push({ version: cells[0], date: cells[1], change: cells[2], prediction: cells[3], outcome });
  }
  if (!rows.length) return unreadable('no ledger row parsed');

  const tally = (o) => rows.filter((r) => r.outcome === o).length;
  return {
    verified: tally('verified'),
    falsified: tally('falsified'),
    pending: tally('pending'),
    unknown: tally('unknown'),
    rows,
  };
}

// --repo: the loop's own paper trail. Findings JSON per run, plus the skill journals it wrote.
function parseRepo(repo) {
  const loopRuns = [];
  const records = [];
  const runsDir = path.join(repo, 'docs', 'harness-dev', 'loop-runs');
  for (const f of ls(runsDir).filter((f) => f.endsWith('.json'))) {
    const j = readJson(path.join(runsDir, f));
    if (!j) continue;
    records.push(j);
    loopRuns.push({
      run: j.run || f.replace(/\.json$/, ''),
      loop: j.loop || 'unknown',
      date: (/(\d{4}-\d{2}-\d{2})/.exec(j.run || f) || [])[1] || null,
      rounds: Array.isArray(j.rounds) ? j.rounds.length : null,
      verdict: j.verdict || null,
      stoppedBy: j.stoppedBy || null,
    });
  }
  loopRuns.sort((a, b) => String(b.date).localeCompare(String(a.date)));

  const learnings = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    for (const e of (() => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } })()) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name === 'LEARNINGS.md') {
        const skill = path.basename(path.dirname(p));
        let text = '';
        try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
        for (const line of text.split('\n')) {
          const m = /^##\s+(\d{4}-\d{2}-\d{2})\s*(?:·\s*(.*))?$/.exec(line.trim());
          if (m) learnings.push({ date: m[1], entry: (m[2] || '').trim(), skill });
        }
      }
    }
  };
  walk(repo, 0);
  learnings.sort((a, b) => b.date.localeCompare(a.date));

  // (c) rounds-to-green: a trend, not a saving. It is reported labelled and never priced — nobody
  // measured what those rounds would have cost without the loop, so no counterfactual exists.
  const green = loopRuns
    .filter((r) => r.loop === 'develop-phase' && r.verdict === 'APROBADO' && r.rounds)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

  const savings = {
    ab: abRuns(records),
    predictions: parsePredictions(repo),
    roundsToGreen: green.length ? { proxy: true, trend: green.map((r) => r.rounds), runs: green.map((r) => r.run) } : null,
  };
  return { loopRuns, learnings, savings };
}

// ─────────────────────────────────────────────────────────────────────────────
// CARDS — rule-based recommendations, zero tokens
// ─────────────────────────────────────────────────────────────────────────────

// A card is a recommendation with its evidence and its limits attached. Three properties are not
// negotiable, and they are what separate this from a horoscope:
//
//   1. A rule that finds no evidence prints NOTHING. There is no "all clear" card, no filler to make
//      the grid look full. The count of rules that stayed silent is printed instead.
//   2. Every card carries `doesNotProve`. A number that is a proxy says so next to itself.
//   3. No card edits anything. /session-review proposes and never applies; so does this.
//
// Thresholds are deliberately blunt (5 events, 3 sessions, 70%). A tuned threshold is a threshold
// nobody can argue with, and these are meant to be argued with.
const RULES = [
  {
    id: 'continue-token',
    type: 'HABIT',
    severity: 'warn',
    when: (d) => d.hygiene.continuations.count >= 5
      && d.hygiene.continuations.afterAgentTurn / d.hygiene.continuations.count >= 0.8,
    headline: (d) => `${d.hygiene.continuations.count} bare continuation turns — ${d.hygiene.continuations.afterAgentTurn} of them right after the agent ended its turn`,
    evidence: (d) => `${pctOf(d.hygiene.continuations.count, d.hygiene.humanPrompts)} of human prompts in the window`,
    recommendation: 'The agent stops before the unit of work ends. Candidate AGENTS.md rule: finish the unit, or say what is missing before stopping.',
    doesNotProve: 'that the agent was wrong to stop — a human pacing the work produces the same shape',
    source: 'hygiene.continuations',
  },
  {
    id: 'manual-model-switch',
    type: 'DISPATCH',
    severity: 'warn',
    when: (d) => d.hygiene.modelSwitches.count >= 5,
    headline: (d) => `/model typed ${d.hygiene.modelSwitches.count} times in this window`,
    evidence: (d) => Object.entries(d.hygiene.modelSwitches.targets).map(([k, v]) => `${k} ×${v}`).join(' · ') || 'no target recorded',
    recommendation: 'A switch made by hand every session is a configuration nobody wrote down: settings.model for the main thread, `model:` in an agent file, or .agents/model-lineup.json for the roles.',
    doesNotProve: 'that any of those targets is the better model — nothing here compares them',
    source: 'hygiene.modelSwitches',
  },
  {
    id: 'skill-shelfware',
    type: 'SKILL CANDIDATE',
    severity: 'warn',
    when: (d) => d.skills && d.skills.installedNotUsed.project.length >= 5 && d.skills.shelfRatio.project >= 0.6,
    headline: (d) => `${d.skills.installedNotUsed.project.length} of the project's ${Math.round(d.skills.installedNotUsed.project.length / d.skills.shelfRatio.project)} installed skills were never invoked here`,
    evidence: (d) => d.skills.installedNotUsed.project.slice(0, 12).join(', '),
    recommendation: 'Prune them, or name the invocation in AGENTS.md so the use becomes observable.',
    doesNotProve: 'that a skill is useless — a description that auto-triggered without the Skill tool leaves no trace in the transcript',
    source: 'skills.installedNotUsed',
  },
  {
    id: 'skill-used-not-installed',
    type: 'SKILL CANDIDATE',
    severity: 'info',
    when: (d) => d.skills && d.skills.usedNotInstalled.length > 0,
    headline: (d) => `${d.skills.usedNotInstalled.length} name(s) were invoked that no SKILL.md or command file backs`,
    evidence: (d) => d.skills.usedNotInstalled.join(', '),
    recommendation: 'Check whether each is a workflow (which is fine) or a skill that was removed while the habit of calling it stayed.',
    doesNotProve: 'that anything is broken — built-in commands and workflows land here too',
    source: 'skills.usedNotInstalled',
  },
  {
    id: 'repeated-crash',
    type: 'HABIT',
    severity: 'warn',
    when: (d) => d.tools.errorClusters.some((c) => c.count >= 3),
    headline: (d) => `the same failure came back ${d.tools.errorClusters[0].count} times across ${d.tools.errorClusters[0].sessions} session(s)`,
    evidence: (d) => `«${clip(d.tools.errorClusters[0].sample, 120)}» · last seen ${String(d.tools.errorClusters[0].lastAt).slice(0, 10)}`,
    recommendation: 'A failure that repeats is a preflight check nobody wrote. Add it to the project preflight, or record the fix in the relevant LEARNINGS.md.',
    doesNotProve: 'that all of them share one root cause — the cluster key is the first eight words of the error',
    source: 'tools.errorClusters',
  },
  {
    id: 'denials-as-rules',
    type: 'AGENTS.md RULE',
    severity: 'info',
    when: (d) => d.tools.denials.reasons.length >= 3,
    headline: (d) => `${d.tools.denials.count} tool call(s) refused — ${d.tools.denials.reasons.length} with a reason you typed`,
    evidence: (d) => d.tools.denials.reasons.slice(0, 4).map((r) => `«${clip(r.reason, 70)}»`).join(' · '),
    recommendation: 'A denial reason is the only correction in this file that is not a proxy. Read them as candidate contract lines; the grep for each is in the Tools section.',
    doesNotProve: 'that the rule belongs in AGENTS.md — it may belong in a skill, and you are the one who promotes it',
    source: 'tools.denials.reasons',
  },
  {
    id: 'interrupt-rate',
    type: 'HABIT',
    severity: 'info',
    when: (d) => d.hygiene.interrupts >= 10 && d.hygiene.humanPrompts > 0
      && d.hygiene.interrupts / d.hygiene.humanPrompts >= 0.08,
    headline: (d) => `${d.hygiene.interrupts} interrupted turns — ${pctOf(d.hygiene.interrupts, d.hygiene.humanPrompts)} of your prompts`,
    evidence: (d) => `${d.hygiene.interrupts} of ${d.hygiene.humanPrompts} prompts followed a turn you stopped mid-flight`,
    recommendation: 'Interrupting this often usually means the unit of work is too large to watch. Plan mode, or smaller units, gives you a decision point instead of a stop button.',
    doesNotProve: 'that the interrupted turns were going wrong — stopping a correct turn early looks identical',
    source: 'hygiene.interrupts',
  },
  {
    id: 'compaction-pressure',
    type: 'HABIT',
    severity: 'info',
    when: (d) => d.hygiene.compactions.auto >= 3,
    headline: (d) => `${d.hygiene.compactions.auto} sessions were compacted automatically`,
    evidence: (d) => `average ${human(d.hygiene.compactions.avgPreTokens)} tokens before the cut · /handoff typed ×${d.hygiene.slashCommands['/handoff'] || 0}`,
    recommendation: 'An automatic summary is a handoff nobody wrote. Close the session on your own terms before the context runs out.',
    doesNotProve: 'that shorter sessions produce better work — only that these were cut without your hand',
    source: 'hygiene.compactions',
  },
  {
    id: 'hand-dispatched-role',
    type: 'DISPATCH',
    severity: 'info',
    when: (d) => d.skills && Object.entries(d.tools.subagents.byType)
      .some(([role, n]) => n >= 5 && d.skills.roles.includes(role)),
    headline: (d) => {
      const [role, n] = Object.entries(d.tools.subagents.byType).find(([r, x]) => x >= 5 && d.skills.roles.includes(r));
      return `${role} was spawned by hand ${n} times — a role this repo already defines`;
    },
    evidence: (d) => {
      const [role] = Object.entries(d.tools.subagents.byType).find(([r, x]) => x >= 5 && d.skills.roles.includes(r));
      return `.claude/agents/${role}.md exists · ${d.workflows.length} workflow run(s) in the same window`;
    },
    recommendation: 'Candidate dispatch criterion: say in AGENTS.md when this role runs itself, instead of describing it in prose each time.',
    doesNotProve: 'that a workflow would have been cheaper — no counterfactual was measured',
    source: 'tools.subagents.byType',
  },
  {
    id: 'main-thread-heavy',
    type: 'HABIT',
    severity: 'info',
    when: (d) => d.totals.costUsd >= 50 && mainShare(d) >= 0.7,
    headline: (d) => `the main thread is ${pctOf(1, 1 / mainShare(d))} of priced spend`,
    evidence: (d) => `$${d.totals.costUsd.toFixed(0)} priced · ${d.tools.subagents.total} subagent spawns in the same window`,
    recommendation: 'Work that runs in the main thread pays full context on every turn. The roles in .claude/agents exist to move some of it off that thread.',
    doesNotProve: 'that delegating would have cost less — no run here measured the alternative',
    source: 'agents',
  },
  {
    id: 'unpriced-model',
    type: 'DASHBOARD',
    severity: 'info',
    when: (d) => d.unpricedModels.length > 0,
    headline: (d) => `${d.unpricedModels.join(', ')} has no list price here`,
    evidence: (d) => {
      const rows = d.agents.filter((a) => !a.priced);
      return `${rows.reduce((n, a) => n + a.runs, 0)} run(s) · ${human(rows.reduce((n, a) => n + a.tokens, 0))} tokens excluded from est.$`;
    },
    recommendation: 'Verify the list price and add it to PRICE_PER_MTOK. Never from memory: an invented price is worse than none.',
    doesNotProve: 'anything about the work — only that the total below is a floor',
    source: 'unpricedModels',
  },
  {
    id: 'review-pending',
    type: 'LIFECYCLE',
    severity: 'warn',
    when: (d) => !!(d.reviews && d.reviews.latest && d.reviews.latest.pending > 0),
    headline: (d) => `${plural(d.reviews.latest.pending, 'card')} from the last /session-review ${d.reviews.latest.pending === 1 ? 'is' : 'are'} still open after ${d.reviews.latest.ageDays} days`,
    evidence: (d) => d.reviews.latest.cards.filter((c) => c.state === 'pending')
      .map((c) => `«${clip(c.text, 70)}» — ${c.evidence}`).join(' · '),
    recommendation: 'Promote it, or reject it in the report so it stops surfacing here.',
    doesNotProve: 'that you rejected it — a rejected card is a valid outcome, and nothing on disk records that decision',
    source: 'reviews.latest.cards',
  },
  {
    id: 'review-stale',
    type: 'LIFECYCLE',
    severity: 'info',
    when: (d) => (d.reviews === null && d.hygiene.sessions >= 10)
      || !!(d.reviews && d.reviews.latest && d.reviews.latest.ageDays !== null && d.reviews.latest.ageDays >= 21),
    headline: (d) => (d.reviews && d.reviews.latest
      ? `the last /session-review ran ${d.reviews.latest.ageDays} days ago`
      : `${d.hygiene.sessions} sessions here and no /session-review has ever run`),
    evidence: (d) => (d.reviews && d.reviews.latest ? d.reviews.latest.file : 'docs/harness-dev/loop-runs/ holds no *-session-review.md'),
    recommendation: 'Run /session-review. It starts from the cards above rather than from the raw corpus, so it is cheaper than it was.',
    doesNotProve: 'that anything has gone wrong in the meantime',
    source: 'reviews',
  },
];

const pctOf = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : 'n/a');
const mainShare = (d) => {
  if (!d.totals.costUsd) return 0;
  return d.agents.filter((a) => a.agentType === 'main').reduce((n, a) => n + a.costUsd, 0) / d.totals.costUsd;
};

function evaluateCards(d) {
  const fired = [];
  const silent = [];
  for (const rule of RULES) {
    let hit = false;
    try { hit = !!rule.when(d); } catch { hit = false; }
    if (!hit) { silent.push(rule.id); continue; }
    try {
      fired.push({
        rule: rule.id,
        type: rule.type,
        severity: rule.severity,
        headline: rule.headline(d),
        evidence: rule.evidence(d),
        recommendation: rule.recommendation,
        doesNotProve: rule.doesNotProve,
        source: rule.source,
      });
    } catch (e) {
      // A rule that matched but cannot describe what it matched is a broken rule, not a finding.
      warn(`card rule ${rule.id} matched but could not render — skipped (${e.message})`);
      silent.push(rule.id);
    }
  }
  const order = { warn: 0, info: 1 };
  fired.sort((a, b) => (order[a.severity] - order[b.severity]) || a.rule.localeCompare(b.rule));
  return { fired, silent };
}

// ─────────────────────────────────────────────────────────────────────────────
// AGGREGATE
// ─────────────────────────────────────────────────────────────────────────────

// The guards this plugin installs, read from its own hooks.json rather than hardcoded — a guard
// added to the manifest and not to this list would silently read as "never fired". Absent manifest
// (a copied-scripts install) returns null, and the block renders nothing rather than four zeroes.
function pluginGuardNames() {
  const manifest = readJson(path.join(__dirname, '..', 'hooks', 'hooks.json'));
  if (!manifest || !manifest.hooks) return null;
  const names = new Set();
  for (const entries of Object.values(manifest.hooks)) {
    for (const e of entries || []) {
      for (const h of (e && e.hooks) || []) {
        const m = /scripts\/hooks\/([a-z0-9-]+)\.js/.exec(String(h.command || ''));
        // loop-telemetry is a writer, not a guard: it never blocks a call, so it has no fire to count.
        if (m && m[1] !== 'loop-telemetry') names.add(m[1]);
      }
    }
  }
  return [...names].sort();
}

// ─────────────────────────────────────────────────────────────────────────────
// INVENTORY — what is installed, against what actually ran
// ─────────────────────────────────────────────────────────────────────────────

// Every place a skill can be installed for this machine. Read-only, and tolerant of every one of
// them being absent: most projects have two of these five.
function inventorySkills(repo) {
  const home = os.homedir();
  const out = [];
  const seen = new Set();
  const add = (name, source, file, enabled = true) => {
    const key = `${source}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, source, path: file, enabled });
  };
  const scanSkills = (dir, source) => {
    for (const e of ls(dir)) {
      if (fs.existsSync(path.join(dir, e, 'SKILL.md'))) add(e, source, path.join(dir, e), true);
    }
  };
  const scanCommands = (dir, source) => {
    for (const f of ls(dir).filter((f) => f.endsWith('.md'))) add(f.replace(/\.md$/, ''), source, path.join(dir, f), true);
  };

  scanSkills(path.join(repo, '.claude', 'skills'), 'project');
  scanSkills(path.join(repo, '.agents', 'skills'), 'project-agents');
  scanSkills(path.join(home, '.claude', 'skills'), 'user');
  scanSkills(path.join(home, '.agents', 'skills'), 'user-agents');
  scanCommands(path.join(repo, '.claude', 'commands'), 'project-command');
  scanCommands(path.join(home, '.claude', 'commands'), 'user-command');

  // Plugins: only the ones installed for this user or for this very project, and only the ones the
  // settings still enable. A disabled plugin is installed-but-off, which is a third state, not zero.
  const installed = readJson(path.join(home, '.claude', 'plugins', 'installed_plugins.json'));
  let enabledMap = {};
  const settings = readJson(path.join(home, '.claude', 'settings.json'));
  // Only this one key is read. The rest of settings.json is none of the dashboard's business.
  if (settings && settings.enabledPlugins && typeof settings.enabledPlugins === 'object') enabledMap = settings.enabledPlugins;
  for (const [key, entries] of Object.entries((installed && installed.plugins) || {})) {
    const pluginName = key.split('@')[0];
    const enabled = enabledMap[key] !== false;
    for (const inst of entries || []) {
      if (inst.scope !== 'user' && path.resolve(String(inst.projectPath || '')) !== repo) continue;
      const base = inst.installPath;
      if (!base) continue;
      for (const e of ls(path.join(base, 'skills'))) {
        if (fs.existsSync(path.join(base, 'skills', e, 'SKILL.md'))) add(`${pluginName}:${e}`, 'plugin', path.join(base, 'skills', e), enabled);
      }
      for (const f of ls(path.join(base, 'commands')).filter((f) => f.endsWith('.md'))) {
        add(f.replace(/\.md$/, ''), 'plugin-command', path.join(base, 'commands', f), enabled);
      }
    }
  }
  // Role files are not skills, but the DISPATCH rule needs to know a role exists before it can say
  // the human is doing that role's dispatching by hand.
  const roles = ls(path.join(repo, '.claude', 'agents')).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
  return { skills: out, roles };
}

// A plugin skill is invoked as `plugin:skill` but installed under `skill`; a typed /name may be a
// command or a skill. Both are normalised to the bare name before the two sets are compared.
const bareName = (n) => String(n).replace(/^[^:]+:/, '').replace(/^\//, '');

function buildInventory(repo, hygiene) {
  const { skills, roles } = inventorySkills(repo);
  const usedCounts = new Map();
  for (const [name, n] of Object.entries(hygiene.skillCalls)) {
    usedCounts.set(bareName(name), { viaSkillTool: n, viaSlash: 0, raw: name });
  }
  for (const [name, n] of Object.entries(hygiene.slashCommands)) {
    const bare = bareName(name);
    const r = usedCounts.get(bare) || { viaSkillTool: 0, viaSlash: 0, raw: name };
    r.viaSlash += n;
    usedCounts.set(bare, r);
  }

  const installedByName = new Map();
  for (const sk of skills) {
    const bare = bareName(sk.name);
    if (!installedByName.has(bare)) installedByName.set(bare, []);
    installedByName.get(bare).push(sk);
  }

  const used = [...usedCounts.entries()].map(([name, r]) => ({
    name,
    viaSkillTool: r.viaSkillTool,
    viaSlash: r.viaSlash,
    sources: (installedByName.get(name) || []).map((sk) => sk.source),
  })).sort((a, b) => (b.viaSkillTool + b.viaSlash) - (a.viaSkillTool + a.viaSlash));

  const bySource = {};
  for (const sk of skills) bySource[sk.source] = (bySource[sk.source] || 0) + 1;

  const unusedIn = (sources) => skills.filter((sk) => sources.includes(sk.source) && !usedCounts.has(bareName(sk.name)))
    .map((sk) => sk.name).sort();
  const countIn = (sources) => skills.filter((sk) => sources.includes(sk.source)).length;
  const projectSources = ['project', 'project-agents', 'project-command'];
  const userSources = ['user', 'user-agents', 'user-command'];
  const projectUnused = unusedIn(projectSources);
  const userUnused = unusedIn(userSources);
  const projectCount = countIn(projectSources);
  const userCount = countIn(userSources);

  return {
    repo,
    roles,
    installed: skills.length,
    enabled: skills.filter((sk) => sk.enabled).length,
    bySource,
    used,
    // Invoked through the Skill tool but nowhere on disk: a workflow, or a skill removed after the
    // habit of calling it stayed. A typed /name that is not installed is almost always a built-in
    // (/model, /compact), so it is left in commands.typed rather than reported as a missing skill.
    usedNotInstalled: used.filter((u) => !u.sources.length && u.viaSkillTool > 0)
      .map((u) => u.name).sort(),
    installedNotUsed: { project: projectUnused, user: userUnused.slice(0, 20), userCount: userUnused.length },
    shelfRatio: {
      project: projectCount ? projectUnused.length / projectCount : 0,
      user: userCount ? userUnused.length / userCount : 0,
    },
    note: 'used = the Skill tool\'s own input.skill, plus every typed /name. A skill whose description auto-triggered without the Skill tool leaves no trace in a transcript and cannot be counted here.',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// REVIEWS — what Loop 6 proposed, and whether the human promoted it
// ─────────────────────────────────────────────────────────────────────────────

const CARD_TYPES = ['SKILL CANDIDATE', 'AGENTS.md RULE', 'DISPATCH', 'HABIT', 'LIFECYCLE'];

// The report format is a contract, not a style: these are the lines read back here. session-review.md
// says so at the point where it writes them.
function parseReviewCards(text) {
  const cards = [];
  for (const line of text.split('\n')) {
    const m = /^▸\s+\*\*([A-Za-z. ]+)\*\*\s+(.+?)\s*$/.exec(line.trim());
    if (!m) continue;
    const type = m[1].trim();
    if (!CARD_TYPES.includes(type)) continue;
    const body = m[2].trim();
    const count = Number((/×(\d+)/.exec(body) || [])[1]) || null;
    // The terms a promotion can be grepped for: what the card quoted, and any /name it named.
    const terms = [
      ...[...body.matchAll(/«([^»]{2,60})»/g)].map((x) => x[1]),
      ...[...body.matchAll(/(?:^|\s)\/([a-z][a-z0-9-]{2,30})/g)].map((x) => x[1]),
    ];
    cards.push({ type, text: body, count, terms });
  }
  return cards;
}

// The distinctive word of a quoted term — the one worth grepping a contract for. A whole sentence
// never matches; its rarest long word usually does.
function keyTerm(term) {
  const words = String(term).toLowerCase().match(/[\p{L}][\p{L}\p{N}-]{3,}/gu) || [];
  const stop = new Set(['pasa', 'esto', 'por', 'para', 'que', 'con', 'the', 'this', 'that', 'from', 'into', 'sesion', 'sesión', 'session', 'mis', 'mi', 'todo', 'toda', 'cada']);
  const useful = words.filter((w) => !stop.has(w));
  return (useful.sort((a, b) => b.length - a.length)[0] || words[0] || '').trim();
}

function grepContract(repo, term) {
  for (const file of ['AGENTS.md', 'CLAUDE.md']) {
    const abs = path.join(repo, file);
    if (!fs.existsSync(abs)) continue;
    let text = '';
    try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    const i = lines.findIndex((l) => l.toLowerCase().includes(term.toLowerCase()));
    if (i >= 0) return `${file}:${i + 1}`;
  }
  return null;
}

function parseReviews(repo, inventory) {
  const dir = path.join(repo, 'docs', 'harness-dev', 'loop-runs');
  if (!fs.existsSync(dir)) return null;
  const files = ls(dir).filter((f) => /session-review\.md$/.test(f)).sort().reverse();
  if (!files.length) return null;

  const history = [];
  let latest = null;
  for (const f of files) {
    let text = '';
    try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    const date = (/(\d{4}-\d{2}-\d{2})/.exec(f) || [])[1] || null;
    const cards = parseReviewCards(text).map((c) => {
      if (c.type === 'AGENTS.md RULE') {
        for (const term of c.terms) {
          const key = keyTerm(term);
          const hit = key ? grepContract(repo, key) : null;
          if (hit) return { ...c, state: 'promoted', evidence: hit };
        }
        return { ...c, state: 'pending', evidence: `no term of this card appears in AGENTS.md or CLAUDE.md` };
      }
      if (c.type === 'SKILL CANDIDATE') {
        const wanted = c.terms.map(keyTerm).filter(Boolean);
        const hit = (inventory ? inventory.used.concat(
          (inventory.installedNotUsed.project || []).concat(inventory.installedNotUsed.user || []).map((n) => ({ name: n })),
        ) : []).find((sk) => wanted.some((w) => bareName(sk.name).includes(w)));
        return hit
          ? { ...c, state: 'promoted', evidence: `a skill or command named ${hit.name} now exists` }
          : { ...c, state: 'pending', evidence: `nothing named ${wanted.join(' / ') || '(unnamed)'} is installed` };
      }
      // A dispatch criterion and a habit leave no artefact to grep for. Saying "pending" would be a
      // guess; saying n/a is the honest answer and keeps them out of the pending count.
      return { ...c, state: 'n/a', evidence: 'nothing on disk settles this card either way' };
    });
    const row = {
      file: path.join('docs', 'harness-dev', 'loop-runs', f),
      date,
      ageDays: date ? Math.round((Date.now() - Date.parse(`${date}T12:00:00Z`)) / 864e5) : null,
      cards,
      promoted: cards.filter((c) => c.state === 'promoted').length,
      pending: cards.filter((c) => c.state === 'pending').length,
    };
    if (!latest) latest = row;
    history.push({ date: row.date, cards: cards.length, promoted: row.promoted, pending: row.pending });
  }
  if (latest && !latest.cards.length) {
    // Present but with no card line parsed is not the same fact as "no review yet".
    return { latest: { ...latest, unreadable: 'no ▸ **TYPE** card line parsed' }, history };
  }
  return { latest, history };
}

function buildSignals(sessions, prompts, args) {
  const inWindow = (ts) => args.sinceMs === null || (Number.isFinite(Date.parse(ts)) && Date.parse(ts) >= args.sinceMs);

  // -- tools ------------------------------------------------------------------
  const byName = new Map();
  const subagents = new Map();
  let exitPlanMode = 0;
  const skillCalls = new Map();
  for (const ev of sessions) {
    for (const u of ev.toolUses) {
      if (!inWindow(u.ts)) continue;
      const r = byName.get(u.name) || { name: u.name, calls: 0, errors: 0 };
      r.calls++;
      byName.set(u.name, r);
      if (u.name === 'ExitPlanMode') exitPlanMode++;
      if (u.name === 'Skill' && u.input && u.input.skill) {
        skillCalls.set(String(u.input.skill), (skillCalls.get(String(u.input.skill)) || 0) + 1);
      }
      if ((u.name === 'Agent' || u.name === 'Task') && u.input && u.input.subagent_type) {
        const t = String(u.input.subagent_type);
        subagents.set(t, (subagents.get(t) || 0) + 1);
      }
    }
  }

  const clusters = new Map();
  const denials = [];
  const guardFires = new Map();
  let staleEdits = 0;
  let apiErrors = 0;
  let totalErrors = 0;
  for (const ev of sessions) {
    apiErrors += ev.apiErrors;
    for (const res of ev.toolResults) {
      if (!inWindow(res.ts) || !res.isError) continue;
      const text = String(res.text || '');
      const row = res.tool ? byName.get(res.tool) : null;
      if (row) row.errors++;
      totalErrors++;

      const fire = GUARD_FIRE.exec(text);
      // A blocked call is the guard working, not the tool failing: it is never a crash cluster.
      if (fire) { guardFires.set(fire[1], (guardFires.get(fire[1]) || 0) + 1); continue; }
      if (DENIAL.test(text)) {
        const m = DENIAL_REASON.exec(text);
        denials.push({
          ts: res.ts,
          sessionId: ev.sessionId,
          tool: res.tool || null,
          reason: m ? m[1].trim().replace(/\s+/g, ' ') || null : null,
        });
        continue;
      }
      if (STALE_EDIT.test(text)) staleEdits++;
      const sig = signature(text.split('\n').slice(0, 3).join(' '));
      if (!sig) continue;
      const c = clusters.get(sig) || {
        signature: sig, count: 0, tool: res.tool || null,
        sample: text.replace(/\s+/g, ' ').slice(0, 160),
        sessions: new Set(), firstAt: res.ts, lastAt: res.ts,
      };
      c.count++;
      c.sessions.add(ev.sessionId);
      if (String(res.ts) < String(c.firstAt)) c.firstAt = res.ts;
      if (String(res.ts) > String(c.lastAt)) c.lastAt = res.ts;
      clusters.set(sig, c);
    }
  }

  // -- guards and other hooks -------------------------------------------------
  const installed = pluginGuardNames();
  const hookRows = new Map();
  for (const ev of sessions) {
    for (const h of ev.hooks) {
      if (!inWindow(h.ts)) continue;
      const key = `${h.hookName} ${h.command || '(unnamed)'}`;
      const r = hookRows.get(key) || { hookName: h.hookName, command: h.command || '(unnamed)', runs: 0, nonZeroExit: 0, contextInjections: 0 };
      r.runs++;
      if (h.exitCode) r.nonZeroExit++;
      if (h.injected) r.contextInjections++;
      hookRows.set(key, r);
    }
  }

  // -- hygiene ----------------------------------------------------------------
  // The shape filter and the 60-second dedup are session-review.md section 2 and its "event count,
  // not record count" rule, moved into the script: both were applied by hand, and by hand they are
  // a judgment call the next run has to make again.
  let droppedAgentShaped = 0;
  let dedupedRecords = 0;
  const seen = new Map();
  const human = [];
  for (const pr of prompts) {
    if (looksAgentAuthored(pr.text)) { droppedAgentShaped++; continue; }
    const key = `${pr.sessionId} ${signature(pr.text)}`;
    const at = Date.parse(pr.ts);
    const prev = seen.get(key);
    if (prev !== undefined && Number.isFinite(at) && Math.abs(at - prev) <= 60000) { dedupedRecords++; continue; }
    seen.set(key, at);
    human.push(pr);
  }

  const continuations = human.filter((p) => CONTINUATION.test(p.text.trim()));
  const corrections = human.filter((p) => p.isFollowUp && CORRECTION.test(p.text.trim()));
  const interrupts = sessions.reduce((n, ev) => n + ev.interrupts.filter((i) => inWindow(i.ts)).length, 0);
  const compactions = sessions.flatMap((ev) => ev.compactions.filter((c) => inWindow(c.ts)));
  const slashCommands = new Map();
  const modelTargets = new Map();
  for (const ev of sessions) {
    for (const c of ev.commands) {
      if (!inWindow(c.ts)) continue;
      slashCommands.set(c.name, (slashCommands.get(c.name) || 0) + 1);
      if (c.name === '/model' && c.args) modelTargets.set(c.args, (modelTargets.get(c.args) || 0) + 1);
    }
  }
  const activeSessions = sessions.filter((ev) => ev.lastTs === null || inWindow(ev.lastTs)
    || ev.toolUses.some((u) => inWindow(u.ts)));
  const planSessions = activeSessions.filter((ev) => ev.planMode).length;
  const preTokens = compactions.map((c) => c.preTokens).filter((n) => n > 0);
  const sortMap = (m) => Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]));

  return {
    tools: {
      byName: [...byName.values()].sort((a, b) => b.calls - a.calls)
        .map((r) => ({ ...r, errorRate: r.calls ? r.errors / r.calls : 0 })),
      totalCalls: [...byName.values()].reduce((n, r) => n + r.calls, 0),
      totalErrors,
      errorClusters: [...clusters.values()].filter((c) => c.count > 1)
        .sort((a, b) => b.count - a.count).slice(0, 10)
        .map((c) => ({ ...c, sessions: c.sessions.size })),
      denials: { count: denials.length, reasons: denials.filter((d) => d.reason).slice(0, 10) },
      staleEdits,
      // Retried transport errors, not failed work: Claude Code retries these itself and the run
      // usually completes. Counted because a burst of them explains a slow session.
      apiErrors,
      subagents: { byType: sortMap(subagents), total: [...subagents.values()].reduce((n, x) => n + x, 0) },
      planMode: { exitPlanMode, sessionsWithPlanMode: planSessions },
    },
    guards: {
      pluginGuards: installed
        ? installed.map((name) => ({ name, fires: guardFires.get(name) || 0, advisory: name === 'repeat-tool-guard' }))
        : null,
      otherHooks: [...hookRows.values()].sort((a, b) => b.runs - a.runs).slice(0, 10),
      note: 'a fire is a tool_result beginning `harness-audit <guard>: blocked` - the same words inside a prompt are a mention, not a fire',
    },
    hygiene: {
      sessions: activeSessions.length,
      humanPrompts: human.length,
      droppedAgentShaped,
      dedupedRecords,
      continuations: {
        count: continuations.length,
        afterAgentTurn: continuations.filter((p) => p.isFollowUp).length,
        pattern: 'a whole turn that is only continua/sigue/dale/ok/go on',
      },
      corrections: {
        count: corrections.length,
        proxy: true,
        pattern: 'opens with no/espera/para/stop/wait and lands right after an agent turn',
        sample: corrections.slice(0, 5).map((p) => p.text.replace(/\s+/g, ' ').slice(0, 90)),
      },
      interrupts,
      compactions: {
        count: compactions.length,
        auto: compactions.filter((c) => c.trigger === 'auto').length,
        manual: compactions.filter((c) => c.trigger === 'manual').length,
        avgPreTokens: preTokens.length ? Math.round(preTokens.reduce((n, x) => n + x, 0) / preTokens.length) : 0,
      },
      modelSwitches: { count: slashCommands.get('/model') || 0, targets: sortMap(modelTargets) },
      slashCommands: sortMap(slashCommands),
      skillCalls: sortMap(skillCalls),
      planMode: { sessions: planSessions, of: activeSessions.length },
      caveats: [
        'continuations and corrections are user-role turns matched by shape; a loop re-prompting its own session writes the same shape, which is why the dropped count is printed',
        'a correction-shaped prompt is not proof the agent was wrong - tools.denials.reasons are the only explicit corrections here',
      ],
    },
  };
}

function aggregate(args) {
  const candidates = args.projectCandidates && args.projectCandidates.length ? args.projectCandidates : [args.project];
  const found = candidates.find((slug) => fs.existsSync(path.join(args.root, slug)));
  if (!found) {
    const available = ls(args.root).filter((d) => !d.startsWith('.')).slice(0, 8);
    throw new Error(`no telemetry under ${args.root} — tried: ${candidates.join(', ')}\navailable:\n  ${available.join('\n  ') || '(none)'}`);
  }
  args.project = found;
  const projectDir = path.join(args.root, found);

  const sessions = ls(projectDir).filter((f) => f.endsWith('.jsonl')).map((f) => f.replace(/\.jsonl$/, ''));
  let turns = [];
  let prompts = [];
  let workflows = [];
  const events = [];
  for (const id of sessions) {
    const s = parseSession(projectDir, id);
    turns = turns.concat(s.turns);
    prompts = prompts.concat(s.prompts);
    events.push(s.events);

    const sessionDir = path.join(projectDir, id);
    if (!fs.existsSync(sessionDir)) continue;
    turns = turns.concat(parseTaskAgents(sessionDir, s.taskLabels));
    const wf = parseWorkflows(sessionDir);
    turns = turns.concat(wf.turns);
    workflows = workflows.concat(wf.runs);
  }

  // Unparseable timestamps can't be windowed or bucketed — keeping them lands a bar under literal "undefined".
  turns = turns.filter((t) => {
    if (Number.isFinite(Date.parse(t.ts))) return true;
    warn(`turn with unparseable timestamp (${t.agentType}·${t.model}) — skipped`);
    return false;
  });

  const inWindow = (ts) => args.sinceMs === null || Date.parse(ts) >= args.sinceMs;
  turns = turns.filter((t) => inWindow(t.ts));
  prompts = prompts.filter((p) => inWindow(p.ts));
  workflows = workflows.filter((w) => inWindow(w.startedAt)).sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  const rows = new Map();
  const days = new Map();
  // The 5m/1h split is kept apart because the two write tiers bill at 1.25x and 2x: collapsing them
  // would let a renamed subkey reprice every 1h write as a 5m one without changing any visible total.
  const totals = { runs: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, tokens: 0, costUsd: 0 };
  const unpriced = new Set();
  const introPriced = new Set();
  for (const t of turns) {
    const model = baseModel(t.model);
    const key = `${t.agentType}·${model}`;
    const r = rows.get(key) || { agentType: t.agentType, model, runs: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, costUsd: 0, priced: true };
    const price = priceFor(model, t.ts);
    const c = costOf(price, t.usage);
    if (c === null) { r.priced = false; unpriced.add(model); }
    else if (price.isIntro) introPriced.add(`${model} ($${price.in}/$${price.out} thru ${price.until})`);
    r.runs++; r.in += t.usage.in; r.out += t.usage.out;
    r.cacheRead += t.usage.cacheRead; r.cacheWrite += t.usage.cw5 + t.usage.cw1;
    r.tokens += t.usage.tokens; r.costUsd += c || 0;
    rows.set(key, r);

    totals.runs++; totals.in += t.usage.in; totals.out += t.usage.out;
    totals.cacheRead += t.usage.cacheRead; totals.cacheWrite += t.usage.cw5 + t.usage.cw1;
    totals.cacheWrite5m += t.usage.cw5; totals.cacheWrite1h += t.usage.cw1;
    totals.tokens += t.usage.tokens; totals.costUsd += c || 0;

    const day = String(t.ts).slice(0, 10);
    days.set(day, (days.get(day) || 0) + t.usage.tokens);
  }

  const counts = new Map();
  for (const p of prompts) {
    const sig = signature(p.text);
    const c = counts.get(sig) || { count: 0, sample: p.text };
    c.count++;
    counts.set(sig, c);
  }
  const perDay = new Map();
  for (const p of prompts) {
    const day = String(p.ts).slice(0, 10);
    if (!perDay.has(day)) perDay.set(day, new Set());
    perDay.get(day).add(p.sessionId);
  }
  const words = prompts.reduce((n, p) => n + p.text.trim().split(/\s+/).length, 0);
  const promptStats = {
    total: prompts.length,
    avgWords: prompts.length ? words / prompts.length : 0,
    sessionsPerDay: perDay.size ? [...perDay.values()].reduce((n, s) => n + s.size, 0) / perDay.size : 0,
    followUpRate: prompts.length ? prompts.filter((p) => p.isFollowUp).length / prompts.length : 0,
    top: [...counts.values()].sort((a, b) => b.count - a.count).slice(0, args.top),
  };

  const repo = args.repo ? parseRepo(args.repo) : { loopRuns: [], learnings: [], savings: null };
  const agents = [...rows.values()].sort((a, b) => b.tokens - a.tokens);
  const signals = buildSignals(events, prompts, args);
  const inventoryRepo = args.repo || process.cwd();
  const skillsInventory = buildInventory(inventoryRepo, signals.hygiene);
  const reviews = parseReviews(inventoryRepo, skillsInventory);

  const data = {
    project: args.project,
    generatedAt: new Date().toISOString(),
    window: args.sinceMs ? new Date(args.sinceMs).toISOString() : 'all',
    agents,
    totals,
    unpricedModels: [...unpriced],
    introPricedModels: [...introPriced],
    timeline: [...days.entries()].sort().map(([date, tokens]) => ({ date, tokens })),
    workflows,
    loopRuns: repo.loopRuns,
    learnings: repo.learnings,
    savings: repo.savings,
    prompts: promptStats,
    tools: signals.tools,
    guards: signals.guards,
    hygiene: signals.hygiene,
    skills: skillsInventory,
    reviews,
    lineup: buildLineup(args, agents),
    warnings: warnings.length,
  };

  // Cards read the finished aggregate, so a rule can cross fields (a role in .claude/agents against
  // the subagents that ran, a pending review card against the skills on disk).
  const cards = evaluateCards(data);
  data.cards = cards.fired;
  data.rulesSilent = cards.silent;
  data.warnings = warnings.length;
  return data;
}

// D25/F11 — configured vs. observed, free from telemetry that already carries message.model per
// agent. This block is entirely optional: no model-lineup.json anywhere (global or project) means
// no LINEUP block, not an error — most projects running loop-stats have never set one up.
function buildLineup(args, agents) {
  let lineupMod;
  try { lineupMod = require('./model-lineup.js'); }
  catch (e) { warn(`model-lineup.js unavailable — skipping LINEUP block (${e.code || e.message})`); return null; }

  let lineup;
  try {
    if (args.lineup) {
      lineup = JSON.parse(fs.readFileSync(args.lineup, 'utf8'));
    } else {
      const globalPath = path.join(os.homedir(), '.agents', 'model-lineup.json');
      const projectPath = path.join(args.repo || process.cwd(), '.agents', 'model-lineup.json');
      const g = fs.existsSync(globalPath) ? JSON.parse(fs.readFileSync(globalPath, 'utf8')) : null;
      const p = fs.existsSync(projectPath) ? JSON.parse(fs.readFileSync(projectPath, 'utf8')) : null;
      if (!g && !p) return null;
      lineup = lineupMod.mergeLineups(g, p);
    }
  } catch (e) {
    warn(`model-lineup.json unreadable — skipping LINEUP block (${e.message})`);
    return null;
  }

  // The dashboard reads Claude Code's own transcripts — "configured" only makes sense against the
  // target this machine is actually running, which is always 'claude' here.
  const { resolved } = lineupMod.resolveLineup(lineup, 'claude');
  const rows = [];
  for (const role of lineupMod.ROLES) {
    const cfg = resolved[role];
    if (!cfg) continue;
    const candidates = role === 'critic'
      ? agents.filter((a) => /-critic$/.test(a.agentType))
      : agents.filter((a) => a.agentType === role);
    const observed = candidates.sort((a, b) => b.runs - a.runs)[0] || null;
    rows.push({
      role,
      configured: cfg.model,
      observedAgentType: observed ? observed.agentType : null,
      observedModel: observed ? observed.model : null,
      observedRuns: observed ? observed.runs : 0,
      drift: !!(observed && baseModel(observed.model) !== baseModel(cfg.model)),
    });
  }
  return rows.length ? rows : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDER-ANSI
// ─────────────────────────────────────────────────────────────────────────────

const W = 56;
const SPARK = '▁▂▃▄▅▆▇█';

const short = (m) => baseModel(m).replace(/^claude-/, '').split('-')[0];
const human = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const money = (n, priced) => (priced ? n.toFixed(2) : 'n/a');
const clip = (s, w) => (s.length > w ? `${s.slice(0, w - 1)}…` : s);
const row = (s) => `│${clip(s, W).padEnd(W)}│`;
const duration = (ms) => (ms >= 36e5 ? `${(ms / 36e5).toFixed(1)}h` : `${Math.round(ms / 6e4)}m`);

function sparkline(timeline) {
  const bars = timeline.slice(-14);
  if (!bars.length) return '';
  const max = Math.max(...bars.map((b) => b.tokens)) || 1;
  return bars.map((b) => SPARK[Math.max(0, Math.ceil((b.tokens / max) * 8) - 1)]).join('');
}

const signed = (n, digits = 1) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(digits)}`;

function renderSavings(s) {
  const out = [];
  if (!s) {
    out.push(row(' SAVINGS   no counterfactual in scope — pass --repo <path>'));
    return out;
  }
  out.push(row(' SAVINGS   measured only — no multipliers, no estimates'));

  if (s.ab.length) {
    // Every A/B run is printed, not a top-N: a two-armed run that measured nothing is the row this
    // block most needs on screen, and a cap would drop it under the ones that came out well.
    for (const a of s.ab) {
      const denom = a.scoreMax ? `/${a.scoreMax}` : '';
      out.push(row(`   A/B     ${clip(a.subject, 22).padEnd(22)}  Δscore ${signed(a.deltaScore)}${denom}`));
      out.push(row(a.deltaTokens === null
        ? `           Δtok n/a — ${a.tokensReason}`
        : `           Δtok ${signed(a.deltaTokens, 0)} (with-skill − without)`));
    }
  } else {
    out.push(row('   A/B     none — /skill-loop is the only two-armed loop'));
  }

  const p = s.predictions;
  out.push(row(!p
    ? '   PREDICT no process-log.md — /iterate has never run here'
    : p.unreadable
      ? `   PREDICT process-log.md present, ledger unreadable (${p.unreadable})`
      : `   PREDICT ${p.verified} verified · ${p.falsified} falsified · ${p.pending} pending`));
  // A row this parser could not read is shown, never dropped: dropping it reads as "0 falsified".
  if (p && p.unknown) out.push(row(`           ${p.unknown} unreadable — outcome in no known wording`));

  const g = s.roundsToGreen;
  out.push(row(g
    ? `   PROXY   rounds-to-green ${g.trend.join(' · ')} (proxy, not a saving)`
    : '   PROXY   rounds-to-green: no approved develop-phase run'));
  return out;
}

const pct = (x) => `${Math.round(x * 100)}%`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;

// The operator blocks. Each one prints the number and, where the number is a proxy, the word proxy
// next to it — an unlabelled proxy is the failure mode this whole file exists to avoid.
// Cards first, because they are the only part of this report that says what to do about it.
function renderCards(d) {
  const out = [];
  if (!d.cards) return out;
  if (!d.cards.length) {
    out.push(row(` CARDS     none — ${d.rulesSilent.length} rules checked, none found evidence`));
    return out;
  }
  out.push(row(` CARDS     ${d.cards.length} fired · ${d.rulesSilent.length} rules silent (no evidence)`));
  for (const c of d.cards.slice(0, 4)) {
    out.push(row(`   ${c.severity === 'warn' ? '▸' : '·'} ${clip(c.headline, 50)}`));
  }
  if (d.cards.length > 4) out.push(row(`   +${d.cards.length - 4} more — see the HTML report`));

  const r = d.reviews;
  out.push(row(r && r.latest
    ? `   REVIEW  ${r.latest.date} · ${r.latest.promoted} promoted · ${r.latest.pending} pending`
    : '   REVIEW  no /session-review has run in this repo yet'));

  if (d.skills) {
    const proj = d.skills.installedNotUsed.project.length;
    out.push(row(`   SKILLS  ${d.skills.installed} installed · ${d.skills.used.length} invoked · ${plural(proj, 'project skill')} unused`));
  }
  return out;
}

function renderSignals(d) {
  const out = [];
  const h = d.hygiene;
  const t = d.tools;
  if (!h || !t) return out;

  out.push(row(` HYGIENE   ${plural(h.humanPrompts, 'prompt')} · ${plural(h.sessions, 'session')} · ${h.droppedAgentShaped} agent-shaped dropped`));
  if (h.continuations.count) {
    out.push(row(`   ×${h.continuations.count} bare «continua» — ${h.continuations.afterAgentTurn}/${h.continuations.count} after an agent turn`));
  }
  const bits = [];
  if (h.interrupts) bits.push(plural(h.interrupts, 'interrupt'));
  if (h.compactions.count) bits.push(`${plural(h.compactions.count, 'compaction')} (${h.compactions.auto} auto)`);
  if (h.modelSwitches.count) bits.push(`${h.modelSwitches.count} /model`);
  if (bits.length) out.push(row(`   ${bits.join(' · ')}`));
  if (h.corrections.count) {
    out.push(row(`   ${plural(h.corrections.count, 'correction-shaped turn')} (proxy — see denials)`));
  }

  out.push(row(` TOOLS     ${t.totalCalls} calls · ${t.totalErrors} errors · ${t.denials.count} denied by you`));
  for (const r of t.byName.slice(0, 3)) {
    out.push(row(`   ${r.name.padEnd(16)} ${String(r.calls).padStart(5)}  ${r.errors ? `${r.errors} err (${pct(r.errorRate)})` : ''}`));
  }
  for (const c of t.errorClusters.slice(0, 2)) {
    out.push(row(`   ×${c.count} «${clip(c.sample, 34)}»`));
  }
  for (const dn of t.denials.reasons.slice(0, 1)) {
    out.push(row(`   denied «${clip(dn.reason, 38)}»`));
  }

  const g = d.guards;
  if (g && g.pluginGuards) {
    const fires = g.pluginGuards.reduce((n, x) => n + x.fires, 0);
    out.push(row(` GUARDS    ${g.pluginGuards.length} installed · ${plural(fires, 'fire')} in ${plural(h.sessions, 'session')}`));
    for (const x of g.pluginGuards.filter((x) => x.fires)) {
      out.push(row(`   ${x.name} ×${x.fires}`));
    }
  }
  for (const hk of (g ? g.otherHooks : []).slice(0, 2)) {
    out.push(row(`   hook ${clip(hk.command, 30).padEnd(30)} ×${hk.runs}${hk.nonZeroExit ? ` · ${hk.nonZeroExit} exit≠0` : ''}`));
  }
  return out;
}

function renderAnsi(d) {
  const out = [];
  const date = d.generatedAt.slice(0, 10);
  const head = `─ LOOP-STATS ▓ ${clip(d.project, 24)} `;
  const tail = ` ${date} ─`;
  out.push(`┌${head}${'─'.repeat(Math.max(1, W - head.length - tail.length))}${tail}┐`);

  const cols = (a, b, c, e, f, g) =>
    ` ${clip(a, 18).padEnd(18)}${b.padStart(5)}${c.padStart(8)}${e.padStart(7)}${f.padStart(9)}${g.padStart(8)}`;
  out.push(row(cols('AGENT', 'RUNS', 'IN', 'OUT', 'CACHE-R', 'est.$')));
  for (const a of d.agents.slice(0, 8)) {
    out.push(row(cols(`${a.agentType}·${short(a.model)}`, String(a.runs), human(a.in), human(a.out),
      human(a.cacheRead), money(a.costUsd, a.priced))));
  }
  const allPriced = d.unpricedModels.length === 0;
  out.push(row(cols('TOTAL', String(d.totals.runs), human(d.totals.in), human(d.totals.out),
    human(d.totals.cacheRead), money(d.totals.costUsd, true) + (allPriced ? '' : '*'))));

  if (d.lineup) {
    const lnCols = (a, b, c) => ` ${clip(a, 12).padEnd(12)}${b.padStart(19)}${c.padStart(19)}`;
    out.push(row(lnCols('LINEUP', 'CONFIGURED', 'OBSERVED')));
    for (const r of d.lineup) {
      const obs = r.observedModel ? `${short(r.observedModel)}${r.drift ? ' ⚠' : ''}` : '—';
      out.push(row(lnCols(r.role, short(r.configured), obs)));
    }
    const drifted = d.lineup.filter((r) => r.drift);
    if (drifted.length) {
      out.push(row(` DRIFT     ${drifted.map((r) => `${r.role}: cfg ${short(r.configured)}, ran ${short(r.observedModel)}`).join(' · ')}`));
    }
  }

  const byName = new Map();
  for (const w of d.workflows) byName.set(w.name, (byName.get(w.name) || 0) + 1);
  const activity = [...byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([n, c]) => `${n} ×${c}`).join(' · ') || 'no workflow runs';
  out.push(row(` ACTIVITY  ${sparkline(d.timeline)}  ${activity}`));

  const last = d.workflows[0];
  const lastName = last && last.name !== last.runId ? ` ${clip(last.name, 16)}` : '';
  out.push(row(last
    ? ` LAST RUN  ${last.runId.slice(0, 9)}${lastName} · ${last.rounds ? `${last.rounds} rd · ` : ''}${last.verdict || last.state || 'in flight'}`
    : ' LAST RUN  none in window'));

  if (d.workflows.length) {
    const wfCols = (a, b, c, e, f, g) =>
      ` ${clip(a, 20).padEnd(20)}${b.padStart(6)}${c.padStart(6)}${e.padStart(3)}${f.padStart(9)}${g.padStart(11)}`;
    out.push(row(wfCols('WORKFLOW', 'WHEN', 'DUR', 'RD', 'TOKENS', 'VERDICT')));
    for (const w of d.workflows.slice(0, 5)) {
      out.push(row(wfCols(w.name, w.startedAt.slice(5, 10), duration(w.durationMs),
        w.rounds ? String(w.rounds) : '—', human(w.tokens), w.verdict || w.state || '—')));
    }
  }

  for (const r of d.loopRuns.slice(0, 2)) {
    out.push(row(` LOOP-RUN  ${r.date || '?'} ${clip(r.loop, 14)} · ${r.rounds || '?'} rd · ${r.verdict || '?'}`));
  }

  if (d.learnings.length) {
    const skills = [...new Set(d.learnings.map((l) => l.skill))].join(', ');
    out.push(row(` LEARNINGS +${d.learnings.length} · ${skills}`));
  } else {
    out.push(row(' LEARNINGS none · pass --repo to scan LEARNINGS.md'));
  }
  for (const w of d.workflows.slice(0, 2)) {
    if (w.resultLine) out.push(row(`   ${w.runId} · ${w.resultLine}`));
  }

  out.push(...renderSavings(d.savings));

  const p = d.prompts;
  out.push(...renderCards(d));
  out.push(...renderSignals(d));
  out.push(row(` PROMPTS   ${p.total} user turns · ${p.avgWords.toFixed(1)} words avg · ${p.sessionsPerDay.toFixed(1)} sess/day`));
  out.push(row(`           ${Math.round(p.followUpRate * 100)}% follow-ups (proxy: turn after agent turn)`));
  for (const t of p.top.slice(0, 2)) {
    out.push(row(`   ×${t.count} «${t.sample.replace(/\s+/g, ' ')}»`));
  }

  out.push(`└── v2 · measured counterfactuals only · no multipliers ─┘`);
  if (!allPriced) out.push(`  * est.$ excludes unpriced models: ${d.unpricedModels.join(', ')}`);
  if (d.introPricedModels.length) out.push(`  * priced at introductory rate: ${d.introPricedModels.join(', ')}`);
  return out.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDER-HTML — one self-contained file: no CDN, no webfont, no script, no fetch.
// ─────────────────────────────────────────────────────────────────────────────

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function renderHtml(d) {
  const agentRows = d.agents.map((a) => `<tr>
      <td class="k">${esc(a.agentType)}<span class="dim">·${esc(a.model)}</span></td>
      <td>${a.runs}</td><td>${human(a.in)}</td><td>${human(a.out)}</td>
      <td>${human(a.cacheRead)}</td><td>${human(a.cacheWrite)}</td>
      <td class="${a.priced ? '' : 'dim'}">${money(a.costUsd, a.priced)}</td></tr>`).join('');

  const max = Math.max(1, ...d.timeline.map((t) => t.tokens));
  const bars = d.timeline.slice(-30).map((t) => `<div class="bar" style="height:${Math.max(2, Math.round((t.tokens / max) * 100))}%">
      <span>${esc(t.date.slice(5))} · ${human(t.tokens)}</span></div>`).join('');

  const wfRows = d.workflows.slice(0, 12).map((w) => `<tr>
      <td class="k">${esc(w.runId)}</td><td>${esc(w.name)}</td>
      <td>${esc(w.startedAt.slice(0, 16).replace('T', ' '))}</td>
      <td>${duration(w.durationMs)}</td><td>${w.rounds || '—'}</td>
      <td>${human(w.tokens)}</td><td class="${w.verdict ? '' : 'dim'}">${esc(w.verdict || w.state || '—')}</td>
      <td class="dim">${esc(clip(w.resultLine || '', 60))}</td></tr>`).join('');

  const loopRows = d.loopRuns.slice(0, 10).map((r) => `<tr><td class="k">${esc(r.date || '?')}</td>
      <td>${esc(r.loop)}</td><td>${r.rounds || '—'}</td><td>${esc(r.verdict || '—')}</td>
      <td class="dim">${esc(r.stoppedBy || '')}</td></tr>`).join('');

  const lineupRows = (d.lineup || []).map((r) => `<tr><td class="k">${esc(r.role)}</td>
      <td>${esc(short(r.configured))}</td>
      <td class="${r.drift ? '' : 'dim'}">${r.observedModel ? esc(short(r.observedModel)) : '—'}${r.drift ? ' ⚠' : ''}</td>
      <td class="dim">${r.observedRuns}</td></tr>`).join('');

  const s = d.savings;
  const abRows = (s && s.ab.length ? s.ab : []).map((a) => `<tr><td class="k">${esc(a.subject)}</td>
      <td>${a.rounds}</td><td>${signed(a.deltaScore)}${a.scoreMax ? `/${a.scoreMax}` : ''}</td>
      <td class="${a.deltaTokens === null ? 'dim' : ''}">${a.deltaTokens === null ? 'n/a' : signed(a.deltaTokens, 0)}</td>
      <td class="dim">${esc(a.tokensReason || 'per-arm tokens recorded (v2)')}</td></tr>`).join('');

  const predRows = (s && s.predictions ? s.predictions.rows : []).map((r) => `<tr><td class="k">${esc(r.version)}</td>
      <td>${esc(r.date)}</td><td class="dim">${esc(r.change)}</td>
      <td class="dim">${esc(clip(r.prediction, 70))}</td><td>${esc(r.outcome)}</td></tr>`).join('');

  const savingsBody = s ? `${abRows ? `<div class="scroll"><table>
    <thead><tr><th>A/B run</th><th>rounds</th><th>Δ score</th><th>Δ tokens</th><th>note</th></tr></thead>
    <tbody>${abRows}</tbody></table></div>` : '<p class="sub">No two-armed run in scope — /skill-loop is the only loop that produces one.</p>'}
    <p class="sub">${!s.predictions
    ? 'No process-log.md — /iterate has never run in this repo.'
    : s.predictions.unreadable
      ? `process-log.md is present but its ledger is unreadable (${esc(String(s.predictions.unreadable))}) — <b>no prediction counted</b>, and that is not the same as none falsified.`
      : `Optimizer predictions (process-log.md ledger): <b>${s.predictions.verified} verified · ${s.predictions.falsified} falsified · ${s.predictions.pending} pending · ${s.predictions.unknown} unreadable</b>`}<br>
    ${s.roundsToGreen ? `Rounds-to-green: ${s.roundsToGreen.trend.join(' · ')} — <b>proxy, explicitly not a saving</b>: nobody measured what those rounds would have cost without the loop.` : 'Rounds-to-green: no approved develop-phase run in scope.'}<br>
    Δ score and Δ tokens compare the two arms of an A/B that both ran. Nothing here is a multiplier, and
    an unmeasured quantity is printed n/a with its reason — never estimated.</p>` : '<p class="sub">No counterfactual in scope — pass --repo &lt;path&gt; to read loop-runs and process-log.md.</p>';

  const learnRows = d.learnings.slice(0, 10).map((l) => `<tr><td class="k">${esc(l.date)}</td>
      <td>${esc(l.skill)}</td><td class="dim">${esc(l.entry)}</td></tr>`).join('');

  const topRows = d.prompts.top.map((t) => `<tr><td class="k">×${t.count}</td>
      <td class="dim">«${esc(t.sample.replace(/\s+/g, ' ').slice(0, 90))}»</td></tr>`).join('');

  const section = (title, body) => (body ? `<h2>${title}</h2>${body}` : '');
  const sectionSub = (title, sub, body) => (body ? `<h2>${title}<span class="n">${sub}</span></h2>${body}` : '');
  const tile = (label, value, small, detail, hot) => `<div class="tile${hot ? ' hot' : ''}">
      <div class="l">${label}</div><div class="v">${value}${small ? `<small>${small}</small>` : ''}</div>
      ${detail ? `<div class="d">${detail}</div>` : ''}</div>`;

  const h = d.hygiene;
  const t = d.tools;
  const g = d.guards;

  const pill = (cls, label) => `<span class="pill ${cls}">${esc(label)}</span>`;
  const cardsBody = !d.cards ? '' : `${d.cards.length ? `<div class="cards">${d.cards.map((c) => `
    <div class="card${c.severity === 'warn' ? ' warn' : ''}">
      <div class="top">${pill(c.type === 'LIFECYCLE' ? 'life' : 'type', c.type)}${pill(c.severity, c.severity)}<span class="rid">${esc(c.rule)}</span></div>
      <h3>${esc(c.headline)}</h3>
      <div class="ev">${esc(c.evidence)}</div>
      <div class="rec">${esc(c.recommendation)}</div>
      <div class="not">${esc(c.doesNotProve)}</div>
      <span class="src">${esc(c.source)}</span>
    </div>`).join('')}</div>` : '<p class="sub">No rule found evidence in this window. Nothing is printed rather than something reassuring.</p>'}
    <p class="sub">${d.rulesSilent.length} rule(s) checked and silent: ${esc(d.rulesSilent.join(', '))}.
    A rule with no evidence prints nothing — padding a report to fill the grid is how an instrument becomes a horoscope.
    Every card proposes; none of them edits anything.</p>`;

  const rv = d.reviews;
  const stateClass = { promoted: 'ok', pending: 'pend', 'n/a': 'na' };
  const reviewRows = !rv || !rv.latest ? '' : rv.latest.cards.map((c) => `<tr>
      <td class="k">${pill('type', c.type)}</td>
      <td class="k wrap">${esc(clip(c.text, 120))}</td>
      <td>${c.count || '—'}</td>
      <td class="k">${pill(stateClass[c.state] || 'na', c.state)}</td>
      <td class="k dim wrap">${esc(clip(c.evidence, 80))}</td></tr>`).join('');
  const reviewBody = !rv || !rv.latest ? `<p class="sub">No <code>*-session-review.md</code> in <code>docs/harness-dev/loop-runs/</code>${d.skills ? ` under ${esc(d.skills.repo)}` : ''} — Loop 6 has never run here, so nothing above has ever been promoted or rejected on the record.</p>`
    : `<div class="life">
      <div class="lifebox">
        <div class="l">latest run</div>
        <div class="big">${esc(rv.latest.date || 'undated')} <small>· ${rv.latest.ageDays} days ago</small></div>
        <div class="trail">
          <span class="step"><b>${rv.latest.cards.length}</b> proposed</span><span class="arrow">→</span>
          <span class="step"><b>${rv.latest.promoted}</b> promoted</span><span class="arrow">→</span>
          <span class="step"><b>${rv.latest.pending}</b> pending</span><span class="arrow">→</span>
          <span class="step"><b>${rv.latest.cards.length - rv.latest.promoted - rv.latest.pending}</b> n/a</span>
        </div>
        <p class="sub" style="margin-top:.8rem">${rv.latest.unreadable
    ? `The report is present but ${esc(rv.latest.unreadable)} — which is not the same fact as "no review yet".`
    : 'Promotion is checked by grepping this repo\'s contract and skills for what each card quoted. A DISPATCH or HABIT card leaves no artefact to grep, so it reads n/a rather than pending.'}</p>
        <p class="sub">${esc(rv.latest.file)}</p>
      </div>
      <div class="scroll"><table>
        <thead><tr><th class="k">type</th><th class="k">card, verbatim</th><th>×</th><th class="k">state</th><th class="k">evidence</th></tr></thead>
        <tbody>${reviewRows}</tbody></table></div>
    </div>`;

  const sk = d.skills;
  const usedRows = !sk ? '' : sk.used.slice(0, 20).map((u) => `<tr><td class="k">${esc(u.name)}</td>
      <td>${u.viaSkillTool || '—'}</td><td>${u.viaSlash || '—'}</td>
      <td class="k dim">${esc(u.sources.join(', ') || 'not installed here')}</td></tr>`).join('');
  const skillsBody = !sk ? '' : `<div class="cols">
    <div><div class="scroll"><table>
      <thead><tr><th class="k">invoked</th><th>Skill tool</th><th>typed</th><th class="k">installed as</th></tr></thead>
      <tbody>${usedRows}</tbody></table></div></div>
    <div>
      <p class="sub">${sk.installed} installed for this project and user${sk.enabled !== sk.installed ? ` (${sk.installed - sk.enabled} disabled)` : ''} ·
      ${Object.entries(sk.bySource).map(([k, v]) => `${esc(k)} ${v}`).join(' · ') || 'none found'}</p>
      ${sk.installedNotUsed.project.length ? `<p class="sub"><b>Project skills never invoked in this window (${sk.installedNotUsed.project.length}):</b><br>
        <span class="chips">${sk.installedNotUsed.project.slice(0, 24).map((n) => `<span class="chip">${esc(n)}</span>`).join('')}</span></p>` : ''}
      ${sk.installedNotUsed.userCount ? `<p class="sub">${sk.installedNotUsed.userCount} user-level skill(s) also went uninvoked.</p>` : ''}
      ${sk.usedNotInstalled.length ? `<p class="sub">Invoked through the Skill tool but not installed here: ${esc(sk.usedNotInstalled.join(', '))}.</p>` : ''}
      <p class="sub">${esc(sk.note)}</p>
    </div>
  </div>`;

  const hygieneBody = !h ? '' : `<div class="tiles">
    ${tile('continuations', h.continuations.count, `${h.continuations.afterAgentTurn}/${h.continuations.count || 0} after agent`, esc(h.continuations.pattern), h.continuations.count >= 5)}
    ${tile('interrupts', h.interrupts, h.humanPrompts ? pct(h.interrupts / h.humanPrompts) : '', 'the human stopped a turn mid-flight', h.interrupts >= 10)}
    ${tile('/model switches', h.modelSwitches.count, '', esc(Object.entries(h.modelSwitches.targets).map(([k, v]) => `${k} ×${v}`).join(' · ')) || 'no target recorded', h.modelSwitches.count >= 5)}
    ${tile('compactions', h.compactions.count, `${h.compactions.auto} auto · ${h.compactions.manual} manual`, h.compactions.avgPreTokens ? `avg ${human(h.compactions.avgPreTokens)} tokens before the cut` : '', h.compactions.auto >= 3)}
    ${tile('corrections <span class="proxy">proxy</span>', h.corrections.count, h.humanPrompts ? pct(h.corrections.count / h.humanPrompts) : '', esc(h.corrections.pattern))}
    ${tile('plan mode', h.planMode.sessions, `of ${h.planMode.of} sessions`, `ExitPlanMode ×${t ? t.planMode.exitPlanMode : 0}`)}
    </div>
    ${h.corrections.sample.length ? `<p class="sub">Correction-shaped, verbatim: ${h.corrections.sample.map((x) => `«${esc(clip(x, 70))}»`).join(' · ')}</p>` : ''}
    <p class="sub">${h.humanPrompts} human prompts over ${h.sessions} sessions · ${h.droppedAgentShaped} agent-shaped turns dropped · ${h.dedupedRecords} duplicate records collapsed.<br>
    ${h.caveats.map(esc).join('<br>')}</p>`;

  const toolRows = !t ? '' : t.byName.slice(0, 12).map((r) => `<tr><td class="k">${esc(r.name)}</td>
      <td>${r.calls}</td><td class="${r.errors ? '' : 'dim'}">${r.errors || '—'}</td>
      <td class="dim">${r.errors ? pct(r.errorRate) : ''}</td></tr>`).join('');
  const clusterRows = !t ? '' : t.errorClusters.map((c) => `<tr>
      <td class="k wrap">${esc(clip(c.sample, 110))}</td><td>${c.count}</td><td>${c.sessions}</td>
      <td class="k dim">${esc(String(c.lastAt).slice(5, 10))}</td></tr>`).join('');
  const denialRows = !t ? '' : t.denials.reasons.map((r) => `<tr>
      <td class="k wrap">«${esc(clip(r.reason, 120))}»</td><td class="k dim">${esc(r.tool || '—')}</td></tr>`).join('');

  const toolsBody = !t ? '' : `<div class="cols">
    <div><div class="scroll"><table>
      <thead><tr><th class="k">tool</th><th>calls</th><th>errors</th><th>rate</th></tr></thead>
      <tbody>${toolRows}</tbody></table></div>
      <p class="sub">Subagents spawned: ${esc(Object.entries(t.subagents.byType).map(([k, v]) => `${k} ×${v}`).join(' · ')) || 'none'}.
      ${t.staleEdits ? `${t.staleEdits} edit(s) hit a file that changed since it was read. ` : ''}
      ${t.apiErrors ? `${t.apiErrors} transport error(s) were retried by the client — slow, not failed.` : ''}</p></div>
    <div>${clusterRows ? `<div class="scroll"><table>
      <thead><tr><th class="k">repeated failure</th><th>×</th><th>sess.</th><th class="k">last</th></tr></thead>
      <tbody>${clusterRows}</tbody></table></div>` : '<p class="sub">No failure repeated inside this window.</p>'}
      ${denialRows ? `<div class="scroll"><table style="margin-top:1rem">
      <thead><tr><th class="k">you refused the call, and said why</th><th class="k">tool</th></tr></thead>
      <tbody>${denialRows}</tbody></table></div>
      <p class="sub">${t.denials.count} call(s) refused. These reasons are the only explicit corrections in this file — everything else about your prompting is a proxy.</p>`
    : '<p class="sub">No tool call refused with a typed reason in this window.</p>'}</div>
  </div>`;

  const guardRows = !g || !g.pluginGuards ? '' : g.pluginGuards.map((x) => `<tr>
      <td class="k">${esc(x.name)}${x.advisory ? ' <span class="dim">(advisory)</span>' : ''}</td>
      <td class="${x.fires ? '' : 'dim'}">${x.fires}</td></tr>`).join('');
  const hookRows = !g ? '' : g.otherHooks.map((hk) => `<tr><td class="k">${esc(hk.hookName)}</td>
      <td class="k dim">${esc(clip(hk.command, 46))}</td><td>${hk.runs}</td>
      <td class="${hk.nonZeroExit ? '' : 'dim'}">${hk.nonZeroExit}</td><td class="dim">${hk.contextInjections}</td></tr>`).join('');
  const guardsBody = !g ? '' : `<div class="cols">
    <div>${guardRows ? `<div class="scroll"><table>
      <thead><tr><th class="k">guard installed by this plugin</th><th>fires</th></tr></thead>
      <tbody>${guardRows}</tbody></table></div>` : '<p class="sub">hooks.json is not readable from here, so no guard list is shown — an empty list would read as "none installed".</p>'}
      <p class="sub">${esc(g.note)} Zero fires does not mean nothing dangerous happened; these guards are conservative by design.</p></div>
    <div>${hookRows ? `<div class="scroll"><table>
      <thead><tr><th class="k">other PreToolUse hook</th><th class="k">command</th><th>runs</th><th>exit≠0</th><th>injected</th></tr></thead>
      <tbody>${hookRows}</tbody></table></div>` : '<p class="sub">No other PreToolUse hook ran in this window.</p>'}</div>
  </div>`;


  return `<title>loop-stats · ${esc(d.project)}</title>
<style>
  :root { --p:#33ff66; --dim:#1f8f45; --bg:#050805; --warn:#f5c542; --warn-dim:#8a6d1c; }
  * { box-sizing:border-box; }
  body { margin:0; padding:2rem 1rem; background:var(--bg); color:var(--p);
    font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"DejaVu Sans Mono",monospace;
    font-size:14px; line-height:1.5; text-shadow:0 0 6px rgba(51,255,102,.45); }
  body::before { content:""; position:fixed; inset:0; pointer-events:none; z-index:2;
    background:repeating-linear-gradient(180deg,rgba(0,0,0,0) 0 2px,rgba(0,0,0,.28) 2px 4px); }
  body::after { content:""; position:fixed; inset:0; pointer-events:none; z-index:1;
    background:radial-gradient(ellipse at center,rgba(51,255,102,.07),transparent 70%); }
  main { max-width:960px; margin:0 auto; border:1px solid var(--dim); padding:1.5rem;
    box-shadow:0 0 40px rgba(51,255,102,.12) inset; }
  h1 { font-size:1.1rem; margin:0 0 .25rem; letter-spacing:.18em; }
  h2 { font-size:.8rem; margin:2rem 0 .5rem; letter-spacing:.22em; color:var(--dim); text-transform:uppercase; }
  .sub { color:var(--dim); margin:0 0 1rem; font-size:.78rem; }
  .scroll { overflow-x:auto; }
  table { width:100%; border-collapse:collapse; white-space:nowrap; }
  th,td { text-align:right; padding:.3rem .6rem; border-bottom:1px solid rgba(31,143,69,.35); }
  th:first-child,td:first-child,td.k { text-align:left; }
  th { color:var(--dim); font-weight:400; font-size:.72rem; letter-spacing:.12em; }
  tr:last-child td { border-bottom:none; }
  tfoot td { border-top:1px solid var(--dim); border-bottom:none; font-weight:700; }
  .dim { color:var(--dim); }
  td.wrap, .wrap { white-space:normal; }
  h2 .n { color:var(--p); letter-spacing:0; text-transform:none; font-size:.74rem; margin-left:.75rem; }
  .cols { display:grid; grid-template-columns:1fr 1fr; gap:1.5rem; align-items:start; }
  @media (max-width:820px) { .cols { grid-template-columns:1fr; } }
  .tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:.6rem; }
  .tile { border:1px solid var(--dim); padding:.65rem .8rem; }
  .tile .l { font-size:.66rem; letter-spacing:.14em; color:var(--dim); text-transform:uppercase; }
  .tile .v { font-size:1.5rem; font-weight:500; line-height:1.15; margin-top:.2rem; }
  .tile .v small { font-size:.72rem; color:var(--dim); font-weight:400; margin-left:.3rem; }
  .tile .d { font-size:.72rem; color:var(--dim); margin-top:.15rem; }
  .tile.hot .v { color:var(--warn); }
  .cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(330px,1fr)); gap:.75rem; }
  .card { border:1px solid var(--dim); padding:.8rem .95rem 1.4rem; display:flex; flex-direction:column; gap:.45rem; position:relative; }
  .card.warn { border-color:var(--warn-dim); }
  .card .top { display:flex; align-items:center; gap:.5rem; }
  .card .rid { color:var(--dim); margin-left:auto; font-size:.66rem; }
  .card h3 { margin:0; font-size:.98rem; font-weight:500; line-height:1.35; text-wrap:balance; }
  .card .ev { font-size:.78rem; border-left:2px solid var(--dim); padding-left:.6rem; word-break:break-word; }
  .card .rec { font-size:.78rem; }
  .card .rec::before { content:"→ "; color:var(--dim); }
  .card .not { font-size:.72rem; color:var(--dim); margin-top:auto; padding-top:.4rem; border-top:1px dashed var(--dim); }
  .card .not::before { content:"does not prove · "; letter-spacing:.08em; text-transform:uppercase; font-size:.62rem; }
  .card .src { position:absolute; right:.95rem; bottom:.5rem; font-size:.62rem; color:var(--dim); letter-spacing:.06em; }
  .pill { display:inline-block; padding:.05rem .45rem; border:1px solid currentColor; font-size:.64rem;
    letter-spacing:.12em; text-transform:uppercase; text-shadow:none; line-height:1.5; }
  .pill.type { color:var(--p); } .pill.info { color:var(--dim); }
  .pill.warn, .pill.life, .pill.pend { color:var(--warn); }
  .pill.ok { color:var(--p); background:rgba(51,255,102,.08); }
  .pill.na { color:var(--dim); border-style:dashed; }
  .life { display:grid; grid-template-columns:1fr 1.6fr; gap:1.25rem; align-items:start; }
  @media (max-width:820px) { .life { grid-template-columns:1fr; } }
  .lifebox { border:1px solid var(--dim); padding:.8rem .95rem; }
  .lifebox .l { font-size:.66rem; letter-spacing:.14em; color:var(--dim); text-transform:uppercase; }
  .lifebox .big { font-size:1.4rem; font-weight:500; line-height:1.2; }
  .lifebox .big small { font-size:.75rem; color:var(--dim); font-weight:400; }
  .trail { display:flex; gap:.5rem; align-items:center; margin-top:.7rem; font-size:.74rem; color:var(--dim); flex-wrap:wrap; }
  .trail .step { border:1px solid var(--dim); padding:.2rem .55rem; }
  .trail .step b { color:var(--p); font-weight:500; }
  .chips { display:inline-flex; flex-wrap:wrap; gap:.35rem; margin-top:.4rem; }
  .chip { border:1px solid var(--dim); padding:.05rem .5rem; font-size:.7rem; color:var(--dim); }
  .proxy { font-size:.6rem; color:var(--warn-dim); border:1px dashed var(--warn-dim); padding:0 .35rem; letter-spacing:.1em; text-shadow:none; }
  .fold { color:var(--dim); font-size:.74rem; text-align:center; margin:2.5rem 0 0; letter-spacing:.14em; }
  .fold::before, .fold::after { content:" ▓▒░ "; color:var(--dim); }
  .chart { display:flex; align-items:flex-end; gap:3px; height:110px; margin-top:.5rem; }
  .bar { flex:1; background:linear-gradient(180deg,var(--p),var(--dim)); position:relative; min-width:6px; }
  .bar span { position:absolute; bottom:100%; left:50%; transform:translateX(-50%);
    font-size:.6rem; color:var(--dim); opacity:0; white-space:nowrap; }
  .bar:hover span { opacity:1; }
  footer { margin-top:2rem; padding-top:.75rem; border-top:1px solid var(--dim);
    color:var(--dim); font-size:.72rem; }
</style>
<main>
  <h1>LOOP-STATS ▓ ${esc(d.project)}</h1>
  <p class="sub">${esc(d.generatedAt.slice(0, 16).replace('T', ' '))} · window: ${esc(d.window)} · ${d.totals.runs} agent runs · ${human(d.totals.tokens)} tokens${d.warnings ? ` · ${d.warnings} parse warnings` : ''}</p>

  ${sectionSub('Cards', 'rule-based · zero tokens · each one carries its evidence and its limits', cardsBody)}
  ${sectionSub('Session-review lifecycle', 'what Loop 6 proposed, and where it went', reviewBody)}
  ${sectionSub('Session hygiene', 'how the driving went — every proxy says so', hygieneBody)}
  ${sectionSub('Tools &amp; failures', t ? `${t.totalCalls} calls · ${t.totalErrors} errors · ${t.denials.count} refused` : '', toolsBody)}
  ${sectionSub('Guards &amp; hooks', 'what blocked a call, and what merely ran', guardsBody)}
  ${sectionSub('Skills &amp; commands', 'installed against invoked', skillsBody)}

  <p class="fold">accounting</p>

  <h2>Tokens by agent × model</h2>
  <div class="scroll"><table>
    <thead><tr><th>agent</th><th>runs</th><th>in</th><th>out</th><th>cache-r</th><th>cache-w</th><th>est.$</th></tr></thead>
    <tbody>${agentRows}</tbody>
    <tfoot><tr><td class="k">TOTAL</td><td>${d.totals.runs}</td><td>${human(d.totals.in)}</td>
      <td>${human(d.totals.out)}</td><td>${human(d.totals.cacheRead)}</td>
      <td>${human(d.totals.cacheWrite)}</td><td>${d.totals.costUsd.toFixed(2)}</td></tr></tfoot>
  </table></div>
  ${d.unpricedModels.length ? `<p class="sub">est.$ excludes unpriced models: ${esc(d.unpricedModels.join(', '))}</p>` : ''}
  ${d.introPricedModels.length ? `<p class="sub">priced at introductory rate: ${esc(d.introPricedModels.join(', '))}</p>` : ''}

  ${section('Model line-up — configured vs. observed', lineupRows ? `<div class="scroll"><table>
    <thead><tr><th>role</th><th>configured</th><th>observed</th><th>runs</th></tr></thead>
    <tbody>${lineupRows}</tbody></table></div>
    <p class="sub">⚠ = drift: the role ran on a different model family than model-lineup.json configures.</p>` : '')}

  <h2>Tokens per day</h2>
  <div class="chart">${bars}</div>

  ${section('Workflow activations', wfRows ? `<div class="scroll"><table>
    <thead><tr><th>run</th><th>workflow</th><th>started</th><th>duration</th><th>rounds</th><th>tokens</th><th>verdict</th><th>result</th></tr></thead>
    <tbody>${wfRows}</tbody></table></div>` : '')}

  ${section('Loop runs (findings JSON)', loopRows ? `<div class="scroll"><table>
    <thead><tr><th>date</th><th>loop</th><th>rounds</th><th>verdict</th><th>stopped by</th></tr></thead>
    <tbody>${loopRows}</tbody></table></div>` : '')}

  <h2>Savings — measured counterfactuals only</h2>
  ${savingsBody}
  ${section('Optimizer predictions', predRows ? `<div class="scroll"><table>
    <thead><tr><th>v</th><th>date</th><th>change</th><th>prediction</th><th>outcome</th></tr></thead>
    <tbody>${predRows}</tbody></table></div>` : '')}

  ${section('Learnings', learnRows ? `<div class="scroll"><table>
    <thead><tr><th>date</th><th>skill</th><th>entry</th></tr></thead>
    <tbody>${learnRows}</tbody></table></div>` : '')}

  <h2>Prompts</h2>
  <p class="sub">${d.prompts.total} user turns · ${d.prompts.avgWords.toFixed(1)} words avg ·
    ${d.prompts.sessionsPerDay.toFixed(1)} sessions/day ·
    ${Math.round(d.prompts.followUpRate * 100)}% follow-ups (proxy: a turn landing right after the agent ended its own)<br>
    Counts every user-role turn in the transcript. A slash command or a loop that re-prompts its session
    writes one too, and nothing in the format marks it apart from a keystroke — so these are turns, not keystrokes.</p>
  <div class="scroll"><table><tbody>${topRows}</tbody></table></div>

  <footer>v2 · cards are rule-based recommendations: each prints its evidence, the field it came from,
  and what it does not prove, and a rule that finds no evidence prints nothing. Nothing here edits
  anything — you promote. Every figure is measured from local transcripts and the repo's own loop records;
  est.$ is list price × measured tokens, never a multiplier, and a saving with no counterfactual behind
  it is not shown — the reason it cannot be shown is.</footer>
</main>`;
}

// ─────────────────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv.slice(2));
  let data;
  try {
    // --from-json re-renders a saved aggregate without touching the transcripts (a 1 GB root takes
    // seconds to walk; a saved JSON takes none). The file is trusted as far as its shape parses.
    data = args.fromJson ? JSON.parse(fs.readFileSync(args.fromJson, 'utf8')) : aggregate(args);
  } catch (e) { process.stderr.write(`loop-stats: ${e.message}\n`); process.exit(1); }

  if (args.jsonOut) {
    try { fs.writeFileSync(args.jsonOut, `${JSON.stringify(data, null, 2)}\n`); process.stderr.write(`loop-stats: wrote ${args.jsonOut}\n`); }
    catch (e) { process.stderr.write(`loop-stats: cannot write ${args.jsonOut}: ${e.code}\n`); process.exit(1); }
  }
  if (args.html) {
    try { fs.writeFileSync(args.html, renderHtml(data)); process.stderr.write(`loop-stats: wrote ${args.html}\n`); }
    catch (e) { process.stderr.write(`loop-stats: cannot write ${args.html}: ${e.code}\n`); process.exit(1); }
  }
  process.stdout.write(args.json ? `${JSON.stringify(data, null, 2)}\n` : `${renderAnsi(data)}\n`);
}

if (require.main === module) main();

module.exports = { slugCandidates, promptText, parseArgs, aggregate, renderAnsi, renderHtml };
