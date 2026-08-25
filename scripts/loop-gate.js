#!/usr/bin/env node
// loop-gate.js — the deterministic seam between a seat and the panel chair.
//
// Every loop in this repo has one costume seam: a critic or the scorer emits JSON, and the chair — a
// model — reads it, trusts it, and aggregates it. Nothing between the two can say no. A finding that
// anchors at a file that does not exist, or at line 900 of a 40-line file, is indistinguishable from a
// real one once it is inside the findings JSON, and it will be reported to a human as evidence.
//
// This is the gate for that seam, and it costs zero tokens: `check-findings` refuses a seat's output
// that breaks the contract its own agent file states, and `resume` refuses to guess what a half-written
// run was doing. Both report errors as a numbered, self-repairable list — the seat re-runs against the
// list rather than the chair paraphrasing the problem back at it.
//
//   node loop-gate.js check-findings <file|-> [--root <repo>] [--seat <name>]
//   node loop-gate.js check-handoff <file|-> [--seat <name>]
//   node loop-gate.js resume <run-dir>
//
// Exit codes are the contract, not the prose: 0 = usable, 2 = the caller must repair and retry,
// 1 = this script was invoked wrong. 2 is never a reason to proceed with what you have.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FINDING_KEYS = ['severity', 'file', 'line', 'summary', 'fix'];
// The seat does not name its own finding, for the same reason swarm-forge refuses a handoff whose
// draft sets `id` or `from`: an identifier a sender chooses is an identifier two senders can collide
// on. The chair assigns `id` and `critic` at aggregation, and a seat that pre-fills them has either
// been told which round it is in or is guessing — both are findings about the loop, not about the code.
const RESERVED_KEYS = ['id', 'critic'];
const SEVERITIES = new Set(['blocker', 'major', 'minor']);
const CRITERION_KEYS = ['id', 'source', 'class', 'applies', 'pass', 'evidence'];
const CLASSES = new Set(['blocker', 'quality']);
const WEIGHT = { blocker: 3, quality: 1 };
// A handoff is what a builder seat REPORTS at the end of its round: where it thinks the work stands,
// and what it can point at. The gate checks the shape — a status from the fixed set, evidence that is
// not empty, a blocker named exactly when the status is blocked — and nothing more. A handoff that
// passes this gate has been reported by the worker, not certified by anyone; the chair says so.
const HANDOFF_KEYS = ['status', 'summary', 'evidence', 'blocker'];
const HANDOFF_STATUSES = new Set(['complete', 'continue', 'blocked']);

const FINDING_SHAPE = [
  'Expected shape — a JSON array, one object per finding, and nothing else in the reply:',
  '  [ { "severity": "blocker|major|minor", "file": "<a path that exists>", "line": <0 = file-wide>,',
  '      "summary": "one sentence: the defect", "fix": "one sentence: the action" } ]',
  'Do not set "id" or "critic" — the panel chair assigns those.',
  'An empty array is a valid reply, and it is a claim you have to have earned.',
].join('\n');

const SCORECARD_SHAPE = [
  'Expected shape — a JSON object, and nothing else in the reply:',
  '  { "rubric": "<path>", "excluded": ["<path> — why"],',
  '    "criteria": [ { "id": "S2", "source": "structural|rubric", "class": "blocker|quality",',
  '                    "applies": true, "pass": true, "evidence": "<a command and its output, or file:line>" } ],',
  '    "findings": [ { "severity": "...", "file": "...", "line": 0, "summary": "...", "fix": "..." } ] }',
  'At least one finding per FAILED criterion. Do not set "id" or "critic" on a finding.',
].join('\n');

const HANDOFF_SHAPE = [
  'Expected shape — a JSON object, and nothing else in the reply:',
  '  { "status": "complete|continue|blocked", "summary": "one sentence: where the work stands",',
  '    "evidence": ["<a command and its output, or file:line>", "..."],',
  '    "blocker": "<only when status is blocked: what stops the work, in one sentence>" }',
  'A handoff is what the seat reports; the gate checks its shape, it does not certify it.',
].join('\n');

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

