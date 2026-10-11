#!/usr/bin/env node
// jev.js — the one door to TypeSafe's System One API (model "jev"), and the one switch for it.
//
// Jev answers three shapes only — a yes-probability (noul), one option out of a map (choice), a
// position on an ordered scale (score) — over the state the caller hands it. It reads no file, runs
// no tool and generates no text. That is the point: the places this package lets it in are the ones
// where a model was making a discrete call that code should own — "does this finding restate that
// one", "which skill fits this prompt" — and a judgment that comes back as a number can be gated,
// thresholded and logged, where a paragraph could only be trusted.
//
// The switch is global and it is the key. TYPESAFE_API_KEY in the environment, or a
// `TYPESAFE_API_KEY=` line in ~/.agents/secrets.env (where lineup-advise keeps its key), turns every
// Jev path on. No key → `isEnabled()` is false and every caller is a no-op that says so; the loops run
// exactly as they did before this file existed. Nothing here ever reads the working tree, a
// transcript or git — a caller sends what it chooses to send, and README §Jev says what that is.
//
// Tests never touch the network: JEV_MOCK_FILE=<path> installs a transport that answers from a JSON
// file (`answers` keyed by question id, `default` otherwise, `fail`/`latencyMs` to rehearse the
// degraded paths), and counts as enabled without a key.

'use strict';

const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const MODEL = 'jev-latest';
const SECRETS = path.join(os.homedir(), '.agents', 'secrets.env');
const KEY_NAME = 'TYPESAFE_API_KEY';
const MAX_STATE_BYTES = 16 * 1024;
const MAX_OPTIONS = 255;
const MAX_CRITERION_CHARS = 160;
const WAITS = [4000, 10000, 20000];

class JevDisabled extends Error {
  constructor() { super('Jev is off: no TYPESAFE_API_KEY (env or ~/.agents/secrets.env)'); this.code = 'JEV_DISABLED'; }
}

// `off` is a kill switch that keeps the key on disk: the loops go back to today's behaviour without
// the operator having to delete a secret to pause a feature.
function readKey() {
  const env = process.env[KEY_NAME];
  if (env !== undefined) return env && env !== 'off' ? env : null;
  try {
    const line = fs.readFileSync(SECRETS, 'utf8').split('\n').find((l) => l.startsWith(`${KEY_NAME}=`));
    const v = line ? line.slice(KEY_NAME.length + 1).trim() : '';
    return v && v !== 'off' ? v : null;
  } catch { return null; }
}

function status() {
  if (process.env.JEV_MOCK_FILE) return { enabled: true, source: 'mock' };
  if (process.env[KEY_NAME] && process.env[KEY_NAME] !== 'off') return { enabled: true, source: 'env' };
  return readKey() ? { enabled: true, source: 'secrets' } : { enabled: false, source: null };
}

