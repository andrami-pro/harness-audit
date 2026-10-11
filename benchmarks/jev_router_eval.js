#!/usr/bin/env node
// jev_router_eval.js — does the prompt-router pick the right skill and the right tier, and from which
// confidence can its tier be acted on? Run this before routing anything by it.
//
// The corpus is real operator prompts, anonymized and labelled by hand (benchmarks/fixtures/
// router_corpus.jsonl): one expected skill (or none), optional `skill_alt` answers that are also
// acceptable, and one expected tier. Each prompt goes through the production request — the hook's own
// classify(), both questions in one call — so the number measured is the number the hook lives with.
//
// Jev is not deterministic: the same request moves p by up to 0.08 (docs/harness-dev/loop-runs/
// 2026-10-10-jev-router-noise-probe.txt). So the eval always runs the corpus TWICE and reports every
// headline number as the mean of the two passes and their range.
//
// Two precisions for the skill: STRICT counts only the primary label, LAX also accepts an alternative.
// The tier has no alternatives, so its strict and lax are the same number. Confusion matrices use the
// primary label.
//
// The threshold, read two ways, both printed:
//   CUMULATIVE (used) — the lowest confidence cut-off whose kept predictions (at least MIN_N) are right
//     at least 9 times in 10. That is the decision routeByJev actually makes: "route everything above p".
//     Its precision is the precision of all the routed tasks together, whatever a higher cut-off does.
//   HOLDS FROM THERE ON (reported, not used) — the lowest cut-off from which precision never drops under
//     0.9 at any higher cut-off with at least MIN_N kept. Stricter: one confident error near the top
//     refuses every cut-off, even when the routed set as a whole clears 0.9.
// With two passes, the threshold is the higher of the two passes' cumulative cut-offs, or none if either
// pass has none.
//
// Routing down is not routing up: up costs money, down costs quality. routeByJev caps a downgrade —
// one tier at most, never below sonnet (jev.js decideTier) — and the eval replays exactly that decision
// over the corpus with the line-up's implementer (opus) as the configured tier. A downgrade is right when
// the tier it lands on is at least the labelled one. Its precision, in BOTH passes, must reach 0.9 on at
// least MIN_N downgrades for the verdict to allow routeByJev in a wrapper.
//
// The skill options come from a frozen snapshot (benchmarks/fixtures/router_skills.json), so a run is
// reproducible on any machine. Production does NOT read it: the hook reads the live inventory of the
// session's cwd (skill-inventory.js), which differs per project and per machine. --write-skills
// rebuilds the snapshot from this machine's inventory, through the hook's own optionsFrom(), with
// every private-terms.json term replaced.
//
//   node benchmarks/jev_router_eval.js [--corpus <jsonl>] [--skills <json>] [--json <out>]
//   node benchmarks/jev_router_eval.js --write-skills <out> [--cwd <dir>]
//
//   0  measured: a tier threshold exists and capped downgrades keep ≥ 0.9 — routeByJev may be enabled
//   1  measured, and one of the two fails — routeByJev must keep the configured line-up
//   2  the corpus or the skill snapshot is malformed
//   3  Jev is off (no TYPESAFE_API_KEY) — nothing was measured
//
// N is small: 64 prompts, one operator, mostly Spanish. A precision from it is a reading of this
// operator's prompts, not of anyone's. Thresholds come with the N they were measured on.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const LOOPS = path.join(ROOT, 'plugins/harness-loops/scripts');
const jev = require(path.join(LOOPS, 'jev.js'));
const { classify, optionsFrom, BUDGET_MS } = require(path.join(LOOPS, 'hooks/prompt-router.js'));

const TIER_NAMES = Object.keys(jev.TIERS);
const TARGET = 0.9;
const GRID = [0.3, 0.4, 0.5, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.99];
const MIN_N = 5;            // a cut-off that keeps fewer predictions than this proves nothing either way
const PASSES = 2;
const CONFIGURED = 'opus';  // the line-up's implementer: what a downgrade is measured from
const CONCURRENCY = 4;

function readCorpus(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l, i) => {
    try { return JSON.parse(l); } catch (e) { throw new Error(`line ${i + 1}: ${e.message}`); }
  });
}

