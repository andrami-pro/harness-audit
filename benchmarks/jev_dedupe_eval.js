#!/usr/bin/env node
// jev_dedupe_eval.js — does loop-gate's dedupe tell a restatement from a new finding, and at which
// threshold? Run this before trusting it.
//
// loop-gate.js ships with 0.85 (0.95 for a blocker), and those numbers were chosen, not measured.
// This measures them. It feeds a labelled corpus through the production path — the same `dedupe()`
// the panel loops call, one request per 50 pairs, the same question — then re-thresholds the
// probabilities it got back at several cut-offs, offline, so one paid request prices every threshold.
//
// The two errors do not cost the same. A restatement read as new (false negative) buys a redundant
// fix round. A new finding read as a restatement (false positive) is hidden from the stop rule, and a
// hidden new blocker or major lets a loop stop on a defect nobody fixed. So the exit code gates on the
// second kind only, at the thresholds loop-gate actually uses:
//
//   node benchmarks/jev_dedupe_eval.js [--corpus <path>] [--json <out>]
//
//   0  production thresholds hide no new blocker or major
//   1  they hide at least one — raise the threshold, or do not trust the dedupe on this domain
//   2  the corpus is malformed
//   3  Jev is off (no TYPESAFE_API_KEY) — nothing was measured
//
// The corpus is small and synthetic: a number from it is a smoke reading, not a calibration of your
// domain. Add cases from your own loop-runs/ — the round files already hold the pairs — before
// treating any threshold as settled.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { dedupe, DEDUPE_THRESHOLD, DEDUPE_BLOCKER_THRESHOLD } = require(path.join(ROOT, 'plugins/harness-loops/scripts/loop-gate.js'));
const jev = require(path.join(ROOT, 'plugins/harness-loops/scripts/jev.js'));

const THRESHOLDS = [0.5, 0.65, 0.75, 0.85, 0.9, 0.95];
const SEVERITIES = ['blocker', 'major', 'minor'];

function validateCorpus(corpus) {
  const errors = [];
  if (!corpus || !Array.isArray(corpus.cases) || !corpus.cases.length) return ['"cases" is missing or empty'];
  const keys = new Set();
  const ids = new Set();
  corpus.cases.forEach((c, i) => {
    const w = `cases[${i}]${c && c.id ? ` (${c.id})` : ''}`;
    if (!c || typeof c.id !== 'string' || !c.id) { errors.push(`${w} has no id`); return; }
    if (ids.has(c.id)) errors.push(`${w} reuses the id ${c.id}`);
    ids.add(c.id);
    // One candidate set per case: two cases on the same critic + file would pair with each other's
    // findings in the single request, and the label would no longer describe what was asked.
    const key = `${c.critic}|${c.file}`;
    if (keys.has(key)) errors.push(`${w} shares critic + file with another case — cases must not pair across each other`);
    keys.add(key);
    if (!Array.isArray(c.previous) || !c.previous.length) errors.push(`${w} has no previous findings`);
    for (const f of [...(c.previous || []), c.current]) {
      if (!f || !SEVERITIES.includes(f.severity) || typeof f.summary !== 'string' || !f.summary || !Number.isInteger(f.line)) {
        errors.push(`${w} carries a finding without severity/line/summary`);
        break;
      }
    }
    if (!(c.restates === null || (Number.isInteger(c.restates) && c.restates >= 0 && c.restates < (c.previous || []).length))) {
      errors.push(`${w} has restates ${JSON.stringify(c.restates)} — an index into previous, or null`);
    }
  });
  return errors;
}

// The corpus becomes two rounds, exactly as a panel run would write them.
function toRounds(corpus) {
  const previous = [];
  const current = [];
  for (const c of corpus.cases) {
    c.previous.forEach((f, i) => previous.push({ ...f, id: `R1-${c.id}-${i}`, critic: c.critic, file: c.file }));
    current.push({ ...c.current, id: `R2-${c.id}`, critic: c.critic, file: c.file });
  }
  return { previous, current };
}

const bar = (t, severity) => (severity === 'blocker' ? Math.max(t, DEDUPE_BLOCKER_THRESHOLD) : t);

function score(corpus, byId, t) {
  const m = { t, tp: 0, fp: 0, fn: 0, tn: 0, fpBySeverity: { blocker: 0, major: 0, minor: 0 }, wrongMatch: 0, fpCases: [], fnCases: [] };
  for (const c of corpus.cases) {
    const r = byId.get(`R2-${c.id}`);
    const carried = r.via === 'exact' || r.p >= bar(t, c.current.severity);
    const truth = c.restates !== null;
    if (carried && truth) {
      m.tp += 1;
      if (r.restates !== `R1-${c.id}-${c.restates}`) m.wrongMatch += 1;
    } else if (carried) {
      m.fp += 1; m.fpBySeverity[c.current.severity] += 1; m.fpCases.push({ id: c.id, kind: c.kind, severity: c.current.severity, p: r.p });
    } else if (truth) {
      m.fn += 1; m.fnCases.push({ id: c.id, kind: c.kind, severity: c.current.severity, p: r.p });
    } else m.tn += 1;
  }
  m.precision = m.tp + m.fp ? m.tp / (m.tp + m.fp) : null;
  m.recall = m.tp + m.fn ? m.tp / (m.tp + m.fn) : null;
  return m;
}

