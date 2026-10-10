#!/usr/bin/env node
// loop-stats.js — read-only dashboard over the transcripts Claude Code already writes.
// Node >= 18, zero dependencies. It never writes to ~/.claude and never touches the network.
//
// The transcript format is internal and undocumented — a Claude Code update can change it without
// notice. Every unreadable line is skipped with a warning instead of aborting, and the shapes this
// parser depends on are pinned in scripts/fixtures/telemetry/ so validate.js sees the break.
//
//   node scripts/loop-stats.js [--project <path|slug>] [--root <dir>] [--repo <path>]
//                              [--since 7d] [--top 3] [--html [out]] [--open] [--json]
//                              [--json-out <file>] [--from-json <file>]
//
// Or, from anywhere: bin/loop-stats (same flags), or /dashboard inside Claude Code.

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
    jsonOut: null, fromJson: null, open: false, all: false, brief: false,
    untilMs: null, windowMs: null,
    // The report's language. Defaults to the shell's LANG; the numbers and every verbatim quote stay
    // as they are — only the report's own words change.
    lang: /^(es|fr)/.test(String(process.env.LANG || '')) ? String(process.env.LANG).slice(0, 2) : 'en',
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--project') a.project = argv[++i];
    else if (flag === '--root') a.root = argv[++i];
    else if (flag === '--repo') a.repo = argv[++i];
    else if (flag === '--html') {
      // `--html` with no path is the common case: the report goes to the cache, never into the repo.
      const next = argv[i + 1];
      a.html = (next === undefined || next.startsWith('--')) ? DEFAULT_HTML : argv[++i];
    }
    else if (flag === '--open') { a.open = true; if (!a.html) a.html = DEFAULT_HTML; }
    else if (flag === '--json') a.json = true;
    else if (flag === '--all') a.all = true;
    else if (flag === '--brief') a.brief = true;
    else if (flag === '--json-out') a.jsonOut = argv[++i];
    else if (flag === '--from-json') a.fromJson = argv[++i];
    else if (flag === '--lineup') a.lineup = argv[++i];
    else if (flag === '--lang') {
      const v = String(argv[++i] || '');
      if (['en', 'es', 'fr'].includes(v)) a.lang = v;
      else warn(`--lang expects en, es or fr — ignored, using ${a.lang}`);
    }
    else if (flag === '--top') {
      const n = Number.parseInt(argv[++i], 10);
      if (Number.isInteger(n) && n > 0) a.top = n;
      else warn('--top expects a positive integer — ignored, using 3');
    }
    else if (flag === '--since') {
      const m = /^(\d+)d$/.exec(argv[++i] || '');
      if (m) { a.windowMs = Number(m[1]) * 864e5; a.sinceMs = Date.now() - a.windowMs; }
      else warn('--since expects <N>d (e.g. 7d) — ignored, showing all history');
    } else warn(`unknown flag ${flag} — ignored`);
  }
  a.root = path.resolve(a.root);
  if (a.repo) a.repo = path.resolve(a.repo);
  a.projectCandidates = slugCandidates(a.project || process.cwd());
  a.project = a.projectCandidates[0];
  return a;
}