// A path is only an anchor if something is actually there. Resolved against the repo root and refused
// if it escapes it: a finding filed against /etc/passwd is not a finding about this project.
function anchorError(root, file, line, where) {
  if (!isNonEmptyString(file)) return `${where} "file" is missing or empty — every finding anchors somewhere`;
  const abs = path.resolve(root, file);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    return `${where} "file" resolves outside the repo: ${file}`;
  }
  if (!fs.existsSync(abs)) return `${where} "file" does not exist: ${file}`;
  // Every filesystem call here runs on a string a seat chose, so each one is a way for a malformed
  // finding to throw rather than be reported — and an uncaught throw takes the whole round with it,
  // which is a worse outcome than the defect it was inspecting. The gate reports; it never dies.
  try {
    if (fs.statSync(abs).isDirectory()) {
      return line > 0 ? `${where} "file" is a directory but "line" is ${line}: ${file}` : null;
    }
    if (line > 0) {
      const lines = fs.readFileSync(abs, 'utf8').split('\n').length;
      if (line > lines) return `${where} "line" ${line} is past the end of ${file} (${lines} lines)`;
    }
  } catch (e) {
    return `${where} "file" could not be read: ${file} (${e.code || e.message})`;
  }
  return null;
}

function checkFinding(finding, root, where) {
  const errors = [];
  if (!isPlainObject(finding)) return [`${where} is not an object`];

  for (const k of RESERVED_KEYS) {
    if (k in finding) errors.push(`${where} sets the reserved key "${k}" — the panel chair assigns it, not you`);
  }
  for (const k of Object.keys(finding)) {
    if (!FINDING_KEYS.includes(k) && !RESERVED_KEYS.includes(k)) {
      errors.push(`${where} carries an unknown key "${k}" — the contract is exactly: ${FINDING_KEYS.join(', ')}`);
    }
  }
  for (const k of FINDING_KEYS) {
    if (!(k in finding)) errors.push(`${where} is missing "${k}"`);
  }

  if ('severity' in finding && !SEVERITIES.has(finding.severity)) {
    errors.push(`${where} has severity "${finding.severity}" — the ladder is fixed: blocker, major, minor`);
  }
  if ('line' in finding && (!Number.isInteger(finding.line) || finding.line < 0)) {
    errors.push(`${where} has line ${JSON.stringify(finding.line)} — an integer ≥ 0 (0 = file-wide)`);
  }
  for (const k of ['summary', 'fix']) {
    if (k in finding && !isNonEmptyString(finding[k])) errors.push(`${where} has an empty "${k}"`);
  }

  if ('file' in finding) {
    const line = Number.isInteger(finding.line) ? finding.line : 0;
    const err = anchorError(root, finding.file, line, where);
    if (err) errors.push(err);
  }
  return errors;
}

function checkFindingList(findings, root, offset = 0) {
  if (!Array.isArray(findings)) return ['"findings" is not an array'];
  return findings.flatMap((f, i) => checkFinding(f, root, `finding[${i + offset}]`));
}

// The scorer's own file tells it the caller recomputes its arithmetic. Until now the caller was a
// model doing sums in prose. Here it is a function: same formula, same table, and a number the gate
// derives rather than reads. A headline the table does not support is reported as a mismatch, never
// silently preferred either way — the chair still owns the gate, it just no longer owns the addition.
function scoreOf(criteria) {
  let num = 0;
  let den = 0;
  let blockers = 0;
  for (const c of criteria) {
    if (c.applies !== true) continue;
    const w = WEIGHT[c.class];
    den += w;
    if (c.pass === true) num += w;
    else if (c.class === 'blocker') blockers += 1;
  }
  return { score: den === 0 ? 0 : Math.round((100 * num) / den), blockers, counted: den };
}