const isEnabled = () => status().enabled;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function postJson(body, key, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data),
        'user-agent': 'harness-audit-jev/1',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) {
          const err = new Error(`HTTP ${res.statusCode} — ${text.slice(0, 160)}`);
          err.status = res.statusCode;
          return reject(err);
        }
        try { resolve(JSON.parse(text)); } catch (e) { reject(new Error(`invalid JSON from api.typesafe.ai: ${e.message}`)); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout ${timeoutMs}ms`)));
    req.on('error', reject);
    req.end(data);
  });
}

function mockTransport(file) {
  return async (body) => {
    const mock = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (mock.latencyMs) await sleep(mock.latencyMs);
    if (mock.fail) {
      const err = new Error(mock.fail === 'timeout' ? 'timeout 0ms' : `HTTP ${mock.fail} — mocked`);
      if (mock.fail !== 'timeout') err.status = Number(mock.fail);
      throw err;
    }
    const answers = {};
    for (const id of Object.keys(body.questions)) {
      const a = (mock.answers && mock.answers[id]) || mock.default;
      if (a === undefined) throw new Error(`mock has no answer for question "${id}" and no default`);
      answers[id] = { type: body.questions[id].type, ...a };
    }
    return { model: 'jev-mock', answers, usage: { input_tokens: 0, output_tokens: 0 } };
  };
}

function truncateState(state) {
  const text = typeof state === 'string' ? state : JSON.stringify(state);
  if (Buffer.byteLength(text) <= MAX_STATE_BYTES) return state;
  // A state that does not fit is cut, not refused: a partial judgment the caller can threshold beats
  // a thrown error in a hook. The cut is announced in the state itself so the model sees the seam.
  return `${text.slice(0, MAX_STATE_BYTES)}\n[state truncated at ${MAX_STATE_BYTES} bytes]`;
}

// Retries follow lineup-advise: 429/529/5xx and timeouts are transient, everything else is final.
// A caller with a latency budget passes `waits: []` and gets exactly one attempt.
async function ask({ state, questions }, { timeoutMs = 20000, waits = WAITS, transport } = {}) {
  const st = status();
  if (!st.enabled) throw new JevDisabled();
  const send = transport || (process.env.JEV_MOCK_FILE ? mockTransport(process.env.JEV_MOCK_FILE) : null)
    || ((body) => postJson(body, readKey(), timeoutMs));
  const body = { state: truncateState(state), model: MODEL, questions };
  for (let attempt = 0; ; attempt += 1) {
    try { return await send(body); } catch (e) {
      const transient = [429, 529].includes(e.status) || (e.status >= 500 && e.status < 600) || /timeout/.test(e.message);
      if (!transient || attempt >= waits.length) throw e;
      await sleep(waits[attempt]);
    }
  }
}

function noulQuestion(instructions, criteria = null) {
  return { type: 'noul', instructions, criteria };
}

function choiceQuestion(instructions, options) {
  const keys = Object.keys(options);
  if (keys.length > MAX_OPTIONS) throw new Error(`choice takes at most ${MAX_OPTIONS} options, got ${keys.length}`);
  const criteria = {};
  for (const k of keys) criteria[k] = String(options[k] == null ? '' : options[k]).slice(0, MAX_CRITERION_CHARS);
  return { type: 'choice', instructions, criteria };
}

async function noul(state, instructions, opts = {}) {
  const { criteria = null, ...rest } = opts;
  const r = await ask({ state, questions: { q: noulQuestion(instructions, criteria) } }, rest);
  return Number(r.answers.q.noul);
}

async function choice(state, instructions, options, opts = {}) {
  const r = await ask({ state, questions: { q: choiceQuestion(instructions, options) } }, opts);
  const a = r.answers.q;
  return { choice: a.choice, probabilities: a.probabilities || {}, confidence: a.confidence == null ? null : Number(a.confidence) };
}

// ── tier routing ─────────────────────────────────────────────────────────────────────────────────────
// The line-up's four tiers, one criterion each — the words README §Jev prints. The prompt-router hook
// asks this question about every prompt; develop-phase's routeByJev asks it about the task, through
// `node jev.js route`, and only acts on the answer at or above ROUTE_TIER_THRESHOLD.
const PROMPT_CHARS = 1500;
const TIER_QUESTION = 'Which model tier does a subagent for this prompt deserve?';
const TIERS = {
  haiku: 'the prompt carries no task of its own (ok, go on, retry), or it is a lookup or a command to run',
  sonnet: 'explain, answer about the state of something, write a message, give instructions, verify',
  opus: 'build or fix code or UI',
  fable: 'architecture, product, business, pricing or a plan',
};

// The lowest confidence above which the tiers Jev picked were right at least 9 times in 10, together:
// 0.80, the higher of two passes (0.80 and 0.70), 91.0% over 52% of 64 prompts — benchmarks/
// jev_router_eval.js, docs/harness-dev/loop-runs/2026-10-11-jev-router.txt. null would mean no cut-off
// reached 0.9, and routeByJev would keep the line-up.
const ROUTE_TIER_THRESHOLD = 0.8;

// The probability Jev gives its own choice; `confidence` when the answer carries no distribution.
const pOf = (a) => Number(a.probabilities?.[a.choice] ?? a.confidence);

// Routing errors are not symmetric. Up costs money; down costs quality, and the corpus shows Jev calling
// opus work haiku at p=0.99. So a downgrade is capped: one tier at most, and never below sonnet.
const TIER_ORDER = ['haiku', 'sonnet', 'opus', 'fable'];
const FLOOR = TIER_ORDER.indexOf('sonnet');
const tierOf = (model) => (/(?:^|[-/])(haiku|sonnet|opus|fable)(?=[-.\d]|$)/.exec(String(model || '')) || [])[1] || null;

// The tier the implementer takes, or null to keep the configured one, and why. Pure: the eval simulates
// the same decision over the corpus that `jev.js route` makes for develop-phase.
function decideTier({ configured, suggested, p, threshold }) {
  const from = TIER_ORDER.indexOf(tierOf(configured));
  if (from === -1) return { tier: null, reason: `the configured implementer (${configured}) is no Claude tier — nothing to route from` };
  if (!TIER_ORDER.includes(suggested)) return { tier: null, reason: `Jev answered no known tier (${suggested})` };
  if (threshold == null) return { tier: null, reason: 'no measured threshold: the router eval has not reached 0.9 precision' };
  if (!(p >= threshold)) return { tier: null, reason: `p=${p} < threshold ${threshold}` };
  let to = TIER_ORDER.indexOf(suggested);
  const caps = [];
  if (to < from - 1) { to = from - 1; caps.push('one tier down at most'); }
  if (to < FLOOR) { to = FLOOR; caps.push('never below sonnet'); }
  const capped = caps.length ? ` → ${TIER_ORDER[to]} (${caps.join(', ')})` : '';
  if (to === from) return { tier: null, reason: `p=${p} ≥ ${threshold}: ${suggested}${capped}, the configured tier` };
  return { tier: TIER_ORDER[to], reason: `p=${p} ≥ ${threshold}: ${suggested}${capped}` };
}

// Never throws: the caller (a seat reading stdout) gets the reason in `error` and decides.
async function routeTier(task, { configured, ...opts } = {}) {
  const out = { enabled: isEnabled(), suggested: null, p: null, threshold: ROUTE_TIER_THRESHOLD, tier: null, reason: null, error: null };
  if (!out.enabled) return { ...out, error: 'Jev off (no TYPESAFE_API_KEY)' };
  try {
    const r = await ask({ state: { prompt: String(task).slice(0, PROMPT_CHARS) }, questions: { tier: choiceQuestion(TIER_QUESTION, TIERS) } },
      { timeoutMs: 8000, waits: [2000], ...opts });
    const a = r.answers.tier;
    if (!a || !TIERS[a.choice]) return { ...out, error: `Jev answered no known tier (${a && a.choice})` };
    const d = decideTier({ configured, suggested: a.choice, p: pOf(a), threshold: ROUTE_TIER_THRESHOLD });
    return { ...out, suggested: a.choice, p: pOf(a), ...d };
  } catch (e) {
    return { ...out, error: `Jev unavailable: ${String(e.message).split('\n')[0]}` };
  }
}

module.exports = {
  ENDPOINT, MODEL, KEY_NAME, SECRETS, JevDisabled, PROMPT_CHARS, TIER_QUESTION, TIERS, ROUTE_TIER_THRESHOLD, TIER_ORDER,
  readKey, status, isEnabled, ask, noul, choice, noulQuestion, choiceQuestion, postJson, pOf, tierOf, decideTier, routeTier,
};

// `node jev.js route --configured <model>` — the task on stdin, one JSON line on stdout, exit 0 whatever happened.
if (require.main === module) {
  const i = process.argv.indexOf('--configured');
  if (process.argv[2] !== 'route' || i === -1 || !process.argv[i + 1]) {
    process.stderr.write('usage: node jev.js route --configured <implementer model> < task.txt\n');
    process.exit(1);
  }
  let raw = '';
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    routeTier(raw.trim(), { configured: process.argv[i + 1] }).then((r) => { process.stdout.write(`${JSON.stringify(r)}\n`); process.exit(0); });
  });
}
