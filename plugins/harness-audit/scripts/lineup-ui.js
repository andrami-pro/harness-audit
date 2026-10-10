#!/usr/bin/env node
// lineup-ui.js — the editor for ~/.agents/model-lineup.json (D25c).
//
// The line-up is the one config in this repo a human edits by hand and a machine consumes literally,
// which is exactly the shape that produces a `nvidia-nim/zai/glm-5.2` — valid JSON, plausible strings,
// no such model. So the editor never asks anyone to type a model id: every value comes from the live
// catalog, and a save runs the same two gates the loops run (D25a independence, D25c catalog).
//
//   node lineup-ui.js [--global <path>] [--catalog <path>]
//     TTY      — interactive matrix: role x harness, pick from the catalog, save.
//     no TTY   — prints the resolved matrix and the catalog summary, exits 0. Same command in a pipe,
//                a CI log or a subagent, where a raw-mode TUI would hang or corrupt the stream.
//
//   node lineup-ui.js ollama-sync [--models-json <path>]
//     Rewrites the `ollama` provider block of ~/.pi/agent/models.json from `ollama list`, so the
//     catalog stops advertising models the local server does not actually have.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { execFileSync } = require('node:child_process');

const { ROLES, MULTI_PROVIDER_TARGETS, loadCatalog, catalogProblems, resolveLineup, hardViolation } = require('./model-lineup.js');

const GLOBAL_LINEUP = path.join(os.homedir(), '.agents', 'model-lineup.json');
const MODELS_JSON = path.join(os.homedir(), '.pi', 'agent', 'models.json');

// The columns are `defaults` plus the multi-provider harnesses, in a fixed order so the cursor lands
// in the same place every run. `claude` is deliberately absent as a column: Claude Code reads
// `defaults`, and a `harness.claude` block with a provider would silently fall back (resolveLineup)
// while looking like it applied.
const COLUMNS = ['defaults', ...[...MULTI_PROVIDER_TARGETS].filter((t) => t !== 'kilo-loops').sort()];

// Escape codes only where something can render them. The static path is meant to be piped — into a
// file, a log, a subagent's context — and a matrix full of `\x1b[2m` there is worse than no colour.
const paint = (code) => (process.stdout.isTTY ? (s) => `\x1b[${code}m${s}\x1b[0m` : (s) => `${s}`);
const C = { dim: paint(2), bold: paint(1), inv: paint(7), red: paint(31), green: paint(32) };

function readLineup(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return { version: 1, defaults: {}, harness: {} }; }
}

function entryAt(lineup, column, role) {
  if (column === 'defaults') return (lineup.defaults || {})[role] || null;
  return ((lineup.harness || {})[column] || {})[role] || null;
}

function setEntryAt(lineup, column, role, entry) {
  if (column === 'defaults') {
    lineup.defaults = lineup.defaults || {};
    if (entry) lineup.defaults[role] = entry; else delete lineup.defaults[role];
    return;
  }
  lineup.harness = lineup.harness || {};
  lineup.harness[column] = lineup.harness[column] || {};
  if (entry) lineup.harness[column][role] = entry; else delete lineup.harness[column][role];
}

const label = (e) => (e ? (e.provider ? `${e.provider}/${e.model}` : e.model) : '—');

// `defaults` feeds Claude Code, whose registry is not Pi's — it serves ids (claude-opus-5) that Pi's
// catalog has never heard of. Offering only Pi's anthropic list there would quietly push the user to
// downgrade a working line-up, so the ids already in the file are always offered too.
function choicesFor(column, catalog, lineup) {
  const inUse = new Set();
  for (const col of COLUMNS) for (const role of ROLES) {
    const e = entryAt(lineup, col, role);
    if (e && !e.provider) inUse.add(e.model);
  }
  if (column === 'defaults') {
    const anthropic = [...catalog.pairs]
      .filter((p) => p.startsWith('anthropic/'))
      .map((p) => p.slice('anthropic/'.length));
    return [...new Set([...inUse, ...anthropic])].sort().map((model) => ({ model }));
  }
  return [...catalog.pairs].sort().map((pair) => {
    const i = pair.indexOf('/');
    return { provider: pair.slice(0, i), model: pair.slice(i + 1) };
  });
}

