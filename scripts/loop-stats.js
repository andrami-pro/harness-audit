#!/usr/bin/env node
// loop-stats.js — read-only dashboard over the transcripts Claude Code already writes.
// Node >= 18, zero dependencies. It never writes to ~/.claude and never touches the network.
//
// The transcript format is internal and undocumented — a Claude Code update can change it without
// notice. Every unreadable line is skipped with a warning instead of aborting, and the shapes this
// parser depends on are pinned in scripts/fixtures/telemetry/ so validate.js sees the break.
//
//   node scripts/loop-stats.js [--project <slug>] [--root <dir>] [--repo <path>]
//                              [--since 7d] [--html <out>] [--json]

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

function parseArgs(argv) {
  const a = {
    root: path.join(os.homedir(), '.claude', 'projects'),
    project: null, repo: null, sinceMs: null, html: null, json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--project') a.project = argv[++i];
    else if (flag === '--root') a.root = argv[++i];
    else if (flag === '--repo') a.repo = argv[++i];
    else if (flag === '--html') a.html = argv[++i];
    else if (flag === '--json') a.json = true;
    else if (flag === '--since') {
      const m = /^(\d+)d$/.exec(argv[++i] || '');
      if (m) a.sinceMs = Date.now() - Number(m[1]) * 864e5;
      else warn('--since expects <N>d (e.g. 7d) — ignored, showing all history');
    } else warn(`unknown flag ${flag} — ignored`);
  }
  a.root = path.resolve(a.root);
  if (a.repo) a.repo = path.resolve(a.repo);
  a.project = a.project || process.cwd().replace(/[/.]/g, '-');
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

function parseSession(projectDir, sessionId) {
  const turns = [];
  const prompts = [];
  const taskLabels = new Map();
  let prevKind = null;
  for (const r of readJsonl(path.join(projectDir, `${sessionId}.jsonl`))) {
    if (r.type === 'assistant') {
      const u = usageOf(r);
      if (u) turns.push({ agentType: 'main', model: r.message.model, ts: r.timestamp, usage: u });
      for (const b of (r.message && r.message.content) || []) {
        if (b && b.type === 'tool_use' && b.name === 'Task') taskLabels.set(b.id, b.input || {});
      }
      prevKind = 'assistant';
    } else if (r.type === 'user') {
      const text = promptText(r);
      // Only a tool result breaks the "agent just handed the floor back" state; caveats and
      // command wrappers are bookkeeping the human never saw.
      if (text === null) { if (isToolResult(r)) prevKind = 'tool'; continue; }
      // Proxy for "I had to correct it": the agent had ended its turn and the human typed again.
      prompts.push({ ts: r.timestamp, sessionId, text, isFollowUp: prevKind === 'assistant' });
      prevKind = 'user';
    }
  }
  return { turns, prompts, taskLabels };
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

// --repo: the loop's own paper trail. Findings JSON per run, plus the skill journals it wrote.
function parseRepo(repo) {
  const loopRuns = [];
  const runsDir = path.join(repo, 'docs', 'harness-dev', 'loop-runs');
  for (const f of ls(runsDir).filter((f) => f.endsWith('.json'))) {
    const j = readJson(path.join(runsDir, f));
    if (!j) continue;
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
  return { loopRuns, learnings };
}

// ─────────────────────────────────────────────────────────────────────────────
// AGGREGATE
// ─────────────────────────────────────────────────────────────────────────────

function aggregate(args) {
  const projectDir = path.join(args.root, args.project);
  if (!fs.existsSync(projectDir)) {
    const available = ls(args.root).filter((d) => !d.startsWith('.')).slice(0, 8);
    throw new Error(`no telemetry at ${projectDir}\navailable under ${args.root}:\n  ${available.join('\n  ') || '(none)'}`);
  }

  const sessions = ls(projectDir).filter((f) => f.endsWith('.jsonl')).map((f) => f.replace(/\.jsonl$/, ''));
  let turns = [];
  let prompts = [];
  let workflows = [];
  for (const id of sessions) {
    const s = parseSession(projectDir, id);
    turns = turns.concat(s.turns);
    prompts = prompts.concat(s.prompts);

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
    top: [...counts.values()].sort((a, b) => b.count - a.count).slice(0, 3),
  };

  const repo = args.repo ? parseRepo(args.repo) : { loopRuns: [], learnings: [] };

  return {
    project: args.project,
    generatedAt: new Date().toISOString(),
    window: args.sinceMs ? new Date(args.sinceMs).toISOString() : 'all',
    agents: [...rows.values()].sort((a, b) => b.tokens - a.tokens),
    totals,
    unpricedModels: [...unpriced],
    introPricedModels: [...introPriced],
    timeline: [...days.entries()].sort().map(([date, tokens]) => ({ date, tokens })),
    workflows,
    loopRuns: repo.loopRuns,
    learnings: repo.learnings,
    prompts: promptStats,
    warnings: warnings.length,
  };
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

  const p = d.prompts;
  out.push(row(` PROMPTS   ${p.total} user turns · ${p.avgWords.toFixed(1)} words avg · ${p.sessionsPerDay.toFixed(1)} sess/day`));
  out.push(row(`           ${Math.round(p.followUpRate * 100)}% follow-ups (proxy: turn after agent turn)`));
  for (const t of p.top.slice(0, 2)) {
    out.push(row(`   ×${t.count} «${t.sample.replace(/\s+/g, ' ')}»`));
  }

  out.push(`└── v1 · savings need a counterfactual — see /skill-loop ┘`);
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

  const learnRows = d.learnings.slice(0, 10).map((l) => `<tr><td class="k">${esc(l.date)}</td>
      <td>${esc(l.skill)}</td><td class="dim">${esc(l.entry)}</td></tr>`).join('');

  const topRows = d.prompts.top.map((t) => `<tr><td class="k">×${t.count}</td>
      <td class="dim">«${esc(t.sample.replace(/\s+/g, ' ').slice(0, 90))}»</td></tr>`).join('');

  const section = (title, body) => (body ? `<h2>${title}</h2>${body}` : '');

  return `<title>loop-stats · ${esc(d.project)}</title>
<style>
  :root { --p:#33ff66; --dim:#1f8f45; --bg:#050805; }
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

  <h2>Tokens per day</h2>
  <div class="chart">${bars}</div>

  ${section('Workflow activations', wfRows ? `<div class="scroll"><table>
    <thead><tr><th>run</th><th>workflow</th><th>started</th><th>duration</th><th>rounds</th><th>tokens</th><th>verdict</th><th>result</th></tr></thead>
    <tbody>${wfRows}</tbody></table></div>` : '')}

  ${section('Loop runs (findings JSON)', loopRows ? `<div class="scroll"><table>
    <thead><tr><th>date</th><th>loop</th><th>rounds</th><th>verdict</th><th>stopped by</th></tr></thead>
    <tbody>${loopRows}</tbody></table></div>` : '')}

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

  <footer>v1 · savings need a counterfactual — see /skill-loop. Every figure above is measured from
  local transcripts; est.$ is list price × measured tokens, never a multiplier.</footer>
</main>`;
}

// ─────────────────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv.slice(2));
  let data;
  try { data = aggregate(args); }
  catch (e) { process.stderr.write(`loop-stats: ${e.message}\n`); process.exit(1); }

  if (args.html) {
    try { fs.writeFileSync(args.html, renderHtml(data)); process.stderr.write(`loop-stats: wrote ${args.html}\n`); }
    catch (e) { process.stderr.write(`loop-stats: cannot write ${args.html}: ${e.code}\n`); process.exit(1); }
  }
  process.stdout.write(args.json ? `${JSON.stringify(data, null, 2)}\n` : `${renderAnsi(data)}\n`);
}

main();
