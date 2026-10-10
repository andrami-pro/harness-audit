#!/usr/bin/env node
// prompt-router — UserPromptSubmit hook. Advisory, and off unless a TypeSafe key is present.
//
// The operator of a machine with sixty installed skills picks the right one by memory, and picks the
// model tier for a subagent by habit — usually the default, usually the most expensive. Both are
// discrete choices over a short text, which is the one thing a System One model does in under a
// second for a fraction of a cent. This hook asks Jev two questions about the prompt just submitted:
// which installed skill fits it (choice over the inventory scripts/skill-inventory.js builds for the
// dashboard too), and which tier a subagent for it deserves (haiku / sonnet / opus). The answers ride
// `additionalContext`, so the model sees a suggestion and the transcript keeps it. It NEVER decides:
// no `decision`, no `permissionDecision`, no rewriting of the prompt.
//
// What leaves the machine, and only when a key is present: the first PROMPT_CHARS characters of the
// prompt, and the names plus short descriptions of the installed skills. Not the working tree, not
// the transcript, not the session id. README §Jev says the same in the operator's terms.
//
// Latency is the budget a hook cannot exceed: one attempt, no retry, a hard race at BUDGET_MS.
// A slow API costs one dropped suggestion; it never holds a prompt. Any failure exits 0 silently.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const jev = require('../jev.js');

const PROMPT_CHARS = 1500;
const MIN_PROMPT_CHARS = 12;
const BUDGET_MS = 1500;
const MAX_SKILLS = 120;
const MIN_CONFIDENCE = 0.5;
const CACHE_MS = 60 * 60 * 1000;

const TIERS = {
  haiku: 'a mechanical or lookup task: find a file, rename, run a command, answer from something already in view',
  sonnet: 'ordinary implementation or review: one feature, one bug, a bounded edit with clear acceptance',
  opus: 'multi-file design, ambiguous requirements, architecture or reasoning where the wrong call is expensive',
};

function cacheDir() {
  return process.env.PROMPT_ROUTER_DIR || path.join(os.tmpdir(), 'harness-audit', 'prompt-router');
}

// The inventory scan walks plugin caches and skill dirs; once an hour per project is plenty.
function skillOptions(cwd) {
  const file = path.join(cacheDir(), `${cwd.replace(/[^\w.-]/g, '_')}.json`);
  try {
    const st = fs.statSync(file);
    if (Date.now() - st.mtimeMs < CACHE_MS) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { /* no cache, or stale */ }
  const { inventorySkills } = require('../skill-inventory.js');
  const { skills } = inventorySkills(cwd);
  const options = {};
  for (const s of skills) {
    if (!s.enabled || /command$/.test(s.source)) continue;
    if (Object.keys(options).length >= MAX_SKILLS) break;
    options[s.name] = (s.description || s.name).slice(0, 120);
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(options));
  } catch { /* cache is a convenience */ }
  return options;
}

async function route(p) {
  const prompt = String(p.prompt || '').trim();
  if (prompt.length < MIN_PROMPT_CHARS || prompt.startsWith('/')) return null;
  const cwd = typeof p.cwd === 'string' && p.cwd ? p.cwd : process.cwd();
  const options = skillOptions(cwd);
  const questions = { tier: jev.choiceQuestion('Which model tier does a subagent for this prompt deserve?', TIERS) };
  if (Object.keys(options).length) {
    questions.skill = jev.choiceQuestion(
      'Which installed skill is the right one to load for this prompt? Pick none when no skill fits.',
      { ...options, none: 'no installed skill fits this prompt' },
    );
  }
  const r = await jev.ask({ state: { prompt: prompt.slice(0, PROMPT_CHARS) }, questions }, { timeoutMs: BUDGET_MS, waits: [] });
  const parts = [];
  const skill = r.answers.skill;
  if (skill && skill.choice && skill.choice !== 'none' && Number(skill.confidence) >= MIN_CONFIDENCE) {
    parts.push(`likely skill \`${skill.choice}\` (p=${Number(skill.probabilities?.[skill.choice] ?? skill.confidence).toFixed(2)})`);
  }
  const tier = r.answers.tier;
  if (tier && TIERS[tier.choice] && Number(tier.confidence) >= MIN_CONFIDENCE) {
    parts.push(`subagent tier ${tier.choice} (p=${Number(tier.probabilities?.[tier.choice] ?? tier.confidence).toFixed(2)})`);
  }
  if (!parts.length) return null;
  return `harness-audit jev (advisory): ${parts.join('; ')}. Ignore if the prompt already says what to do.`;
}

async function main(raw) {
  let p;
  try { p = JSON.parse(raw); } catch { return; }
  if (!p || p.hook_event_name !== 'UserPromptSubmit') return;
  if (!jev.isEnabled()) return;
  const timer = new Promise((resolve) => setTimeout(() => resolve(null), BUDGET_MS).unref());
  const text = await Promise.race([route(p).catch(() => null), timer]);
  if (!text) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text },
  }));
}

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  main(raw).catch(() => {}).finally(() => process.exit(0));
});