function renderMatrix(lineup, { cursorRole, cursorCol } = {}) {
  const widths = COLUMNS.map((col) => Math.max(col.length,
    ...ROLES.map((role) => label(entryAt(lineup, col, role)).length)));
  const roleW = Math.max(...ROLES.map((r) => r.length));
  const lines = [];
  lines.push(`  ${' '.repeat(roleW)}  ${COLUMNS.map((c, i) => C.dim(c.padEnd(widths[i]))).join('  ')}`);
  for (const role of ROLES) {
    const cells = COLUMNS.map((col, i) => {
      const text = label(entryAt(lineup, col, role)).padEnd(widths[i]);
      return role === cursorRole && col === cursorCol ? C.inv(text) : text;
    });
    lines.push(`${role === cursorRole ? '▸ ' : '  '}${C.bold(role.padEnd(roleW))}  ${cells.join('  ')}`);
  }
  return lines.join('\n');
}

// Both gates, run against the file as it would be saved — not against the row just edited. The
// independence rule (D25a) is a property of a pair of roles, so it can only be judged whole.
function gate(lineup, catalog) {
  const problems = [];
  for (const target of ['claude', ...COLUMNS.filter((c) => c !== 'defaults')]) {
    const hard = hardViolation(resolveLineup(lineup, target).resolved);
    if (hard) problems.push(`[${target}] ${hard}`);
  }
  for (const p of catalogProblems(lineup, catalog)) {
    const fix = p.suggestions.length ? ` (¿querías ${p.suggestions.join(' o ')}?)` : '';
    problems.push(`harness.${p.target}.${p.role} = ${p.pair} no existe en el catálogo${fix}`);
  }
  return problems;
}

function printStatic(lineup, catalog, catalogReason) {
  process.stdout.write(`${C.bold('LINE-UP DE MODELOS')} ${C.dim(`· ${GLOBAL_LINEUP}`)}\n\n`);
  process.stdout.write(`${renderMatrix(lineup)}\n\n`);
  if (!catalog) {
    process.stdout.write(`${C.dim(`catálogo no disponible — ${catalogReason}`)}\n`);
    return 0;
  }
  const byProvider = {};
  for (const pair of catalog.pairs) {
    const p = pair.slice(0, pair.indexOf('/'));
    byProvider[p] = (byProvider[p] || 0) + 1;
  }
  process.stdout.write(`${C.dim(`catálogo: ${Object.entries(byProvider).map(([p, n]) => `${p} ${n}`).join(' · ')}`)}\n`);
  const problems = gate(lineup, catalog);
  for (const p of problems) process.stdout.write(`${C.red('✗')} ${p}\n`);
  if (!problems.length) process.stdout.write(`${C.green('✓')} line-up válido\n`);
  process.stdout.write(`${C.dim('(sin TTY: solo lectura — corre esto en una terminal para editarlo)')}\n`);
  return problems.length ? 1 : 0;
}

async function pick(title, items, render) {
  return new Promise((resolve) => {
    let i = 0;
    const PAGE = 12;
    const draw = () => {
      const start = Math.max(0, Math.min(i - Math.floor(PAGE / 2), items.length - PAGE));
      const view = items.slice(start, start + PAGE);
      const body = view.map((it, k) => {
        const text = ` ${render(it)} `;
        return start + k === i ? C.inv(text) : text;
      }).join('\n');
      process.stdout.write(`\x1b[2J\x1b[H${C.bold(title)}\n\n${body}\n\n${C.dim('↑↓ mover · enter elegir · esc cancelar')}\n`);
    };
    const onKey = (_str, key) => {
      if (key.name === 'up') i = (i - 1 + items.length) % items.length;
      else if (key.name === 'down') i = (i + 1) % items.length;
      else if (key.name === 'return') { cleanup(); return resolve(items[i]); }
      else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) { cleanup(); return resolve(null); }
      draw();
    };
    const cleanup = () => process.stdin.off('keypress', onKey);
    process.stdin.on('keypress', onKey);
    draw();
  });
}

