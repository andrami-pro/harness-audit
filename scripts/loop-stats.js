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

function parseArgs(argv) {
  const a = {
    root: path.join(os.homedir(), '.claude', 'projects'),
    project: null, repo: null, sinceMs: null, html: null, json: false, top: 3, lineup: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--project') a.project = argv[++i];
    else if (flag === '--root') a.root = argv[++i];
    else if (flag === '--repo') a.repo = argv[++i];
    else if (flag === '--html') a.html = argv[++i];
    else if (flag === '--json') a.json = true;
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
    top: [...counts.values()].sort((a, b) => b.count - a.count).slice(0, args.top),
  };

  const repo = args.repo ? parseRepo(args.repo) : { loopRuns: [], learnings: [], savings: null };
  const agents = [...rows.values()].sort((a, b) => b.tokens - a.tokens);

  return {
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
    lineup: buildLineup(args, agents),
    warnings: warnings.length,
  };
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

  <footer>v2 · every figure above is measured from local transcripts and the repo's own loop records;
  est.$ is list price × measured tokens, never a multiplier, and a saving with no counterfactual behind
  it is not shown — the reason it cannot be shown is.</footer>
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