async function evaluate(corpus) {
  const { previous, current } = toRounds(corpus);
  const result = await dedupe(previous, current, { threshold: DEDUPE_THRESHOLD, jev });
  const byId = new Map(result.findings.map((f) => [f.id, f]));
  const table = THRESHOLDS.map((t) => score(corpus, byId, t));
  const judged = corpus.cases.map((c) => ({ c, r: byId.get(`R2-${c.id}`) })).filter(({ r }) => r.via === 'jev');
  const pos = judged.filter(({ c }) => c.restates !== null).map(({ r }) => r.p);
  const neg = judged.filter(({ c }) => c.restates === null).map(({ r }) => r.p);
  return {
    mode: result.mode, reason: result.reason, pairs: result.pairs, requests: result.requests,
    production: score(corpus, byId, DEDUPE_THRESHOLD),
    table,
    separation: { minRestated: pos.length ? Math.min(...pos) : null, maxNew: neg.length ? Math.max(...neg) : null },
    cases: corpus.cases.map((c) => {
      const r = byId.get(`R2-${c.id}`);
      return { id: c.id, kind: c.kind, severity: c.current.severity, truth: c.restates === null ? null : `R1-${c.id}-${c.restates}`, p: r.p, via: r.via, restates: r.restates };
    }),
  };
}

const pct = (x) => (x === null ? '  n/a' : `${(100 * x).toFixed(0).padStart(4)}%`);

function render(corpus, e) {
  const out = [];
  out.push(`jev dedupe eval — ${corpus.cases.length} cases (${corpus.cases.filter((c) => c.restates !== null).length} restated, ${corpus.cases.filter((c) => c.restates === null).length} new) · ${e.pairs} pair(s), ${e.requests} request(s)`);
  out.push(`separation: lowest p on a true restatement ${e.separation.minRestated?.toFixed(2) ?? 'n/a'} · highest p on a new finding ${e.separation.maxNew?.toFixed(2) ?? 'n/a'}`);
  out.push('');
  out.push('threshold  precision  recall   hidden new (blocker/major/minor)  wrong match');
  for (const m of e.table) {
    const mark = m.t === DEDUPE_THRESHOLD ? ' ← loop-gate' : '';
    out.push(`  ${m.t.toFixed(2)}      ${pct(m.precision)}    ${pct(m.recall)}   ${String(m.fpBySeverity.blocker).padStart(3)} / ${String(m.fpBySeverity.major).padStart(2)} / ${String(m.fpBySeverity.minor).padStart(2)}                     ${m.wrongMatch}${mark}`);
  }
  out.push(`(a blocker is only carried at p ≥ ${DEDUPE_BLOCKER_THRESHOLD}, at every threshold)`);
  const p = e.production;
  if (p.fpCases.length) {
    out.push('');
    out.push('HIDDEN at loop-gate thresholds — new findings read as restatements:');
    for (const f of p.fpCases) out.push(`  ${f.id} ${f.severity.padEnd(7)} p=${f.p.toFixed(2)}  ${f.kind}`);
  }
  if (p.fnCases.length) {
    out.push('');
    out.push('MISSED at loop-gate thresholds — restatements read as new (costs a redundant fix, never a hidden defect):');
    for (const f of p.fnCases) out.push(`  ${f.id} ${f.severity.padEnd(7)} p=${f.p.toFixed(2)}  ${f.kind}`);
  }
  return out.join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (name) => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1]; };
  const corpusPath = opt('--corpus') || path.join(__dirname, 'jev-dedupe', 'corpus.json');
  let corpus;
  try { corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8')); } catch (e) {
    process.stderr.write(`jev_dedupe_eval: cannot read ${corpusPath}: ${e.message}\n`); process.exit(2);
  }
  const errors = validateCorpus(corpus);
  if (errors.length) {
    process.stderr.write(`CORPUS INVALID: ${errors.length} error(s)\n`);
    errors.forEach((x, i) => process.stderr.write(`  ${i + 1}. ${x}\n`));
    process.exit(2);
  }
  if (!jev.isEnabled()) {
    process.stdout.write('NOT MEASURED — Jev is off (no TYPESAFE_API_KEY). Run plugins/harness-loops/bin/jev-setup first.\n');
    process.exit(3);
  }
  const e = await evaluate(corpus);
  if (e.mode !== 'jev') {
    process.stdout.write(`NOT MEASURED — dedupe ran ${e.mode} (${e.reason}).\n`);
    process.exit(3);
  }
  if (opt('--json')) fs.writeFileSync(opt('--json'), `${JSON.stringify(e, null, 2)}\n`);
  process.stdout.write(`${render(corpus, e)}\n\n`);
  const hidden = e.production.fpBySeverity.blocker + e.production.fpBySeverity.major;
  process.stdout.write(hidden
    ? `VERDICT: FAIL — ${hidden} new blocker/major hidden at ${DEDUPE_THRESHOLD}/${DEDUPE_BLOCKER_THRESHOLD}. Do not trust the dedupe on this domain until this is 0.\n`
    : `VERDICT: PASS — no new blocker or major hidden at ${DEDUPE_THRESHOLD}/${DEDUPE_BLOCKER_THRESHOLD}. Recall ${pct(e.production.recall).trim()} (the rest costs redundant fix rounds, not defects).\n`);
  process.exit(hidden ? 1 : 0);
}

if (require.main === module) main().catch((e) => { process.stderr.write(`jev_dedupe_eval: ${e.message}\n`); process.exit(1); });

module.exports = { validateCorpus, toRounds, score, evaluate, THRESHOLDS };