async function interactive(lineupPath, lineup, catalog) {
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  let role = ROLES[0];
  let col = COLUMNS[0];
  let dirty = false;
  let message = '';

  const draw = () => {
    const problems = gate(lineup, catalog);
    const status = problems.length
      ? problems.map((p) => `${C.red('✗')} ${p}`).join('\n')
      : `${C.green('✓')} line-up válido`;
    process.stdout.write(`\x1b[2J\x1b[H${C.bold('LINE-UP DE MODELOS')} ${C.dim(`· ${lineupPath}${dirty ? ' · sin guardar' : ''}`)}\n\n`
      + `${renderMatrix(lineup, { cursorRole: role, cursorCol: col })}\n\n${status}\n`
      + `${message ? `\n${message}\n` : ''}`
      + `\n${C.dim('↑↓ rol · ←→ columna · enter elegir modelo · x quitar · s guardar · q salir')}\n`);
  };

  return new Promise((resolve) => {
    const finish = (code) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      resolve(code);
    };
    const onKey = async (_str, key) => {
      message = '';
      if (key.name === 'up') role = ROLES[(ROLES.indexOf(role) - 1 + ROLES.length) % ROLES.length];
      else if (key.name === 'down') role = ROLES[(ROLES.indexOf(role) + 1) % ROLES.length];
      else if (key.name === 'left') col = COLUMNS[(COLUMNS.indexOf(col) - 1 + COLUMNS.length) % COLUMNS.length];
      else if (key.name === 'right') col = COLUMNS[(COLUMNS.indexOf(col) + 1) % COLUMNS.length];
      else if (key.name === 'x') { setEntryAt(lineup, col, role, null); dirty = true; }
      else if (key.name === 'return') {
        process.stdin.off('keypress', onKey);
        const chosen = await pick(`${col} · ${role}`, choicesFor(col, catalog, lineup), (e) => label(e));
        process.stdin.on('keypress', onKey);
        if (chosen) { setEntryAt(lineup, col, role, chosen); dirty = true; }
      } else if (key.name === 's') {
        const problems = gate(lineup, catalog);
        if (problems.length) { message = C.red('no se guarda: arregla primero lo de arriba'); }
        else {
          fs.mkdirSync(path.dirname(lineupPath), { recursive: true });
          fs.writeFileSync(lineupPath, `${JSON.stringify(lineup, null, 2)}\n`);
          dirty = false;
          message = C.green(`guardado en ${lineupPath}`);
        }
      } else if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
        process.stdin.off('keypress', onKey);
        return finish(dirty ? 1 : 0);
      }
      draw();
    };
    process.stdin.on('keypress', onKey);
    draw();
  });
}

// `ollama list` is the only source that knows which models the local server actually has. Seeding
// models.json by hand means the catalog advertises models that 404 at request time — the same class
// of failure this whole file exists to prevent, one layer down.
function ollamaSync(modelsJsonPath) {
  let out;
  try {
    out = execFileSync('ollama', ['list'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    process.stderr.write('lineup-ui: `ollama list` no responde — ¿ollama instalado y arrancado?\n');
    return 1;
  }
  const ids = out.split('\n').slice(1)
    .map((l) => l.trim().split(/\s+/)[0])
    .filter((id) => id && id !== 'NAME');
  if (!ids.length) {
    process.stderr.write('lineup-ui: ollama no tiene ningún modelo descargado (ollama pull <modelo>)\n');
    return 1;
  }
  let cfg = { providers: {} };
  try { cfg = JSON.parse(fs.readFileSync(modelsJsonPath, 'utf8')); } catch { /* archivo nuevo */ }
  cfg.providers = cfg.providers || {};
  const previous = cfg.providers.ollama || {};
  cfg.providers.ollama = {
    baseUrl: previous.baseUrl || 'http://localhost:11434/v1',
    api: previous.api || 'openai-completions',
    apiKey: previous.apiKey || 'ollama',
    compat: previous.compat || { supportsDeveloperRole: false, supportsReasoningEffort: false },
    models: ids.map((id) => ({ id })),
  };
  fs.mkdirSync(path.dirname(modelsJsonPath), { recursive: true });
  fs.writeFileSync(modelsJsonPath, `${JSON.stringify(cfg, null, 2)}\n`);
  process.stdout.write(`ollama-sync: ${ids.length} modelo(s) en ${modelsJsonPath} — ${ids.join(', ')}\n`);
  return 0;
}

function opt(argv, name, def) {
  const i = argv.indexOf(name);
  return i === -1 || i === argv.length - 1 ? def : argv[i + 1];
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === 'ollama-sync') process.exit(ollamaSync(opt(argv, '--models-json', MODELS_JSON)));

  const lineupPath = opt(argv, '--global', GLOBAL_LINEUP);
  const lineup = readLineup(lineupPath);
  const catalog = loadCatalog(opt(argv, '--catalog', null));

  if (!process.stdin.isTTY || !process.stdout.isTTY || argv.includes('--print')) {
    process.exit(printStatic(lineup, catalog.pairs ? catalog : null, catalog.reason));
  }
  if (!catalog.pairs) {
    process.stderr.write(`lineup-ui: sin catálogo no se puede editar sin riesgo — ${catalog.reason}\n`);
    process.exit(1);
  }
  process.exit(await interactive(lineupPath, lineup, catalog));
}

if (require.main === module) main();

module.exports = { main, COLUMNS, choicesFor, gate, renderMatrix, ollamaSync };