// The report quotes prompts and denial reasons verbatim, so its default home is the user's cache —
// never the repo, where a `git add -A` would publish a month of their prompting.
const DEFAULT_HTML = '\u0000default';
function resolveHtmlPath(args) {
  if (args.html !== DEFAULT_HTML) return args.html;
  const cache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  const dir = path.join(cache, 'harness-audit', 'dashboard');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${args.all ? 'all' : args.project}.html`);
}

// Best-effort, never fatal, never a dependency: a headless box or a locked-down desktop just gets
// the path printed and opens it itself.
function openFile(file) {
  const { spawn } = require('node:child_process');
  const cmd = process.platform === 'darwin' ? ['open', [file]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', file]]
      : (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) ? ['xdg-open', [file]] : null;
  if (!cmd) return false;
  try {
    spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch { return false; }
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
    id: 'harness-caught',
    priority: 0,
    type: 'HARNESS',
    severity: 'info',
    when: (d) => !!(d.caught && d.caught.total > 0),
    headline: (d) => `the harness said no ${d.caught.total} time${d.caught.total === 1 ? '' : 's'} on the record`,
    evidence: (d) => {
      const c = d.caught;
      const bits = [];
      if (c.rejected.length) bits.push(`${c.rejected.length} workflow run${c.rejected.length === 1 ? '' : 's'} RECHAZADO by the reviewer (${c.rejected.map((r) => `${r.name} ${r.date}${r.rounds ? ` ×${r.rounds}` : ''}`).slice(0, 3).join(', ')})`);
      if (c.rejectedLoops.length) bits.push(`${c.rejectedLoops.length} loop run${c.rejectedLoops.length === 1 ? '' : 's'} stopped by a seat`);
      if (c.guardFires.length) bits.push(c.guardFires.map((g) => `${g.name} blocked ×${g.fires}`).join(', '));
      if (c.promoted.length) bits.push(`${c.promoted.length} review card${c.promoted.length === 1 ? '' : 's'} promoted into the contract`);
      if (c.ab.length) bits.push(c.ab.map((a) => `A/B ${a.subject} ${a.deltaScore >= 0 ? '+' : ''}${a.deltaScore}${a.scoreMax ? `/${a.scoreMax}` : ''}`).join(', '));
      if (c.predictions.verified || c.predictions.falsified) bits.push(`${c.predictions.verified} prediction${c.predictions.verified === 1 ? '' : 's'} verified, ${c.predictions.falsified} falsified`);
      if (c.learnings) bits.push(`${c.learnings} learning${c.learnings === 1 ? '' : 's'} written`);
      return bits.join(' · ');
    },
    recommendation: 'nothing to do - this is the receipt. When the list is short, the loops that produce it (/review-loop, /session-review, /skill-loop) are the ones not running',
    doesNotProve: 'what would have shipped without the harness - nobody ran that arm; each line is an event, the counterfactual is not',
    source: 'caught',
  },
  {
    id: 'continue-token',
    priority: 3,
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
    priority: 5,
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
    priority: 4,
    type: 'SKILL CANDIDATE',
    severity: 'warn',
    when: (d) => d.skills && d.skills.installedNotUsed.project.length >= 5 && d.skills.shelfRatio.project >= 0.6,
    headline: (d) => `${d.skills.installedNotUsed.project.length} of the ${d.skills.installedNotUsed.projectTotal} skills installed in this project were never invoked here`,
    evidence: (d) => d.skills.installedNotUsed.project.slice(0, 12).join(', '),
    recommendation: 'Prune them, or name the invocation in AGENTS.md so the use becomes observable.',
    doesNotProve: 'that a skill is useless — a description that auto-triggered without the Skill tool leaves no trace in the transcript',
    source: 'skills.installedNotUsed',
  },
  {
    id: 'skill-used-not-installed',
    priority: 11,
    type: 'SKILL CANDIDATE',
    severity: 'info',
    when: (d) => d.skills && d.skills.usedNotInstalled.length > 0,
    headline: (d) => `${d.skills.usedNotInstalled.length} name(s) were invoked that no SKILL.md or command file backs`,
    evidence: (d) => d.skills.usedNotInstalled.join(', '),
    recommendation: 'Check whether each is a workflow or a skill bundled with the client (both fine) or one that was removed while the habit of calling it stayed.',
    doesNotProve: 'that anything is missing — skills the client ships, and workflows, have no SKILL.md under this project or home directory either',
    source: 'skills.usedNotInstalled',
  },
  {
    id: 'repeated-crash',
    priority: 2,
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
    priority: 6,
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
    priority: 8,
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
    priority: 9,
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
    priority: 7,
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
    priority: 10,
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
    priority: 13,
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
    priority: 1,
    type: 'LIFECYCLE',
    severity: 'warn',
    when: (d) => !!(d.reviews && d.reviews.latest && d.reviews.latest.pending > 0),
    headline: (d) => `${plural(d.reviews.latest.pending, 'card')} from the last /session-review ${d.reviews.latest.pending === 1 ? 'is' : 'are'} still open after ${d.reviews.latest.ageDays} days`,
    evidence: (d) => d.reviews.latest.cards.filter((c) => c.state === 'pending')
      .map((c) => `${clip(c.text, 90)} — ${c.evidence}`).join(' · '),
    recommendation: 'Promote it, or reject it in the report so it stops surfacing here.',
    doesNotProve: 'that you rejected it — a rejected card is a valid outcome, and nothing on disk records that decision',
    source: 'reviews.latest.cards',
  },
  {
    id: 'review-stale',
    priority: 12,
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
  // Severity first, then a fixed priority: the first card is the one the report puts on stage as
  // "the one thing", so its order is a decision written here, not an accident of the alphabet.
  const order = { warn: 0, info: 1 };
  const prioOf = (id) => (RULES.find((r) => r.id === id) || {}).priority || 99;
  fired.sort((a, b) => (order[a.severity] - order[b.severity]) || (prioOf(a.rule) - prioOf(b.rule)));
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

// Read from its own module: harness-loops' prompt-router needs the same inventory, and a plugin
// cannot reach a sibling plugin's files, so both ship a copy (validate.js keeps them identical).
const { inventorySkills: readInventory } = require('./skill-inventory.js');
const inventorySkills = (repo) => readInventory(repo, { warn });

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

  const outcomesByBare = new Map();
  for (const [raw, o] of Object.entries(hygiene.skillOutcomes || {})) outcomesByBare.set(bareName(raw), o);
  const used = [...usedCounts.entries()].map(([name, r]) => {
    const files = installedByName.get(name) || [];
    const primary = files[0] || {};
    return {
      name,
      viaSkillTool: r.viaSkillTool,
      viaSlash: r.viaSlash,
      sources: files.map((sk) => sk.source),
      words: primary.words || 0,
      ageDays: primary.ageDays === undefined ? null : primary.ageDays,
      learnings: primary.learnings === undefined ? null : primary.learnings,
      description: primary.description || '',
      outcomes: outcomesByBare.get(name) || null,
    };
  }).sort((a, b) => (b.viaSkillTool + b.viaSlash) - (a.viaSkillTool + a.viaSlash));

  const bySource = {};
  for (const sk of skills) bySource[sk.source] = (bySource[sk.source] || 0) + 1;

  // A skill installed in both .claude/skills and .agents/skills is one skill on the shelf.
  const unusedIn = (sources) => [...new Set(skills
    .filter((sk) => sources.includes(sk.source) && !usedCounts.has(bareName(sk.name)))
    .map((sk) => bareName(sk.name)))].sort();
  const countIn = (sources) => new Set(skills.filter((sk) => sources.includes(sk.source))
    .map((sk) => bareName(sk.name))).size;
  const projectSources = ['project', 'project-agents', 'project-command'];
  const userSources = ['user', 'user-agents', 'user-command'];
  const projectUnused = unusedIn(projectSources);
  const userUnused = unusedIn(userSources);
  const projectCount = countIn(projectSources);
  const userCount = countIn(userSources);

  // -- advice: three lists, every entry carrying the reasons it is there --------------------------
  // "uninstall" is a candidate, not a verdict: the reasons are facts (unused in the window, a copy
  // in two roots, a disabled plugin, a large file never loaded to any effect), and the human decides.
  const rootOf = (src) => (src.startsWith('project') ? 'project' : src.startsWith('user') ? 'user' : 'plugin');
  const uninstall = [];
  for (const [bare, files] of installedByName) {
    if (usedCounts.has(bare)) continue;
    const scopes = [...new Set(files.map((f) => rootOf(f.source)))];
    if (!scopes.includes('project') && !scopes.includes('user')) continue;
    const primary = files.slice().sort((a, b) => (b.words || 0) - (a.words || 0))[0];
    const reasons = [];
    reasons.push({ code: 'unused', words: primary.words || 0, scope: scopes.join('+') });
    if (files.length > 1) reasons.push({ code: 'duplicate', sources: files.map((f) => f.source) });
    if (files.some((f) => !f.enabled)) reasons.push({ code: 'disabled' });
    if (primary.ageDays !== null && primary.ageDays !== undefined && primary.ageDays >= 90) reasons.push({ code: 'stale', ageDays: primary.ageDays });
    uninstall.push({ name: bare, sources: files.map((f) => f.source), words: primary.words || 0, ageDays: primary.ageDays, reasons });
  }
  // Project-scope first (it loads every session), then by the context it costs.
  uninstall.sort((a, b) => (Number(b.sources.some((x) => x.startsWith('project'))) - Number(a.sources.some((x) => x.startsWith('project')))) || b.words - a.words);

  // "improve" fires only on skills that were actually reached for: a correction rate is a rate over
  // uses, and a skill never used has no rate. Each reason names the count behind it.
  const improve = [];
  for (const u of used) {
    const uses = u.viaSkillTool + u.viaSlash;
    if (uses < 2 || u.viaSkillTool === 0) continue;
    const reasons = [];
    const o = u.outcomes;
    if (o && o.uses >= 2) {
      const rough = o.corrected + o.interrupted + o.denied;
      if (rough / o.uses >= 1 / 3) reasons.push({ code: 'followed-by-correction', rough, uses: o.uses, corrected: o.corrected, interrupted: o.interrupted, denied: o.denied });
    }
    if (uses >= 3 && u.learnings === null && u.sources.some((x) => !x.startsWith('plugin'))) reasons.push({ code: 'never-looped', uses });
    if (uses >= 3 && u.ageDays !== null && u.ageDays >= 90) reasons.push({ code: 'old-for-its-use', uses, ageDays: u.ageDays });
    if (u.words >= 2500 && uses >= 2) reasons.push({ code: 'heavy', words: u.words });
    if (reasons.length) improve.push({ name: u.name, uses, sources: u.sources, editable: u.sources.length > 0, words: u.words, ageDays: u.ageDays, learnings: u.learnings, reasons });
  }
  improve.sort((a, b) => b.uses - a.uses);
  const flagged = new Set(improve.map((x) => x.name));
  const keep = used.filter((u) => u.sources.length && u.viaSkillTool + u.viaSlash >= 2 && !flagged.has(u.name)).slice(0, 5).map((u) => u.name);

  return {
    repo,
    roles,
    advice: { keep, improve, uninstall: uninstall.slice(0, 20), uninstallTotal: uninstall.length,
      note: 'uninstall = installed in this project or your home, never invoked in the window; improve = invoked at least twice and followed by a correction, interrupt or refusal in a third of its uses (proxy), or used often without a LEARNINGS.md, or untouched for 90 days. Facts from disk and transcripts; the decision is yours.' },
    installed: skills.length,
    enabled: skills.filter((sk) => sk.enabled).length,
    bySource,
    used,
    // Invoked through the Skill tool but nowhere on disk: a workflow, or a skill removed after the
    // habit of calling it stayed. A typed /name that is not installed is almost always a built-in
    // (/model, /compact), so it is left in commands.typed rather than reported as a missing skill.
    usedNotInstalled: used.filter((u) => !u.sources.length && u.viaSkillTool > 0)
      .map((u) => u.name).sort(),
    installedNotUsed: {
      project: projectUnused, user: userUnused.slice(0, 20), userCount: userUnused.length,
      projectTotal: projectCount, userTotal: userCount,
    },
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

const CARD_TYPES = ['SKILL CANDIDATE', 'AGENTS.md RULE', 'DISPATCH', 'HABIT', 'LIFECYCLE', 'HARNESS'];

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

const dedupeBy = (xs, key) => {
  const seen = new Set();
  return xs.filter((x) => { const k = key(x); if (seen.has(k)) return false; seen.add(k); return true; });
};

function buildSignals(sessions, prompts, args) {
  const inWindow = (ts) => {
    if (args.sinceMs === null && args.untilMs === null) return true;
    const at = Date.parse(ts);
    if (!Number.isFinite(at)) return false;
    return (args.sinceMs === null || at >= args.sinceMs) && (args.untilMs === null || at < args.untilMs);
  };

  // -- tools ------------------------------------------------------------------
  const byName = new Map();
  const subagents = new Map();
  let exitPlanMode = 0;
  const skillCalls = new Map();
  const skillUses = [];
  for (const ev of sessions) {
    for (const u of ev.toolUses) {
      if (!inWindow(u.ts)) continue;
      const r = byName.get(u.name) || { name: u.name, calls: 0, errors: 0 };
      r.calls++;
      byName.set(u.name, r);
      if (u.name === 'ExitPlanMode') exitPlanMode++;
      if (u.name === 'Skill' && u.input && u.input.skill) {
        skillCalls.set(String(u.input.skill), (skillCalls.get(String(u.input.skill)) || 0) + 1);
        skillUses.push({ sessionId: ev.sessionId, ts: u.ts, skill: String(u.input.skill) });
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

  // What the human did next, per skill invocation: the first human prompt after the call in the same
  // session, and whether an interrupt or a refusal landed before it. This is the only per-skill
  // outcome a transcript can carry, and it is a proxy — a correction after a skill ran is not proof
  // the skill was what went wrong. It is enough to say "look at this one", never "this one is bad".
  const skillOutcomes = new Map();
  for (const use of skillUses) {
    const at = Date.parse(use.ts);
    const next = human.filter((p) => p.sessionId === use.sessionId && Date.parse(p.ts) > at)
      .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))[0] || null;
    const until = next ? Date.parse(next.ts) : Infinity;
    const between = (arr) => arr.filter((x) => x.sessionId === use.sessionId && Date.parse(x.ts) > at && Date.parse(x.ts) <= until).length;
    const o = skillOutcomes.get(use.skill) || { uses: 0, corrected: 0, interrupted: 0, denied: 0, continued: 0 };
    o.uses++;
    if (next && CORRECTION.test(next.text.trim())) o.corrected++;
    if (next && CONTINUATION.test(next.text.trim())) o.continued++;
    if (between(sessions.flatMap((ev) => ev.interrupts.map((i) => ({ ...i, sessionId: ev.sessionId }))))) o.interrupted++;
    if (between(denials)) o.denied++;
    skillOutcomes.set(use.skill, o);
  }
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
      denials: {
        count: denials.length,
        // The same reason recorded twice (a resend, a retried call) is one correction. Same rule as
        // the prompt dedup: event count, not record count.
        reasons: dedupeBy(denials.filter((d) => d.reason), (d) => d.reason.toLowerCase()).slice(0, 10),
      },
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
      skillOutcomes: Object.fromEntries([...skillOutcomes.entries()].sort((a, b) => b[1].uses - a[1].uses)),
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

  const inRange = (ts, since, until) => {
    const at = Date.parse(ts);
    if (!Number.isFinite(at)) return false;
    return (since === null || at >= since) && (until === null || at < until);
  };
  const inWindow = (ts) => args.sinceMs === null && args.untilMs === null
    ? true : inRange(ts, args.sinceMs, args.untilMs);
  const allTurns = turns;
  const allPrompts = prompts;
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

  // The window before this one, measured the same way from the same parse. This is the only thing
  // in the report that can say "better" or "worse" — everything else is a level, and a level tells
  // you nothing about whether the last change helped. Absent when no `--since` was given (there is
  // no "before" for all of history) or when that earlier window holds no session at all: a delta
  // against an empty window is a fabrication, and it is reported as `null`, never as -100%.
  let previous = null;
  if (args.windowMs) {
    const prevArgs = { ...args, sinceMs: args.sinceMs - args.windowMs, untilMs: args.sinceMs };
    const prevPrompts = allPrompts.filter((p) => inRange(p.ts, prevArgs.sinceMs, prevArgs.untilMs));
    const prevSignals = buildSignals(events, prevPrompts, prevArgs);
    if (prevSignals.hygiene.sessions > 0) {
      const prevTurns = allTurns.filter((t) => inRange(t.ts, prevArgs.sinceMs, prevArgs.untilMs));
      let cost = 0;
      let tokens = 0;
      for (const t of prevTurns) {
        cost += costOf(priceFor(baseModel(t.model), t.ts), t.usage) || 0;
        tokens += t.usage.tokens;
      }
      previous = {
        // A window with a handful of prompts cannot anchor a rate: 0 of 7 against 16 of 209 is
        // not "up from zero", it is noise. The floor is blunt on purpose and stated where it is used.
        comparable: prevSignals.hygiene.humanPrompts >= 30 && prevSignals.hygiene.sessions >= 5,
        from: new Date(prevArgs.sinceMs).toISOString(),
        to: new Date(prevArgs.untilMs).toISOString(),
        sessions: prevSignals.hygiene.sessions,
        humanPrompts: prevSignals.hygiene.humanPrompts,
        continuations: prevSignals.hygiene.continuations.count,
        interrupts: prevSignals.hygiene.interrupts,
        compactions: prevSignals.hygiene.compactions.count,
        modelSwitches: prevSignals.hygiene.modelSwitches.count,
        toolErrors: prevSignals.tools.totalErrors,
        denials: prevSignals.tools.denials.count,
        skillsInvoked: Object.keys(prevSignals.hygiene.skillCalls).length,
        tokens,
        costUsd: cost,
      };
    }
  }
  const inventoryRepo = args.repo || process.cwd();
  const skillsInventory = buildInventory(inventoryRepo, signals.hygiene);
  const reviews = parseReviews(inventoryRepo, skillsInventory);
  const caught = buildCaught({ workflows, loopRuns: repo.loopRuns, learnings: repo.learnings, savings: repo.savings, guards: signals.guards, reviews, hygiene: signals.hygiene });

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
    caught,
    previous,
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

// ─────────────────────────────────────────────────────────────────────────────
// CAUGHT — every event where a harness component said no, or changed something, on the record
// ─────────────────────────────────────────────────────────────────────────────
//
// This is the only place the report answers "did the harness help?", and it answers with a list of
// events, never with a saving: a rejected run is a reviewer that returned a diff before it merged; a
// guard fire is a command that did not run; a promoted card is a rule that reached the contract; an
// A/B row is a measured gap. What none of them prove is what would have shipped without the harness —
// nobody ran that arm — and the block says so where it is rendered.
function buildCaught(src) {
  const rejected = src.workflows.filter((w) => w.verdict === 'RECHAZADO')
    .map((w) => ({ runId: w.runId, name: w.name, date: String(w.startedAt).slice(0, 10), rounds: w.rounds }));
  const rejectedLoops = src.loopRuns.filter((r) => r.verdict === 'RECHAZADO' || (r.stoppedBy && /blocker|scorer|reviewer/i.test(r.stoppedBy)))
    .map((r) => ({ run: r.run, loop: r.loop, date: r.date, stoppedBy: r.stoppedBy }));
  const guardFires = (src.guards && src.guards.pluginGuards ? src.guards.pluginGuards : [])
    .filter((g) => g.fires > 0 && !g.advisory).map((g) => ({ name: g.name, fires: g.fires }));
  const nudges = (src.guards && src.guards.pluginGuards ? src.guards.pluginGuards : [])
    .filter((g) => g.fires > 0 && g.advisory).reduce((n, g) => n + g.fires, 0);
  const promoted = src.reviews && src.reviews.latest
    ? src.reviews.latest.cards.filter((c) => c.state === 'promoted').map((c) => ({ type: c.type, text: c.text, evidence: c.evidence }))
    : [];
  const ab = src.savings && src.savings.ab ? src.savings.ab.filter((a) => a.deltaScore !== null && a.deltaScore !== undefined)
    .map((a) => ({ subject: a.subject, deltaScore: a.deltaScore, scoreMax: a.scoreMax })) : [];
  const verified = src.savings && src.savings.predictions && !src.savings.predictions.unreadable ? src.savings.predictions.verified : 0;
  const falsified = src.savings && src.savings.predictions && !src.savings.predictions.unreadable ? src.savings.predictions.falsified : 0;
  const learnings = src.learnings.length;
  const roundsToGreen = src.savings && src.savings.roundsToGreen ? src.savings.roundsToGreen.trend : [];
  const total = rejected.length + rejectedLoops.length + guardFires.reduce((n, g) => n + g.fires, 0)
    + promoted.length + ab.length + verified + falsified + learnings;
  return {
    total,
    rejected, rejectedLoops, guardFires, nudges, promoted, ab, predictions: { verified, falsified }, learnings, roundsToGreen,
    doesNotProve: 'what would have shipped without the harness - nobody ran that arm. Each line is an event on the record; the counterfactual is not.',
  };
}

// Every project this machine has telemetry for. A slug that cannot be read is a row in
// `failedProjects`, never an abort: one corrupt project must not cost you the other thirty-five.
function aggregateAll(args) {
  const slugs = ls(args.root).filter((d) => !d.startsWith('.') && !d.startsWith('-tmp-'))
    .filter((d) => { try { return fs.statSync(path.join(args.root, d)).isDirectory(); } catch { return false; } })
    .sort();

  const projects = [];
  const failed = [];
  const skillTotals = new Map();
  const hygiene = { continuations: 0, interrupts: 0, modelSwitches: 0, compactions: 0, humanPrompts: 0 };
  const totals = { projects: 0, sessions: 0, runs: 0, tokens: 0, costUsd: 0 };

  for (const slug of slugs) {
    process.stderr.write(`loop-stats: reading ${slug}\n`);
    const before = warnings.length;
    let d;
    try {
      // No --repo across projects: a repo path belongs to one project, and guessing which is how a
      // dashboard starts reporting another project's contract as this one's.
      d = aggregate({ ...args, project: slug, projectCandidates: [slug], repo: null });
    } catch (e) { failed.push({ project: slug, error: e.message.split('\n')[0] }); continue; }

    for (const [name, n] of Object.entries(d.hygiene.skillCalls)) {
      const r = skillTotals.get(name) || { name, count: 0, projects: 0 };
      r.count += n;
      r.projects++;
      skillTotals.set(name, r);
    }
    hygiene.continuations += d.hygiene.continuations.count;
    hygiene.interrupts += d.hygiene.interrupts;
    hygiene.modelSwitches += d.hygiene.modelSwitches.count;
    hygiene.compactions += d.hygiene.compactions.count;
    hygiene.humanPrompts += d.hygiene.humanPrompts;
    totals.sessions += d.hygiene.sessions;
    totals.runs += d.totals.runs;
    totals.tokens += d.totals.tokens;
    totals.costUsd += d.totals.costUsd;

    projects.push({
      project: slug,
      sessions: d.hygiene.sessions,
      runs: d.totals.runs,
      tokens: d.totals.tokens,
      costUsd: d.totals.costUsd,
      unpricedModels: d.unpricedModels,
      lastActivity: d.timeline.length ? d.timeline[d.timeline.length - 1].date : null,
      cards: d.cards.length,
      warnings: warnings.length - before,
    });
  }
  totals.projects = projects.length;
  projects.sort((a, b) => b.costUsd - a.costUsd);

  return {
    mode: 'all',
    root: args.root,
    generatedAt: new Date().toISOString(),
    window: args.sinceMs ? new Date(args.sinceMs).toISOString() : 'all',
    projects,
    totals,
    // Cross-project, because a skill is installed once and used everywhere. Recurring PROMPTS are
    // deliberately not aggregated here: the same eight words mean different things in two repos.
    skills: [...skillTotals.values()].sort((a, b) => b.count - a.count),
    hygiene,
    failedProjects: failed,
    warnings: warnings.length,
  };
}

// What the model pass in /session-review actually reads. Everything else — the agent×model table,
// the timeline, the workflow history, the savings ledger — is accounting a `for` loop already did,
// and paying a context window to re-read it is the expensive way to learn nothing.
const BRIEF_KEYS = ['project', 'generatedAt', 'window', 'previous', 'caught', 'hygiene', 'tools', 'guards', 'skills', 'reviews', 'cards', 'rulesSilent', 'prompts', 'warnings'];
function briefOf(d) {
  const out = {};
  for (const k of BRIEF_KEYS) if (d[k] !== undefined) out[k] = d[k];
  // Trimmed further where the full field is a wall: the model needs the shelf list, not the roster.
  if (out.skills) {
    out.skills = {
      installed: d.skills.installed,
      used: d.skills.used,
      usedNotInstalled: d.skills.usedNotInstalled,
      installedNotUsed: { project: d.skills.installedNotUsed.project, userCount: d.skills.installedNotUsed.userCount },
      roles: d.skills.roles,
      advice: d.skills.advice,
      note: d.skills.note,
    };
  }
  if (out.tools) {
    out.tools = {
      totalCalls: d.tools.totalCalls,
      totalErrors: d.tools.totalErrors,
      errorClusters: d.tools.errorClusters,
      denials: d.tools.denials,
      subagents: d.tools.subagents,
      planMode: d.tools.planMode,
    };
  }
  if (out.guards) out.guards = { pluginGuards: d.guards.pluginGuards, note: d.guards.note };
  return out;
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

function renderAll(d) {
  // Wider than the per-project box: this one is a table of names, and a slug clipped to 26 columns
  // stops naming anything.
  const WA = 74;
  const row = (t) => `│${clip(t, WA).padEnd(WA)}│`;
  const out = [];
  const head = '─ LOOP-STATS ▓ ALL PROJECTS ';
  out.push(`┌${head}${'─'.repeat(Math.max(0, WA - head.length - 12))} ${d.generatedAt.slice(0, 10)} ─┐`);
  out.push(row(` ${plural(d.totals.projects, 'project')} · ${plural(d.totals.sessions, 'session')} · ${human(d.totals.tokens)} tokens · $${d.totals.costUsd.toFixed(0)}`));
  out.push(row(` PROJECT${' '.repeat(34)} SESS   TOKENS    est.$  CARDS`));
  for (const p of d.projects.slice(0, 12)) {
    const name = clip(p.project.replace(/^-home-[^-]+-/, ''), 40).padEnd(40);
    out.push(row(` ${name} ${String(p.sessions).padStart(4)} ${human(p.tokens).padStart(8)} ${p.costUsd.toFixed(0).padStart(8)} ${String(p.cards).padStart(6)}`));
  }
  if (d.projects.length > 12) out.push(row(` +${d.projects.length - 12} more`));
  out.push(row(' SKILLS    used across projects'));
  for (const sk of d.skills.slice(0, 5)) {
    out.push(row(`   ${clip(sk.name, 28).padEnd(28)} ×${sk.count} in ${plural(sk.projects, 'project')}`));
  }
  if (!d.skills.length) out.push(row('   none invoked through the Skill tool in this window'));
  out.push(row(` HYGIENE   ${plural(d.hygiene.continuations, 'continuation')} · ${plural(d.hygiene.interrupts, 'interrupt')} · ${d.hygiene.modelSwitches} /model`));
  for (const f of d.failedProjects) out.push(row(` UNREAD    ${clip(f.project, 22)} — ${clip(f.error, 22)}`));
  out.push(`└─ per-project detail: --project <path|slug> ${'─'.repeat(Math.max(0, WA - 44))}┘`);
  return out.join('\n');
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
// STRINGS — the report's own words, in the three languages its author reads
// ─────────────────────────────────────────────────────────────────────────────
// Numbers, names, paths and every verbatim quote are never translated: a quote in another language
// is a paraphrase, and a paraphrase in the quote slot is a fabrication with good manners.

const STR = {
  en: {
    eyebrow: 'harness-audit · recap', lastDays: (n) => `last ${n} days`, allHistory: 'all history',
    readHere: 'Read from the transcripts on this machine; nothing left it.',
    sessions: 'sessions', asked: 'things you asked for', spend: 'est. spend', floor: '(floor — see the ledger)',
    attention: (n, q) => `${n} thing${n === 1 ? '' : 's'} worth your attention below, ${q} rule${q === 1 ? '' : 's'} checked and quiet.`,
    noCards: 'No rule found evidence in this window. Nothing is printed rather than something reassuring.',
    startHere: 'Start here', startKicker: 'One thing. The card with the most evidence behind it, and what to do about it.',
    whatToDo: 'What to do.', notProve: 'What this does not prove.',
    caught: 'What the harness stopped', caughtKicker: 'Every time a piece of the harness said no, or changed something, on the record. This is the receipt — events, not a saving.',
    caughtNone: 'Nothing on the record this window: no reviewer verdict, no guard fire, no promoted card, no A/B. The loops that produce a receipt are the ones not running.',
    timesOnRecord: (n) => `time${n === 1 ? '' : 's'} on the record`,
    cRejected: (n) => `${n} workflow run${n === 1 ? '' : 's'} returned by the reviewer before merging`,
    cLoops: (n) => `${n} loop run${n === 1 ? '' : 's'} stopped by a seat`,
    cGuard: (name, n) => `${name} blocked a command ×${n}`,
    cPromoted: (n) => `${n} review card${n === 1 ? '' : 's'} promoted into the contract`,
    cAb: (subj, delta, max) => `skill-loop A/B on ${subj}: ${delta} ${max ? `of ${max}` : ''} with the skill vs without`,
    cPred: (v, f) => `${v} optimizer prediction${v === 1 ? '' : 's'} verified, ${f} falsified`,
    cLearn: (n) => `${n} lesson${n === 1 ? '' : 's'} written to a LEARNINGS.md`,
    cGreen: (t) => `rounds to green on approved runs: ${t}`,
    cNudges: (n) => `plus ${n} nudge${n === 1 ? '' : 's'} from the repeat-tool guard (advisory, not counted)`,
    caughtNot: 'What this does not prove: what would have shipped without the harness. Nobody ran that arm. Each line is an event; the counterfactual is not.',
    driving: 'How the driving went',
    drivingCmp: (n) => `Against the ${n} days before — rates per 100 prompts, so a busier month does not read as a worse one.`,
    drivingQuiet: (n, s, p) => `The ${n} days before this window were too quiet to compare against (${s} session${s === 1 ? '' : 's'}, ${p} prompts). Next month there will be a baseline.`,
    drivingNoSince: 'Pass --since to get a comparison against the window before.',
    tContinua: 'bare «continua»', tContinuaSub: (a, n) => `${a} of ${n} right after the agent stopped`,
    tInterrupt: 'interrupted', tInterruptSub: (p) => `${p} of your turns stopped mid-flight`,
    tModel: '/model by hand', tModelNone: 'no target recorded',
    tCompact: 'compactions', tCompactSub: (a, avg) => `${a} automatic${avg ? ` · avg ${avg} tokens before the cut` : ''}`,
    drivingFine: (hp, ss, dr, dd, co) => `${hp} human prompts over ${ss} sessions. ${dr} turns that looked human but were written by a loop to its own subagent were dropped; ${dd} duplicate record${dd === 1 ? '' : 's'} collapsed. ${co} turn${co === 1 ? '' : 's'} opened like a correction`,
    drivingFine2: '— the reasons you typed while refusing a call, further down, are the only corrections here that are not a guess.',
    breaking: 'What kept breaking', breakingKicker: 'The failure that came back most. A failure that repeats is a preflight check nobody wrote.',
    breakingNone: 'Nothing failed the same way twice in this window.',
    bossSub: (ss, last) => `times, across ${ss} · last on ${last}`,
    bossTool: (t) => `Tool: <b>${t}</b>. Clustered by the first eight words of the error, so this may be more than one root cause wearing the same message.`,
    toolsFine: (calls, errs) => `${calls} tool calls in all · ${errs} errors`,
    stale: (n) => `${n} edit${n === 1 ? '' : 's'} hit a file that had changed since it was read`,
    retries: (n) => `${n} transport retr${n === 1 ? 'y' : 'ies'}, which are slow rather than failed`,
    toolsNone: (calls, errs) => `${calls} tool calls, ${errs} errors, none of them repeated.`,
    skills: 'Your skills', skillsKicker: 'What you reached for, what to sharpen, and what is only costing context. Facts from disk and from the transcripts; the decisions are yours.',
    topUsed: 'Most used', usedNone: 'Nothing was invoked through the Skill tool or by name in this window.',
    notInstalled: 'not installed here', outcomes: (o) => [o.interrupted ? `${o.interrupted} interrupted` : '', o.denied ? `${o.denied} refused` : '', o.corrected ? `${o.corrected} corrected` : '', o.continued ? `${o.continued} «continua»` : ''].filter(Boolean).join(' · '),
    keep: 'Keep', keepSub: 'Used, and nothing followed them that looked like trouble.',
    improve: 'Improve', improveSub: 'Used at least twice, with a reason to open the file.',
    improveNone: 'No used skill shows a reason to open it.',
    rFollowed: (r) => `${r.rough} of ${r.uses} uses were followed by an interrupt, a refusal or a correction-shaped turn (${[r.interrupted ? `${r.interrupted} interrupted` : '', r.denied ? `${r.denied} refused` : '', r.corrected ? `${r.corrected} corrected` : ''].filter(Boolean).join(', ')}) — proxy`,
    rLooped: (r) => `used ${r.uses} times and has never been through /skill-loop — no LEARNINGS.md beside it`,
    rOld: (r) => `used ${r.uses} times, SKILL.md untouched for ${r.ageDays} days`,
    rHeavy: (r) => `${r.words} words of context on every call`,
    improveHow: (name) => `Have an idea? <code>/skill-loop ${name}</code> measures it blind, with and without.`,
    improveBundled: 'Ships with the client, so there is no SKILL.md to edit: the fix is a line in AGENTS.md about when to call it.',
    uninstall: 'Uninstall candidates', uninstallSub: (n, total) => `${n} of ${total} — never invoked in the window. Project scope first, because it loads every session.`,
    uninstallNone: 'Every installed skill was invoked at least once.',
    uUnused: (r) => `never invoked in the window · ${r.words} words loaded ${r.scope === 'project' ? 'every session' : 'when matched'}`,
    uDup: (r) => `installed twice: ${r.sources.join(' and ')}`,
    uDisabled: 'plugin disabled in settings — installed but off',
    uStale: (r) => `SKILL.md untouched for ${r.ageDays} days`,
    uninstallNot: 'A skill whose description auto-triggered without the Skill tool leaves no trace in a transcript. This is what the Skill tool saw, not proof a skill is useless.',
    more: (n) => `and ${n} more`,
    usedNotInstalled: (list) => `Invoked but with no SKILL.md under this project or your home: ${list} — a workflow, or a skill the client ships.`,
    distinct: (n) => `${n} distinct skills this window`,
    reportCard: 'Report card',
    rcKicker: (date, age) => `What your last <code>/session-review</code> proposed on ${date}, ${age} days ago, and where each card is now. Checked means the repo now contains it.`,
    rcNever: 'Loop 6 has never run in this repo, so nothing has ever been proposed, promoted or rejected on the record.',
    promoted: 'promoted', proposed: 'proposed', pending: 'pending',
    rcUnreadable: (why) => `The report is present but ${why} — not the same fact as "no review yet".`,
    rcHow: 'Promotion is checked by grepping this repo\'s contract and skills for what each card quoted. A DISPATCH or HABIT card leaves nothing on disk to grep, so it reads n/a rather than pending.',
    nextLesson: 'Next lesson:', rcStarts: '— it now starts from the cards in this report.',
    rcRun: 'Run <code>/session-review</code> once. From then on this scene shows what it proposed and whether you kept it.',
    rest: 'The rest of the cards', restKicker: (n) => `${n} more, in order. Open one for its evidence and its limits. None of them edits anything — you promote.`,
    silent: (n, list) => `${n} rule${n === 1 ? '' : 's'} checked and quiet: ${list}. A rule with no evidence prints nothing — padding a report to fill the grid is how an instrument becomes a horoscope.`,
    guards: 'Guards, and the calls you refused', guardsKicker: 'What blocked a call by rule, and what you blocked by hand — with the reason you typed.',
    gInstalled: (n, f, ss) => `<b>${n}</b> guards installed · <b>${f}</b> fire${f === 1 ? '' : 's'} in ${ss}`,
    gNoList: 'hooks.json is not readable from here, so no guard list is shown — an empty list would read as "none installed".',
    advisory: '(advisory)',
    gFine: 'A fire is a result beginning <code>harness-audit &lt;guard&gt;: blocked</code>. Zero fires does not mean nothing dangerous happened; the guards are conservative by design.',
    gOther: (n, list) => ` Other hooks ran ${n} times: ${list}.`,
    refused: (n, r) => `<b>${n}</b> call${n === 1 ? '' : 's'} you refused${r ? `, <b>${r}</b> with a reason` : ''}`,
    refusedFine: 'These are the only corrections in this report that are not a proxy: you typed them. Each one is a candidate line for AGENTS.md, and you are the one who promotes it.',
    refusedNone: 'No refusal carried a typed reason this window.',
    ledger: 'The ledger', ledgerKicker: 'Tokens, cost, workflows, savings — the accounting that used to be the whole report. Open it when you need a number.',
    lAgents: 'Tokens by agent × model', lUnpriced: (l) => `est.$ excludes unpriced models: ${l} — a floor, not a total.`, lIntro: (l) => `priced at introductory rate: ${l}`,
    lLineup: 'Model line-up — configured vs. observed', lDrift: '⚠ = drift: the role ran on a different model family than model-lineup.json configures.',
    lDays: 'Tokens per day', lWorkflows: 'Workflow activations', lLoops: 'Loop runs (findings JSON)', lSavings: 'Savings — measured counterfactuals only',
    lNoAb: 'No two-armed run in scope — /skill-loop is the only loop that produces one.',
    lNoPred: 'No process-log.md — /iterate has never run in this repo.',
    lPredUnread: (w) => `process-log.md is present but its ledger is unreadable (${w}) — <b>no prediction counted</b>, and that is not the same as none falsified.`,
    lPred: (v, f, p, u) => `Optimizer predictions: <b>${v} verified · ${f} falsified · ${p} pending · ${u} unreadable</b>.`,
    lGreen: (t) => ` Rounds-to-green ${t} — a proxy, explicitly not a saving.`, lNoGreen: ' No approved develop-phase run in scope.',
    lNoMult: ' Nothing here is a multiplier; an unmeasured quantity is printed n/a with its reason.',
    lNoRepo: 'No counterfactual in scope — pass --repo to read loop-runs and process-log.md.',
    lPredictions: 'Optimizer predictions', lLearnings: 'Learnings', lPrompts: 'Prompts',
    lPromptsFine: (t, w, sd, fu) => `${t} user turns · ${w} words avg · ${sd} sessions/day · ${fu} follow-ups`,
    lTurns: '. These are turns, not keystrokes: a loop that re-prompts its session writes one too.',
    lEvery: 'Every tool',
    footer: 'every figure is measured from local transcripts and the repo\'s own loop records. Cards are rule-based recommendations: each prints its evidence, the field it came from and what it does not prove, and a rule that finds no evidence prints nothing. est.$ is list price × measured tokens, never a multiplier. A comparison is shown only where the window before was busy enough to anchor one. Nothing here edits anything — you promote.',
    unreadableLines: (n) => ` ${n} transcript line(s) could not be read.`,
    tooQuiet: 'too quiet before to compare', same: '▪ same as before', per100: 'per 100 prompts', better: 'better', worse: 'worse',
    warn: 'warn', info: 'info', prune: 'prune', failure: 'failure',
    types: { HABIT: 'habit', DISPATCH: 'dispatch', 'SKILL CANDIDATE': 'skill candidate', 'AGENTS.md RULE': 'AGENTS.md rule', LIFECYCLE: 'lifecycle', DASHBOARD: 'dashboard', HARNESS: 'harness' },
  },
  es: {
    eyebrow: 'harness-audit · resumen', lastDays: (n) => `últimos ${n} días`, allHistory: 'todo el historial',
    readHere: 'Leído de los transcripts de esta máquina; nada salió de ella.',
    sessions: 'sesiones', asked: 'cosas que pediste', spend: 'gasto est.', floor: '(piso — ver el libro mayor)',
    attention: (n, q) => `${n} cosa${n === 1 ? '' : 's'} que merece${n === 1 ? '' : 'n'} tu atención abajo, ${q} regla${q === 1 ? '' : 's'} revisada${q === 1 ? '' : 's'} y en silencio.`,
    noCards: 'Ninguna regla encontró evidencia en esta ventana. No se imprime nada antes que algo tranquilizador.',
    startHere: 'Empezá por acá', startKicker: 'Una sola cosa. La card con más evidencia detrás, y qué hacer con ella.',
    whatToDo: 'Qué hacer.', notProve: 'Qué no prueba esto.',
    caught: 'Lo que el arnés frenó', caughtKicker: 'Cada vez que una pieza del arnés dijo que no, o cambió algo, con registro. Esto es el recibo: eventos, no un ahorro.',
    caughtNone: 'Nada registrado en esta ventana: ni veredicto de reviewer, ni guard disparado, ni card promovida, ni A/B. Los loops que producen un recibo son los que no están corriendo.',
    timesOnRecord: (n) => `${n === 1 ? 'vez' : 'veces'} con registro`,
    cRejected: (n) => `${n} corrida${n === 1 ? '' : 's'} de workflow devuelta${n === 1 ? '' : 's'} por el reviewer antes de mergear`,
    cLoops: (n) => `${n} corrida${n === 1 ? '' : 's'} de loop frenada${n === 1 ? '' : 's'} por un asiento`,
    cGuard: (name, n) => `${name} bloqueó un comando ×${n}`,
    cPromoted: (n) => `${n} card${n === 1 ? '' : 's'} de review promovida${n === 1 ? '' : 's'} al contrato`,
    cAb: (subj, delta, max) => `A/B de skill-loop sobre ${subj}: ${delta} ${max ? `de ${max}` : ''} con el skill vs sin él`,
    cPred: (v, f) => `${v} predicción${v === 1 ? '' : 'es'} del optimizador verificada${v === 1 ? '' : 's'}, ${f} falsada${f === 1 ? '' : 's'}`,
    cLearn: (n) => `${n} ${n === 1 ? 'lección escrita' : 'lecciones escritas'} en un LEARNINGS.md`,
    cGreen: (t) => `rondas hasta verde en corridas aprobadas: ${t}`,
    cNudges: (n) => `más ${n} aviso${n === 1 ? '' : 's'} del guard de repetición (consultivo, no cuenta)`,
    caughtNot: 'Qué no prueba esto: qué habría salido sin el arnés. Nadie corrió ese brazo. Cada línea es un evento; el contrafactual no lo es.',
    driving: 'Cómo fue la conducción',
    drivingCmp: (n) => `Contra los ${n} días anteriores — tasas por 100 prompts, para que un mes más cargado no se lea como uno peor.`,
    drivingQuiet: (n, s, p) => `Los ${n} días anteriores a esta ventana fueron demasiado tranquilos para comparar (${s} sesión${s === 1 ? '' : 'es'}, ${p} prompts). El mes que viene habrá línea base.`,
    drivingNoSince: 'Pasá --since para comparar contra la ventana anterior.',
    tContinua: '«continua» a secas', tContinuaSub: (a, n) => `${a} de ${n} justo después de que el agente paró`,
    tInterrupt: 'interrumpidos', tInterruptSub: (p) => `${p} de tus turnos cortados a mitad`,
    tModel: '/model a mano', tModelNone: 'sin destino registrado',
    tCompact: 'compactaciones', tCompactSub: (a, avg) => `${a} automática${a === 1 ? '' : 's'}${avg ? ` · media ${avg} tokens antes del corte` : ''}`,
    drivingFine: (hp, ss, dr, dd, co) => `${hp} prompts humanos en ${ss} sesiones. Se descartaron ${dr} turnos que parecían humanos pero los escribió un loop a su propio subagente; ${dd} registro${dd === 1 ? '' : 's'} duplicado${dd === 1 ? '' : 's'} colapsado${dd === 1 ? '' : 's'}. ${co} turno${co === 1 ? '' : 's'} abrieron como corrección`,
    drivingFine2: '— las razones que tipeaste al rechazar una llamada, más abajo, son las únicas correcciones de acá que no son una suposición.',
    breaking: 'Qué se rompía una y otra vez', breakingKicker: 'El fallo que más volvió. Un fallo que se repite es un check de preflight que nadie escribió.',
    breakingNone: 'Nada falló dos veces de la misma manera en esta ventana.',
    bossSub: (ss, last) => `veces, en ${ss} · la última el ${last}`,
    bossTool: (t) => `Tool: <b>${t}</b>. Agrupado por las primeras ocho palabras del error, así que puede ser más de una causa raíz con el mismo mensaje.`,
    toolsFine: (calls, errs) => `${calls} llamadas a tools en total · ${errs} errores`,
    stale: (n) => `${n} edición${n === 1 ? '' : 'es'} chocó con un archivo que cambió desde su lectura`,
    retries: (n) => `${n} reintento${n === 1 ? '' : 's'} de transporte, que son lentos, no fallidos`,
    toolsNone: (calls, errs) => `${calls} llamadas a tools, ${errs} errores, ninguno repetido.`,
    skills: 'Tus skills', skillsKicker: 'Lo que usaste, lo que conviene afinar y lo que solo cuesta contexto. Hechos del disco y de los transcripts; las decisiones son tuyas.',
    topUsed: 'Más usados', usedNone: 'Nada se invocó por la tool Skill ni por nombre en esta ventana.',
    notInstalled: 'no instalado acá', outcomes: (o) => [o.interrupted ? `${o.interrupted} interrumpido${o.interrupted === 1 ? '' : 's'}` : '', o.denied ? `${o.denied} rechazado${o.denied === 1 ? '' : 's'}` : '', o.corrected ? `${o.corrected} corregido${o.corrected === 1 ? '' : 's'}` : '', o.continued ? `${o.continued} «continua»` : ''].filter(Boolean).join(' · '),
    keep: 'Conservar', keepSub: 'Usados, y nada después que pareciera un problema.',
    improve: 'Mejorar', improveSub: 'Usados al menos dos veces, con una razón para abrir el archivo.',
    improveNone: 'Ningún skill usado muestra una razón para abrirlo.',
    rFollowed: (r) => `${r.rough} de ${r.uses} usos fueron seguidos de una interrupción, un rechazo o un turno con forma de corrección (${[r.interrupted ? `${r.interrupted} interrumpido${r.interrupted === 1 ? '' : 's'}` : '', r.denied ? `${r.denied} rechazado${r.denied === 1 ? '' : 's'}` : '', r.corrected ? `${r.corrected} corregido${r.corrected === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ')}) — proxy`,
    rLooped: (r) => `usado ${r.uses} veces y nunca pasó por /skill-loop — no hay LEARNINGS.md al lado`,
    rOld: (r) => `usado ${r.uses} veces, SKILL.md sin tocar hace ${r.ageDays} días`,
    rHeavy: (r) => `${r.words} palabras de contexto en cada llamada`,
    improveHow: (name) => `¿Tenés una idea? <code>/skill-loop ${name}</code> la mide a ciegas, con y sin.`,
    improveBundled: 'Viene con el cliente, así que no hay SKILL.md que editar: el arreglo es una línea en AGENTS.md sobre cuándo llamarlo.',
    uninstall: 'Candidatos a desinstalar', uninstallSub: (n, total) => `${n} de ${total} — nunca invocados en la ventana. Primero los de proyecto, porque cargan en cada sesión.`,
    uninstallNone: 'Todos los skills instalados se invocaron al menos una vez.',
    uUnused: (r) => `nunca invocado en la ventana · ${r.words} palabras cargadas ${r.scope === 'project' ? 'en cada sesión' : 'cuando coincide'}`,
    uDup: (r) => `instalado dos veces: ${r.sources.join(' y ')}`,
    uDisabled: 'plugin desactivado en settings — instalado pero apagado',
    uStale: (r) => `SKILL.md sin tocar hace ${r.ageDays} días`,
    uninstallNot: 'Un skill cuya descripción se disparó sola sin la tool Skill no deja rastro en un transcript. Esto es lo que vio la tool Skill, no prueba de que un skill sea inútil.',
    more: (n) => `y ${n} más`,
    usedNotInstalled: (list) => `Invocados pero sin SKILL.md en este proyecto ni en tu home: ${list} — un workflow, o un skill que trae el cliente.`,
    distinct: (n) => `${n} skills distintos en esta ventana`,
    reportCard: 'Boletín',
    rcKicker: (date, age) => `Lo que tu último <code>/session-review</code> propuso el ${date}, hace ${age} días, y dónde está cada card ahora. Tildada significa que el repo ya la contiene.`,
    rcNever: 'El Loop 6 nunca corrió en este repo, así que nunca se propuso, promovió ni rechazó nada con registro.',
    promoted: 'promovidas', proposed: 'propuestas', pending: 'pendientes',
    rcUnreadable: (why) => `El informe existe pero ${why} — no es lo mismo que "sin review todavía".`,
    rcHow: 'La promoción se verifica buscando en el contrato y los skills de este repo lo que cada card citó. Una card DISPATCH o HABIT no deja nada en disco que buscar, así que dice n/a y no pendiente.',
    nextLesson: 'Próxima lección:', rcStarts: '— ahora arranca desde las cards de este informe.',
    rcRun: 'Corré <code>/session-review</code> una vez. Desde entonces esta escena muestra qué propuso y si lo conservaste.',
    rest: 'El resto de las cards', restKicker: (n) => `${n} más, en orden. Abrí una para ver su evidencia y sus límites. Ninguna edita nada — vos promovés.`,
    silent: (n, list) => `${n} regla${n === 1 ? '' : 's'} revisada${n === 1 ? '' : 's'} y en silencio: ${list}. Una regla sin evidencia no imprime nada — rellenar un informe para llenar la grilla es cómo un instrumento se vuelve horóscopo.`,
    guards: 'Guards, y las llamadas que rechazaste', guardsKicker: 'Qué bloqueó una llamada por regla, y qué bloqueaste vos a mano — con la razón que tipeaste.',
    gInstalled: (n, f, ss) => `<b>${n}</b> guards instalados · <b>${f}</b> disparo${f === 1 ? '' : 's'} en ${ss}`,
    gNoList: 'hooks.json no se puede leer desde acá, así que no se muestra lista de guards — una lista vacía se leería como "ninguno instalado".',
    advisory: '(consultivo)',
    gFine: 'Un disparo es un resultado que empieza con <code>harness-audit &lt;guard&gt;: blocked</code>. Cero disparos no significa que no pasó nada peligroso; los guards son conservadores a propósito.',
    gOther: (n, list) => ` Otros hooks corrieron ${n} veces: ${list}.`,
    refused: (n, r) => `<b>${n}</b> llamada${n === 1 ? '' : 's'} que rechazaste${r ? `, <b>${r}</b> con razón` : ''}`,
    refusedFine: 'Estas son las únicas correcciones de este informe que no son un proxy: las tipeaste vos. Cada una es una línea candidata para AGENTS.md, y quien la promueve sos vos.',
    refusedNone: 'Ningún rechazo llevó una razón tipeada en esta ventana.',
    ledger: 'El libro mayor', ledgerKicker: 'Tokens, coste, workflows, ahorros — la contabilidad que antes era todo el informe. Abrilo cuando necesites un número.',
    lAgents: 'Tokens por agente × modelo', lUnpriced: (l) => `est.$ excluye modelos sin precio: ${l} — un piso, no un total.`, lIntro: (l) => `con precio de lanzamiento: ${l}`,
    lLineup: 'Line-up de modelos — configurado vs. observado', lDrift: '⚠ = drift: el rol corrió en otra familia de modelo que la que configura model-lineup.json.',
    lDays: 'Tokens por día', lWorkflows: 'Activaciones de workflow', lLoops: 'Corridas de loop (findings JSON)', lSavings: 'Ahorros — solo contrafactuales medidos',
    lNoAb: 'Ninguna corrida de dos brazos en alcance — /skill-loop es el único loop que produce una.',
    lNoPred: 'No hay process-log.md — /iterate nunca corrió en este repo.',
    lPredUnread: (w) => `process-log.md existe pero su ledger es ilegible (${w}) — <b>ninguna predicción contada</b>, y eso no es lo mismo que ninguna falsada.`,
    lPred: (v, f, p, u) => `Predicciones del optimizador: <b>${v} verificadas · ${f} falsadas · ${p} pendientes · ${u} ilegibles</b>.`,
    lGreen: (t) => ` Rondas hasta verde ${t} — un proxy, explícitamente no un ahorro.`, lNoGreen: ' Ninguna corrida develop-phase aprobada en alcance.',
    lNoMult: ' Nada de esto es un multiplicador; una cantidad no medida se imprime n/a con su razón.',
    lNoRepo: 'Sin contrafactual en alcance — pasá --repo para leer loop-runs y process-log.md.',
    lPredictions: 'Predicciones del optimizador', lLearnings: 'Aprendizajes', lPrompts: 'Prompts',
    lPromptsFine: (t, w, sd, fu) => `${t} turnos de usuario · ${w} palabras de media · ${sd} sesiones/día · ${fu} de seguimiento`,
    lTurns: '. Son turnos, no teclas: un loop que re-promptea su sesión también escribe uno.',
    lEvery: 'Todas las tools',
    footer: 'cada cifra está medida de transcripts locales y de los registros de loop del propio repo. Las cards son recomendaciones por regla: cada una imprime su evidencia, el campo del que salió y qué no prueba, y una regla que no encuentra evidencia no imprime nada. est.$ es precio de lista × tokens medidos, nunca un multiplicador. Una comparación se muestra solo donde la ventana anterior tuvo actividad suficiente para anclarla. Nada de esto edita nada — vos promovés.',
    unreadableLines: (n) => ` ${n} línea(s) del transcript no se pudieron leer.`,
    tooQuiet: 'antes demasiado tranquilo para comparar', same: '▪ igual que antes', per100: 'por 100 prompts', better: 'mejor', worse: 'peor',
    warn: 'aviso', info: 'info', prune: 'podar', failure: 'fallo',
    types: { HABIT: 'hábito', DISPATCH: 'despacho', 'SKILL CANDIDATE': 'skill candidato', 'AGENTS.md RULE': 'regla AGENTS.md', LIFECYCLE: 'ciclo de vida', DASHBOARD: 'dashboard', HARNESS: 'arnés' },
  },
  fr: {
    eyebrow: 'harness-audit · récap', lastDays: (n) => `${n} derniers jours`, allHistory: 'tout l\'historique',
    readHere: 'Lu dans les transcripts de cette machine ; rien n\'en est sorti.',
    sessions: 'sessions', asked: 'choses demandées', spend: 'dépense est.', floor: '(plancher — voir le grand livre)',
    attention: (n, q) => `${n} chose${n === 1 ? '' : 's'} qui mérite${n === 1 ? '' : 'nt'} votre attention ci-dessous, ${q} règle${q === 1 ? '' : 's'} vérifiée${q === 1 ? '' : 's'} et silencieuse${q === 1 ? '' : 's'}.`,
    noCards: 'Aucune règle n\'a trouvé de preuve dans cette fenêtre. Rien n\'est imprimé plutôt que quelque chose de rassurant.',
    startHere: 'Commencez ici', startKicker: 'Une seule chose. La carte avec le plus de preuves derrière elle, et quoi en faire.',
    whatToDo: 'Quoi faire.', notProve: 'Ce que cela ne prouve pas.',
    caught: 'Ce que le harnais a arrêté', caughtKicker: 'Chaque fois qu\'une pièce du harnais a dit non, ou a changé quelque chose, avec trace. C\'est le reçu : des événements, pas une économie.',
    caughtNone: 'Rien de tracé dans cette fenêtre : ni verdict du reviewer, ni garde déclenchée, ni carte promue, ni A/B. Les boucles qui produisent un reçu sont celles qui ne tournent pas.',
    timesOnRecord: (n) => `fois avec trace`,
    cRejected: (n) => `${n} exécution${n === 1 ? '' : 's'} de workflow renvoyée${n === 1 ? '' : 's'} par le reviewer avant merge`,
    cLoops: (n) => `${n} exécution${n === 1 ? '' : 's'} de boucle arrêtée${n === 1 ? '' : 's'} par un siège`,
    cGuard: (name, n) => `${name} a bloqué une commande ×${n}`,
    cPromoted: (n) => `${n} carte${n === 1 ? '' : 's'} de review promue${n === 1 ? '' : 's'} dans le contrat`,
    cAb: (subj, delta, max) => `A/B skill-loop sur ${subj} : ${delta} ${max ? `sur ${max}` : ''} avec le skill vs sans`,
    cPred: (v, f) => `${v} prédiction${v === 1 ? '' : 's'} de l'optimiseur vérifiée${v === 1 ? '' : 's'}, ${f} falsifiée${f === 1 ? '' : 's'}`,
    cLearn: (n) => `${n} leçon${n === 1 ? '' : 's'} écrite${n === 1 ? '' : 's'} dans un LEARNINGS.md`,
    cGreen: (t) => `tours jusqu'au vert sur les exécutions approuvées : ${t}`,
    cNudges: (n) => `plus ${n} rappel${n === 1 ? '' : 's'} de la garde de répétition (consultatif, non compté)`,
    caughtNot: 'Ce que cela ne prouve pas : ce qui aurait été livré sans le harnais. Personne n\'a exécuté ce bras. Chaque ligne est un événement ; le contrefactuel n\'en est pas un.',
    driving: 'Comment s\'est passée la conduite',
    drivingCmp: (n) => `Contre les ${n} jours précédents — taux pour 100 prompts, pour qu'un mois plus chargé ne se lise pas comme un mois pire.`,
    drivingQuiet: (n, s, p) => `Les ${n} jours précédant cette fenêtre étaient trop calmes pour comparer (${s} session${s === 1 ? '' : 's'}, ${p} prompts). Le mois prochain il y aura une base.`,
    drivingNoSince: 'Passez --since pour obtenir une comparaison avec la fenêtre précédente.',
    tContinua: '« continua » nu', tContinuaSub: (a, n) => `${a} sur ${n} juste après l'arrêt de l'agent`,
    tInterrupt: 'interrompus', tInterruptSub: (p) => `${p} de vos tours coupés en vol`,
    tModel: '/model à la main', tModelNone: 'aucune cible enregistrée',
    tCompact: 'compactions', tCompactSub: (a, avg) => `${a} automatique${a === 1 ? '' : 's'}${avg ? ` · moy. ${avg} tokens avant la coupe` : ''}`,
    drivingFine: (hp, ss, dr, dd, co) => `${hp} prompts humains sur ${ss} sessions. ${dr} tours qui semblaient humains mais écrits par une boucle à son propre sous-agent ont été écartés ; ${dd} enregistrement${dd === 1 ? '' : 's'} en double fusionné${dd === 1 ? '' : 's'}. ${co} tour${co === 1 ? '' : 's'} ont commencé comme une correction`,
    drivingFine2: '— les raisons tapées en refusant un appel, plus bas, sont les seules corrections ici qui ne sont pas une supposition.',
    breaking: 'Ce qui cassait encore et encore', breakingKicker: 'La panne la plus revenue. Une panne qui se répète est un check de preflight que personne n\'a écrit.',
    breakingNone: 'Rien n\'a échoué deux fois de la même façon dans cette fenêtre.',
    bossSub: (ss, last) => `fois, sur ${ss} · la dernière le ${last}`,
    bossTool: (t) => `Outil : <b>${t}</b>. Regroupé par les huit premiers mots de l'erreur, donc peut-être plusieurs causes sous le même message.`,
    toolsFine: (calls, errs) => `${calls} appels d'outils au total · ${errs} erreurs`,
    stale: (n) => `${n} édition${n === 1 ? '' : 's'} sur un fichier modifié depuis sa lecture`,
    retries: (n) => `${n} nouvelle${n === 1 ? '' : 's'} tentative${n === 1 ? '' : 's'} de transport, lentes plutôt qu'échouées`,
    toolsNone: (calls, errs) => `${calls} appels d'outils, ${errs} erreurs, aucune répétée.`,
    skills: 'Vos skills', skillsKicker: 'Ce que vous avez utilisé, ce qu\'il faut affûter, et ce qui ne coûte que du contexte. Faits du disque et des transcripts ; les décisions sont les vôtres.',
    topUsed: 'Les plus utilisés', usedNone: 'Rien n\'a été invoqué via l\'outil Skill ni par nom dans cette fenêtre.',
    notInstalled: 'non installé ici', outcomes: (o) => [o.interrupted ? `${o.interrupted} interrompu${o.interrupted === 1 ? '' : 's'}` : '', o.denied ? `${o.denied} refusé${o.denied === 1 ? '' : 's'}` : '', o.corrected ? `${o.corrected} corrigé${o.corrected === 1 ? '' : 's'}` : '', o.continued ? `${o.continued} « continua »` : ''].filter(Boolean).join(' · '),
    keep: 'Garder', keepSub: 'Utilisés, et rien après qui ressemble à un problème.',
    improve: 'Améliorer', improveSub: 'Utilisés au moins deux fois, avec une raison d\'ouvrir le fichier.',
    improveNone: 'Aucun skill utilisé ne montre de raison de l\'ouvrir.',
    rFollowed: (r) => `${r.rough} des ${r.uses} usages ont été suivis d'une interruption, d'un refus ou d'un tour en forme de correction (${[r.interrupted ? `${r.interrupted} interrompu${r.interrupted === 1 ? '' : 's'}` : '', r.denied ? `${r.denied} refusé${r.denied === 1 ? '' : 's'}` : '', r.corrected ? `${r.corrected} corrigé${r.corrected === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ')}) — proxy`,
    rLooped: (r) => `utilisé ${r.uses} fois et jamais passé par /skill-loop — pas de LEARNINGS.md à côté`,
    rOld: (r) => `utilisé ${r.uses} fois, SKILL.md intouché depuis ${r.ageDays} jours`,
    rHeavy: (r) => `${r.words} mots de contexte à chaque appel`,
    improveHow: (name) => `Une idée ? <code>/skill-loop ${name}</code> la mesure à l'aveugle, avec et sans.`,
    improveBundled: 'Livré avec le client, donc pas de SKILL.md à éditer : le correctif est une ligne dans AGENTS.md sur quand l\'appeler.',
    uninstall: 'Candidats à la désinstallation', uninstallSub: (n, total) => `${n} sur ${total} — jamais invoqués dans la fenêtre. Ceux du projet d'abord, car ils se chargent à chaque session.`,
    uninstallNone: 'Chaque skill installé a été invoqué au moins une fois.',
    uUnused: (r) => `jamais invoqué dans la fenêtre · ${r.words} mots chargés ${r.scope === 'project' ? 'à chaque session' : 'quand il correspond'}`,
    uDup: (r) => `installé deux fois : ${r.sources.join(' et ')}`,
    uDisabled: 'plugin désactivé dans settings — installé mais éteint',
    uStale: (r) => `SKILL.md intouché depuis ${r.ageDays} jours`,
    uninstallNot: 'Un skill dont la description s\'est déclenchée seule sans l\'outil Skill ne laisse aucune trace dans un transcript. Ceci est ce que l\'outil Skill a vu, pas la preuve qu\'un skill est inutile.',
    more: (n) => `et ${n} de plus`,
    usedNotInstalled: (list) => `Invoqués mais sans SKILL.md dans ce projet ni dans votre home : ${list} — un workflow, ou un skill livré par le client.`,
    distinct: (n) => `${n} skills distincts dans cette fenêtre`,
    reportCard: 'Bulletin',
    rcKicker: (date, age) => `Ce que votre dernier <code>/session-review</code> a proposé le ${date}, il y a ${age} jours, et où en est chaque carte. Cochée signifie que le dépôt la contient désormais.`,
    rcNever: 'La boucle 6 n\'a jamais tourné dans ce dépôt, donc rien n\'a jamais été proposé, promu ou rejeté avec trace.',
    promoted: 'promues', proposed: 'proposées', pending: 'en attente',
    rcUnreadable: (why) => `Le rapport existe mais ${why} — ce n'est pas la même chose que « pas encore de review ».`,
    rcHow: 'La promotion est vérifiée en cherchant dans le contrat et les skills de ce dépôt ce que chaque carte a cité. Une carte DISPATCH ou HABIT ne laisse rien sur disque à chercher, donc elle indique n/a plutôt qu\'en attente.',
    nextLesson: 'Prochaine leçon :', rcStarts: '— elle part désormais des cartes de ce rapport.',
    rcRun: 'Lancez <code>/session-review</code> une fois. Ensuite cette scène montre ce qu\'il a proposé et si vous l\'avez gardé.',
    rest: 'Le reste des cartes', restKicker: (n) => `${n} de plus, dans l'ordre. Ouvrez-en une pour ses preuves et ses limites. Aucune ne modifie quoi que ce soit — c'est vous qui promouvez.`,
    silent: (n, list) => `${n} règle${n === 1 ? '' : 's'} vérifiée${n === 1 ? '' : 's'} et silencieuse${n === 1 ? '' : 's'} : ${list}. Une règle sans preuve n'imprime rien — remplir un rapport pour garnir la grille, c'est ainsi qu'un instrument devient un horoscope.`,
    guards: 'Gardes, et les appels que vous avez refusés', guardsKicker: 'Ce qui a bloqué un appel par règle, et ce que vous avez bloqué à la main — avec la raison tapée.',
    gInstalled: (n, f, ss) => `<b>${n}</b> gardes installées · <b>${f}</b> déclenchement${f === 1 ? '' : 's'} sur ${ss}`,
    gNoList: 'hooks.json n\'est pas lisible d\'ici, donc aucune liste de gardes n\'est affichée — une liste vide se lirait comme « aucune installée ».',
    advisory: '(consultatif)',
    gFine: 'Un déclenchement est un résultat commençant par <code>harness-audit &lt;guard&gt;: blocked</code>. Zéro déclenchement ne veut pas dire que rien de dangereux ne s\'est produit ; les gardes sont prudentes par conception.',
    gOther: (n, list) => ` D'autres hooks ont tourné ${n} fois : ${list}.`,
    refused: (n, r) => `<b>${n}</b> appel${n === 1 ? '' : 's'} refusé${n === 1 ? '' : 's'}${r ? `, <b>${r}</b> avec une raison` : ''}`,
    refusedFine: 'Ce sont les seules corrections de ce rapport qui ne sont pas un proxy : vous les avez tapées. Chacune est une ligne candidate pour AGENTS.md, et c\'est vous qui la promouvez.',
    refusedNone: 'Aucun refus ne portait de raison tapée dans cette fenêtre.',
    ledger: 'Le grand livre', ledgerKicker: 'Tokens, coût, workflows, économies — la comptabilité qui était tout le rapport. Ouvrez-le quand il vous faut un chiffre.',
    lAgents: 'Tokens par agent × modèle', lUnpriced: (l) => `est.$ exclut les modèles sans prix : ${l} — un plancher, pas un total.`, lIntro: (l) => `au tarif de lancement : ${l}`,
    lLineup: 'Line-up des modèles — configuré vs observé', lDrift: '⚠ = dérive : le rôle a tourné sur une autre famille de modèle que celle configurée dans model-lineup.json.',
    lDays: 'Tokens par jour', lWorkflows: 'Activations de workflow', lLoops: 'Exécutions de boucle (findings JSON)', lSavings: 'Économies — contrefactuels mesurés seulement',
    lNoAb: 'Aucune exécution à deux bras dans le périmètre — /skill-loop est la seule boucle qui en produit.',
    lNoPred: 'Pas de process-log.md — /iterate n\'a jamais tourné dans ce dépôt.',
    lPredUnread: (w) => `process-log.md existe mais son registre est illisible (${w}) — <b>aucune prédiction comptée</b>, ce qui n'est pas la même chose qu'aucune falsifiée.`,
    lPred: (v, f, p, u) => `Prédictions de l'optimiseur : <b>${v} vérifiées · ${f} falsifiées · ${p} en attente · ${u} illisibles</b>.`,
    lGreen: (t) => ` Tours jusqu'au vert ${t} — un proxy, explicitement pas une économie.`, lNoGreen: ' Aucune exécution develop-phase approuvée dans le périmètre.',
    lNoMult: ' Rien ici n\'est un multiplicateur ; une quantité non mesurée est imprimée n/a avec sa raison.',
    lNoRepo: 'Aucun contrefactuel dans le périmètre — passez --repo pour lire loop-runs et process-log.md.',
    lPredictions: 'Prédictions de l\'optimiseur', lLearnings: 'Apprentissages', lPrompts: 'Prompts',
    lPromptsFine: (t, w, sd, fu) => `${t} tours utilisateur · ${w} mots en moyenne · ${sd} sessions/jour · ${fu} de suivi`,
    lTurns: '. Ce sont des tours, pas des frappes : une boucle qui re-prompte sa session en écrit un aussi.',
    lEvery: 'Tous les outils',
    footer: 'chaque chiffre est mesuré à partir des transcripts locaux et des registres de boucle du dépôt. Les cartes sont des recommandations par règle : chacune imprime sa preuve, le champ d\'où elle vient et ce qu\'elle ne prouve pas, et une règle sans preuve n\'imprime rien. est.$ est prix catalogue × tokens mesurés, jamais un multiplicateur. Une comparaison n\'est montrée que là où la fenêtre précédente était assez active pour l\'ancrer. Rien ici ne modifie quoi que ce soit — c\'est vous qui promouvez.',
    unreadableLines: (n) => ` ${n} ligne(s) de transcript n'ont pas pu être lues.`,
    tooQuiet: 'trop calme avant pour comparer', same: '▪ comme avant', per100: 'pour 100 prompts', better: 'mieux', worse: 'pire',
    warn: 'alerte', info: 'info', prune: 'élaguer', failure: 'panne',
    types: { HABIT: 'habitude', DISPATCH: 'dispatch', 'SKILL CANDIDATE': 'skill candidat', 'AGENTS.md RULE': 'règle AGENTS.md', LIFECYCLE: 'cycle de vie', DASHBOARD: 'dashboard', HARNESS: 'harnais' },
  },
};

// The cards' own words, per rule. The JSON keeps English — it is the contract validate.js and
// /session-review read — and the report swaps the display text. A rule with no entry here renders
// in English rather than in a guess.
const RULE_I18N = {
  'harness-caught': {
    es: { headline: (d) => `el arnés dijo que no ${d.caught.total} ${d.caught.total === 1 ? 'vez' : 'veces'} con registro`, recommendation: 'nada que hacer: esto es el recibo. Cuando la lista es corta, los loops que la producen (/review-loop, /session-review, /skill-loop) son los que no están corriendo', doesNotProve: 'qué habría salido sin el arnés — nadie corrió ese brazo; cada línea es un evento, el contrafactual no' },
    fr: { headline: (d) => `le harnais a dit non ${d.caught.total} fois avec trace`, recommendation: 'rien à faire : c\'est le reçu. Quand la liste est courte, les boucles qui la produisent (/review-loop, /session-review, /skill-loop) sont celles qui ne tournent pas', doesNotProve: 'ce qui aurait été livré sans le harnais — personne n\'a exécuté ce bras ; chaque ligne est un événement, le contrefactuel n\'en est pas un' },
  },
  'continue-token': {
    es: { headline: (d) => `${d.hygiene.continuations.count} turnos de «continua» a secas — ${d.hygiene.continuations.afterAgentTurn} de ellos justo después de que el agente terminó`, recommendation: 'el agente termina su turno antes de terminar la unidad de trabajo. Regla candidata para AGENTS.md: terminar la unidad o decir qué falta antes de parar; o más effort en tareas largas', doesNotProve: 'que el agente hiciera mal en parar — un humano marcando el ritmo produce la misma forma' },
    fr: { headline: (d) => `${d.hygiene.continuations.count} tours « continua » nus — ${d.hygiene.continuations.afterAgentTurn} juste après la fin du tour de l'agent`, recommendation: 'l\'agent termine son tour avant la fin de l\'unité de travail. Règle candidate pour AGENTS.md : finir l\'unité ou dire ce qui manque avant de s\'arrêter ; ou plus d\'effort sur les tâches longues', doesNotProve: 'que l\'agent a eu tort de s\'arrêter — un humain qui donne le rythme produit la même forme' },
  },
  'manual-model-switch': {
    es: { headline: (d) => `/model tipeado ${d.hygiene.modelSwitches.count} veces en esta ventana`, recommendation: 'una decisión que tomás a mano cada sesión. Configurala una vez: settings.model para el hilo principal, model: por archivo de agente, o el line-up para los roles', doesNotProve: 'que alguno de esos destinos sea el mejor modelo — ninguna corrida acá los compara' },
    fr: { headline: (d) => `/model tapé ${d.hygiene.modelSwitches.count} fois dans cette fenêtre`, recommendation: 'une décision prise à la main à chaque session. Configurez-la une fois : settings.model pour le fil principal, model: par fichier d\'agent, ou le line-up pour les rôles', doesNotProve: 'qu\'une de ces cibles soit le meilleur modèle — aucune exécution ici ne les compare' },
  },
  'skill-shelfware': {
    es: { headline: (d) => `${d.skills.installedNotUsed.project.length} de los ${d.skills.installedNotUsed.projectTotal} skills instalados en este proyecto nunca se invocaron acá`, recommendation: 'cada SKILL.md cuesta contexto en cada sesión. Podá, o hacé la invocación explícita en AGENTS.md para que el uso sea observable', doesNotProve: 'que un skill sea inútil — una descripción que se disparó sola sin la tool Skill no deja rastro acá' },
    fr: { headline: (d) => `${d.skills.installedNotUsed.project.length} des ${d.skills.installedNotUsed.projectTotal} skills installés dans ce projet n'ont jamais été invoqués ici`, recommendation: 'chaque SKILL.md coûte du contexte à chaque session. Élaguez, ou rendez l\'invocation explicite dans AGENTS.md pour que l\'usage devienne observable', doesNotProve: 'qu\'un skill soit inutile — une description déclenchée seule sans l\'outil Skill ne laisse aucune trace ici' },
  },
  'skill-used-not-installed': {
    es: { headline: (d) => `${d.skills.usedNotInstalled.length} nombre(s) invocados que ningún SKILL.md ni comando de acá define`, recommendation: 'un workflow, o un skill que se quitó después de que quedó el hábito de llamarlo. Si es un workflow, nada que hacer; si se quitó, el hábito sobrevivió al archivo', doesNotProve: 'nada sobre la calidad — solo que el nombre y el disco no coinciden' },
    fr: { headline: (d) => `${d.skills.usedNotInstalled.length} nom(s) invoqués qu'aucun SKILL.md ni commande d'ici ne définit`, recommendation: 'un workflow, ou un skill retiré après que l\'habitude de l\'appeler est restée. Si c\'est un workflow, rien à faire ; s\'il a été retiré, l\'habitude a survécu au fichier', doesNotProve: 'rien sur la qualité — seulement que le nom et le disque ne concordent pas' },
  },
  'repeated-crash': {
    es: { headline: (d) => `el mismo fallo volvió ${d.tools.errorClusters[0].count} veces en ${d.tools.errorClusters[0].sessions} sesión(es)`, recommendation: 'un fallo que se repite es un check de preflight que nadie escribió. Agregalo al preflight del proyecto, o registrá el arreglo en el LEARNINGS.md del skill', doesNotProve: 'que todos compartan la misma causa raíz — la firma son las primeras ocho palabras del error' },
    fr: { headline: (d) => `la même panne est revenue ${d.tools.errorClusters[0].count} fois sur ${d.tools.errorClusters[0].sessions} session(s)`, recommendation: 'une panne qui se répète est un check de preflight que personne n\'a écrit. Ajoutez-le au preflight du projet, ou notez le correctif dans le LEARNINGS.md du skill', doesNotProve: 'qu\'elles partagent toutes la même cause — la signature est les huit premiers mots de l\'erreur' },
  },
  'denials-as-rules': {
    es: { headline: (d) => `${d.tools.denials.count} llamadas que rechazaste — ${d.tools.denials.reasons.length} con una razón tipeada`, recommendation: 'una razón de rechazo es la única corrección de este informe que no es un proxy. Cada una es una línea candidata para AGENTS.md; la card busca el contrato y dice si ya está', doesNotProve: 'que la regla pertenezca a AGENTS.md — puede ser de un skill. Vos promovés' },
    fr: { headline: (d) => `${d.tools.denials.count} appels refusés — ${d.tools.denials.reasons.length} avec une raison tapée`, recommendation: 'une raison de refus est la seule correction de ce rapport qui ne soit pas un proxy. Chacune est une ligne candidate pour AGENTS.md ; la carte cherche le contrat et dit si elle y est déjà', doesNotProve: 'que la règle appartienne à AGENTS.md — elle peut relever d\'un skill. C\'est vous qui promouvez' },
  },
  'interrupt-rate': {
    es: { headline: (d) => `${d.hygiene.interrupts} turnos interrumpidos — ${pctOf(d.hygiene.interrupts, d.hygiene.humanPrompts)} de tus prompts`, recommendation: 'interrumpir es corregir el rumbo a mano. Unidades de trabajo más chicas o plan mode antes de una tarea larga reducen las veces que hace falta', doesNotProve: 'que los turnos interrumpidos fueran mal — cortar un turno correcto antes de tiempo se ve idéntico' },
    fr: { headline: (d) => `${d.hygiene.interrupts} tours interrompus — ${pctOf(d.hygiene.interrupts, d.hygiene.humanPrompts)} de vos prompts`, recommendation: 'interrompre, c\'est corriger le cap à la main. Des unités de travail plus petites ou le plan mode avant une longue tâche réduisent les fois où c\'est nécessaire', doesNotProve: 'que les tours interrompus allaient mal — couper tôt un tour correct se voit pareil' },
  },
  'compaction-pressure': {
    es: { headline: (d) => `${d.hygiene.compactions.auto} compactaciones automáticas — la sesión se cortó sin tu mano`, recommendation: 'un resumen es un handoff con pérdida. Corré /handoff y abrí sesión nueva antes de que la auto-compactación lo haga por vos', doesNotProve: 'que las sesiones cortas sean mejores — solo que las largas se cortaron sin tu mano' },
    fr: { headline: (d) => `${d.hygiene.compactions.auto} compactions automatiques — la session a été coupée sans votre main`, recommendation: 'un résumé est un handoff avec perte. Lancez /handoff et ouvrez une nouvelle session avant que l\'auto-compaction ne le fasse pour vous', doesNotProve: 'que les sessions courtes soient meilleures — seulement que les longues ont été coupées sans votre main' },
  },
  'hand-dispatched-role': {
    es: { headline: (d) => `un rol de .claude/agents lanzado a mano — un rol que este repo ya define`, recommendation: 'criterio de despacho candidato (D23): cuándo el rol se lanza solo. Lanzarlo a mano cada vez es hacer de despachador', doesNotProve: 'que un workflow hubiera sido más barato — sin contrafactual' },
    fr: { headline: (d) => `un rôle de .claude/agents lancé à la main — un rôle que ce dépôt définit déjà`, recommendation: 'critère de dispatch candidat (D23) : quand le rôle se lance seul. Le lancer à la main à chaque fois, c\'est faire le dispatcher', doesNotProve: 'qu\'un workflow aurait été moins cher — pas de contrefactuel' },
  },
  'main-thread-heavy': {
    es: { headline: (d) => `el hilo principal es el ${pctOf(d.agents.filter((a) => a.agentType === 'main').reduce((n, a) => n + a.costUsd, 0), d.totals.costUsd)} del gasto con precio`, recommendation: 'la conversación cuesta más que los agentes que despacha. Delegar exploración e implementación a subagentes mueve tokens a modelos más baratos y contextos más chicos', doesNotProve: 'que delegar hubiera costado menos — sin contrafactual no se afirma ningún ahorro' },
    fr: { headline: (d) => `le fil principal représente ${pctOf(d.agents.filter((a) => a.agentType === 'main').reduce((n, a) => n + a.costUsd, 0), d.totals.costUsd)} de la dépense tarifée`, recommendation: 'la conversation coûte plus que les agents qu\'elle dispatch. Déléguer exploration et implémentation à des sous-agents déplace les tokens vers des modèles moins chers et des contextes plus petits', doesNotProve: 'que déléguer aurait coûté moins — sans contrefactuel aucune économie n\'est affirmée' },
  },
  'unpriced-model': {
    es: { headline: (d) => `${d.unpricedModels.join(', ')} no tiene precio de lista acá`, recommendation: 'verificá el precio de lista y agregalo a PRICE_PER_MTOK. Nunca de memoria: un precio inventado es peor que ninguno', doesNotProve: 'nada sobre el trabajo — solo que la contabilidad es un piso' },
    fr: { headline: (d) => `${d.unpricedModels.join(', ')} n'a pas de prix catalogue ici`, recommendation: 'vérifiez le prix catalogue et ajoutez-le à PRICE_PER_MTOK. Jamais de mémoire : un prix inventé est pire qu\'aucun', doesNotProve: 'rien sur le travail — seulement que la comptabilité est un plancher' },
  },
  'review-pending': {
    es: { headline: (d) => `${d.reviews.latest.pending} card(s) del último /session-review siguen abiertas después de ${d.reviews.latest.ageDays} días`, recommendation: 'promovela, o rechazala en el informe para que deje de aparecer acá', doesNotProve: 'que la rechazaras — una card rechazada es un resultado válido, y nada en disco registra esa decisión' },
    fr: { headline: (d) => `${d.reviews.latest.pending} carte(s) du dernier /session-review encore ouvertes après ${d.reviews.latest.ageDays} jours`, recommendation: 'promouvez-la, ou rejetez-la dans le rapport pour qu\'elle cesse d\'apparaître ici', doesNotProve: 'que vous l\'ayez rejetée — une carte rejetée est un résultat valide, et rien sur disque n\'enregistre cette décision' },
  },
  'review-stale': {
    es: { headline: (d) => (d.reviews && d.reviews.latest ? `el último /session-review tiene ${d.reviews.latest.ageDays} días` : `${d.hygiene.sessions} sesiones y ningún /session-review todavía`), recommendation: 'corré /session-review — ahora arranca desde las cards de este informe, no del corpus crudo', doesNotProve: 'nada — es una cadencia, no un hallazgo' },
    fr: { headline: (d) => (d.reviews && d.reviews.latest ? `le dernier /session-review date de ${d.reviews.latest.ageDays} jours` : `${d.hygiene.sessions} sessions et aucun /session-review encore`), recommendation: 'lancez /session-review — il part désormais des cartes de ce rapport, pas du corpus brut', doesNotProve: 'rien — c\'est une cadence, pas une trouvaille' },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// RENDER-HTML — one self-contained file: no CDN, no webfont, no script, no fetch.
//
// The report is a recap, read top to bottom: one idea per scene, the number first, the sentence
// second, the evidence third, and the thing to do about it before the next scene. The pixel-art
// identity lives in the chrome — numerals, icons, borders, block bars — and the reading text is set
// in the system's own sans at a size a person can read after a long day. A webfont would be a
// network call from a report whose whole promise is that nothing leaves the machine, so there is
// none: the pixel numerals below are drawn, not typed.
// ─────────────────────────────────────────────────────────────────────────────

// Every value that reaches the HTML goes through this — prompts, denial reasons and error text are
// verbatim user and tool output, and a report that renders them raw is a script injection with a
// green theme.
const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// A 5×7 pixel glyph set for the numerals and the few symbols a number needs. '#' is a lit pixel.
const PIXEL_GLYPHS = {
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  ',': ['.....', '.....', '.....', '.....', '.##..', '..#..', '.#...'],
  '%': ['##..#', '##.#.', '...#.', '..#..', '.#...', '#.##.', '#..##'],
  '$': ['..#..', '.####', '#.#..', '.###.', '..#.#', '####.', '..#..'],
  'k': ['#....', '#....', '#..#.', '#.#..', '##...', '#.#..', '#..#.'],
  'M': ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  '+': ['.....', '..#..', '..#..', '#####', '..#..', '..#..', '.....'],
  '/': ['....#', '...#.', '...#.', '..#..', '.#...', '.#...', '#....'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
  'L': ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  'O': ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  'P': ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  'S': ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  'T': ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  'A': ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
};

// Pixel numerals as inline SVG. `px` is the size of one pixel; the glyph is 5 wide with a 1-px gap.
function pixelText(text, px = 6, color = 'currentColor') {
  const chars = [...String(text)].map((c) => PIXEL_GLYPHS[c] || PIXEL_GLYPHS[' ']);
  const w = chars.length * 6 - 1;
  const rects = [];
  chars.forEach((g, ci) => g.forEach((rowStr, y) => [...rowStr].forEach((bit, x) => {
    if (bit === '#') rects.push(`<rect x="${ci * 6 + x}" y="${y}" width="1" height="1"/>`);
  })));
  return `<svg class="px" viewBox="0 0 ${w} 7" width="${w * px}" height="${7 * px}" shape-rendering="crispEdges" fill="${color}" aria-label="${esc(String(text))}" role="img">${rects.join('')}</svg>`;
}

// 9×9 pixel icons, same encoding. Decorative — every one sits next to the word it illustrates.
const PIXEL_ICONS = {
  check: ['.........', '.......#.', '......##.', '.....##..', '.#..##...', '.####....', '..##.....', '.........', '.........'],
  box: ['#########', '#.......#', '#.......#', '#.......#', '#.......#', '#.......#', '#.......#', '#.......#', '#########'],
  dash: ['.........', '.........', '.........', '.........', '..#####..', '.........', '.........', '.........', '.........'],
  warn: ['....#....', '...###...', '...#.#...', '..##.##..', '..#.#.#..', '.##.#.##.', '.#.....#.', '#########', '.........'],
  skull: ['..#####..', '.#######.', '##.###.##', '##.###.##', '#########', '.##.#.##.', '..#####..', '..#.#.#..', '..#####..'],
  star: ['....#....', '....#....', '...###...', '#########', '.#######.', '..#####..', '..##.##..', '.##...##.', '.........'],
  flag: ['#........', '#######..', '#......#.', '#......#.', '#######..', '#........', '#........', '#........', '#........'],
  bolt: ['....##...', '...##....', '..##.....', '.######..', '....##...', '...##....', '..##.....', '.##......', '#........'],
  loop: ['..#####..', '.#.....#.', '#.......#', '#.......#', '#.......#', '.#..#..#.', '....##...', '....###..', '....####.'],
  cut: ['##.....##', '###...###', '.###.###.', '..#####..', '...###...', '..#####..', '.###.###.', '###...###', '##.....##'],
  swap: ['..#......', '.##......', '#######..', '.##......', '..#......', '......#..', '......##.', '..#######', '......##.'],
  shield: ['.#######.', '#########', '#..###..#', '#..###..#', '#########', '.#######.', '..#####..', '...###...', '....#....'],
  lesson: ['.........', '#########', '#.......#', '#.#####.#', '#.......#', '#.#####.#', '#.......#', '#########', '.........'],
  stop: ['..#####..', '.#######.', '#########', '#########', '#########', '#########', '#########', '.#######.', '..#####..'],
  wrench: ['......##.', '.....####', '.....#.##', '....###..', '...###...', '..###....', '.###.....', '###......', '##.......'],
  trash: ['..#####..', '#########', '.#.....#.', '.#.#.#.#.', '.#.#.#.#.', '.#.#.#.#.', '.#.#.#.#.', '.#.....#.', '.#######.'],
};
function pixelIcon(name, px = 3, color = 'currentColor') {
  const g = PIXEL_ICONS[name] || PIXEL_ICONS.box;
  const rects = [];
  g.forEach((rowStr, y) => [...rowStr].forEach((bit, x) => { if (bit === '#') rects.push(`<rect x="${x}" y="${y}" width="1" height="1"/>`); }));
  return `<svg class="ico" viewBox="0 0 9 9" width="${9 * px}" height="${9 * px}" shape-rendering="crispEdges" fill="${color}" aria-hidden="true">${rects.join('')}</svg>`;
}

// A number for a pixel headline: compact, and never more characters than a glance can take in.
const heroNum = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));
const withCommas = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

function renderHtml(d, lang = 'en') {
  const S = STR[lang] || STR.en;
  const h = d.hygiene;
  const t = d.tools;
  const g = d.guards;
  const sk = d.skills;
  const rv = d.reviews;
  const cg = d.caught;
  const prev = d.previous;
  const cards = d.cards || [];
  const days = d.window === 'all' ? null : Math.round((Date.parse(d.generatedAt) - Date.parse(d.window)) / 864e5);
  const windowLabel = days ? S.lastDays(days) : S.allHistory;
  // A slug cannot be turned back into a path (every dash is ambiguous); the repo basename can.
  const projectName = sk && sk.repo ? path.basename(sk.repo) : d.project;
  const sessionsWord = (n) => `${n} ${S.sessions}`;

  // Display text for a card: the rule's own words in the report's language, English otherwise.
  const words = (c) => {
    const i = RULE_I18N[c.rule] && RULE_I18N[c.rule][lang];
    if (!i) return { headline: c.headline, recommendation: c.recommendation, doesNotProve: c.doesNotProve };
    let headline = c.headline;
    try { headline = i.headline(d); } catch { /* a field the rule needs is absent in this aggregate: keep English */ }
    return { headline, recommendation: i.recommendation, doesNotProve: i.doesNotProve };
  };

  // ── delta chips, only where a comparison is honest ──────────────────────
  // Hygiene counts are compared as rates per 100 human prompts, because a busier month has more of
  // everything; sessions and cost are compared raw. `lowerIsBetter` decides the colour, never the
  // arithmetic. When the previous window is too thin the chip says so instead of a percentage.
  const rate = (n, per) => (per ? (n / per) * 100 : 0);
  const chip = (nowN, prevN, { asRate = true, lowerIsBetter = true, unit = '' } = {}) => {
    if (!prev) return '';
    if (!prev.comparable) return `<span class="chip mute" title="${prev.sessions} ${S.sessions}, ${prev.humanPrompts} prompts">${S.tooQuiet}</span>`;
    const a = asRate ? rate(nowN, h.humanPrompts) : nowN;
    const b = asRate ? rate(prevN, prev.humanPrompts) : prevN;
    const diff = a - b;
    if (Math.abs(diff) < 0.5) return `<span class="chip mute">${S.same}</span>`;
    const better = lowerIsBetter ? diff < 0 : diff > 0;
    const arrow = diff < 0 ? '▼' : '▲';
    const val = asRate ? `${Math.abs(diff).toFixed(1)} ${S.per100}` : `${withCommas(Math.abs(diff))}${unit}`;
    return `<span class="chip ${better ? 'good' : 'bad'}">${arrow} ${val} ${better ? S.better : S.worse}</span>`;
  };

  // ── shared bits ─────────────────────────────────────────────────────────
  const pill = (cls, label) => `<span class="pill ${cls}">${esc(label)}</span>`;
  const typeLabel = (type) => (S.types[type] || type.toLowerCase());
  const sevLabel = (c) => (c.severity === 'warn' ? S.warn : S.info);
  const typeIcon = { HABIT: 'loop', DISPATCH: 'swap', 'SKILL CANDIDATE': 'star', 'AGENTS.md RULE': 'flag', LIFECYCLE: 'lesson', DASHBOARD: 'box', HARNESS: 'shield' };
  const blocks = (n, of, cls = '') => {
    const total = Math.max(1, Math.min(20, of));
    const lit = Math.round((Math.min(n, of) / Math.max(1, of)) * total);
    return `<span class="bar ${cls}" aria-hidden="true">${'<i class="on"></i>'.repeat(lit)}${'<i></i>'.repeat(total - lit)}</span>`;
  };
  const scene = (num, title, kicker, body, cls = '') => `<section class="scene ${cls}" id="s${num}">
    <header class="sh"><span class="num">${pixelText(String(num).padStart(2, '0'), 3)}</span><h2>${title}</h2>${kicker ? `<p class="kicker">${kicker}</p>` : ''}</header>
    ${body}
  </section>`;
  const cardFull = (c) => { const w = words(c); return `<article class="card ${c.severity}">
      <div class="top">${pixelIcon(typeIcon[c.type] || 'box', 2)}${pill('type', typeLabel(c.type))}${pill(c.severity, sevLabel(c))}<span class="rid">${esc(c.rule)}</span></div>
      <h3>${esc(w.headline)}</h3>
      <p class="ev">${esc(c.evidence)}</p>
      <p class="rec"><b>${S.whatToDo}</b> ${esc(w.recommendation)}</p>
      <p class="not"><b>${S.notProve}</b> ${esc(w.doesNotProve)}</p>
      <span class="src">${esc(c.source)}</span>
    </article>`; };
  const cardRow = (c) => { const w = words(c); return `<details class="crow ${c.severity}">
      <summary>${pixelIcon(typeIcon[c.type] || 'box', 2)}<span class="ct">${esc(typeLabel(c.type))}</span><span class="ch">${esc(w.headline)}</span><span class="rid">${esc(c.rule)}</span></summary>
      <div class="cbody"><p class="ev">${esc(c.evidence)}</p>
      <p class="rec"><b>${S.whatToDo}</b> ${esc(w.recommendation)}</p>
      <p class="not"><b>${S.notProve}</b> ${esc(w.doesNotProve)}</p></div>
    </details>`; };

  // ── 00 cover ────────────────────────────────────────────────────────────
  const cover = `<header class="cover">
    <p class="eyebrow">${S.eyebrow}</p>
    <h1><span class="pxtitle">${pixelText('LOOP-STATS', 4)}</span><span class="proj">${esc(projectName)}</span></h1>
    <p class="lede">${windowLabel}${days ? `, ${esc(d.window.slice(0, 10))} → ${esc(d.generatedAt.slice(0, 10))}` : ''}. ${S.readHere}</p>
    <div class="heroes">
      <div class="hero"><div class="hv">${pixelText(String(h ? h.sessions : d.totals.runs), 7)}</div><div class="hl">${S.sessions}</div>${prev && prev.comparable ? chip(h ? h.sessions : 0, prev.sessions, { asRate: false, lowerIsBetter: false }) : ''}</div>
      <div class="hero"><div class="hv">${pixelText(String(h ? h.humanPrompts : d.prompts.total), 7)}</div><div class="hl">${S.asked}</div></div>
      <div class="hero"><div class="hv">${pixelText(`$${heroNum(d.totals.costUsd)}`, 7)}</div><div class="hl">${S.spend}${d.unpricedModels.length ? ` ${S.floor}` : ''}</div>${prev && prev.comparable ? chip(d.totals.costUsd, prev.costUsd, { asRate: false, lowerIsBetter: true, unit: '$' }) : ''}</div>
    </div>
    <p class="lede">${cards.length ? S.attention(cards.length, d.rulesSilent.length) : S.noCards}</p>
  </header>`;

  // ── 01 the one thing ────────────────────────────────────────────────────
  const stageCards = cards.filter((c) => c.rule !== 'harness-caught');
  const first = stageCards[0];
  const oneThing = first ? scene(1, S.startHere, S.startKicker, cardFull(first), 'stage') : '';

  // ── 02 what the harness stopped ─────────────────────────────────────────
  const caughtLines = [];
  if (cg) {
    if (cg.rejected.length) caughtLines.push(['stop', S.cRejected(cg.rejected.length), cg.rejected.slice(0, 4).map((r) => `${r.name} · ${r.date}${r.rounds ? ` · ×${r.rounds}` : ''}`).join('  ·  ')]);
    if (cg.rejectedLoops.length) caughtLines.push(['stop', S.cLoops(cg.rejectedLoops.length), cg.rejectedLoops.slice(0, 4).map((r) => `${r.loop} · ${r.date || '?'}${r.stoppedBy ? ` · ${r.stoppedBy}` : ''}`).join('  ·  ')]);
    for (const gf of cg.guardFires) caughtLines.push(['shield', S.cGuard(gf.name, gf.fires), '']);
    if (cg.promoted.length) caughtLines.push(['check', S.cPromoted(cg.promoted.length), cg.promoted.map((c) => `${clip(c.text, 80)} → ${c.evidence}`).join('  ·  ')]);
    for (const a of cg.ab) caughtLines.push(['star', S.cAb(a.subject, `${a.deltaScore >= 0 ? '+' : ''}${a.deltaScore}`, a.scoreMax), '']);
    if (cg.predictions.verified || cg.predictions.falsified) caughtLines.push(['flag', S.cPred(cg.predictions.verified, cg.predictions.falsified), '']);
    if (cg.learnings) caughtLines.push(['lesson', S.cLearn(cg.learnings), '']);
    if (cg.roundsToGreen.length) caughtLines.push(['loop', S.cGreen(cg.roundsToGreen.join(' · ')), '']);
  }
  const caughtScene = scene(2, S.caught, S.caughtKicker, cg && cg.total
    ? `<div class="receipt">
      <div class="rhead">${pixelIcon('shield', 5, 'var(--gold)')}<div class="rv">${pixelText(String(cg.total), 9, 'var(--gold)')}</div><div class="rt">${S.timesOnRecord(cg.total)}</div></div>
      <ul class="rlist">${caughtLines.map(([ic, line, detail]) => `<li>${pixelIcon(ic, 2, 'var(--gold)')}<div><span class="rl">${esc(line)}</span>${detail ? `<span class="rd">${esc(detail)}</span>` : ''}</div></li>`).join('')}</ul>
      ${cg.nudges ? `<p class="fine">${S.cNudges(cg.nudges)}</p>` : ''}
      <p class="fine">${S.caughtNot}</p>
    </div>`
    : `<p class="fine">${S.caughtNone}</p>`, 'gold');

  // ── 03 how the driving went ─────────────────────────────────────────────
  const tile = (icon, label, n, sub, chipHtml, hot) => `<div class="tile${hot ? ' hot' : ''}">
      <div class="tl">${pixelIcon(icon, 2)}<span>${label}</span></div>
      <div class="tv">${pixelText(String(n), 4)}</div>
      <div class="ts">${sub}</div>${chipHtml}</div>`;
  const driving = !h ? '' : scene(3, S.driving, prev && prev.comparable
    ? S.drivingCmp(days)
    : prev ? S.drivingQuiet(days, prev.sessions, prev.humanPrompts) : S.drivingNoSince,
  `<div class="tiles">
    ${tile('loop', S.tContinua, h.continuations.count, S.tContinuaSub(h.continuations.afterAgentTurn, h.continuations.count), chip(h.continuations.count, prev ? prev.continuations : 0), h.continuations.count >= 5)}
    ${tile('bolt', S.tInterrupt, h.interrupts, S.tInterruptSub(h.humanPrompts ? pct(h.interrupts / h.humanPrompts) : '0%'), chip(h.interrupts, prev ? prev.interrupts : 0), h.interrupts >= 10)}
    ${tile('swap', S.tModel, h.modelSwitches.count, esc(Object.entries(h.modelSwitches.targets).slice(0, 3).map(([k, v]) => `${k} ×${v}`).join(' · ')) || S.tModelNone, chip(h.modelSwitches.count, prev ? prev.modelSwitches : 0), h.modelSwitches.count >= 5)}
    ${tile('cut', S.tCompact, h.compactions.count, S.tCompactSub(h.compactions.auto, h.compactions.avgPreTokens ? human(h.compactions.avgPreTokens) : ''), chip(h.compactions.count, prev ? prev.compactions : 0), h.compactions.auto >= 3)}
  </div>
  <p class="fine">${S.drivingFine(h.humanPrompts, h.sessions, h.droppedAgentShaped, h.dedupedRecords, h.corrections.count)} <span class="proxy">proxy</span> ${S.drivingFine2}</p>`);

  // ── 04 what kept breaking ───────────────────────────────────────────────
  const boss = t && t.errorClusters[0];
  const breaking = !t ? '' : scene(4, S.breaking, boss ? S.breakingKicker : S.breakingNone,
    boss ? `<div class="boss">
      <div class="bl">${pixelIcon('skull', 5, 'var(--red)')}<div class="bv">${pixelText(`${boss.count}`, 8, 'var(--red)')}</div><div class="bt">${S.bossSub(sessionsWord(boss.sessions), esc(String(boss.lastAt).slice(0, 10)))}</div></div>
      <blockquote class="quote">${esc(clip(boss.sample, 220))}</blockquote>
      <p class="fine">${S.bossTool(esc(boss.tool || '?'))}</p>
    </div>
    ${t.errorClusters.length > 1 ? `<ul class="list">${t.errorClusters.slice(1, 5).map((c) => `<li><span class="n">×${c.count}</span> <span class="q">${esc(clip(c.sample, 110))}</span></li>`).join('')}</ul>` : ''}
    <p class="fine">${S.toolsFine(withCommas(t.totalCalls), t.totalErrors)}${t.staleEdits ? ` · ${S.stale(t.staleEdits)}` : ''}${t.apiErrors ? ` · ${S.retries(t.apiErrors)}` : ''}. ${chip(t.totalErrors, prev ? prev.toolErrors : 0)}</p>`
      : `<p class="fine">${S.toolsNone(withCommas(t.totalCalls), t.totalErrors)} ${chip(t.totalErrors, prev ? prev.toolErrors : 0)}</p>`);

  // ── 05 your skills ──────────────────────────────────────────────────────
  const used = sk ? sk.used.filter((u) => (u.viaSkillTool > 0 || u.sources.length > 0) && u.viaSkillTool + u.viaSlash > 0) : [];
  const adv = sk && sk.advice ? sk.advice : { keep: [], improve: [], uninstall: [], uninstallTotal: 0 };
  const medal = (i) => (i === 0 ? pixelIcon('star', 3, 'var(--gold)') : i === 1 ? pixelIcon('star', 3, 'var(--ink-dim)') : i === 2 ? pixelIcon('star', 3, 'var(--bronze)') : `<span class="rank">${i + 1}</span>`);
  const reasonText = (r) => ({
    'followed-by-correction': S.rFollowed, 'never-looped': S.rLooped, 'old-for-its-use': S.rOld, heavy: S.rHeavy,
    unused: S.uUnused, duplicate: S.uDup, disabled: () => S.uDisabled, stale: S.uStale,
  }[r.code] || (() => r.code))(r);
  const topList = used.length ? `<ol class="ranked">${used.slice(0, 6).map((u, i) => `<li>${medal(i)}<span class="name">${esc(u.name)}</span>${blocks(u.viaSkillTool + u.viaSlash, used[0].viaSkillTool + used[0].viaSlash, 'gold')}<span class="cnt">×${u.viaSkillTool + u.viaSlash}</span><span class="where">${esc(u.sources.join(', ') || S.notInstalled)}${u.outcomes && S.outcomes(u.outcomes) ? ` · ${esc(S.outcomes(u.outcomes))}` : ''}</span></li>`).join('')}</ol>` : `<p class="fine">${S.usedNone}</p>`;
  const improveList = adv.improve.length ? `<ul class="advice">${adv.improve.slice(0, 6).map((x) => `<li>${pixelIcon('wrench', 2, 'var(--amber)')}<div><span class="an">${esc(x.name)} <span class="mute">×${x.uses}</span></span>
      <ul class="why">${x.reasons.map((r) => `<li>${esc(reasonText(r))}</li>`).join('')}</ul>
      <span class="how">${x.editable ? S.improveHow(esc(x.name)) : S.improveBundled}</span></div></li>`).join('')}</ul>` : `<p class="fine">${S.improveNone}</p>`;
  const uninstallList = adv.uninstall.length ? `<ul class="advice">${adv.uninstall.slice(0, 10).map((x) => `<li>${pixelIcon('trash', 2, 'var(--ink-dim)')}<div><span class="an">${esc(x.name)} <span class="mute">${esc(x.sources.join(', '))}</span></span>
      <ul class="why">${x.reasons.map((r) => `<li>${esc(reasonText(r))}</li>`).join('')}</ul></div></li>`).join('')}</ul>${adv.uninstallTotal > 10 ? `<p class="fine">${S.more(adv.uninstallTotal - 10)}</p>` : ''}` : `<p class="fine">${S.uninstallNone}</p>`;
  const skillsScene = !sk ? '' : scene(5, S.skills, S.skillsKicker,
    `<h4 class="sub-h">${S.topUsed}</h4>
    ${topList}
    <div class="three">
      <div class="col keep"><h4 class="sub-h">${pixelIcon('check', 2, 'var(--green)')} ${S.keep}</h4><p class="fine top0">${S.keepSub}</p>
        ${adv.keep.length ? `<p class="chips">${adv.keep.map((n) => `<span class="chipname on">${esc(n)}</span>`).join('')}</p>` : ''}</div>
      <div class="col improve"><h4 class="sub-h">${pixelIcon('wrench', 2, 'var(--amber)')} ${S.improve}</h4><p class="fine top0">${S.improveSub}</p>${improveList}</div>
      <div class="col uninstall"><h4 class="sub-h">${pixelIcon('trash', 2, 'var(--ink-dim)')} ${S.uninstall}</h4><p class="fine top0">${S.uninstallSub(Math.min(10, adv.uninstallTotal), sk.installed)}</p>${uninstallList}</div>
    </div>
    <p class="fine">${S.uninstallNot}${sk.usedNotInstalled.length ? ` ${S.usedNotInstalled(esc(sk.usedNotInstalled.join(', ')))}` : ''}${prev && prev.comparable ? ` ${S.distinct(Object.keys(h.skillCalls).length)} ${chip(Object.keys(h.skillCalls).length, prev.skillsInvoked, { asRate: false, lowerIsBetter: false })}` : ''}</p>`);

  // ── 06 report card ──────────────────────────────────────────────────────
  const stateIcon = { promoted: pixelIcon('check', 2, 'var(--green)'), pending: pixelIcon('box', 2, 'var(--amber)'), 'n/a': pixelIcon('dash', 2, 'var(--ink-dim)') };
  const reportCard = scene(6, S.reportCard, rv && rv.latest ? S.rcKicker(esc(rv.latest.date || '?'), rv.latest.ageDays) : S.rcNever,
  rv && rv.latest ? `<div class="rc">
      <div class="rc-score">
        <div class="rv">${pixelText(`${rv.latest.promoted}/${rv.latest.cards.length}`, 6, 'var(--gold)')}</div>
        <div class="rl">${S.promoted}</div>
        <div class="trail"><span><b>${rv.latest.cards.length}</b> ${S.proposed}</span><span class="arr">→</span><span><b>${rv.latest.promoted}</b> ${S.promoted}</span><span class="arr">→</span><span class="pend"><b>${rv.latest.pending}</b> ${S.pending}</span><span class="arr">→</span><span><b>${rv.latest.cards.length - rv.latest.promoted - rv.latest.pending}</b> n/a</span></div>
      </div>
      <ul class="checklist">${rv.latest.cards.map((c) => `<li class="${c.state.replace('/', '')}">${stateIcon[c.state] || stateIcon['n/a']}<div><span class="ct">${esc(typeLabel(c.type))}</span><span class="txt">${esc(clip(c.text, 140))}</span><span class="evd">${esc(c.evidence)}</span></div></li>`).join('')}</ul>
    </div>
    <p class="fine">${rv.latest.unreadable ? S.rcUnreadable(esc(rv.latest.unreadable)) : S.rcHow} ${S.nextLesson} <code>/session-review</code> ${S.rcStarts}</p>`
    : `<p class="fine">${S.rcRun}</p>`);

  // ── 07 the rest of the cards ────────────────────────────────────────────
  const rest = stageCards.slice(1);
  const moreCards = rest.length ? scene(7, S.rest, S.restKicker(rest.length),
    `<div class="crows">${rest.map(cardRow).join('')}</div>
    <p class="fine">${S.silent(d.rulesSilent.length, esc(d.rulesSilent.join(', ')))}</p>`) : '';

  // ── 08 guards & refusals ────────────────────────────────────────────────
  const fires = g && g.pluginGuards ? g.pluginGuards.reduce((n, x) => n + x.fires, 0) : 0;
  const guards = !g ? '' : scene(8, S.guards, S.guardsKicker,
    `<div class="two">
      <div>
        <p class="gh">${pixelIcon('shield', 3, fires ? 'var(--amber)' : 'var(--green)')} ${S.gInstalled(g.pluginGuards ? g.pluginGuards.length : 0, fires, sessionsWord(h ? h.sessions : 0))}</p>
        ${g.pluginGuards ? `<ul class="list plain">${g.pluginGuards.map((x) => `<li><span class="n">${x.fires}</span> ${esc(x.name)}${x.advisory ? ` <span class="mute">${S.advisory}</span>` : ''}</li>`).join('')}</ul>` : `<p class="fine">${S.gNoList}</p>`}
        <p class="fine">${S.gFine}${g.otherHooks.length ? S.gOther(g.otherHooks.reduce((n, x) => n + x.runs, 0), esc(g.otherHooks.slice(0, 3).map((x) => `${x.command} ×${x.runs}`).join(', '))) : ''}</p>
      </div>
      <div>
        <p class="gh">${pixelIcon('flag', 3, 'var(--gold)')} ${S.refused(t ? t.denials.count : 0, t ? t.denials.reasons.length : 0)} ${chip(t ? t.denials.count : 0, prev ? prev.denials : 0)}</p>
        ${t && t.denials.reasons.length ? `<ul class="list quotes">${t.denials.reasons.slice(0, 5).map((r) => `<li><span class="q">«${esc(clip(r.reason, 140))}»</span><span class="mute"> — ${esc(r.tool || 'tool')}</span></li>`).join('')}</ul>
        <p class="fine">${S.refusedFine}</p>` : `<p class="fine">${S.refusedNone}</p>`}
      </div>
    </div>`);

  // ── 09 the ledger (the old report, folded) ──────────────────────────────
  const agentRows = d.agents.map((a) => `<tr>
      <td class="k">${esc(a.agentType)}<span class="mute"> · ${esc(a.model)}</span></td>
      <td>${a.runs}</td><td>${human(a.in)}</td><td>${human(a.out)}</td>
      <td>${human(a.cacheRead)}</td><td>${human(a.cacheWrite)}</td>
      <td class="${a.priced ? '' : 'mute'}">${money(a.costUsd, a.priced)}</td></tr>`).join('');
  const max = Math.max(1, ...d.timeline.map((x) => x.tokens));
  const bars = d.timeline.slice(-30).map((x) => `<div class="tbar" style="height:${Math.max(2, Math.round((x.tokens / max) * 100))}%"><span>${esc(x.date.slice(5))} · ${human(x.tokens)}</span></div>`).join('');
  const wfRows = d.workflows.slice(0, 12).map((w) => `<tr>
      <td class="k">${esc(w.runId)}</td><td class="k">${esc(w.name)}</td>
      <td class="k">${esc(w.startedAt.slice(0, 16).replace('T', ' '))}</td>
      <td>${duration(w.durationMs)}</td><td>${w.rounds || '—'}</td>
      <td>${human(w.tokens)}</td><td class="k ${w.verdict ? '' : 'mute'}">${esc(w.verdict || w.state || '—')}</td></tr>`).join('');
  const loopRows = d.loopRuns.slice(0, 10).map((r) => `<tr><td class="k">${esc(r.date || '?')}</td>
      <td class="k">${esc(r.loop)}</td><td>${r.rounds || '—'}</td><td class="k">${esc(r.verdict || '—')}</td>
      <td class="k mute">${esc(r.stoppedBy || '')}</td></tr>`).join('');
  const lineupRows = (d.lineup || []).map((r) => `<tr><td class="k">${esc(r.role)}</td>
      <td class="k">${esc(short(r.configured))}</td>
      <td class="k ${r.drift ? '' : 'mute'}">${r.observedModel ? esc(short(r.observedModel)) : '—'}${r.drift ? ' ⚠' : ''}</td>
      <td class="mute">${r.observedRuns}</td></tr>`).join('');
  const sv = d.savings;
  const abRows = (sv && sv.ab.length ? sv.ab : []).map((a) => `<tr><td class="k">${esc(a.subject)}</td>
      <td>${a.rounds}</td><td>${signed(a.deltaScore)}${a.scoreMax ? `/${a.scoreMax}` : ''}</td>
      <td class="${a.deltaTokens === null ? 'mute' : ''}">${a.deltaTokens === null ? 'n/a' : signed(a.deltaTokens, 0)}</td>
      <td class="k mute">${esc(a.tokensReason || 'per-arm tokens recorded (v2)')}</td></tr>`).join('');
  const predRows = (sv && sv.predictions ? sv.predictions.rows : []).map((r) => `<tr><td class="k">${esc(r.version)}</td>
      <td class="k">${esc(r.date)}</td><td class="k mute">${esc(r.change)}</td>
      <td class="k mute">${esc(clip(r.prediction, 70))}</td><td class="k">${esc(r.outcome)}</td></tr>`).join('');
  const learnRows = d.learnings.slice(0, 10).map((l) => `<tr><td class="k">${esc(l.date)}</td>
      <td class="k">${esc(l.skill)}</td><td class="k mute">${esc(l.entry)}</td></tr>`).join('');
  const topRows = d.prompts.top.map((x) => `<tr><td class="k">×${x.count}</td>
      <td class="k mute">«${esc(x.sample.replace(/\s+/g, ' ').slice(0, 90))}»</td></tr>`).join('');
  const table = (head, body) => (body ? `<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>` : '');
  const savingsText = sv ? `<p class="fine">${!sv.predictions
    ? S.lNoPred
    : sv.predictions.unreadable
      ? S.lPredUnread(esc(String(sv.predictions.unreadable)))
      : S.lPred(sv.predictions.verified, sv.predictions.falsified, sv.predictions.pending, sv.predictions.unknown)}
    ${sv.roundsToGreen ? S.lGreen(sv.roundsToGreen.trend.join(' · ')) : S.lNoGreen}${S.lNoMult}</p>` : `<p class="fine">${S.lNoRepo}</p>`;

  const ledger = `<details class="ledger" id="s9">
    <summary><span class="num">${pixelText('09', 3)}</span><h2>${S.ledger}</h2><p class="kicker">${S.ledgerKicker}</p></summary>
    <div class="lbody">
      <h4>${S.lAgents}</h4>
      ${table('<th class="k">agent</th><th>runs</th><th>in</th><th>out</th><th>cache-r</th><th>cache-w</th><th>est.$</th>', `${agentRows}<tr class="total"><td class="k">TOTAL</td><td>${d.totals.runs}</td><td>${human(d.totals.in)}</td><td>${human(d.totals.out)}</td><td>${human(d.totals.cacheRead)}</td><td>${human(d.totals.cacheWrite)}</td><td>${d.totals.costUsd.toFixed(2)}</td></tr>`)}
      ${d.unpricedModels.length ? `<p class="fine">${S.lUnpriced(esc(d.unpricedModels.join(', ')))}</p>` : ''}
      ${d.introPricedModels.length ? `<p class="fine">${S.lIntro(esc(d.introPricedModels.join(', ')))}</p>` : ''}
      ${lineupRows ? `<h4>${S.lLineup}</h4>${table('<th class="k">role</th><th class="k">configured</th><th class="k">observed</th><th>runs</th>', lineupRows)}<p class="fine">${S.lDrift}</p>` : ''}
      <h4>${S.lDays}</h4>
      <div class="tchart">${bars}</div>
      ${wfRows ? `<h4>${S.lWorkflows}</h4>${table('<th class="k">run</th><th class="k">workflow</th><th class="k">started</th><th>duration</th><th>rounds</th><th>tokens</th><th class="k">verdict</th>', wfRows)}` : ''}
      ${loopRows ? `<h4>${S.lLoops}</h4>${table('<th class="k">date</th><th class="k">loop</th><th>rounds</th><th class="k">verdict</th><th class="k">stopped by</th>', loopRows)}` : ''}
      <h4>${S.lSavings}</h4>
      ${abRows ? table('<th class="k">A/B run</th><th>rounds</th><th>Δ score</th><th>Δ tokens</th><th class="k">note</th>', abRows) : `<p class="fine">${S.lNoAb}</p>`}
      ${savingsText}
      ${predRows ? `<h4>${S.lPredictions}</h4>${table('<th class="k">v</th><th class="k">date</th><th class="k">change</th><th class="k">prediction</th><th class="k">outcome</th>', predRows)}` : ''}
      ${learnRows ? `<h4>${S.lLearnings}</h4>${table('<th class="k">date</th><th class="k">skill</th><th class="k">entry</th>', learnRows)}` : ''}
      <h4>${S.lPrompts}</h4>
      <p class="fine">${S.lPromptsFine(d.prompts.total, d.prompts.avgWords.toFixed(1), d.prompts.sessionsPerDay.toFixed(1), `${Math.round(d.prompts.followUpRate * 100)}%`)} <span class="proxy">proxy</span>${S.lTurns}</p>
      ${table('<th class="k">×</th><th class="k">prompt</th>', topRows)}
      ${t ? `<h4>${S.lEvery}</h4>${table('<th class="k">tool</th><th>calls</th><th>errors</th>', t.byName.map((r) => `<tr><td class="k">${esc(r.name)}</td><td>${r.calls}</td><td class="${r.errors ? '' : 'mute'}">${r.errors || '—'}</td></tr>`).join(''))}` : ''}
    </div>
  </details>`;

  return `<title>loop-stats · ${esc(d.project)}</title>
<style>
  :root {
    --bg:#060b08; --panel:#0b1510; --panel2:#0f1c15; --line:#1e3d2a; --line2:#2b5a3c;
    --ink:#e7f3ea; --ink-dim:#93ad9c; --mute:#5f7a69;
    --green:#3dff7a; --green-deep:#1f8f45; --gold:#ffd23f; --bronze:#d08a4a; --amber:#f5c542; --red:#ff5c5c;
    --sans:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans",sans-serif;
    --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"DejaVu Sans Mono",monospace;
  }
  * { box-sizing:border-box; }
  html { background:var(--bg); }
  body { margin:0; padding:2.5rem 1rem 4rem; background:var(--bg); color:var(--ink);
    font-family:var(--sans); font-size:16px; line-height:1.6; font-variant-numeric:tabular-nums; }
  body::before { content:""; position:fixed; inset:0; pointer-events:none; z-index:2; opacity:.35;
    background:repeating-linear-gradient(180deg,rgba(0,0,0,0) 0 3px,rgba(0,0,0,.25) 3px 4px); }
  main { max-width:880px; margin:0 auto; display:flex; flex-direction:column; gap:1.25rem; }
  code { font-family:var(--mono); font-size:.92em; color:var(--green); background:rgba(61,255,122,.07); padding:0 .3em; }
  b { font-weight:600; color:var(--ink); }
  p { margin:0; max-width:64ch; }
  .fine { color:var(--ink-dim); font-size:.9rem; margin-top:1rem; max-width:70ch; }
  .fine.top0 { margin-top:.2rem; margin-bottom:.6rem; }
  .mute { color:var(--mute); }
  .px, .ico { display:inline-block; vertical-align:middle; image-rendering:pixelated; }
  .px { filter:drop-shadow(0 0 6px rgba(61,255,122,.35)); }

  .cover { border:3px solid var(--line2); background:var(--panel); padding:2rem 2rem 1.75rem; box-shadow:8px 8px 0 #000; }
  .eyebrow { font-family:var(--mono); font-size:.72rem; letter-spacing:.22em; text-transform:uppercase; color:var(--green-deep); }
  h1 { margin:.5rem 0 .75rem; display:flex; flex-direction:column; gap:.4rem; font-weight:600; }
  h1 .pxtitle { color:var(--green); }
  h1 .proj { font-size:1.35rem; color:var(--ink); letter-spacing:.02em; font-weight:500; }
  .lede { color:var(--ink-dim); font-size:1rem; max-width:62ch; }
  .heroes { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:1rem; margin:1.5rem 0 1.25rem; }
  .hero { border:2px solid var(--line); padding:1rem 1rem .9rem; background:var(--panel2); }
  .hero .hv { color:var(--green); margin-bottom:.4rem; }
  .hero .hl { font-size:.85rem; color:var(--ink-dim); text-transform:uppercase; letter-spacing:.1em; font-family:var(--mono); }

  .scene { border:2px solid var(--line); background:var(--panel); padding:1.5rem 1.75rem 1.75rem; box-shadow:6px 6px 0 #000; }
  .scene.stage { border-color:var(--amber); box-shadow:6px 6px 0 #000, 0 0 0 4px rgba(245,197,66,.08); }
  .scene.gold { border-color:var(--gold); box-shadow:6px 6px 0 #000, 0 0 0 4px rgba(255,210,63,.08); }
  .sh { display:grid; grid-template-columns:auto 1fr; gap:.25rem 1rem; align-items:center; margin-bottom:1.25rem; }
  .sh .num { color:var(--green-deep); grid-row:1 / span 2; align-self:start; margin-top:.3rem; }
  h2 { margin:0; font-size:1.45rem; font-weight:650; letter-spacing:-.01em; text-wrap:balance; line-height:1.2; }
  .kicker { color:var(--ink-dim); font-size:.95rem; max-width:64ch; }
  .sub-h { margin:1.25rem 0 .5rem; font-family:var(--mono); font-size:.72rem; letter-spacing:.2em; text-transform:uppercase; color:var(--ink-dim); font-weight:500; display:flex; align-items:center; gap:.4rem; }
  .sub-h:first-child { margin-top:0; }

  .card { border:2px solid var(--line2); background:var(--panel2); padding:1.25rem 1.4rem 2rem; position:relative; display:flex; flex-direction:column; gap:.7rem; }
  .card.warn { border-color:var(--amber); }
  .card .top { display:flex; align-items:center; gap:.6rem; flex-wrap:wrap; }
  .card h3 { margin:.2rem 0 0; font-size:1.35rem; line-height:1.3; font-weight:650; text-wrap:balance; max-width:32ch; }
  .card .ev { border-left:4px solid var(--line2); padding:.25rem 0 .25rem .9rem; color:var(--ink); font-family:var(--mono); font-size:.86rem; line-height:1.55; max-width:none; word-break:break-word; }
  .card .rec { font-size:1rem; }
  .card .not { color:var(--ink-dim); font-size:.9rem; padding-top:.6rem; border-top:1px dashed var(--line); }
  .card .src { position:absolute; right:1rem; bottom:.6rem; font-family:var(--mono); font-size:.68rem; color:var(--mute); }
  .card .rid, .crow .rid { margin-left:auto; font-family:var(--mono); font-size:.72rem; color:var(--mute); }
  .pill { display:inline-block; padding:.1rem .5rem; border:2px solid currentColor; font-family:var(--mono); font-size:.68rem; letter-spacing:.12em; text-transform:uppercase; line-height:1.5; }
  .pill.type { color:var(--green); } .pill.info { color:var(--ink-dim); } .pill.warn { color:var(--amber); }
  .crows { display:flex; flex-direction:column; gap:.5rem; }
  .crow { border:2px solid var(--line); background:var(--panel2); }
  .crow.warn { border-left:6px solid var(--amber); }
  .crow summary { list-style:none; cursor:pointer; display:flex; align-items:center; gap:.7rem; padding:.75rem 1rem; }
  .crow summary::-webkit-details-marker { display:none; }
  .crow summary::after { content:"+"; font-family:var(--mono); color:var(--green-deep); margin-left:.5rem; }
  .crow[open] summary::after { content:"−"; }
  .crow .ct { font-family:var(--mono); font-size:.68rem; letter-spacing:.12em; text-transform:uppercase; color:var(--green-deep); white-space:nowrap; }
  .crow .ch { flex:1; font-weight:500; }
  .crow .cbody { padding:0 1rem 1rem 3.4rem; display:flex; flex-direction:column; gap:.6rem; }
  .crow .ev { font-family:var(--mono); font-size:.84rem; color:var(--ink-dim); border-left:4px solid var(--line2); padding-left:.8rem; max-width:none; word-break:break-word; }
  .crow .not { color:var(--ink-dim); font-size:.9rem; }

  .receipt { display:flex; flex-direction:column; gap:1rem; }
  .rhead { display:flex; align-items:center; gap:1rem; flex-wrap:wrap; }
  .rhead .rt { color:var(--ink-dim); font-size:1.05rem; }
  .rlist { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:.5rem; }
  .rlist li { display:flex; gap:.7rem; align-items:flex-start; border:2px solid var(--line); background:var(--panel2); padding:.65rem .9rem; }
  .rlist li > svg { margin-top:.25rem; flex:none; }
  .rlist div { display:flex; flex-direction:column; gap:.15rem; }
  .rlist .rl { font-weight:500; }
  .rlist .rd { font-family:var(--mono); font-size:.78rem; color:var(--mute); word-break:break-word; }

  .tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:.9rem; }
  .tile { border:2px solid var(--line); background:var(--panel2); padding:.9rem 1rem 1rem; display:flex; flex-direction:column; gap:.4rem; }
  .tile.hot { border-color:var(--amber); }
  .tile .tl { display:flex; align-items:center; gap:.5rem; font-family:var(--mono); font-size:.72rem; letter-spacing:.12em; text-transform:uppercase; color:var(--ink-dim); }
  .tile .tv { color:var(--green); } .tile.hot .tv { color:var(--amber); }
  .tile .ts { font-size:.88rem; color:var(--ink-dim); }
  .chip { display:inline-block; margin-top:.25rem; padding:.1rem .5rem; font-family:var(--mono); font-size:.72rem; border:2px solid currentColor; }
  .chip.good { color:var(--green); } .chip.bad { color:var(--amber); } .chip.mute { color:var(--mute); border-style:dashed; }
  .proxy { font-family:var(--mono); font-size:.62rem; color:var(--amber); border:1px dashed var(--amber); padding:0 .35rem; letter-spacing:.1em; vertical-align:middle; }

  .boss { display:flex; flex-direction:column; gap:1rem; }
  .boss .bl { display:flex; align-items:center; gap:1rem; flex-wrap:wrap; }
  .boss .bt { color:var(--ink-dim); }
  .quote { margin:0; border:2px solid var(--line2); border-left:6px solid var(--red); background:#120b0b; padding:.9rem 1rem; font-family:var(--mono); font-size:.88rem; line-height:1.55; color:var(--ink); word-break:break-word; }
  .list { list-style:none; margin:1rem 0 0; padding:0; display:flex; flex-direction:column; gap:.4rem; max-width:none; }
  .list li { display:flex; gap:.6rem; align-items:baseline; font-size:.92rem; }
  .list .n { font-family:var(--mono); color:var(--amber); min-width:2.6rem; }
  .list .q { color:var(--ink-dim); font-family:var(--mono); font-size:.84rem; }
  .list.plain .n { color:var(--green); }
  .list.quotes li { display:block; }
  .list.quotes .q { color:var(--ink); font-family:var(--sans); font-size:.98rem; }

  .ranked { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:.55rem; }
  .ranked li { display:grid; grid-template-columns:2rem 1fr minmax(120px,220px) 3rem; gap:.5rem .8rem; align-items:center; border:2px solid var(--line); background:var(--panel2); padding:.6rem .9rem; }
  .ranked .rank { font-family:var(--mono); color:var(--mute); text-align:center; }
  .ranked .name { font-weight:600; }
  .ranked .cnt { font-family:var(--mono); color:var(--gold); text-align:right; }
  .ranked .where { grid-column:2 / span 3; font-size:.78rem; color:var(--mute); font-family:var(--mono); }
  .bar { display:inline-flex; gap:2px; height:10px; }
  .bar i { flex:1; background:var(--line); min-width:4px; }
  .bar i.on { background:var(--green); }
  .bar.gold i.on { background:var(--gold); }
  .three { display:grid; grid-template-columns:.9fr 1.2fr 1.6fr; gap:1rem; margin-top:1.25rem; align-items:start; }
  @media (max-width:820px) { .three { grid-template-columns:1fr; } }
  .col { border:2px solid var(--line); background:var(--panel2); padding:.9rem 1rem 1rem; }
  .col.keep { border-color:var(--green-deep); } .col.improve { border-color:var(--amber-dim, #8a6d1c); }
  .advice { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:.6rem; }
  .advice > li { display:flex; gap:.6rem; align-items:flex-start; }
  .advice > li > svg { flex:none; margin-top:.3rem; }
  .advice > li > div { display:flex; flex-direction:column; gap:.2rem; min-width:0; }
  .advice .an { font-weight:600; word-break:break-word; }
  .advice .why { margin:0; padding-left:1rem; font-size:.84rem; color:var(--ink-dim); }
  .advice .how { font-size:.84rem; color:var(--ink); }
  .chips { display:flex; flex-wrap:wrap; gap:.35rem; margin-top:.4rem; max-width:none; }
  .chipname { border:1px solid var(--line2); padding:.05rem .5rem; font-family:var(--mono); font-size:.74rem; color:var(--ink-dim); }
  .chipname.on { color:var(--green); border-color:var(--green-deep); }

  .rc { display:grid; grid-template-columns:minmax(200px,1fr) 2fr; gap:1.25rem; align-items:start; }
  @media (max-width:760px) { .rc { grid-template-columns:1fr; } }
  .rc-score { border:2px solid var(--line2); background:var(--panel2); padding:1rem 1.1rem; }
  .rc-score .rl { font-family:var(--mono); font-size:.72rem; letter-spacing:.12em; text-transform:uppercase; color:var(--ink-dim); margin-top:.4rem; }
  .trail { display:flex; flex-wrap:wrap; gap:.4rem .5rem; margin-top:.8rem; font-size:.84rem; color:var(--ink-dim); align-items:center; }
  .trail span { border:1px solid var(--line); padding:.1rem .5rem; }
  .trail .arr { border:none; color:var(--mute); padding:0; }
  .trail .pend { border-color:var(--amber); color:var(--amber); }
  .checklist { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:.5rem; }
  .checklist li { display:flex; gap:.7rem; align-items:flex-start; border:2px solid var(--line); background:var(--panel2); padding:.65rem .9rem; }
  .checklist li.promoted { border-color:var(--green-deep); }
  .checklist li.pending { border-color:var(--amber); }
  .checklist li > svg { margin-top:.2rem; flex:none; }
  .checklist div { display:flex; flex-direction:column; gap:.15rem; }
  .checklist .ct { font-family:var(--mono); font-size:.66rem; letter-spacing:.12em; text-transform:uppercase; color:var(--green-deep); }
  .checklist .txt { font-size:.95rem; }
  .checklist .evd { font-family:var(--mono); font-size:.76rem; color:var(--mute); }

  .two { display:grid; grid-template-columns:1fr 1fr; gap:1.5rem; align-items:start; }
  @media (max-width:760px) { .two { grid-template-columns:1fr; } }
  .gh { display:flex; align-items:center; gap:.5rem; flex-wrap:wrap; }

  .ledger { border:2px solid var(--line); background:var(--panel); box-shadow:6px 6px 0 #000; }
  .ledger summary { list-style:none; cursor:pointer; padding:1.5rem 1.75rem; display:grid; grid-template-columns:auto 1fr; gap:.25rem 1rem; align-items:center; }
  .ledger summary::-webkit-details-marker { display:none; }
  .ledger summary .num { grid-row:1 / span 2; color:var(--green-deep); align-self:start; margin-top:.3rem; }
  .ledger summary h2::after { content:"  ▸"; color:var(--green-deep); font-size:.9rem; }
  .ledger[open] summary h2::after { content:"  ▾"; }
  .lbody { padding:0 1.75rem 1.75rem; font-family:var(--mono); font-size:.84rem; }
  .lbody h4 { margin:1.75rem 0 .5rem; font-size:.72rem; letter-spacing:.2em; text-transform:uppercase; color:var(--ink-dim); font-weight:500; }
  .lbody h4:first-child { margin-top:.5rem; }
  .scroll { overflow-x:auto; }
  table { width:100%; border-collapse:collapse; white-space:nowrap; }
  th,td { text-align:right; padding:.3rem .6rem; border-bottom:1px solid var(--line); }
  th.k,td.k { text-align:left; }
  th { color:var(--ink-dim); font-weight:400; font-size:.7rem; letter-spacing:.12em; }
  tr.total td { border-top:2px solid var(--line2); border-bottom:none; font-weight:700; }
  .tchart { display:flex; align-items:flex-end; gap:3px; height:110px; margin-top:.5rem; border-bottom:2px solid var(--line); }
  .tbar { flex:1; background:var(--green-deep); position:relative; min-width:6px; }
  .tbar span { position:absolute; bottom:100%; left:50%; transform:translateX(-50%); font-size:.66rem; color:var(--ink-dim); opacity:0; white-space:nowrap; }
  .tbar:hover { background:var(--green); } .tbar:hover span { opacity:1; }
  footer { max-width:880px; margin:1.5rem auto 0; color:var(--mute); font-size:.82rem; font-family:var(--mono); line-height:1.6; }
  @media (prefers-reduced-motion: no-preference) { .crow, .tile, .card { transition:border-color .15s; } }
  @media (max-width:560px) { .scene, .cover { padding:1.1rem 1rem 1.25rem; } .ranked li { grid-template-columns:2rem 1fr 3rem; } .ranked .bar { display:none; } }
</style>
<main lang="${lang}">
  ${cover}
  ${oneThing}
  ${caughtScene}
  ${driving}
  ${breaking}
  ${skillsScene}
  ${reportCard}
  ${moreCards}
  ${guards}
  ${ledger}
</main>
<footer>v2.7 · ${S.footer}${d.warnings ? S.unreadableLines(d.warnings) : ''}</footer>`;
}

// The cross-project view shares the CRT shell but not the report: no cards, because a card belongs to
// a project's own contract, and no recurring prompts, because the same eight words mean different
// things in two repos.
function renderAllHtml(d) {
  const rows = d.projects.map((p) => `<tr>
      <td class="k">${esc(p.project.replace(/^-home-[^-]+-/, ''))}</td>
      <td>${p.sessions}</td><td>${p.runs}</td><td>${human(p.tokens)}</td>
      <td class="${p.unpricedModels.length ? 'dim' : ''}">${p.costUsd.toFixed(2)}${p.unpricedModels.length ? '*' : ''}</td>
      <td>${p.cards}</td><td class="k dim">${esc(p.lastActivity || '—')}</td></tr>`).join('');
  const skillRows = d.skills.map((sk) => `<tr><td class="k">${esc(sk.name)}</td>
      <td>${sk.count}</td><td>${sk.projects}</td></tr>`).join('');
  const failRows = d.failedProjects.map((f) => `<tr><td class="k">${esc(f.project)}</td>
      <td class="k dim wrap">${esc(f.error)}</td></tr>`).join('');
  const unpriced = [...new Set(d.projects.flatMap((p) => p.unpricedModels))];

  return `<title>loop-stats · all projects</title>
<style>
  :root { --p:#33ff66; --dim:#1f8f45; --bg:#050805; }
  * { box-sizing:border-box; }
  body { margin:0; padding:2rem 1rem; background:var(--bg); color:var(--p);
    font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"DejaVu Sans Mono",monospace;
    font-size:14px; line-height:1.5; text-shadow:0 0 6px rgba(51,255,102,.45); font-variant-numeric:tabular-nums; }
  body::before { content:""; position:fixed; inset:0; pointer-events:none; z-index:2;
    background:repeating-linear-gradient(180deg,rgba(0,0,0,0) 0 2px,rgba(0,0,0,.28) 2px 4px); }
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
  td.wrap { white-space:normal; }
  .dim { color:var(--dim); }
  footer { margin-top:2rem; padding-top:.75rem; border-top:1px solid var(--dim); color:var(--dim); font-size:.72rem; }
</style>
<main>
  <h1>LOOP-STATS ▓ ALL PROJECTS</h1>
  <p class="sub">${esc(d.generatedAt.slice(0, 16).replace('T', ' '))} · window: ${esc(d.window)} ·
    ${d.totals.projects} projects · ${d.totals.sessions} sessions · ${human(d.totals.tokens)} tokens ·
    $${d.totals.costUsd.toFixed(2)}${d.warnings ? ` · ${d.warnings} parse warnings` : ''}</p>

  <h2>Projects</h2>
  <div class="scroll"><table>
    <thead><tr><th class="k">project</th><th>sessions</th><th>runs</th><th>tokens</th><th>est.$</th><th>cards</th><th class="k">last day</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
  ${unpriced.length ? `<p class="sub">* excludes unpriced models: ${esc(unpriced.join(', '))}</p>` : ''}
  <p class="sub">Cards are counted, not shown: each one is about a project's own contract and skills.
  Open a single project to read them — <code>--project &lt;path|slug&gt;</code>.</p>

  <h2>Skills invoked across projects</h2>
  ${skillRows ? `<div class="scroll"><table>
    <thead><tr><th class="k">skill</th><th>calls</th><th>projects</th></tr></thead>
    <tbody>${skillRows}</tbody></table></div>`
    : '<p class="sub">No skill was invoked through the Skill tool in this window. A skill that auto-triggered on its description alone leaves no trace here.</p>'}

  <h2>Hygiene, summed</h2>
  <p class="sub">${d.hygiene.humanPrompts} human prompts · ${d.hygiene.continuations} bare continuations ·
  ${d.hygiene.interrupts} interrupts · ${d.hygiene.modelSwitches} /model switches · ${d.hygiene.compactions} compactions.<br>
  Recurring prompts are deliberately absent from this view: the same eight words mean different things in two repositories.</p>

  ${failRows ? `<h2>Projects that could not be read</h2><div class="scroll"><table>
    <thead><tr><th class="k">project</th><th class="k">error</th></tr></thead>
    <tbody>${failRows}</tbody></table></div>` : ''}

  <footer>Read from the local Claude Code transcripts. One unreadable project is a row above, never a
  missing report — and est.$ is list price × measured tokens, never a multiplier.</footer>
</main>`;
}

// ─────────────────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv.slice(2));
  let data;
  try {
    // --from-json re-renders a saved aggregate without touching the transcripts (a 1 GB root takes
    // seconds to walk; a saved JSON takes none). The file is trusted as far as its shape parses.
    data = args.fromJson ? JSON.parse(fs.readFileSync(args.fromJson, 'utf8'))
      : args.all ? aggregateAll(args) : aggregate(args);
  } catch (e) { process.stderr.write(`loop-stats: ${e.message}\n`); process.exit(1); }

  if (args.jsonOut) {
    try { fs.writeFileSync(args.jsonOut, `${JSON.stringify(data, null, 2)}\n`); process.stderr.write(`loop-stats: wrote ${args.jsonOut}\n`); }
    catch (e) { process.stderr.write(`loop-stats: cannot write ${args.jsonOut}: ${e.code}\n`); process.exit(1); }
  }
  if (args.html) {
    const out = resolveHtmlPath(args);
    try {
      fs.writeFileSync(out, data.mode === 'all' ? renderAllHtml(data) : renderHtml(data, args.lang));
      process.stderr.write(`loop-stats: wrote ${out}\n`);
    }
    catch (e) { process.stderr.write(`loop-stats: cannot write ${out}: ${e.code}\n`); process.exit(1); }
    if (args.open && !openFile(out)) process.stderr.write(`loop-stats: open it yourself: ${out}\n`);
  }
  const isAll = data.mode === 'all';
  const payload = args.brief && !isAll ? briefOf(data) : data;
  process.stdout.write(args.json
    ? `${JSON.stringify(payload, null, 2)}\n`
    : `${isAll ? renderAll(data) : renderAnsi(data)}\n`);
}

if (require.main === module) main();

module.exports = {
  slugCandidates, promptText, parseArgs, aggregate, aggregateAll, briefOf, BRIEF_KEYS,
  evaluateCards, parseReviewCards, RULES, renderAnsi, renderHtml, inventorySkills,
};
