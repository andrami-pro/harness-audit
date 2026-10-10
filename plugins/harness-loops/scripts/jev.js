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

module.exports = {
  ENDPOINT, MODEL, KEY_NAME, SECRETS, JevDisabled,
  readKey, status, isEnabled, ask, noul, choice, noulQuestion, choiceQuestion, postJson,
};
