#!/usr/bin/env node
// check-doc-budgets.js — a word ceiling for the docs that accrete.
//
// Standing docs — AGENTS.md, an architecture page, a testing policy — grow by accretion: every rule
// gets restated where it was last needed, every incident gets retold where it hurt, and review alone
// does not stop it. A word budget forces the relocation decision at the moment content is added, which
// is when the author still knows where it belongs. Word count is a crude proxy, accepted on purpose: it
// cannot judge quality, but it can say no.
//
//   node check-doc-budgets.js [--manifest docs/doc-budgets.json] [--root <repo>] [--json]
//
// The manifest maps a path (relative to --root) to its ceiling in words, `wc -w` semantics over the
// whole file. A key of "//" is a comment and is ignored. Exit codes are the contract:
//   0 = every budgeted file exists and is within its ceiling
//   1 = a file is over its ceiling, is missing (a rename must not silently orphan its budget), or
//       resolves outside the root
//   2 = the manifest is absent, unparseable, or budgets nothing — a gate with nothing to check would
//       otherwise pass vacuously, and this one refuses to

'use strict';

const fs = require('node:fs');
const path = require('node:path');

function countWords(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

function loadManifest(file) {
  if (!fs.existsSync(file)) return { error: `manifest not found: ${file}` };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { error: `manifest is not parseable JSON: ${e.message}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'manifest must be a JSON object of { "<path>": <maxWords> }' };
  }
  const entries = [];
  for (const [rel, budget] of Object.entries(parsed)) {
    if (rel === '//') continue;
    if (!Number.isInteger(budget) || budget <= 0) {
      return { error: `manifest entry "${rel}" has a non-positive-integer budget: ${JSON.stringify(budget)}` };
    }
    entries.push({ rel, budget });
  }
  if (!entries.length) return { error: 'manifest budgets nothing — the gate would pass vacuously' };
  return { entries };
}

function checkBudgets(entries, root) {
  const rows = entries.map(({ rel, budget }) => {
    const abs = path.resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + path.sep)) return { rel, budget, words: null, state: 'escape' };
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return { rel, budget, words: null, state: 'missing' };
    const words = countWords(fs.readFileSync(abs, 'utf8'));
    return { rel, budget, words, state: words > budget ? 'over' : 'ok' };
  });
  return { rows, exit: rows.every((r) => r.state === 'ok') ? 0 : 1 };
}

function renderRow(r) {
  switch (r.state) {
    case 'ok': return `✓ ${r.rel} ${r.words}/${r.budget}`;
    case 'over': return `✗ ${r.rel} ${r.words}/${r.budget} (+${r.words - r.budget} over)`;
    case 'missing': return `✗ ${r.rel} MISSING (budget ${r.budget})`;
    default: return `✗ ${r.rel} resolves outside the root (budget ${r.budget})`;
  }
}

function parseArgs(argv) {
  const opts = { manifest: 'docs/doc-budgets.json', root: process.cwd(), json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--manifest') { opts.manifest = argv[i + 1]; i += 1; }
    else if (argv[i] === '--root') { opts.root = argv[i + 1]; i += 1; }
    else if (argv[i] === '--json') opts.json = true;
    else {
      process.stderr.write(`check-doc-budgets.js: unknown argument ${argv[i]}\n`);
      process.exit(2);
    }
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const root = path.resolve(opts.root);
  const manifest = path.resolve(root, opts.manifest);
  const loaded = loadManifest(manifest);
  if (loaded.error) {
    process.stderr.write(`check-doc-budgets.js: ${loaded.error}\n`);
    process.exit(2);
  }
  const { rows, exit } = checkBudgets(loaded.entries, root);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ manifest: path.relative(root, manifest), rows, exit })}\n`);
  } else {
    for (const r of rows) process.stdout.write(`${renderRow(r)}\n`);
    const bad = rows.filter((r) => r.state !== 'ok').length;
    process.stdout.write(bad ? `${bad} of ${rows.length} budget(s) violated\n` : `${rows.length} budget(s) within ceiling\n`);
  }
  process.exit(exit);
}

if (require.main === module) main();

module.exports = { countWords, loadManifest, checkBudgets };