function validate(rows, options) {
  const errors = [];
  const known = new Set([...Object.keys(options), 'none']);
  const ids = new Set();
  rows.forEach((r, i) => {
    const w = `row ${i + 1}${r && r.id ? ` (${r.id})` : ''}`;
    if (!r || typeof r.id !== 'string' || !r.id) { errors.push(`${w} has no id`); return; }
    if (ids.has(r.id)) errors.push(`${w} reuses the id`);
    ids.add(r.id);
    if (typeof r.prompt !== 'string' || !r.prompt.trim()) errors.push(`${w} has no prompt`);
    if (!TIER_NAMES.includes(r.tier)) errors.push(`${w} tier ${JSON.stringify(r.tier)} is not one of ${TIER_NAMES.join('/')}`);
    if (!known.has(r.skill)) errors.push(`${w} skill ${JSON.stringify(r.skill)} is not in the skill snapshot`);
    if (r.skill_alt !== undefined) {
      if (!Array.isArray(r.skill_alt) || !r.skill_alt.length) errors.push(`${w} skill_alt must be a non-empty array when present`);
      else for (const a of r.skill_alt) {
        if (!known.has(a)) errors.push(`${w} skill_alt ${JSON.stringify(a)} is not in the skill snapshot`);
        if (a === r.skill) errors.push(`${w} skill_alt repeats the primary label`);
      }
    }
  });
  if (!Object.keys(options).length) errors.push('the skill snapshot is empty');
  return errors;
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// The eval measures classification, not the network: it waits as long as the client's default retries
// allow. The hook gives up at BUDGET_MS, so every answer slower than that is counted as one the hook
// would have dropped.
async function predict(rows, options) {
  return pool(rows, CONCURRENCY, async (r) => {
    const t0 = Date.now();
    try {
      const c = await classify(r.prompt, options, { timeoutMs: 20000 });
      return { id: r.id, ms: Date.now() - t0, skill: c.skill, tier: c.tier, inputTokens: c.usage?.input_tokens ?? null };
    } catch (e) {
      return { id: r.id, ms: Date.now() - t0, error: String(e.message).split('\n')[0] };
    }
  });
}

const ratio = (a, b) => (b ? a / b : null);

// Per label: how many rows carry it, how many predictions name it, and the two precisions/recalls.
function perLabel(rows, preds, field, labels) {
  const ok = (r, choice, lax) => choice === r[field] || (lax && field === 'skill' && (r.skill_alt || []).includes(choice));
  return labels.map((label) => {
    const expected = rows.filter((r) => r[field] === label);
    const predicted = rows.map((r, i) => [r, preds[i][field]]).filter(([, p]) => p && p.choice === label);
    const hit = (lax) => predicted.filter(([r]) => ok(r, label, lax)).length;
    const found = (lax) => expected.filter((r) => { const p = preds[rows.indexOf(r)][field]; return p && ok(r, p.choice, lax); }).length;
    return {
      label, n: expected.length, predicted: predicted.length,
      precisionStrict: ratio(hit(false), predicted.length), precisionLax: ratio(hit(true), predicted.length),
      recallStrict: ratio(found(false), expected.length), recallLax: ratio(found(true), expected.length),
    };
  }).filter((x) => x.n || x.predicted);
}

function confusion(rows, preds, field) {
  const m = {};
  rows.forEach((r, i) => {
    const got = preds[i][field] ? preds[i][field].choice : '(no answer)';
    m[r[field]] = m[r[field]] || {};
    m[r[field]][got] = (m[r[field]][got] || 0) + 1;
  });
  return m;
}

// Precision of the predictions kept at each cut-off, and the threshold under both readings (header).
function sweep(rows, preds, field, lax) {
  const scored = rows.map((r, i) => ({ r, p: preds[i][field] })).filter((x) => x.p);
  const good = ({ r, p }) => p.choice === r[field] || (lax && (r.skill_alt || []).includes(p.choice));
  const table = GRID.map((t) => {
    const kept = scored.filter((x) => x.p.p >= t);
    return { t, kept: kept.length, coverage: kept.length / rows.length, precision: ratio(kept.filter(good).length, kept.length) };
  });
  const threshold = table.find((row) => row.kept >= MIN_N && row.precision >= TARGET) || null;
  let holdThreshold = null;
  for (let i = table.length - 1; i >= 0; i--) {
    const row = table[i];
    if (row.kept < MIN_N) continue;
    if (row.precision >= TARGET) holdThreshold = row; else break;
  }
  return { table, threshold, holdThreshold };
}

// routeByJev's own decision (jev.js decideTier) replayed on every prompt, from the line-up's implementer.
// Only the downgrades are scored: a downgrade is right when the tier it lands on covers the label.
function downgrades(rows, preds, threshold, configured = CONFIGURED) {
  const rank = (t) => jev.TIER_ORDER.indexOf(t);
  const cases = [];
  let upgrades = 0;
  rows.forEach((r, i) => {
    const p = preds[i].tier;
    if (!p) return;
    const d = jev.decideTier({ configured, suggested: p.choice, p: p.p, threshold });
    if (!d.tier) return;
    if (rank(d.tier) > rank(configured)) { upgrades += 1; return; }
    cases.push({ id: r.id, label: r.tier, suggested: p.choice, p: p.p, tier: d.tier, right: rank(d.tier) >= rank(r.tier) });
  });
  const right = cases.filter((c) => c.right).length;
  return { configured, threshold, decisions: cases.length, right, precision: ratio(right, cases.length), upgrades, wrong: cases.filter((c) => !c.right) };
}

function evaluate(rows, options, preds) {
  const answered = preds.filter((p) => !p.error);
  const acc = (field, lax) => ratio(rows.filter((r, i) => {
    const p = preds[i][field];
    return p && (p.choice === r[field] || (lax && (r.skill_alt || []).includes(p.choice)));
  }).length, rows.length);
  const ms = answered.map((p) => p.ms).sort((a, b) => a - b);
  const q = (x) => (ms.length ? ms[Math.min(ms.length - 1, Math.floor(x * ms.length))] : null);
  const skillLabels = [...new Set([...rows.map((r) => r.skill), ...preds.map((p) => p.skill && p.skill.choice).filter(Boolean)])].sort();
  return {
    n: rows.length, options: Object.keys(options).length, errors: preds.filter((p) => p.error).map((p) => ({ id: p.id, error: p.error })),
    skill: {
      accuracyStrict: acc('skill', false), accuracyLax: acc('skill', true),
      perLabel: perLabel(rows, preds, 'skill', skillLabels),
      confusion: confusion(rows, preds, 'skill'),
      sweepStrict: sweep(rows, preds, 'skill', false), sweepLax: sweep(rows, preds, 'skill', true),
    },
    tier: {
      accuracy: acc('tier', false),
      perLabel: perLabel(rows, preds, 'tier', TIER_NAMES),
      confusion: confusion(rows, preds, 'tier'),
      sweep: sweep(rows, preds, 'tier', false),
    },
    latency: { p50: q(0.5), p95: q(0.95), overBudget: ms.filter((x) => x > BUDGET_MS).length, budgetMs: BUDGET_MS },
    inputTokens: answered.reduce((s, p) => s + (p.inputTokens || 0), 0),
    predictions: preds,
  };
}

// Two passes → one verdict: the higher cumulative threshold (none if a pass has none), then every pass's
// capped downgrades at that threshold.
function combine(rows, passes) {
  const ts = passes.map((e) => e.tier.sweep.threshold);
  const threshold = ts.every(Boolean) ? Math.max(...ts.map((t) => t.t)) : null;
  const down = passes.map((e) => downgrades(rows, e.predictions, threshold));
  const downOk = threshold !== null && down.every((d) => d.decisions >= MIN_N && d.precision >= TARGET);
  const statOf = (values) => { const v = values.filter((x) => x !== null && x !== undefined); return v.length ? { mean: v.reduce((a, b) => a + b, 0) / v.length, min: Math.min(...v), max: Math.max(...v) } : null; };
  const stat = (f) => statOf(passes.map(f));
  return {
    passes: passes.length, threshold, routable: downOk, downgrades: down,
    summary: {
      tier: stat((e) => e.tier.accuracy),
      skillStrict: stat((e) => e.skill.accuracyStrict),
      skillLax: stat((e) => e.skill.accuracyLax),
      tierPrecision: Object.fromEntries(TIER_NAMES.map((t) => [t, stat((e) => (e.tier.perLabel.find((l) => l.label === t) || {}).precisionStrict ?? null)])),
      tierRecall: Object.fromEntries(TIER_NAMES.map((t) => [t, stat((e) => (e.tier.perLabel.find((l) => l.label === t) || {}).recallStrict ?? null)])),
      coverageAtThreshold: threshold === null ? null : stat((e) => e.tier.sweep.table.find((r) => r.t === threshold).coverage),
      precisionAtThreshold: threshold === null ? null : stat((e) => e.tier.sweep.table.find((r) => r.t === threshold).precision),
      downgradePrecision: statOf(down.map((d) => d.precision)),
    },
  };
}

const pct = (x) => (x === null || x === undefined ? '  n/a' : `${(100 * x).toFixed(0).padStart(4)}%`);
const p1 = (x) => (x === null || x === undefined ? 'n/a' : `${(100 * x).toFixed(1)}%`);
const mr = (s) => (s ? `${p1(s.mean)} [${p1(s.min)}–${p1(s.max)}]` : 'n/a');

function renderPass(e, k) {
  const out = [];
  out.push(`── pass ${k} — ${e.n} prompts · ${e.options} skill options · ${e.errors.length} unanswered · ${e.inputTokens} input tokens`);
  out.push(`latency p50 ${e.latency.p50}ms · p95 ${e.latency.p95}ms · ${e.latency.overBudget} answer(s) slower than the hook's ${e.latency.budgetMs}ms budget (the hook drops those)`);
  out.push('');
  out.push(`TIER   top-1 ${pct(e.tier.accuracy).trim()} (strict = lax: tiers carry no alternatives)`);
  out.push('  label    n  pred  precision  recall');
  for (const l of e.tier.perLabel) out.push(`  ${l.label.padEnd(7)}${String(l.n).padStart(3)} ${String(l.predicted).padStart(4)}   ${pct(l.precisionStrict)}    ${pct(l.recallStrict)}`);
  out.push('  confusion (rows = label, columns = Jev):');
  out.push(`  ${''.padEnd(8)}${TIER_NAMES.map((t) => t.padStart(7)).join('')}`);
  for (const t of TIER_NAMES) out.push(`  ${t.padEnd(8)}${TIER_NAMES.map((c) => String((e.tier.confusion[t] || {})[c] || 0).padStart(7)).join('')}`);
  out.push('');
  out.push(`SKILL  top-1 strict ${pct(e.skill.accuracyStrict).trim()} · lax ${pct(e.skill.accuracyLax).trim()}`);
  out.push('  label                          n  pred  prec strict  prec lax  recall strict  recall lax');
  for (const l of e.skill.perLabel) {
    out.push(`  ${l.label.slice(0, 30).padEnd(30)}${String(l.n).padStart(3)} ${String(l.predicted).padStart(4)}     ${pct(l.precisionStrict)}    ${pct(l.precisionLax)}         ${pct(l.recallStrict)}      ${pct(l.recallLax)}`);
  }
  out.push('  confusion, off the diagonal (label → Jev × count):');
  for (const [label, row] of Object.entries(e.skill.confusion).sort()) {
    for (const [got, n] of Object.entries(row)) if (got !== label) out.push(`    ${label} → ${got} ×${n}`);
  }
  out.push('');
  const sw = (name, s) => {
    out.push(`${name} — precision of the predictions kept at each confidence cut-off`);
    out.push('  cut-off  kept  coverage  precision');
    for (const r of s.table) out.push(`  ${r.t.toFixed(2)}    ${String(r.kept).padStart(4)}    ${pct(r.coverage)}     ${pct(r.precision)}`);
    const say = (label, th) => (th
      ? `  → ${label} ${th.t.toFixed(2)}: precision ${pct(th.precision).trim()} on ${th.kept} prediction(s), ${pct(th.coverage).trim()} of the corpus`
      : `  → ${label}: none (no cut-off qualifies on ≥ ${MIN_N} predictions)`);
    out.push(say('cumulative threshold', s.threshold));
    out.push(say('holds-from-there-on threshold (not used)', s.holdThreshold));
  };
  sw('TIER', e.tier.sweep);
  sw('SKILL strict', e.skill.sweepStrict);
  sw('SKILL lax', e.skill.sweepLax);
  if (e.errors.length) {
    out.push('');
    out.push('UNANSWERED:');
    for (const x of e.errors) out.push(`  ${x.id} ${x.error}`);
  }
  return out.join('\n');
}

function render(passes, c) {
  const s = c.summary;
  const out = [];
  out.push(`jev router eval — ${passes[0].n} prompts × ${c.passes} passes (Jev is not deterministic: mean [min–max] of the passes)`);
  out.push(`TIER top-1 ${mr(s.tier)} · SKILL top-1 strict ${mr(s.skillStrict)} · lax ${mr(s.skillLax)}`);
  out.push(`tier precision: ${TIER_NAMES.map((t) => `${t} ${mr(s.tierPrecision[t])}`).join(' · ')}`);
  out.push(`tier recall:    ${TIER_NAMES.map((t) => `${t} ${mr(s.tierRecall[t])}`).join(' · ')}`);
  out.push(c.threshold === null
    ? `THRESHOLD (cumulative, higher of the passes): none — ${passes.map((e, i) => `pass ${i + 1} ${e.tier.sweep.threshold ? e.tier.sweep.threshold.t.toFixed(2) : 'none'}`).join(', ')}`
    : `THRESHOLD (cumulative, higher of the passes): ${c.threshold.toFixed(2)} — precision ${mr(s.precisionAtThreshold)} on ${mr(s.coverageAtThreshold)} of the corpus`);
  for (const [i, d] of c.downgrades.entries()) {
    out.push(`DOWNGRADES pass ${i + 1} (from ${d.configured}, one tier at most, never below sonnet): ${d.decisions === 0 ? 'none' : `${d.right}/${d.decisions} right = ${p1(d.precision)}`}${d.wrong.length ? ` · wrong: ${d.wrong.map((w) => `${w.id} ${w.label}→${w.tier} (Jev ${w.suggested} p=${w.p.toFixed(2)})`).join(', ')}` : ''} · ${d.upgrades} upgrade(s) not scored`);
  }
  out.push('');
  passes.forEach((e, i) => { out.push(renderPass(e, i + 1)); out.push(''); });
  return out.join('\n');
}

function scrub(options) {
  let terms = [];
  try {
    const t = JSON.parse(fs.readFileSync(path.join(ROOT, 'private-terms.json'), 'utf8'));
    terms = [...(t.substring || []), ...(t.fenced || [])];
  } catch { /* no private terms on this machine: nothing to replace */ }
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const out = {};
  // What follows a private term is usually about it (a partner's people, a client's deal), so the
  // description stops at the first one.
  for (const [k, v] of Object.entries(options)) {
    const s = terms.reduce((acc, term) => acc.replace(new RegExp(esc(term), 'gi'), '<private>'), v);
    out[k] = s.includes('<private>') ? s.slice(0, s.indexOf('<private>') + '<private>'.length) : s;
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (name) => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1]; };
  if (opt('--write-skills')) {
    const { inventorySkills } = require(path.join(LOOPS, 'skill-inventory.js'));
    const options = scrub(optionsFrom(inventorySkills(path.resolve(opt('--cwd') || process.cwd())).skills));
    fs.writeFileSync(opt('--write-skills'), `${JSON.stringify(options, null, 2)}\n`);
    process.stdout.write(`${Object.keys(options).length} skill options written to ${opt('--write-skills')}\n`);
    return 0;
  }
  const corpusPath = opt('--corpus') || path.join(__dirname, 'fixtures', 'router_corpus.jsonl');
  const skillsPath = opt('--skills') || path.join(__dirname, 'fixtures', 'router_skills.json');
  let rows; let options;
  try { rows = readCorpus(corpusPath); options = JSON.parse(fs.readFileSync(skillsPath, 'utf8')); } catch (e) {
    process.stderr.write(`jev_router_eval: ${e.message}\n`); return 2;
  }
  const errors = validate(rows, options);
  if (errors.length) {
    process.stderr.write(`CORPUS INVALID: ${errors.length} error(s)\n`);
    errors.forEach((x, i) => process.stderr.write(`  ${i + 1}. ${x}\n`));
    return 2;
  }
  if (!jev.isEnabled()) {
    process.stdout.write('NOT MEASURED — Jev is off (no TYPESAFE_API_KEY). Run plugins/harness-loops/bin/jev-setup first.\n');
    return 3;
  }
  const passes = [];
  for (let k = 0; k < PASSES; k++) passes.push(evaluate(rows, options, await predict(rows, options)));
  if (passes.some((e) => e.errors.length === rows.length)) {
    process.stdout.write(`NOT MEASURED — every request of a pass failed (${passes.find((e) => e.errors.length === rows.length).errors[0].error}).\n`);
    return 3;
  }
  const c = combine(rows, passes);
  if (opt('--json')) fs.writeFileSync(opt('--json'), `${JSON.stringify({ corpus: path.relative(ROOT, corpusPath), skills: path.relative(ROOT, skillsPath), ...c, passDetail: passes }, null, 2)}\n`);
  process.stdout.write(`${render(passes, c)}\n`);
  const why = c.threshold === null ? `no cumulative cut-off keeps tier precision ≥ ${TARGET} in both passes`
    : `capped downgrades at p ≥ ${c.threshold.toFixed(2)} stay under ${TARGET} (or under ${MIN_N} decisions) in a pass`;
  process.stdout.write(c.routable
    ? `VERDICT: ROUTABLE — tier threshold ${c.threshold.toFixed(2)}; capped downgrades ≥ ${TARGET} in both passes. routeByJev may be enabled in a wrapper (ROUTE_TIER_THRESHOLD = ${c.threshold}).\n`
    : `VERDICT: NOT ROUTABLE — ${why}. routeByJev keeps the configured line-up.\n`);
  return c.routable ? 0 : 1;
}

if (require.main === module) main().then((c) => process.exit(c), (e) => { process.stderr.write(`jev_router_eval: ${e.message}\n`); process.exit(1); });

module.exports = { readCorpus, validate, evaluate, sweep, downgrades, combine, perLabel, render, TARGET, GRID, MIN_N, PASSES };