function checkScorecard(card, root) {
  const errors = [];
  if (!Array.isArray(card.criteria)) {
    errors.push('"criteria" is missing or not an array — the scorecard IS the criteria table');
    return { errors };
  }
  if (!card.criteria.length) errors.push('"criteria" is empty — a scorer with no criteria has an opinion, not a score');

  card.criteria.forEach((c, i) => {
    const where = `criteria[${i}]`;
    if (!isPlainObject(c)) { errors.push(`${where} is not an object`); return; }
    for (const k of Object.keys(c)) {
      if (!CRITERION_KEYS.includes(k)) errors.push(`${where} carries an unknown key "${k}" — the contract is exactly: ${CRITERION_KEYS.join(', ')}`);
    }
    for (const k of CRITERION_KEYS) if (!(k in c)) errors.push(`${where} is missing "${k}"`);
    if (!isNonEmptyString(c.id)) errors.push(`${where} has an empty "id"`);
    if ('class' in c && !CLASSES.has(c.class)) errors.push(`${where} has class "${c.class}" — blocker or quality`);
    for (const k of ['applies', 'pass']) {
      if (k in c && typeof c[k] !== 'boolean') errors.push(`${where} has a non-boolean "${k}" — true or false, never a string`);
    }
    // `applies: false` is the one exit from a criterion, so it is the one that has to cost something.
    // Unjustified, it is how a rubric row gets skipped and still reads as covered.
    if (c.applies === false && !isNonEmptyString(c.evidence)) {
      errors.push(`${where} is applies: false with no evidence — an unchecked criterion costs a line of justification`);
    }
    if (c.applies === true && !isNonEmptyString(c.evidence)) {
      errors.push(`${where} has no evidence — a command and its output, or a file:line. "Looks fine" is not evidence`);
    }
  });

  const findings = card.findings === undefined ? [] : card.findings;
  errors.push(...checkFindingList(findings, root));

  // Every failed criterion has to surface as a finding, or the score drops for a reason the fix round
  // is never told about — the loop reports a number nobody can act on. Evaluated unconditionally: a
  // scorecard that already broke another rule is exactly the one most likely to break this one too,
  // and reporting one error per run turns a repair-and-retry loop into a queue.
  const failed = card.criteria.filter((c) => c.applies === true && c.pass === false).length;
  if (failed > 0 && Array.isArray(findings) && findings.length === 0) {
    errors.push(`${failed} criterion/criteria FAILED but "findings" is empty — a failed criterion nobody can act on is a score with no fix behind it`);
  }
  return { errors, totals: errors.length ? null : scoreOf(card.criteria) };
}

function checkHandoff(h) {
  const errors = [];
  if (!isPlainObject(h)) return ['the handoff is not an object'];
  for (const k of Object.keys(h)) {
    if (!HANDOFF_KEYS.includes(k)) errors.push(`handoff carries an unknown key "${k}" — the contract is exactly: ${HANDOFF_KEYS.join(', ')}`);
  }
  for (const k of ['status', 'summary', 'evidence']) {
    if (!(k in h)) errors.push(`handoff is missing "${k}"`);
  }
  if ('status' in h && !HANDOFF_STATUSES.has(h.status)) {
    errors.push(`handoff has status ${JSON.stringify(h.status)} — the set is fixed: complete, continue, blocked`);
  }
  if ('summary' in h && !isNonEmptyString(h.summary)) errors.push('handoff has an empty "summary"');
  if ('evidence' in h) {
    if (!Array.isArray(h.evidence)) errors.push('handoff "evidence" is not an array — one string per item a reader can re-check');
    else if (!h.evidence.length) errors.push('handoff "evidence" is empty — a status nobody can re-check is an opinion');
    else h.evidence.forEach((e, i) => { if (!isNonEmptyString(e)) errors.push(`handoff evidence[${i}] is not a non-empty string`); });
  }
  // The blocker rule cuts both ways. A `blocked` with no blocker is a stall nobody can name, and the
  // chair has nothing to hand the human. A named blocker on a status that is not blocked is two
  // statuses in one object, and the reader takes whichever one suits them.
  if (h.status === 'blocked' && !isNonEmptyString(h.blocker)) {
    errors.push('handoff is blocked with no blocker — a block nobody can name is a stall, not a status');
  }
  if (h.status !== 'blocked' && 'blocker' in h) {
    errors.push(`handoff carries a blocker but is not blocked (status ${JSON.stringify(h.status)}) — one status per handoff`);
  }
  return errors;
}

function readInput(file) {
  const raw = file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8');
  // A seat that wraps its JSON in a ```json fence has still emitted the contract; a chair pasting the
  // block verbatim is the common case, and refusing it would be refusing formatting, not a defect.
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/.exec(raw);
  const text = fenced ? fenced[1] : raw;
  try {
    return JSON.parse(text);
  } catch (e) {
    const err = new Error(`the reply is not parseable JSON: ${e.message}`);
    err.contract = true;
    throw err;
  }
}

function reportInvalid(kind, seat, errors, shape) {
  const who = seat ? `${seat}: ` : '';
  process.stderr.write(`${who}${kind} INVALID: ${errors.length} error(s)\n`);
  errors.forEach((e, i) => process.stderr.write(`  ${i + 1}. ${e}\n`));
  process.stderr.write(`\n${shape}\n`);
  process.exit(2);
}

// Positional-vs-flag parsing done by walking the list, not by indexOf: `--seat scorer scorer.json`
// has two identical tokens, and indexOf answers for the first one whichever you ask about.
function parseArgs(argv, flags) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (flags.includes(argv[i])) { opts[argv[i]] = argv[i + 1]; i += 1; } else positional.push(argv[i]);
  }
  return { opts, positional };
}

function cmdCheckFindings(argv) {
  const { opts, positional } = parseArgs(argv, ['--root', '--seat']);
  const [file] = positional;
  if (!file) {
    process.stderr.write('usage: loop-gate.js check-findings <file|-> [--root <repo>] [--seat <name>]\n');
    process.exit(1);
  }
  const root = path.resolve(opts['--root'] || process.cwd());
  const seat = opts['--seat'] || null;

  let parsed;
  try {
    parsed = readInput(file);
  } catch (e) {
    if (e.contract) reportInvalid('FINDINGS', seat, [e.message], FINDING_SHAPE);
    process.stderr.write(`loop-gate.js: ${e.message}\n`);
    process.exit(1);
  }

  if (Array.isArray(parsed)) {
    const errors = checkFindingList(parsed, root);
    if (errors.length) reportInvalid('FINDINGS', seat, errors, FINDING_SHAPE);
    process.stdout.write(`FINDINGS OK: ${parsed.length} finding(s)${seat ? ` from ${seat}` : ''}\n`);
    return;
  }

  if (isPlainObject(parsed) && ('criteria' in parsed || 'rubric' in parsed)) {
    const { errors, totals } = checkScorecard(parsed, root);
    if (errors.length) reportInvalid('SCORECARD', seat, errors, SCORECARD_SHAPE);
    const findings = Array.isArray(parsed.findings) ? parsed.findings.length : 0;
    process.stdout.write(`SCORECARD OK: ${parsed.criteria.length} criteria (${totals.counted} weight counted) · ${findings} finding(s)\n`);
    // Printed by the gate so the chair reads a computed number instead of producing one. The gate
    // decides nothing: `score ≥ 90 ∧ blockers = 0` stays the chair's call, on these two numbers.
    process.stdout.write(`SCORE: ${totals.score}/100 · BLOCKERS: ${totals.blockers}\n`);
    return;
  }

  reportInvalid('FINDINGS', seat, ['the reply is neither a findings array nor a scorecard object'], FINDING_SHAPE);
}

function cmdCheckHandoff(argv) {
  const { opts, positional } = parseArgs(argv, ['--seat']);
  const [file] = positional;
  if (!file) {
    process.stderr.write('usage: loop-gate.js check-handoff <file|-> [--seat <name>]\n');
    process.exit(1);
  }
  const seat = opts['--seat'] || null;

  let parsed;
  try {
    parsed = readInput(file);
  } catch (e) {
    if (e.contract) reportInvalid('HANDOFF', seat, [e.message], HANDOFF_SHAPE);
    process.stderr.write(`loop-gate.js: ${e.message}\n`);
    process.exit(1);
  }

  // A run aggregate that carries its last handoff is checked on that field, so the same command
  // covers a seat's raw reply and a finished loop-runs/*.json.
  const handoff = isPlainObject(parsed) && !('status' in parsed) && 'handoff' in parsed ? parsed.handoff : parsed;
  const errors = checkHandoff(handoff);
  if (errors.length) reportInvalid('HANDOFF', seat, errors, HANDOFF_SHAPE);
  process.stdout.write(`HANDOFF OK: ${handoff.status} · ${handoff.evidence.length} evidence line(s)${seat ? ` from ${seat}` : ''}\n`);
}

// Rounds are files, and the round a run is on is which files exist — the same reason swarm-forge keeps
// its queue in directory names rather than in a process: a chair that dies in round 3 of a five-round
// deep read loses its context, and everything it had already paid for, unless the rounds are on disk.
//
// This refuses to guess. A gap in the sequence, a file it cannot parse, a round numbered outside the
// run — each is AMBIGUOUS_RUN_STATE with the files listed, exit 2, and a human decides. Reconciling a
// half-written run silently is how a loop resumes into a state nobody chose.
function cmdResume(argv) {
  const dir = argv.find((a) => !a.startsWith('--'));
  if (!dir) {
    process.stderr.write('usage: loop-gate.js resume <run-dir>\n');
    process.exit(1);
  }
  if (!fs.existsSync(dir)) {
    process.stdout.write('NO_RUN\n');
    return;
  }
  const entries = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const rounds = new Map();
  const unreadable = [];
  let final = null;

  for (const f of entries) {
    const m = /^round-(\d+)\.json$/.exec(f);
    if (!m) { final = final || f; continue; }
    const n = Number(m[1]);
    try {
      JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch {
      unreadable.push(f);
      continue;
    }
    if (rounds.has(n)) unreadable.push(f);
    rounds.set(n, f);
  }

  const fail = (reason, files) => {
    process.stderr.write(`AMBIGUOUS_RUN_STATE: ${reason}\n`);
    for (const f of files) process.stderr.write(`  ${path.join(dir, f)}\n`);
    process.stderr.write('\nA human settles this. Do not reconcile it: repair or remove the files above, then re-run.\n');
    process.exit(2);
  };

  if (unreadable.length) fail(`${unreadable.length} round file(s) unparseable or duplicated`, unreadable);
  if (!rounds.size) {
    if (final) { process.stdout.write(`RUN_COMPLETE: ${final}\n`); return; }
    process.stdout.write('NO_RUN\n');
    return;
  }

  const ns = [...rounds.keys()].sort((a, b) => a - b);
  const expected = ns.map((_, i) => i + 1);
  if (ns.join(',') !== expected.join(',')) {
    fail(`round files are not the contiguous sequence 1..${ns.length} (found ${ns.join(', ')})`, ns.map((n) => rounds.get(n)));
  }
  if (final) {
    // A run that already wrote its aggregate is finished. Resuming into it would append rounds to a
    // record whose verdict is already published.
    process.stdout.write(`RUN_COMPLETE: ${final}\n`);
    return;
  }
  process.stdout.write(`COMPLETED_ROUNDS: ${ns.length}\n`);
  process.stdout.write(`RESUME_FROM: ${ns.length + 1}\n`);
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'check-findings': return cmdCheckFindings(rest);
    case 'check-handoff': return cmdCheckHandoff(rest);
    case 'resume': return cmdResume(rest);
    default:
      process.stderr.write('usage: loop-gate.js <check-findings|check-handoff|resume> [...]\n');
      process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  checkFinding, checkFindingList, checkScorecard, checkHandoff, scoreOf,
  FINDING_KEYS, RESERVED_KEYS, HANDOFF_KEYS, HANDOFF_STATUSES,
};
