#!/usr/bin/env node
// validate.js — the package's own preflight gate.
// A methodology that preaches executable rubrics must be able to say no to itself.
// Run: node scripts/validate.js   (exit 0 = releasable, non-zero = fix first)

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const results = [];
// Three states, not two. A check that could not run is not a check that passed: counting it green is
// how a gate reports "all clear" over ground nobody looked at. `skip(reason)` renders ⊘ and is excluded
// from the pass count, so the summary can never claim coverage it does not have.
class Skipped extends Error {}
const skip = (reason) => { throw new Skipped(reason); };
const check = (name, fn) => {
  try {
    const detail = fn();
    results.push({ name, state: 'pass', detail: detail || '' });
  } catch (e) {
    if (e instanceof Skipped) results.push({ name, state: 'skip', detail: e.message });
    else results.push({ name, state: 'fail', detail: e.message.split('\n')[0] });
  }
};
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const mustExist = (rel) => { if (!fs.existsSync(path.join(ROOT, rel))) throw new Error(`${rel} missing`); };
const globMd = (dir) => {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs).filter((f) => f.endsWith('.md')).map((f) => path.join(dir, f)).sort();
};
const walk = (dir) => {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))
    .sort();
};
const hasFrontmatterField = (rel, field) => {
  const s = read(rel);
  if (!/^---\n/.test(s)) throw new Error(`${rel} missing frontmatter`);
  const fm = s.split('---')[1] ?? '';
  // `\s` spans the newline: `field:\s*\S+` reads the NEXT key's name as this field's value.
  if (!new RegExp(`^${field}:[ \\t]*\\S`, 'm').test(fm)) throw new Error(`${rel} frontmatter missing ${field}`);
};

check('plugin.json valid + required fields', () => {
  const p = JSON.parse(read('.claude-plugin/plugin.json'));
  for (const f of ['name', 'description', 'version']) if (!p[f]) throw new Error(`missing field: ${f}`);
  return `${p.name}@${p.version}`;
});

check('marketplace.json valid + lists the plugin', () => {
  const m = JSON.parse(read('.claude-plugin/marketplace.json'));
  if (!m.name) throw new Error('missing field: name');
  if (!Array.isArray(m.plugins) || !m.plugins.some((p) => p.name === 'harness-audit')) {
    throw new Error('plugins[] must include harness-audit');
  }
});

check('SKILL.md exists with name + description frontmatter', () => {
  hasFrontmatterField('skills/harness-audit/SKILL.md', 'name');
  hasFrontmatterField('skills/harness-audit/SKILL.md', 'description');
});

check('companion templates present', () => {
  mustExist('skills/harness-audit/rubric-template.md');
  mustExist('skills/harness-audit/verifier-protocol.md');
  mustExist('WHITEPAPER.md');
  mustExist('README.md');
  mustExist('LICENSE');
});

check('verifier-protocol has the negative-control self-test', () => {
  if (!/negative control|negative-control/i.test(read('skills/harness-audit/verifier-protocol.md'))) {
    throw new Error('missing negative-control section (v2 requirement)');
  }
});

check('no stale model lineup (Haiku must not be the preflight tier)', () => {
  const files = ['skills/harness-audit/SKILL.md', 'WHITEPAPER.md', 'README.md', ...globMd('commands'), ...globMd('agents')];
  for (const rel of files) {
    const hits = read(rel).split('\n')
      .map((l, i) => ({ l, n: i + 1 }))
      .filter(({ l }) => /haiku/i.test(l) && /preflight/i.test(l));
    if (hits.length) throw new Error(`${rel}:${hits[0].n} still pairs Haiku with preflight`);
  }
  return `${files.length} files scanned`;
});

check('benchmark figures are hedged, not asserted', () => {
  const files = ['skills/harness-audit/SKILL.md', 'WHITEPAPER.md', ...globMd('commands'), ...globMd('agents')];
  for (const rel of files) {
    const t = read(rel);
    if (/89\s*%/.test(t) && !/directional|illustrative|not (yet )?(independently )?reproduced/i.test(t)) {
      throw new Error(`${rel} cites 89% without a directional/unreproduced hedge`);
    }
  }
  return `${files.length} files scanned`;
});

check('every commands/*.md has a frontmatter description', () => {
  const files = globMd('commands');
  if (!files.length) throw new Error('commands/ is empty — the plugin ships no loop');
  for (const rel of files) hasFrontmatterField(rel, 'description');
  return `${files.length} command(s) checked`;
});

check('every agents/*.md has a frontmatter description', () => {
  const files = globMd('agents');
  if (!files.length) throw new Error('agents/ is empty — the plugin ships no critics');
  for (const rel of files) hasFrontmatterField(rel, 'description');
  return `${files.length} agent(s) checked`;
});

// Claude Code parses frontmatter leniently, so an unquoted scalar carrying `: ` inside it — every
// `Cost: medium` in a description — works here and breaks everywhere else: GitHub renders a YAML error
// instead of the file, and Pi's strict loader drops the command without a word. Three loops shipped
// invisible on Pi for exactly this. The lenient host is the one that lets it through, so the gate has
// to be stricter than the host it runs on.
//
// Negative control (2026-07-13, reverted): quotes stripped from commands/orchestrate.md's description
// — exit 1, "commands/orchestrate.md: 'description' is an unquoted YAML scalar containing ': '".
check('every frontmatter survives a STRICT YAML parser (GitHub, Pi), not just a lenient one', () => {
  const files = [...globMd('commands'), ...globMd('agents')];
  if (!files.length) throw new Error('nothing scanned — the gate would pass vacuously');
  for (const rel of files) {
    const m = /^---\n([\s\S]*?)\n---/.exec(read(rel));
    if (!m) throw new Error(`${rel}: no frontmatter block`);
    for (const line of m[1].split('\n')) {
      const kv = /^([\w-]+):\s*(.*)$/.exec(line);
      if (!kv) continue;
      const value = kv[2];
      if (value && !/^["'[{]/.test(value) && /:\s/.test(value)) {
        throw new Error(`${rel}: '${kv[1]}' is an unquoted YAML scalar containing ': ' — GitHub errors, Pi drops it silently`);
      }
    }
  }
  return `${files.length} frontmatter block(s) strict-YAML safe`;
});

// Pins the command count the README's loop catalog promises (5: skill-loop, orchestrate, review-loop,
// iterate, session-review — Loop 1 is a pattern, not a command, by design). A 6th command shipped without
// updating the README catalog would drift silently; so would a command that lost its argument-hint, which
// is the piece `/command` autocomplete and the SlashCommand tool both read to know how to call it.
//
// The cap is the anti-proliferation gate: five commands for the five loops that have one (Loop 1 is a
// pattern, not a command), and a sixth file has to argue for itself in the PRD before it argues for
// itself here. F10 raised the cap from 4 to 5 for session-review.
//
// Negative control (2026-07-12, both reverted): argument-hint stripped from commands/iterate.md — exit 1,
// "commands/iterate.md frontmatter missing argument-hint"; a 6th command copied in — exit 1,
// "commands/*.md = 6, expected exactly 5".
check('exactly 5 loop commands, each with description + argument-hint', () => {
  const files = globMd('commands');
  if (files.length !== 5) throw new Error(`commands/*.md = ${files.length}, expected exactly 5`);
  for (const rel of files) {
    hasFrontmatterField(rel, 'description');
    hasFrontmatterField(rel, 'argument-hint');
  }
  return `${files.length} command(s), all with argument-hint`;
});

// The catalog table is the honesty-gated deliverable of F7 (DoD-3): a loop only gets a row once it has a
// real recorded run. If the header survives but a body row is silently dropped by a later edit, this
// check would still pass — that's an editorial risk, not a structural one, and out of scope for a command
// this cheap. What this check guards is the coarser, more common failure: the whole table gone missing.
//
// Negative control (2026-07-12, reverted): dropped the "Stops when" column from the header row —
// exit 1, "README missing the five-loops catalog table header".
check('README documents the loop catalog (table header present)', () => {
  const t = read('README.md');
  if (!/\|\s*Your situation\s*\|\s*Loop\s*\|\s*Command\s*\|\s*Cost\s*\|\s*Stops when\s*\|/.test(t)) {
    throw new Error('README missing the five-loops catalog table header');
  }
});

// Graphify is a first-class prerequisite (D21): critics and the scorer query the graph instead of
// grepping cold. If the Prerequisites section loses the install one-liner, a new user hits an
// undocumented dependency the moment a loop runs a critic.
//
// Negative control (2026-07-12, reverted): replaced the section body with generic toolchain prose —
// exit 1, "Prerequisites section does not mention Graphify".
check('README documents Graphify as a prerequisite', () => {
  const t = read('README.md');
  if (!/### Prerequisites/.test(t)) throw new Error('README missing a Prerequisites section');
  const section = t.split('### Prerequisites')[1].split(/\n### /)[0];
  if (!/graphify/i.test(section)) throw new Error('Prerequisites section does not mention Graphify');
  if (!/uv tool install graphifyy|pipx install graphifyy|pip install graphifyy/.test(section)) {
    throw new Error('Prerequisites section missing the graphifyy install one-liner');
  }
});

// The terms this gate hunts are, by definition, the ones that must never appear in a public file —
// so they cannot live in this file either. Writing your clients' names into the door that guards them
// publishes them. They load from `private-terms.json`, which is gitignored; `private-terms.example.json`
// ships the shape and nothing else. A fork inherits the gate, never the terms.
//
// Matching is substring, not word: the leak that shipped inside a benchmark fixture was glued to its
// neighbour (`<name>_agent`), where a word boundary finds nothing. A term listed under `fenced` is the
// exception — one that hides inside innocent hyphenation and must not fire on it.
function loadPrivateTerms() {
  const file = path.join(ROOT, 'private-terms.json');
  if (!fs.existsSync(file)) return null;
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    ...(cfg.substring || []).map((t) => new RegExp(esc(t), 'i')),
    ...(cfg.fenced || []).map((t) => new RegExp(`(?<![a-z])${esc(t)}(?![a-z])`, 'i')),
  ];
}

// Negative control — a term from private-terms.json planted in the telemetry fixture: exit 1,
// sess-0001.jsonl:2 (2026-07-12). Re-verified 2026-07-13 after the terms moved out of this file.
check('no private contract leaks in commands/, agents/, benchmarks/, fixtures/', () => {
  const leaks = loadPrivateTerms();
  // No terms file is not a pass. A gate that reports green because it was given nothing to look for is
  // the exact failure this repo keeps finding: absence of evidence read as evidence of absence.
  if (!leaks) skip('no private-terms.json — nothing was scanned (copy private-terms.example.json to enable)');
  if (!leaks.length) throw new Error('private-terms.json has no terms — the gate would pass vacuously');
  const files = [...walk('commands'), ...walk('agents'), ...walk('benchmarks'), ...walk('scripts/fixtures')];
  if (!files.length) throw new Error('nothing scanned — the gate would pass vacuously');
  for (const rel of files) {
    read(rel).split('\n').forEach((line, i) => {
      for (const re of leaks) {
        if (re.test(line)) throw new Error(`${rel}:${i + 1} leaks a private term (pattern withheld — see private-terms.json)`);
      }
    });
  }
  return `${files.length} files scanned against ${leaks.length} private term(s)`;
});

check('hooks.json valid + every referenced script exists and parses', () => {
  const h = JSON.parse(read('hooks/hooks.json'));
  const cmds = JSON.stringify(h).match(/scripts\/hooks\/[\w-]+\.js/g) || [];
  if (cmds.length < 3) throw new Error(`expected ≥3 hook scripts referenced, found ${cmds.length}`);
  for (const rel of new Set(cmds)) {
    mustExist(rel);
    execFileSync('node', ['--check', path.join(ROOT, rel)], { stdio: 'pipe' });
  }
  return `${new Set(cmds).size} scripts`;
});

// The hook is the only writer of loop-telemetry.ndjson and the dashboard is the only reader: nothing
// validates the line shape at runtime, and the hook swallows its own errors by design (a dashboard is
// never worth failing a turn over). So a renamed field, a dropped agentType, or a line written for an
// event the schema does not cover fails silently, in production, for weeks — the exact shape of escape
// #4. This check is the only place that shape is asserted.
//
// Negative controls (2026-07-12, each applied, observed, reverted — all exit 1):
//   `ts` dropped from the emitted line .............. "emitted line missing required key ts"
//   EVENTS gate removed (every payload appended) .... "PreToolUse payload wrote a line — the hook must
//                                                      only emit on SubagentStop|Stop"
//   agentType stamped as p.agent_type ?? 'unknown' .. "Stop line carries agentType — an absent agent
//                                                      type is a fact, not a hole to fill"
check('loop-telemetry hook emits a schema-valid ndjson line', () => {
  const script = path.join(ROOT, 'scripts/hooks/loop-telemetry.js');
  mustExist('scripts/hooks/loop-telemetry.js');
  execFileSync('node', ['--check', script], { stdio: 'pipe' });

  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'loop-telemetry-')), 'telemetry.ndjson');
  const fire = (fixture) => execFileSync('node', [script], {
    input: read(path.join('scripts/fixtures/hooks', fixture)),
    env: { ...process.env, LOOP_TELEMETRY_FILE: out },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  fire('subagent-stop.json');
  fire('stop.json');
  fire('other-event.json');

  const lines = fs.readFileSync(out, 'utf8').split('\n').filter(Boolean);
  if (lines.length !== 2) {
    throw new Error(`${lines.length} line(s) written, expected 2 — a PreToolUse payload wrote a line: the hook must only emit on SubagentStop|Stop`);
  }

  const KEYS = new Set(['event', 'ts', 'sessionId', 'agentType']);
  const [sub, stop] = lines.map((l) => JSON.parse(l));
  for (const line of [sub, stop]) {
    for (const k of ['event', 'ts', 'sessionId']) {
      if (typeof line[k] !== 'string' || !line[k]) throw new Error(`emitted line missing required key ${k}`);
    }
    for (const k of Object.keys(line)) if (!KEYS.has(k)) throw new Error(`emitted line carries unknown key ${k}`);
    if (!Number.isFinite(Date.parse(line.ts))) throw new Error(`ts is not a parseable timestamp: ${line.ts}`);
    if (line.sessionId !== '0f2c9b41-demo') throw new Error(`sessionId lost: ${line.sessionId}`);
  }
  if (sub.event !== 'SubagentStop' || stop.event !== 'Stop') throw new Error('event name not carried through');
  if (sub.agentType !== 'implementer') throw new Error(`agentType lost: ${sub.agentType}`);
  if ('agentType' in stop) throw new Error('Stop line carries agentType — an absent agent type is a fact, not a hole to fill');

  fs.rmSync(path.dirname(out), { recursive: true, force: true });
  return '2 lines · SubagentStop+agentType, Stop';
});

check('install.sh parses (sh -n)', () => {
  mustExist('install.sh');
  execFileSync('sh', ['-n', path.join(ROOT, 'install.sh')], { stdio: 'pipe' });
});

// The transcript format is internal to Claude Code and can change without notice. These assertions are
// derived facts, not file-existence: each one dies if a shape this parser depends on moves. Asserting
// only that the fixture parses would guard the neighbouring failure mode, not the one that happens.
//
// Negative control (verifier-protocol.md: a check that can only say PASS is a broken thermometer).
// Each mutation was applied to the fixture, observed, and reverted — 2026-07-12, all exit 1:
//   usage → usageX in an agent jsonl ......... totals.runs = 6, expected 8
//   ephemeral_1h_input_tokens → ..._1h_in .... totals.cacheWrite5m = 1500, expected 500
//   truncated line at sess-0001.jsonl:2 ...... totals.runs = 7, expected 8
//   journal agentId → agent_id ............... totals.runs = 5, expected 8
//   workflowProgress label → "" .............. workflow agent join lost
check('loop-stats reconstructs the pinned telemetry fixture', () => {
  const script = path.join(ROOT, 'scripts/loop-stats.js');
  mustExist('scripts/loop-stats.js');
  execFileSync('node', ['--check', script], { stdio: 'pipe' });

  const raw = execFileSync('node', [script, '--root', path.join(ROOT, 'scripts/fixtures/telemetry'),
    '--project', 'demo', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const d = JSON.parse(raw);

  // usage.* summed across the session, the Task subagent and both workflow agents. The 5m/1h split is
  // asserted separately: cache_creation_input_tokens covers for a renamed subkey, so the collapsed
  // cacheWrite total stays right while every 1h write silently reprices at the cheaper 5m rate.
  const totals = { runs: 8, in: 17000, out: 2180, cacheRead: 25100, cacheWrite: 1500, cacheWrite5m: 500, cacheWrite1h: 1000 };
  for (const [k, want] of Object.entries(totals)) {
    if (d.totals[k] !== want) throw new Error(`totals.${k} = ${d.totals[k]}, expected ${want}`);
  }
  if (d.warnings !== 0) throw new Error(`${d.warnings} line(s) became unreadable`);

  // journal.agentId ↔ agent-<id>.jsonl ↔ workflowProgress.label: without the join these agents are
  // unlabelled and their tokens land nowhere.
  const rows = Object.fromEntries(d.agents.map((a) => [`${a.agentType}·${a.model}`, a]));
  const impl = rows['implementer·claude-opus-4-8'];
  if (!impl || !rows['reviewer·claude-fable-5']) throw new Error('workflow agent join lost');
  if (impl.out !== 1000) throw new Error(`joined implementer out = ${impl.out}, expected 1000`);

  const [wf] = d.workflows;
  if (!wf || wf.name !== 'develop-phase') throw new Error('workflow run record lost');
  if (wf.rounds !== 1 || wf.verdict !== 'APROBADO') throw new Error(`verdict/rounds drifted: ${wf.rounds}/${wf.verdict}`);
  if (wf.durationMs !== 1500000) throw new Error(`duration = ${wf.durationMs}, expected 1500000`);

  if (d.prompts.total !== 3) throw new Error(`prompts.total = ${d.prompts.total}, expected 3`);
  if (d.prompts.top[0].count !== 2) throw new Error('recurring-prompt count drifted');

  // an unpriced model must degrade to n/a, never to a guessed number or a crash
  if (typeof impl.costUsd !== 'number' || impl.costUsd <= 0) throw new Error('cost estimate lost');
  if (d.unpricedModels.length !== 1) throw new Error(`unpriced models = ${d.unpricedModels.length}, expected 1`);

  return `${d.totals.runs} runs · ${d.workflows.length} workflow · $${d.totals.costUsd.toFixed(2)} est.`;
});

// The clean fixture above only proves the happy path — a check that can only PASS is not a gate
// (process.md §0). This second fixture pins a truncated line and a non-JSON line, so a regression that
// turns readJsonl's skip-with-warning into a crash breaks CI, not a reverted manual mutation.
//
// Negative control: readJsonl's per-line try/catch removed (JSON.parse(line) left unguarded) —
// the truncated line now throws past parseSession into aggregate(), which aborts the whole run instead
// of skipping the one line: `loop-stats: Unterminated string in JSON at position 169 (line 1 column 170)`,
// exit 1 — and this check fails with it. Reverted (2026-07-12).
check('loop-stats degrades gracefully on the broken telemetry fixture', () => {
  const script = path.join(ROOT, 'scripts/loop-stats.js');
  const raw = execFileSync('node', [script, '--root', path.join(ROOT, 'scripts/fixtures/telemetry'),
    '--project', 'demo-broken', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const d = JSON.parse(raw);

  if (d.warnings !== 2) throw new Error(`warnings = ${d.warnings}, expected 2 (truncated line + non-JSON line)`);
  if (d.totals.runs !== 1) throw new Error(`totals.runs = ${d.totals.runs}, expected 1 — only the clean turn should survive`);

  return `${d.warnings} warnings · ${d.totals.runs} run survived`;
});

// D25a — the HARD guardrail is the one piece of F11 that must never have a confirmable escape
// hatch: a lineup that puts the reviewer in the implementer's model family has to be rejected by
// construction, not by a prompt someone can click through. So each fixture below pins an id shape
// that reaches familyOf() and that a naive comparison lets through:
//
//   invalid-same-family ....... opus-4-7 vs opus-4-8 — same line, different version. A full-string
//                               compare misses it.
//   invalid-provider-qualified  nvidia-nim/claude-opus-4-8 vs claude-opus-4-8 — same weights behind
//                               a provider prefix, and NOT a hypothetical: stampValue() emits
//                               exactly this `provider/model` shape for multi-provider targets, so
//                               a stamped value copied back into a lineup would blind the one rule
//                               D25 declares non-confirmable.
//   invalid-legacy-id ......... claude-3-5-sonnet-20241022 vs claude-sonnet-5 — the legacy id puts
//                               the version BEFORE the tier, so a position-based parse reads the
//                               family as "claude-3".
//
// Negative controls — each mutation applied, observed, reverted (2026-07-12, all exit 1):
//   reviewer in invalid-same-family.json → claude-fable-5 (a genuinely different family) ..........
//     resolve exited 0 instead of 2 → "accepted a lineup where reviewer and implementer share a
//     model family (invalid-same-family.json) — the independence property (D25a) did not fire"
//   familyOf's dropProvider() removed (tier read from the raw id, provider prefix intact) .........
//     nvidia-nim/claude-opus-4-8 resolved to family "nvidia-nim/claude-opus-4" ≠ "claude-opus",
//     resolve exited 0 → "…(invalid-provider-qualified.json) — the independence property (D25a)
//     did not fire". This is the finding's own failure mode, not a neighbour's.
//   familyOf's segment scan → positional /^claude-([a-z]+)-/ ......................................
//     claude-3-5-sonnet-20241022 resolved to family "claude-3-5-sonnet" ≠ "claude-sonnet",
//     resolve exited 0 → "…(invalid-legacy-id.json) — the independence property (D25a) did not fire"
check('model-lineup.js rejects same-family reviewer/implementer fixtures', () => {
  const script = path.join(ROOT, 'scripts/model-lineup.js');
  mustExist('scripts/model-lineup.js');
  execFileSync('node', ['--check', script], { stdio: 'pipe' });

  execFileSync('node', [script, 'resolve', '--target', 'claude',
    '--file', path.join(ROOT, 'scripts/fixtures/lineup/valid.json')], { stdio: 'pipe' });

  const rejected = ['invalid-same-family.json', 'invalid-provider-qualified.json', 'invalid-legacy-id.json'];
  for (const fixture of rejected) {
    let status = null;
    try {
      execFileSync('node', [script, 'resolve', '--target', 'claude',
        '--file', path.join(ROOT, 'scripts/fixtures/lineup', fixture)], { stdio: 'pipe' });
    } catch (e) { status = e.status; }
    if (status === null) {
      throw new Error(`accepted a lineup where reviewer and implementer share a model family (${fixture}) — the independence property (D25a) did not fire`);
    }
    if (status !== 2) throw new Error(`${fixture}: expected exit 2 (hard violation), got ${status}`);
  }

  return `valid fixture resolves clean, ${rejected.length} same-family fixtures rejected (exit 2)`;
});

// D25c — `check` is the only thing in this repo that reads the *live* model registry, and it exists
// because a line-up can be perfectly valid JSON, pass every guardrail above, and still name a model
// no provider serves. That is not hypothetical: `~/.agents/model-lineup.json` shipped
// `nvidia-nim/zai/glm-5.2` for months (the real pair is `nvidia/z-ai/glm-5.2`) and the only symptom
// was a scorer dispatch that hung 120s and exited 1 — no error naming the model.
//
// The catalog is pinned to a fixture, not read from `pi --list-models`, so this check means the same
// thing on a machine without pi installed. The live path is exercised by hand; the parse is shared.
//
// Negative controls — each mutation applied, observed, reverted (2026-08-20, both exit 1):
//   squash() → identity (exact string compare for suggestions) ....................................
//     still exit 1, but the message lost "did you mean nvidia/z-ai/glm-5.2?" → the check would name
//     a problem without naming the fix, which is the whole value here.
//   catalogProblems() skipping entries whose provider is unknown ..................................
//     nvidia-nim/zai/glm-5.2 passed silently, exit 0 → "check accepted a model no catalog serves".
check('model-lineup.js check catches a lineup naming a model no provider serves', () => {
  const script = path.join(ROOT, 'scripts/model-lineup.js');
  const catalog = path.join(ROOT, 'scripts/fixtures/lineup/catalog-pi.txt');
  mustExist('scripts/fixtures/lineup/catalog-pi.txt');
  mustExist('scripts/fixtures/lineup/invalid-catalog-miss.json');

  execFileSync('node', [script, 'check', '--file', path.join(ROOT, 'scripts/fixtures/lineup/valid.json'),
    '--catalog', catalog], { stdio: 'pipe' });

  let status = null;
  let stderr = '';
  try {
    execFileSync('node', [script, 'check', '--file', path.join(ROOT, 'scripts/fixtures/lineup/invalid-catalog-miss.json'),
      '--catalog', catalog], { stdio: 'pipe' });
  } catch (e) { status = e.status; stderr = String(e.stderr || ''); }
  if (status === null) throw new Error('check accepted a lineup naming a model no catalog serves (invalid-catalog-miss.json)');
  if (status !== 1) throw new Error(`invalid-catalog-miss.json: expected exit 1, got ${status}`);
  if (!stderr.includes('nvidia/z-ai/glm-5.2')) {
    throw new Error(`check named the problem but not the fix — stderr lacks the corrected id: ${stderr.trim()}`);
  }

  // A machine without pi must not fail the line-up it cannot read a catalog for.
  const skipped = execFileSync('node', [script, 'check', '--file', path.join(ROOT, 'scripts/fixtures/lineup/valid.json'),
    '--catalog', path.join(ROOT, 'scripts/fixtures/lineup/does-not-exist.txt')], { encoding: 'utf8' });
  if (!/SKIPPED/.test(skipped)) throw new Error(`an unreadable catalog should SKIP, not pass silently: ${skipped.trim()}`);

  return 'valid lineup passes · wrong pair rejected (exit 1) and the corrected id named · unreadable catalog skips';
});

// The editor is the only way a model id is supposed to enter the line-up, so its non-TTY path is the
// one this check can reach: it must print the matrix and run the same gates, never open raw mode.
// (A TUI that grabbed stdin here would hang the preflight instead of failing it.)
//
// Negative controls — each mutation applied, observed, reverted (2026-08-20):
//   the isTTY guard in main() removed .................. process.stdin.setRawMode threw
//     "The "process.stdin" property must be TTY" → the check failed, which is the point: a pipe must
//     never reach the interactive path.
//   paint() always returning the escape wrapper ........ the piped matrix carried \x1b[2m around every
//     cell → "static output must be pipe-safe" fired.
check('lineup-ui prints and validates the matrix without a TTY', () => {
  const script = path.join(ROOT, 'scripts/lineup-ui.js');
  mustExist('scripts/lineup-ui.js');
  mustExist('bin/lineup');
  execFileSync('node', ['--check', script], { stdio: 'pipe' });

  const catalog = path.join(ROOT, 'scripts/fixtures/lineup/catalog-pi.txt');
  const out = execFileSync('node', [script, '--global', path.join(ROOT, 'scripts/fixtures/lineup/valid.json'),
    '--catalog', catalog], { encoding: 'utf8' });
  for (const role of ['architect', 'implementer', 'reviewer', 'judge']) {
    if (!out.includes(role)) throw new Error(`the printed matrix is missing the ${role} row`);
  }
  if (!out.includes('nvidia/z-ai/glm-5.2')) throw new Error('the printed matrix does not show the pi override');
  if (out.includes('\x1b[')) throw new Error('static output must be pipe-safe — it still carries ANSI escapes');
  if (!/✓/.test(out)) throw new Error(`a valid lineup should print the ok marker: ${out}`);

  let status = null;
  let bad = '';
  try {
    bad = execFileSync('node', [script, '--global', path.join(ROOT, 'scripts/fixtures/lineup/invalid-catalog-miss.json'),
      '--catalog', catalog], { encoding: 'utf8' });
  } catch (e) { status = e.status; bad = String(e.stdout || ''); }
  if (status !== 1) throw new Error(`a lineup naming a nonexistent model must exit 1 from the viewer, got ${status}`);
  if (!bad.includes('nvidia/z-ai/glm-5.2')) throw new Error('the viewer flagged the bad entry without naming the corrected id');

  return 'matrix printed pipe-safe · valid lineup ✓ · unknown model exits 1 and names the fix';
});

// D25d — the advisor is the only thing in this repo that turns "which model is best" into a number,
// and the only way to keep a number honest is to pin the inputs. The fixtures are five real snapshots
// (AA, LMArena, SWE-bench, OpenRouter, `pi --list-models`) trimmed to ~18 models, chosen so that every
// rule the advisor claims to enforce has a case that would violate it:
//   stealth/ox-alpha ....... free, RETAINS prompts, and — in the AA fixture only — given a synthetic
//                            coding index of 90 so that it WOULD win every code role on merit. The real
//                            AA has no row for it; the synthetic row is labelled as such in the fixture.
//                            Without that row the privacy rule is never the operative filter (a model
//                            with no metrics is dropped earlier) and the check would pass by accident.
//   claude-opus-5:batch .... async endpoint → never a candidate
//   ~deepseek/...-latest ... floating alias → never a candidate
//   openrouter/free ........ random router → only ever the explainer
//   kimi-k3 on 3 providers . the same weights, so the reviewer must land in a different FAMILY (D25a),
//                            not merely on a different provider
//
// Negative controls — each mutation applied, observed, reverted (2026-08-25):
//   `sensitive` dropped from the implementer profile → ox-alpha ranked #1 for implementer (coding 90,
//     free) → "sees code, yet a retains model was suggested for a client repo". Before the synthetic AA
//     row existed this mutation did NOT fire — recorded here because that is the whole reason the row
//     is in the fixture.
//   `excludeFamily` not passed for reviewer → reviewer top-1 = kimi-k3 = implementer top-1 → D25a check
//     fired.
check('lineup-advise produces a report from pinned fixtures and honours privacy + D25a', () => {
  const script = path.join(ROOT, 'scripts/lineup-advise.js');
  const fixtures = path.join(ROOT, 'scripts/fixtures/advise');
  mustExist('scripts/lineup-advise.js');
  mustExist('scripts/lineup-aliases.json');
  for (const f of ['aa', 'lmarena', 'swebench', 'openrouter', 'pi']) mustExist(`scripts/fixtures/advise/${f}-2026-08-25.json`);
  execFileSync('node', ['--check', script], { stdio: 'pipe' });

  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'advise-'));
  // A lineup file that does not exist → advisor falls back to an empty current lineup, sensitivity `client`.
  execFileSync('node', [script, '--offline', '--no-probe', '--fixtures', fixtures, '--out', out,
    '--project', path.join(out, 'none.json')], { stdio: 'pipe', env: { ...process.env, HOME: out } });

  const md = fs.readFileSync(path.join(out, 'lineup-advice.md'), 'utf8');
  for (const section of ['## Fuentes', '## Diff contra el line-up actual', '## Top 3 por rol', '## Gratis en OpenRouter hoy', '## No pude mapear']) {
    if (!md.includes(section)) throw new Error(`report is missing the section "${section}"`);
  }
  const json = JSON.parse(fs.readFileSync(path.join(out, 'lineup-advice.json'), 'utf8'));
  if (json.sensitivity !== 'client') throw new Error(`default sensitivity should be client, got ${json.sensitivity}`);

  // Pinned here, NOT read from the script's PROFILES: a mutation that drops `sensitive` from a profile
  // would otherwise drop the assertion with it and the check would pass for the wrong reason (it did,
  // the first time).
  const CODE_FACING = new Set(['architect', 'orchestrator', 'implementer', 'reviewer', 'critic']);
  const { familyOf } = require(path.join(ROOT, 'scripts/model-lineup.js'));
  for (const [role, list] of Object.entries(json.suggestions)) {
    for (const s of list) {
      if (s.id.endsWith(':batch')) throw new Error(`${role}: a :batch endpoint was offered (${s.id})`);
      if (s.model.startsWith('~')) throw new Error(`${role}: a floating ~alias was offered (${s.id})`);
      if (s.model === 'openrouter/free' && role !== 'explainer') throw new Error(`${role}: the random free router was offered`);
      if (CODE_FACING.has(role) && s.data.policy === 'retains') throw new Error(`${role} sees code, yet a retains model was suggested for a client repo (${s.id})`);
      // The user's rule, verbatim: NIM's free tier is for answering questions about the project, never
      // for a seat that runs for an afternoon. A free model is not a free afternoon.
      if (s.provider === 'nvidia' && role !== 'explainer') throw new Error(`${role}: an NVIDIA NIM model was suggested for a long-running role (${s.id}) — quota rule not applied`);
      if (s.provider === 'openrouter' && s.price_out === 0 && !['explainer', 'preflight'].includes(role)) throw new Error(`${role}: an OpenRouter free-tier model was suggested for a long-running role (${s.id})`);
    }
  }
  const impl = json.suggestions.implementer[0];
  const rev = json.suggestions.reviewer[0];
  if (!impl || !rev) throw new Error('fixtures must yield an implementer and a reviewer suggestion');
  if (familyOf({ model: impl.model }) === familyOf({ model: rev.model })) {
    throw new Error(`reviewer top-1 (${rev.id}) shares the implementer's family (${impl.id}) — D25a not applied`);
  }
  if (!md.includes('stealth/ox-alpha') || !md.includes('RETIENE')) throw new Error('the free-models table must list ox-alpha with its retention note');

  return `report rendered · ${Object.keys(json.suggestions).length} roles · retains never on code roles · NIM/free only on short roles · reviewer ${familyOf({ model: rev.model })} ≠ implementer ${familyOf({ model: impl.model })}`;
});

// The shipped `model:` values in agents/*.md are the exact thing a reader opening one of those files
// on GitHub reacts to — "why is this hardcoded?" — so the README has to answer it where that reader
// lands, in the vocabulary the code actually enforces, not a softer paraphrase. Grounded three ways so
// none of the three assertions below can drift from what's real: the tiers named come from the actual
// frontmatter (not a hardcoded guess), the independence wording is checked against hardViolation()'s
// real message, and the "why not delete it" consequence has to name the mechanism (inherits the
// session's model) and the concrete failure mode (mirror), not just assert "independence" as a virtue.
//
// Negative control (2026-07-13, reverted): "D25a" deleted from the README section's independence
// sentence — exit 1, "README never explains the independence guardrail in the vocabulary
// model-lineup.js actually uses (family / D25a)".
check("README documents the default model line-up and why `model:` can't just be deleted", () => {
  const t = read('README.md');
  if (!/## The default model line-up/i.test(t)) throw new Error('README lost the model-line-up disclosure section');
  const section = t.split(/## The default model line-up[^\n]*\n/i)[1].split(/\n## /)[0];

  const tiers = new Set();
  for (const rel of globMd('agents')) {
    const m = /^model:\s*(\S+)/m.exec(read(rel).split('---')[1] || '');
    if (m) tiers.add(m[1]);
  }
  if (!tiers.size) throw new Error('no agents/*.md carries a model: field — nothing to disclose (this check is stale)');
  for (const tier of tiers) {
    if (!new RegExp(`\\b${tier}\\b`).test(section)) {
      throw new Error(`README's model-line-up section never names the "${tier}" tier agents/*.md actually ships`);
    }
  }

  const { hardViolation } = require(path.join(ROOT, 'scripts/model-lineup.js'));
  const sameFamily = {
    reviewer: { model: 'claude-sonnet-4-5', family: 'claude-sonnet' },
    implementer: { model: 'claude-sonnet-4-5', family: 'claude-sonnet' },
  };
  const msg = hardViolation(sameFamily);
  if (!msg || !/family/i.test(msg) || !/D25a/.test(msg)) {
    throw new Error("hardViolation()'s message no longer mentions family/D25a — the fixture grounding this check is stale");
  }
  if (!/family/i.test(section) || !/D25a/.test(section)) {
    throw new Error('README never explains the independence guardrail in the vocabulary model-lineup.js actually uses (family / D25a)');
  }

  const CONSEQUENCE = /delet\w*[\s\S]{0,400}(inherit|session)|(?:inherit|session)[\s\S]{0,400}delet\w*/i;
  if (!CONSEQUENCE.test(section)) {
    throw new Error('README never explains what deleting model: actually does (every agent inherits the session model) — it only asserts the guardrail without the mechanism');
  }
  if (!/mirror/i.test(section)) {
    throw new Error('README never names the concrete failure mode (reviewer becomes a mirror of the implementer)');
  }

  return `${tiers.size} model tier(s) named (${[...tiers].join(', ')}), independence wording matched to model-lineup.js, deletion consequence explained`;
});

// The SAVINGS block is the one place this repo could lie at scale, so every path by which it could
// print a number nobody measured is pinned here:
//   · the A/B delta, recomputed from the raw arm scores and never trusted from the record's own `gap`;
//   · the prediction tally, read from the ledger table only. The fixture's process-log.md carries the
//     trap a real one carries: prose that still reads "Result: 0 escapes. VERIFIED." for a prediction
//     the ledger records as FALSIFIED, kept unedited because the mis-measurement was the finding. A
//     parser that greps the body scores that falsification as a success — the dishonesty D17 forbids;
//   · the three ways of having no token Δ (never metered / metered per round but not per arm / one arm
//     only), which must stay apart: a round total is both arms collapsed, so splitting it fabricates a
//     Δ of 0, and an unmetered arm reads as 0 to anything that sums it — the Δ becomes the other arm;
//   · the `{total}` shape, which is what a harness that never splits in/out can actually produce: both
//     arms still ran, and refusing their Δ on a formatting technicality throws a measurement away;
//   · the tally's `unknown`, which must reach the rendered line. A row the parser cannot read that is
//     silently dropped reads as "0 falsified" — the ledger's falsification would vanish;
//   · outcomes in Spanish as well as English: the plugin is English, the process-log it reads is not
//     necessarily. An English-only parser turns a real Spanish ledger into a confident "0 falsified";
//   · an absent ledger and one whose rows this parser cannot read, which are two different facts. One
//     return value for both makes the block print a false why about a file that exists.
//
// Negative controls (2026-07-12, each applied, observed, reverted — all exit 1):
//   the outcome matched against the whole document instead of the row's outcome cell ...............
//     "predictions: 0 verified / 3 falsified / 0 pending / 0 unknown, expected 1/1/1/0" — the parser
//     stops reading the ledger and starts reading prose, which is the failure this check exists for
//   OUTCOME ordered verified-before-falsified, so a corrected row keeps its superseded word .........
//     "predictions: 2 verified / 0 falsified / 1 pending / 0 unknown, expected 1/1/1/0" — the ledger's
//     falsification read as a win, because the row that carries both words was scored on the wrong one
//   abRuns trusting the record's own `gap` field instead of recomputing from the arms ...............
//     "A/B deltaScore = undefined, expected 7 (mean 21 with-skill − mean 14 without)"
//   armTokens falling back to the round's collapsed tokens, `last.armTokens || (last.tokens && {...})`
//     — the plausible shortcut, not an impossible one ...............................................
//     "round-metered A/B must report deltaTokens n/a, got 0 — a round total is both arms collapsed"
//   OUTCOME reduced to its Spanish spellings (/falsad/, /verificad/, /pendiente/) ...................
//     "predictions: 0 verified / 0 falsified / 0 pending / 3 unknown, expected 1/1/1/0"
//   the `unknown` row dropped from renderSavings ...................................................
//     "the render hides 1 unreadable row(s) — a dropped row reads as '0 falsified'"
//   renderSavings printing a fixed "not recorded (v1 schema)" instead of the record's own reason ....
//     "the unmetered reason never reaches the rendered line" — the v2 record was told it was v1
//   armTotal reading in/out only, so a harness that reports one number per run measures nothing ......
//     "total-shape A/B deltaTokens = 0, expected 9000 — a harness that reports one number per run
//      still measured both arms" — 0, not n/a: the shape it cannot read sums to zero on both arms
//   armTokens accepted with one arm present, the missing arm summed as 0 ............................
//     "one-arm A/B must report deltaTokens n/a, got 30000 — a round total is both arms collapsed"
//   parsePredictions returning the same `null` for an absent file and for a ledger it parsed no row
//   from (`if (!rows.length) return null`) — the render then states "/iterate has never run here"
//   about a process-log.md that exists and carries a falsification .................................
//     "a present ledger this parser cannot read is reported as absent: 'PREDICT no process-log.md —
//      /iterate has never run here'"
check('loop-stats scores the savings fixture from the ledger, not the prose', () => {
  const script = path.join(ROOT, 'scripts/loop-stats.js');
  const stats = (repo, ...flags) => execFileSync('node', [script,
    '--root', path.join(ROOT, 'scripts/fixtures/telemetry'), '--project', 'demo', '--repo', repo, ...flags],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  const { savings } = JSON.parse(stats(path.join(ROOT, 'scripts/fixtures/repo'), '--json'));

  const p = savings.predictions;
  if (p.verified !== 1 || p.falsified !== 1 || p.pending !== 1 || p.unknown !== 0) {
    throw new Error(`predictions: ${p.verified} verified / ${p.falsified} falsified / ${p.pending} pending / ${p.unknown} unknown, expected 1/1/1/0`);
  }
  if (p.rows.find((r) => r.version === 'v2').outcome !== 'falsified') {
    throw new Error('the falsified prediction was scored from the superseded prose, not the ledger');
  }

  const [ab] = savings.ab;
  if (!ab) throw new Error('A/B run lost — no counterfactual row');
  if (ab.deltaScore !== 7) throw new Error(`A/B deltaScore = ${ab.deltaScore}, expected 7 (mean 21 with-skill − mean 14 without)`);
  if (ab.scoreMax !== 25) throw new Error(`A/B scoreMax = ${ab.scoreMax}, expected 25`);
  if (ab.deltaTokens !== 10500) throw new Error(`A/B deltaTokens = ${ab.deltaTokens}, expected 10500 (v2 per-arm tokens)`);

  const arms = { withSkill: [20], withoutSkill: [10] };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-savings-'));
  const runs = path.join(tmp, 'docs/harness-dev/loop-runs');
  fs.mkdirSync(runs, { recursive: true });
  // Neither record can yield a token counterfactual, and each must say a different true reason why:
  // one was never metered, the other was metered per round — a total that already contains both arms.
  fs.writeFileSync(path.join(runs, '2026-01-01-skill-loop-unmetered.json'),
    JSON.stringify({ run: 'unmetered', loop: 'skill-loop', rounds: [{ n: 1, arms }] }));
  fs.writeFileSync(path.join(runs, '2026-01-02-skill-loop-round-metered.json'), JSON.stringify({
    run: 'round-metered',
    loop: 'skill-loop',
    rounds: [{ n: 1, arms, startedAt: '2026-01-02T10:00:00Z', endedAt: '2026-01-02T10:12:00Z', tokens: { in: 41000, out: 6200 } }],
  }));
  // A harness that reports one number per run and no in/out split still produced the counterfactual:
  // both arms ran. Refusing its `{total}` shape would drop a measured Δ on a formatting technicality.
  fs.writeFileSync(path.join(runs, '2026-01-03-skill-loop-total-shape.json'), JSON.stringify({
    run: 'total-shape',
    loop: 'skill-loop',
    rounds: [{ n: 1, arms, armTokens: { withSkill: { total: 30000 }, withoutSkill: { total: 21000 } } }],
  }));
  // One arm metered is no counterfactual at all: the missing arm reads as 0 to any code that sums it,
  // and the Δ becomes the whole cost of the arm that was measured.
  fs.writeFileSync(path.join(runs, '2026-01-04-skill-loop-one-arm.json'), JSON.stringify({
    run: 'one-arm',
    loop: 'skill-loop',
    rounds: [{ n: 1, arms, armTokens: { withSkill: { in: 26000, out: 4000 } } }],
  }));
  // The private ledger this dashboard was built for is written in Spanish, and one of its rows is a
  // falsification. Plus a row whose outcome is neither language: it must surface as unreadable.
  fs.writeFileSync(path.join(runs, 'process-log.md'), [
    '| v | fecha | cambio | predicción | resuelve | resultado |',
    '|---|---|---|---|---|---|',
    '| v1 | 2026-01-02 | §1 | rondas bajan de 4 a 3 | la próxima corrida | **VERIFICADA** — 3 rondas |',
    '| v2 | 2026-01-09 | §0 | escapes ≤ 1 | el próximo commit | **FALSADA — ≥3 escapes** |',
    '| v3 | 2026-01-16 | §3 | se reporta, no se resuelve en silencio | la próxima fase | pendiente |',
    '| v4 | 2026-01-23 | §2 | menos rondas | la próxima corrida | se verá |',
    '',
  ].join('\n'));

  const out = JSON.parse(stats(tmp, '--json'));
  const byRun = Object.fromEntries(out.savings.ab.map((a) => [a.run, a]));
  const ansiTmp = stats(tmp);

  const total = byRun['total-shape'];
  if (!total || total.deltaTokens !== 9000) {
    throw new Error(`total-shape A/B deltaTokens = ${total && total.deltaTokens}, expected 9000 — a harness that reports one number per run still measured both arms`);
  }

  for (const [run, reason] of [
    ['unmetered', /no tokens recorded/i],
    ['round-metered', /not per arm/i],
    ['one-arm', /only one arm/i],
  ]) {
    const a = byRun[run];
    if (!a) throw new Error(`A/B run ${run} lost`);
    if (a.deltaTokens !== null) throw new Error(`${run} A/B must report deltaTokens n/a, got ${a.deltaTokens} — a round total is both arms collapsed`);
    if (!reason.test(a.tokensReason || '')) throw new Error(`${run} A/B states a false reason: "${a.tokensReason}"`);
    // The reason has to reach the screen, not just the JSON: a rendered reason that contradicts the
    // record ("v1 schema") is a false why on a block whose whole contract is to show a true one.
    if (!reason.test(ansiTmp)) throw new Error(`the ${run} reason never reaches the rendered line`);
  }

  const es = out.savings.predictions;
  if (es.verified !== 1 || es.falsified !== 1 || es.pending !== 1 || es.unknown !== 1) {
    throw new Error(`Spanish ledger: ${es.verified} verified / ${es.falsified} falsified / ${es.pending} pending / ${es.unknown} unknown, expected 1/1/1/1`);
  }
  if (!/1 unreadable/.test(ansiTmp)) {
    const line = (ansiTmp.split('\n').find((l) => l.includes('PREDICT')) || '').trim();
    throw new Error(`the render hides ${es.unknown} unreadable row(s) — a dropped row reads as "0 falsified": "${line}"`);
  }
  // A ledger whose columns this parser cannot read is not an absent ledger. The PRD never fixed the
  // table's shape, so the row it carries a falsification in may parse to nothing here — and "no
  // process-log.md, /iterate has never run" would then be a false why about a file that exists.
  const blind = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-blind-'));
  const blindRuns = path.join(blind, 'docs/harness-dev/loop-runs');
  fs.mkdirSync(blindRuns, { recursive: true });
  fs.writeFileSync(path.join(blindRuns, 'process-log.md'), [
    '| v | fecha | cambio | predicción | resultado |',
    '|---|---|---|---|---|',
    '| v1 | 2026-01-09 | §0 | escapes ≤ 1 | ❌ FALSADA — 10 findings |',
    '',
  ].join('\n'));
  const blindAnsi = stats(blind);
  const blindLine = (blindAnsi.split('\n').find((l) => l.includes('PREDICT')) || '').trim();
  if (!/ledger unreadable/.test(blindAnsi) || /never run/.test(blindLine)) {
    throw new Error(`a present ledger this parser cannot read is reported as absent: "${blindLine}"`);
  }
  fs.rmSync(blind, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });

  return `Δscore +${ab.deltaScore}/25 · Δtok +${ab.deltaTokens} · en+es ledgers · unreadable rows and unreadable ledger rendered`;
});

// A schema field no command writes is vapour: the dashboard reads it, a fixture in this very file
// proves it renders, and no run in the wild will ever carry it. That is process.md §0 one layer up —
// a capability nothing can feed is a wish, not a feature — and it is how the Δ tokens row shipped its
// first round: green against a fixture the same diff had written, while `grep -rn armTokens commands/`
// returned nothing. This check binds each consumer field to the command that has to produce it.
//
// Negative controls (2026-07-12, each applied, observed, reverted — both exit 1):
//   `armTokens` struck from commands/skill-loop.md .. "skill-loop must instruct armTokens: the Δ tokens
//                                                      row of loop-stats has no other producer"
//   `startedAt` struck from commands/iterate.md ..... "iterate writes a loop-runs JSON but never
//                                                      instructs the v2 round field(s): startedAt"
check('every loop command produces the v2 schema the dashboard reads', () => {
  const V2 = ['startedAt', 'endedAt', 'tokens'];
  for (const cmd of ['orchestrate', 'iterate', 'review-loop', 'skill-loop']) {
    const src = read(`commands/${cmd}.md`);
    const missing = V2.filter((f) => !src.includes(`"${f}"`));
    if (missing.length) {
      throw new Error(`${cmd} writes a loop-runs JSON but never instructs the v2 round field(s): ${missing.join(', ')}`);
    }
  }
  const ab = read('commands/skill-loop.md');
  if (!ab.includes('"armTokens"') || !/withSkill[\s\S]{0,120}withoutSkill/.test(ab)) {
    throw new Error('skill-loop must instruct armTokens: the Δ tokens row of loop-stats has no other producer');
  }
  return '4 commands instruct startedAt/endedAt/tokens · skill-loop instructs armTokens';
});

// Pi's prompt-template loader parses frontmatter as STRICT YAML, and a file that fails to parse is
// DISCARDED IN SILENCE — no error, no warning, the template just never appears. So a Pi frontmatter
// value is only real if a strict YAML parser would accept it. This repo has no YAML dependency and is
// not adding one, so this reimplements the one rule that actually bit: a plain (unquoted) scalar
// containing `: ` is a mapping indicator, not text, and YAML rejects the line ("mapping values are not
// allowed in this context"). Three of this repo's five descriptions contain one (`Cost: medium`,
// `converge: the`, `keep. Cost: medium-h`) — and for one commit, `/orchestrate`, `/iterate` and
// `/skill-loop` were written to disk and silently thrown away by Pi's loader. Measured with
// `pi --mode rpc` + `get_commands`: 2 of 5 templates registered. The check that was supposed to prevent
// exactly this counted FILES WRITTEN, which is the neighbouring failure mode and not the one that
// happened. That is §0 with the paint still wet: a check aimed one inch off the target is decoration.
function assertPiFrontmatterLoads(rel, pairs) {
  for (const [k, v] of pairs) {
    const value = String(v);
    const quoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
    if (!quoted && /:\s/.test(value)) {
      throw new Error(`${rel}: Pi cannot load this template — frontmatter '${k}' is an unquoted YAML scalar containing ': ', which strict YAML reads as a mapping. Pi's loader will discard the file in silence and the command will not exist.`);
    }
    if (!quoted && /^[>|&*!%@`]/.test(value)) {
      throw new Error(`${rel}: Pi cannot load this template — frontmatter '${k}' is an unquoted YAML scalar opening with the reserved indicator '${value[0]}'.`);
    }
  }
}

// F9's port is a schema TRANSFORM, not a copy — the risk is not "the file is missing" (the four
// checks above already catch that) but "the file exists and is wrong": a command that silently
// drops `description`, an agent whose `permission`/`tools` block is malformed YAML, or a Pi agent
// missing the `name` field pi-subagents requires to discover it at all. Every real commands/*.md and
// agents/*.md in this repo is round-tripped through both transforms so a schema drift in either
// source corpus fails here before it fails a user's install.
//
// Negative control for the F12 strict-YAML hardening (2026-07-13, applied, observed, reverted — exit 1):
//   port-loops.js's `yamlQuote` reduced to the identity function, so descriptions emit unquoted .....
//     "commands/iterate.md: Pi cannot load this template — frontmatter 'description' is an unquoted
//      YAML scalar containing ': '…" — the exact defect real Pi exhibited, now caught before install
//
// Negative controls (2026-07-12, each applied by hand, observed, reverted — all exit 1):
//   transformAgentPi's `if (!name) throw` guard deleted, then run against this check's own
//   no-name fixture ................................................................................
//     "transformAgentPi accepted a fixture with no name field" — the function stopped refusing a
//     source that would have shipped a nameless, undiscoverable pi-subagents agent
//   parseFrontmatter's `if (idx === -1) throw` guard deleted, then run against this check's own
//   multi-line-value fixture .......................................................................
//     "parseFrontmatter accepted a multi-line value instead of refusing it" — instead of throwing,
//     the second line silently became its own bogus frontmatter key (`  Writ: "  Write"`)
//   TOOL_MAP.Bash.permission renamed 'bash' -> 'shell' (no such OpenCode/Kilo permission key) ......
//     "agents/correctness-critic.md: opencode/kilo port emits unknown permission key 'shell'" — a
//     permission key neither harness's documented vocabulary recognizes grants nothing at runtime
check('port-loops.js transforms every real command/agent into valid target frontmatter', () => {
  const script = path.join(ROOT, 'scripts/port-loops.js');
  execFileSync('node', ['--check', script], { stdio: 'pipe' });
  const port = require(script);

  const OC_PERMISSION_KEYS = new Set(['read', 'edit', 'glob', 'grep', 'list', 'bash', 'task',
    'external_directory', 'todowrite', 'webfetch', 'websearch', 'lsp', 'skill', 'question', 'doom_loop']);

  for (const rel of globMd('commands')) {
    const { fm, body } = port.parseFrontmatter(read(rel));
    const { fm: out } = port.transformCommandOpenCodeKilo(fm);
    const description = out.find(([k]) => k === 'description');
    if (!description || !description[1]) throw new Error(`${rel}: ported command lost its description`);
    for (const dropped of ['argument-hint', 'allowed-tools', 'disable-model-invocation']) {
      if (out.some(([k]) => k === dropped)) throw new Error(`${rel}: ported command still carries Claude-only field '${dropped}'`);
    }

    // F12: Pi gets commands too now (prompt templates, .pi/prompts/) — except the ones it cannot run.
    if (port.PI_UNPORTABLE_COMMANDS.has(path.basename(rel, '.md'))) continue;
    const { fm: piOut, body: piBody } = port.transformCommandPi(fm, body);
    const piDescription = piOut.find(([k]) => k === 'description');
    if (!piDescription || !piDescription[1]) throw new Error(`${rel}: pi-ported command lost its description`);
    for (const dropped of port.PI_COMMAND_DROPPED_FIELDS) {
      if (piOut.some(([k]) => k === dropped)) throw new Error(`${rel}: pi-ported command still carries Claude-only field '${dropped}'`);
    }
    // The blocker this check missed the first time: every value has to SURVIVE Pi's strict-YAML
    // frontmatter loader. See assertPiFrontmatterLoads — a file Pi cannot parse is discarded in
    // silence, so "the file was written" proves nothing at all.
    assertPiFrontmatterLoads(rel, piOut);
    const leftoverTaskRef = /\bTask tool\b|\bTask calls\b|subagent_type|\.claude\/agents|each Task returned|`Task`\s|AskUserQuestion|CLAUDE_PLUGIN_ROOT/.exec(piBody);
    if (leftoverTaskRef) throw new Error(`${rel}: pi-ported command body still reads "${leftoverTaskRef[0]}" — a Claude Code-only reference that does not resolve on Pi`);
    // Pi's own prompt-template engine substitutes $ARGUMENTS/$@ natively (docs/prompt-templates.md)
    // — every source command that uses it must keep using it, not have it rewritten into prose.
    if (body.includes('$ARGUMENTS') && !piBody.includes('$ARGUMENTS')) {
      throw new Error(`${rel}: pi-ported command body dropped $ARGUMENTS — it is a real, working substitution on Pi, not dead text`);
    }
  }

  for (const rel of globMd('agents')) {
    const { fm } = port.parseFrontmatter(read(rel));

    const { fm: ocOut } = port.transformAgentOpenCodeKilo(fm);
    if (!ocOut.some(([k, v]) => k === 'mode' && v === 'subagent')) throw new Error(`${rel}: opencode/kilo port missing mode: subagent`);
    const perm = (ocOut.find(([k]) => k === 'permission') || [])[1];
    if (perm) {
      for (const k of Object.keys(perm)) {
        if (!OC_PERMISSION_KEYS.has(k)) throw new Error(`${rel}: opencode/kilo port emits unknown permission key '${k}'`);
      }
    }

    const { fm: piOut } = port.transformAgentPi(fm);
    const piName = piOut.find(([k]) => k === 'name');
    if (!piName || !piName[1]) throw new Error(`${rel}: pi port missing required name field`);
    if (!piOut.some(([k, v]) => k === 'defaultContext' && v === 'fresh')) throw new Error(`${rel}: pi port missing defaultContext: fresh`);
  }

  // A malformed source (a multi-line frontmatter value this line-based parser cannot read) must be
  // refused, not silently mis-split into a bogus extra key.
  let threw = false;
  try {
    port.parseFrontmatter('---\ntools: Read\n  Write\ndescription: x\n---\nbody');
  } catch (e) { threw = /flat key: value/.test(e.message); }
  if (!threw) throw new Error('parseFrontmatter accepted a multi-line value instead of refusing it');

  // A Pi agent fixture missing `name` (the field pi-subagents needs to discover it at all) must
  // refuse to transform rather than write a nameless, undiscoverable agent file.
  let piThrew = false;
  try {
    port.transformAgentPi(port.parseFrontmatter('---\ndescription: no name here\ntools: read\n---\nbody').fm);
  } catch (e) { piThrew = /missing name/.test(e.message); }
  if (!piThrew) throw new Error('transformAgentPi accepted a fixture with no name field');

  return `${globMd('commands').length} command(s) + ${globMd('agents').length} agent(s) round-tripped through opencode/kilo + pi`;
});

// Every capability the port DESTROYS has to be named in the README, because the README is the only
// place a user finds out. This is the check the F9 review should not have had to be: the first draft
// dropped `disable-model-invocation` (the veto that keeps two token-hungry loops and one that analyses
// the human from auto-firing), left a code comment claiming the loss was "documented as a README
// caveat", and shipped no such caveat — while the README went on asserting the veto still held. The
// code was right and the documentation lied, in a repo whose whole product is not lying. So: each
// destroyed guardrail is bound to the prose that has to disclose it, and the binding is executable.
//
// Negative controls (2026-07-12, each applied, observed, reverted — all exit 1):
//   the `disable-model-invocation` paragraph struck from README §Compatibility ....................
//     "README never discloses that the port drops 'disable-model-invocation' — the manual-only veto
//      on /review-loop, /iterate and /session-review does not exist on OpenCode/Kilo"
//     NOTE: this control FAILED TO BITE on the first version of this check (exit 0) — the matrix row
//     alone matched its regex, so a README that had deleted the entire explanatory paragraph still
//     passed. The check was tightened to demand the CONSEQUENCE in prose, not the fact in a cell,
//     and only then did the control fire. Recorded because it is the whole argument for §0: this
//     check was decoration for the length of one commit, and nothing but the control said so.
//   the correctness-critic/WebSearch caveat struck from the README ................................
//     "README never discloses that correctness-critic loses WebSearch on Pi"
//
// F12 RECOLOCATION (2026-07-13, not a deletion): the assertion that used to sit here — "README never
// states plainly that the loop COMMANDS do not port to Pi" — checked a claim that turned out to be
// FALSE. F9 concluded Pi could not run the loop commands at all; it can, via pi-subagents, exactly like
// the agents already required it (see README §Compatibility, "Loops on Pi, in full"). Deleting that
// check outright would leave this file with no memory that the claim was ever tested; instead it is
// replaced below with its mirror image — a check that the README now asserts the TRUE thing (loops run
// on Pi) and keeps asserting the two caveats that are still true (WebSearch, the model alias). A second,
// new check (further down) binds that capability to `install.sh` actually delivering it.
// Negative controls for the recolocated assertions (2026-07-13, each applied, observed, reverted — all
// exit 1):
//   `destDirsFor('pi').commands` reverted to `null` in port-loops.js .............................
//     "port-loops.js no longer ports commands to Pi — the README says it does; one of the two is lying"
//   the "preserved on Pi — by construction" sentence struck from README §Compatibility .............
//     "README no longer states that the manual-only veto survives on Pi by construction"
//   the Pi model-alias caveat paragraph struck from README §Compatibility ..........................
//     "README never discloses that the model: alias is unresolved on Pi too"
check('README discloses every guardrail the port destroys', () => {
  const port = require(path.join(ROOT, 'scripts/port-loops.js'));
  const t = read('README.md');

  // Not "is the string present anywhere" — the disclosure has to sit in the section a reader lands on
  // from the install instructions, or it is a caveat hidden from the person who needs it.
  if (!/## Compatibility across harnesses/.test(t)) throw new Error('README lost the compatibility matrix section');
  const compat = t.split('## Compatibility across harnesses')[1].split(/\n## /)[0];

  // What the transform actually destroys, asked of the transform itself rather than assumed here: a
  // future field silently added to the drop list fails this check until the README names it too.
  const cmdDrops = new Set();
  for (const rel of globMd('commands')) {
    port.transformCommandOpenCodeKilo(port.parseFrontmatter(read(rel)).fm).dropped.forEach((d) => cmdDrops.add(d));
  }
  if (!cmdDrops.has('disable-model-invocation')) {
    throw new Error('the command transform no longer reports dropping disable-model-invocation — either it is carried now (update this check) or the report was lost (a silent drop)');
  }
  // Not satisfied by the matrix row: a table cell reading "❌ no equivalent" is a fact a reader can
  // skim past without learning the consequence. The disclosure has to name what the loss DOES —
  // the three loops become auto-dispatchable — in prose, or it has not been made. (The first version
  // of this check accepted the matrix row alone and its negative control passed 0/3; that is how a
  // check becomes decoration.)
  const CONSEQUENCE = /auto-dispatch(?:able|ed)?[\s\S]{0,400}(review-loop|iterate|session-review)|(review-loop|iterate|session-review)[\s\S]{0,400}auto-dispatch(?:able|ed)?/i;
  if (!/disable-model-invocation/.test(compat) || !CONSEQUENCE.test(compat)) {
    throw new Error("README never discloses that the port drops 'disable-model-invocation' — the manual-only veto on /review-loop, /iterate and /session-review does not exist on OpenCode/Kilo");
  }

  // Pi gets the loops too now (F12) — asked of the transform itself, not assumed: if a future change
  // silently un-ports commands from Pi, this fails until the README is corrected back down with it.
  if (port.destDirsFor('pi').commands === null) {
    throw new Error('port-loops.js no longer ports commands to Pi — the README says it does; one of the two is lying');
  }
  if (!/preserved on Pi[\s\S]{0,40}— by construction/i.test(compat)) {
    throw new Error('README no longer states that the manual-only veto survives on Pi by construction');
  }
  // Command frontmatter never carries `model:` (verified against the transform itself, not assumed) —
  // the caveat is about the 7 ported AGENTS, and it has to say so for Pi specifically, not just for
  // OpenCode/Kilo Code.
  for (const rel of globMd('commands')) {
    if (port.transformCommandPi(port.parseFrontmatter(read(rel)).fm, port.parseFrontmatter(read(rel)).body).fm.some(([k]) => k === 'model')) {
      throw new Error(`${rel}: pi-ported command now carries a model: field — the README's "no commands carry model:" claim is stale`);
    }
  }
  if (!/model:`? line is still a Claude Code alias on Pi/i.test(compat)) {
    throw new Error('README never discloses that the model: alias is unresolved on Pi too, not just on OpenCode/Kilo Code');
  }
  // A loop the port WITHHOLDS is a disclosure too — and the one most easily mistaken for a bug.
  for (const name of port.PI_UNPORTABLE_COMMANDS) {
    if (!new RegExp(`\`?/${name}\`? does not port to Pi`, 'i').test(compat)) {
      throw new Error(`README never states that /${name} does not port to Pi — a user who types it and gets nothing has no way to know that is by design`);
    }
  }

  // The fact seat losing its only route to facts is a caveat, not a footnote.
  const piDrops = port.transformAgentPi(port.parseFrontmatter(read('agents/correctness-critic.md')).fm).dropped;
  if (piDrops.includes('WebSearch') && !/correctness-critic[\s\S]{0,300}WebSearch/i.test(compat)) {
    throw new Error('README never discloses that correctness-critic loses WebSearch on Pi');
  }

  return 'disable-model-invocation dropped on OpenCode/Kilo · Pi loops preserved by construction + model alias · correctness-critic loses WebSearch on Pi';
});

// F12: the check above binds the README's PROSE to the transform's behavior; this one binds it to
// `install.sh` — the thing a user actually runs — and, crucially, to what PI ITSELF WILL ACCEPT.
//
// The first version of this check counted files in `.pi/prompts/` and called that success. Real Pi
// (`pi --mode rpc`, `get_commands`) then registered 2 of the 5 it had "installed": the other three had
// an unquoted `: ` in their description and Pi's strict-YAML loader binned them without a word. Writing
// a file the loader discards is not installing a loop. So every template this installer writes is now
// re-parsed here through the same strict-YAML rule Pi applies (assertPiFrontmatterLoads) — the check
// fails for the reason a user would actually experience ("Pi cannot load this template"), not for the
// adjacent one that was easy to assert ("the file is not there").
//
// Negative controls (2026-07-13, each applied by hand, observed, reverted — all exit 1):
//   port-loops.js's `yamlQuote` reduced to the identity (descriptions emit unquoted, exactly as they
//   did when real Pi silently dropped 3 of 5) ......................................................
//     ".pi/prompts/iterate.md: Pi cannot load this template — frontmatter 'description' is an unquoted
//      YAML scalar containing ': '…"
//   `PI_UNPORTABLE_COMMANDS` emptied, so session-review ports to Pi again .........................
//     "install.sh --target pi wrote 5 prompt template(s), expected 4 — session-review shells out to
//      ${CLAUDE_PLUGIN_ROOT}/scripts/loop-stats.js and cannot run on Pi"
check("install.sh --target pi installs templates Pi can actually load", () => {
  execFileSync('sh', ['-n', path.join(ROOT, 'install.sh')], { stdio: 'pipe' });
  const port = require(path.join(ROOT, 'scripts/port-loops.js'));

  const clean = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-pi-clean-'));
  execFileSync('sh', ['-c', `sh "${path.join(ROOT, 'install.sh')}" --target pi --skip-graphify --skip-subagent-check 2>&1`], { cwd: clean });

  const promptDir = path.join(clean, '.pi/prompts');
  const promptFiles = fs.existsSync(promptDir) ? fs.readdirSync(promptDir).filter((f) => f.endsWith('.md')).sort() : [];
  const expected = globMd('commands').map((f) => path.basename(f))
    .filter((f) => !port.PI_UNPORTABLE_COMMANDS.has(path.basename(f, '.md'))).sort();
  if (promptFiles.length !== expected.length) {
    throw new Error(`install.sh --target pi wrote ${promptFiles.length} prompt template(s), expected ${expected.length} — session-review shells out to \${CLAUDE_PLUGIN_ROOT}/scripts/loop-stats.js and cannot run on Pi`);
  }
  for (const name of port.PI_UNPORTABLE_COMMANDS) {
    if (promptFiles.includes(`${name}.md`)) throw new Error(`install.sh --target pi wrote ${name}.md, a command that cannot run on Pi — it would look like a working loop and die on its first command`);
  }

  // The blocker: does PI accept these files, or does its loader bin them? Same strict-YAML rule,
  // applied to what actually landed on disk — not to what the transform said it would write.
  for (const f of promptFiles) {
    const src = fs.readFileSync(path.join(promptDir, f), 'utf8');
    const { fm, body } = port.parseFrontmatter(src);
    assertPiFrontmatterLoads(`.pi/prompts/${f}`, fm);
    if (!fm.some(([k]) => k === 'description')) throw new Error(`.pi/prompts/${f}: no description — Pi falls back to the first body line in autocomplete`);
    // Asserted against the FILE, not against PI_UNPORTABLE_COMMANDS: deriving "what may be installed"
    // from the same constant that decides what gets installed is a tautology that can never fail. The
    // real, independent property is that nothing Pi is asked to run may reach for a Claude Code
    // plugin-runtime variable — a path that resolves to nothing and dies on the first command.
    if (body.includes('CLAUDE_PLUGIN_ROOT')) {
      throw new Error(`.pi/prompts/${f}: installed to Pi but its body reads \${CLAUDE_PLUGIN_ROOT} — a Claude Code plugin-runtime variable that is empty on Pi, pointing at a script this target never installs. It would look like a working loop and die on its first command.`);
    }
  }

  const agentFiles = fs.existsSync(path.join(clean, '.pi/agents'))
    ? fs.readdirSync(path.join(clean, '.pi/agents')).filter((f) => f.endsWith('.md')) : [];
  if (agentFiles.length !== 7) throw new Error(`install.sh --target pi wrote ${agentFiles.length} agent(s) in .pi/agents, expected 7`);

  return `${promptFiles.length} prompt(s) Pi's strict-YAML loader accepts + ${agentFiles.length} agents · session-review correctly withheld`;
});

// loop-gate.js is the one step in a loop that no agent wrote, so it is the one step whose failure
// nothing else would report: a chair reading a seat's JSON as prose cannot see that `line: 900` is past
// the end of a 40-line file, and it will aggregate that finding and hand it to a human as evidence.
// The fixtures pin each defect class the gate exists to refuse, and the scorecard pins the arithmetic —
// the number the gate opens on, now computed instead of produced by whichever model holds the chair.
//
// Negative controls (2026-08-09, each applied, observed, reverted — all exit 1). The observed message
// is quoted, not the one predicted when the control was written; two of the three came back different:
//   anchorError's fs.existsSync branch removed (a path is trusted if it is a non-empty string) ......
//     "malformed findings exited 1, expected 2 (repair-and-retry)" — NOT the predicted "did not catch
//     the anchor". Without the guard, statSync threw ENOENT uncaught and the gate DIED on a bad
//     finding instead of reporting it: a seat's malformed reply would have taken the whole round with
//     it, a worse failure than the one the control was aimed at, and visible only by running it. The
//     fs calls in anchorError were wrapped in try/catch because of this control, and re-running it
//     against the hardened gate then produced the message originally aimed for: "the gate did not
//     catch an anchor at a file not in the repo". Both runs are recorded: the first found the bug.
//   scoreOf counting `applies: false` criteria into the denominator .................................
//     "gate arithmetic drifted: SCORECARD OK: 5 criteria (11 weight counted) | SCORE: 36/100 ·
//     BLOCKERS: 2" — predicted 40/100; the real drift is larger and it moves the BLOCKER count too,
//     because a criterion with nothing to bind to starts failing a gate it was never part of.
//   the `applies: false with no evidence` rule struck from checkScorecard .........................
//     "the gate lets an unjustified applies:false through — the one exit a criterion has" (as predicted)
check('loop-gate refuses malformed seat output and computes the gate arithmetic', () => {
  const script = path.join(ROOT, 'scripts/loop-gate.js');
  mustExist('scripts/loop-gate.js');
  execFileSync('node', ['--check', script], { stdio: 'pipe' });

  const run = (args) => {
    try {
      return { status: 0, out: execFileSync('node', [script, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), err: '' };
    } catch (e) {
      return { status: e.status, out: e.stdout || '', err: e.stderr || '' };
    }
  };
  const gate = (fixture) => run(['check-findings', path.join(ROOT, 'scripts/fixtures/findings', fixture), '--root', ROOT, '--seat', 'style']);

  const ok = gate('valid-findings.json');
  if (ok.status !== 0) throw new Error(`the gate rejected valid findings: ${ok.err.split('\n')[0]}`);

  const bad = gate('invalid-findings.json');
  if (bad.status !== 2) throw new Error(`malformed findings exited ${bad.status}, expected 2 (repair-and-retry)`);
  for (const [needle, why] of [
    ['reserved key "id"', 'a seat that named its own finding'],
    ['does not exist: scripts/does-not-exist.js', 'an anchor at a file not in the repo'],
    ['past the end of README.md', 'an anchor past the end of a real file'],
    ['severity "critical"', 'a severity outside the fixed ladder'],
    ['unknown key "confidence"', 'a key the contract does not have'],
    ['missing "fix"', 'a finding that names no action'],
  ]) {
    if (!bad.err.includes(needle)) throw new Error(`the gate did not catch ${why} (no "${needle}" in its report)`);
  }

  const card = gate('valid-scorecard.json');
  if (card.status !== 0) throw new Error(`the gate rejected a valid scorecard: ${card.err.split('\n')[0]}`);
  // 5 criteria, one applies:false. Counted weight = 3+3+1+1 = 8; passed = 3+1 = 4 -> 50, one failed blocker.
  if (!/SCORE: 50\/100 · BLOCKERS: 1/.test(card.out)) throw new Error(`gate arithmetic drifted: ${card.out.trim().replace(/\n/g, ' | ')}`);

  const badCard = gate('invalid-scorecard.json');
  if (badCard.status !== 2) throw new Error(`malformed scorecard exited ${badCard.status}, expected 2`);
  if (!/applies: false with no evidence/.test(badCard.err)) {
    throw new Error('the gate lets an unjustified applies:false through — the one exit a criterion has');
  }
  if (!/FAILED but "findings" is empty/.test(badCard.err)) {
    throw new Error('the gate lets a failed criterion through with no finding — a score with no fix behind it');
  }

  // resume: a half-written run is either resumable or it is a question for a human. It is never
  // something to reconcile, which is the one behaviour that would silently restart a paid-for round.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-resume-'));
  const mk = (name, files) => {
    const d = path.join(tmp, name);
    fs.mkdirSync(d, { recursive: true });
    for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(d, f), body);
    return d;
  };
  const states = [
    ['NO_RUN', mk('empty', {}), 0, /NO_RUN/],
    ['resumable', mk('two', { 'round-1.json': '{"n":1}', 'round-2.json': '{"n":2}' }), 0, /COMPLETED_ROUNDS: 2\nRESUME_FROM: 3/],
    ['complete', mk('done', { 'round-1.json': '{"n":1}', '2026-01-01-orchestrate-x.json': '{"verdict":"APROBADO"}' }), 0, /RUN_COMPLETE/],
    ['gap', mk('gap', { 'round-1.json': '{"n":1}', 'round-3.json': '{"n":3}' }), 2, /AMBIGUOUS_RUN_STATE/],
    ['unreadable', mk('broken', { 'round-1.json': '{"n":1}', 'round-2.json': '{"n":2' }), 2, /AMBIGUOUS_RUN_STATE/],
  ];
  for (const [name, dir, wantStatus, wantText] of states) {
    const r = run(['resume', dir]);
    if (r.status !== wantStatus) throw new Error(`resume/${name} exited ${r.status}, expected ${wantStatus}`);
    if (!wantText.test(r.out + r.err)) throw new Error(`resume/${name} reported "${(r.out + r.err).trim().split('\n')[0]}"`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });

  return `6 defect classes refused · SCORE/BLOCKERS computed · ${states.length} resume states`;
});

// A gate nothing calls is the same vapour as a schema field nothing writes (see the v2-schema check
// above): loop-gate.js could pass every fixture in this file while no loop in the repo ever ran it.
// This binds each half of the gate to the commands that have to produce the call.
//
// Negative controls (2026-08-09, each applied, observed, reverted — both exit 1):
//   the check-findings block struck from commands/orchestrate.md ...................................
//     "orchestrate dispatches seats but never gates their JSON — loop-gate.js check-findings has no
//      producer"
//   Bash(node:*) struck from commands/review-loop.md's allowed-tools ...............................
//     "review-loop calls node but its allowed-tools does not permit it — the gate would be denied at
//      the first round"
//   the `:-` default stripped back to a bare ${CLAUDE_PLUGIN_ROOT} in commands/orchestrate.md ......
//     three checks fired at once, which is the correct shape for this one: the two Pi-port checks
//     ("pi-ported command body still reads CLAUDE_PLUGIN_ROOT", ".pi/prompts/orchestrate.md: installed
//     to Pi but its body reads ${CLAUDE_PLUGIN_ROOT}") plus this one, "orchestrate calls loop-gate.js
//     through a bare ${CLAUDE_PLUGIN_ROOT} — a copied-commands install is silently ungated again".
//     Verified end to end as well: `install.sh --target claude --lineup` in a clean repo, then the
//     command's own line with the variable unset — `NO_RUN`, exit 0, gate resolved from .claude/scripts.
//   the "report the run as ungated" sentence struck from commands/orchestrate.md ...................
//     "orchestrate never says what to do when loop-gate.js is absent — a copied-commands install
//      crashes on the missing script and the chair is left with no instruction, so an ungated run
//      reports as a gated one". Added after shipping the gate one version with this hole open: the
//      gate reached two loops that install.sh copies WITHOUT scripts/, and nothing said so.
check('the panel loops actually run their seats through loop-gate', () => {
  for (const cmd of ['orchestrate', 'review-loop']) {
    const src = read(`commands/${cmd}.md`);
    if (!/loop-gate\.js" check-findings/.test(src)) {
      throw new Error(`${cmd} dispatches seats but never gates their JSON — loop-gate.js check-findings has no producer`);
    }
    if (!/loop-gate\.js" resume/.test(src)) {
      throw new Error(`${cmd} never checks for a run already in progress — a chair that dies mid-run re-pays for every round`);
    }
    if (!/round-<n>\.json/.test(src)) {
      throw new Error(`${cmd} never writes a per-round file — resume has nothing to count and always reports NO_RUN`);
    }
    if (!/AMBIGUOUS_RUN_STATE/.test(src)) {
      throw new Error(`${cmd} never says what to do when the run state is ambiguous — the one case that must reach a human`);
    }
    if (!/Bash\(node:\*\)/.test(src)) {
      throw new Error(`${cmd} calls node but its allowed-tools does not permit it — the gate would be denied at the first round`);
    }
    // `${CLAUDE_PLUGIN_ROOT}` only resolves inside the Claude Code plugin runtime, and install.sh
    // copies commands/ and agents/ into a project WITHOUT ever copying scripts/. So a copied-commands
    // install runs `node "/scripts/loop-gate.js"` and gets a module-not-found stack trace — which is
    // neither of the two exit codes the command tells the chair how to read. Every gate call has to
    // carry its own fallback, and the run has to be REPORTED as ungated: silence there turns a missing
    // gate into a passing one, which is the failure mode this whole file exists to refuse.
    if (!/If that command is not available/.test(src) || !/ungated/.test(src)) {
      throw new Error(`${cmd} never says what to do when loop-gate.js is absent — a copied-commands install crashes on the missing script and the chair is left with no instruction, so an ungated run reports as a gated one`);
    }
    // A BARE ${CLAUDE_PLUGIN_ROOT} forced a choice nobody should have to make: install the plugin and
    // get the gate but not your own model line-up, or copy the commands locally and get the line-up
    // but not the gate. The `:-` default removes it — the copied install resolves `.claude/scripts`,
    // which install.sh now populates. Reintroducing a bare reference silently restores the trade-off.
    if (/\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/loop-gate/.test(src)) {
      throw new Error(`${cmd} calls loop-gate.js through a bare \${CLAUDE_PLUGIN_ROOT} — that resolves to nothing outside the plugin runtime, so a copied-commands install is silently ungated again`);
    }
  }
  const inst = read('install.sh');
  if (!/SCRIPT_DEST/.test(inst) || !/scripts\/\*\.js/.test(inst)) {
    throw new Error('install.sh copies commands/ without copying scripts/ beside them — the commands\' .claude/scripts fallback would point at an empty directory');
  }
  return '2 panel loops gate their seats, resume their runs, degrade honestly, and resolve the gate with or without the plugin';
});

// F13 — the capability table is the authority on what the port destroys, and its whole purpose is that
// install.sh and README §Compatibility stop being two independent retellings of the same caveats. So
// every row has to reach the reader in both places: the README in prose, install.sh by printing the
// table rather than its own copy. A row added here with no README disclosure fails this gate.
//
// Negative controls (2026-08-09, each applied, observed, reverted — all exit 1):
//   the loop-gate paragraph struck from README §Compatibility .....................................
//     FIRST RUN: exit 0. The control DID NOT BITE. The marker was still satisfied by the matrix row
//     naming the same feature, so a README that had deleted the entire explanation still passed —
//     the identical trap the guardrail check above records falling into, repeated one check later by
//     someone who had just read that comment. The matrix rows are now stripped before matching, and
//     only then did it fire: "opencode: README §Compatibility never discloses the lost capability
//     'loop-gate'". Recorded because the check was decoration for the length of one edit, and nothing
//     but the control said so.
//   install.sh's `node "$PORTER" --capabilities` calls replaced with the old inline echo blocks .....
//     "install.sh no longer prints the capability table — its warnings are a second copy of it again"
//   HARNESS_CAPABILITIES.pi.lost emptied ..........................................................
//     "pi declares no lost capability — the table would pass vacuously"
check('README and install.sh both disclose every capability the port table destroys', () => {
  const port = require(path.join(ROOT, 'scripts/port-loops.js'));
  const t = read('README.md');
  if (!/## Compatibility across harnesses/.test(t)) throw new Error('README lost the compatibility matrix section');
  const compatFull = t.split('## Compatibility across harnesses')[1].split(/\n## /)[0];
  // The MATRIX ROWS ARE STRIPPED before matching, and that is the whole point of this check rather
  // than an optimisation. Its first version matched the section as a whole, and the negative control
  // for the newest row (delete the loop-gate paragraph) PASSED: the marker was still satisfied by the
  // table cell that names the same feature. A cell reading "⚠️ degraded" is a fact a reader skims past
  // without learning the consequence — the same lesson the guardrail check above records learning the
  // hard way, arriving one check later. So the disclosure must live in prose, where the loss is
  // explained, and a matrix row alone can no longer stand in for it.
  const compat = compatFull.split('\n').filter((l) => !l.trim().startsWith('|')).join('\n');

  const targets = Object.entries(port.HARNESS_CAPABILITIES);
  if (!targets.length) throw new Error('HARNESS_CAPABILITIES is empty — this check would pass vacuously');

  let rows = 0;
  for (const [target, cap] of targets) {
    if (!cap.lost || !cap.lost.length) throw new Error(`${target} declares no lost capability — the table would pass vacuously`);
    const report = port.capabilityReport(target);
    for (const lost of cap.lost) {
      rows += 1;
      if (!lost.readmeMarker || !lost.warning || !lost.warning.length) {
        throw new Error(`${target}/${lost.id} is missing its readmeMarker or its warning text`);
      }
      // Matched against the section a reader lands on from the install instructions, never the whole
      // file: a caveat three sections away is a caveat hidden from the person who needs it.
      if (!new RegExp(lost.readmeMarker, 'i').test(compat)) {
        throw new Error(`${target}: README §Compatibility never discloses the lost capability '${lost.id}'`);
      }
      if (!report.includes(lost.warning[0])) {
        throw new Error(`${target}: capabilityReport() drops the warning for '${lost.id}' — install-time silence on a real loss`);
      }
    }
  }

  const inst = read('install.sh');
  if (!/--capabilities/.test(inst)) {
    throw new Error('install.sh no longer prints the capability table — its warnings are a second copy of it again');
  }
  return `${rows} capability row(s) across ${targets.length} targets, disclosed in README + install.sh`;
});

// D25a is enforced on the LINE-UP (model-lineup.js exits 2 on a same-family reviewer/implementer) —
// but a validated line-up governs nothing until it reaches the agent files, and for a long time it did
// not: the stamper's role→file map knew only the plugin's own agents, so implementer.md and
// reviewer.md, the two files the whole rule exists for, were the two it skipped. In a real project both
// were found still carrying `model: opus`, which is the independence property failing silently with a
// green line-up sitting beside it. An agent with no `model:` line at all was skipped too — and that is
// the same failure wearing different clothes, because both roles then inherit the session's model.
//
// The other half of this check is destruction: `cp -R agents/.` overwrote a project's customized
// domain-critic.md — the exact file README §domain-critic tells you to write — inside the one command
// a user runs to pin their own models.
//
// Negative controls (2026-08-10, each applied, observed, reverted — all exit 1):
//   implementer.md|reviewer.md removed from the stamper's case arms .................................
//     "implementer.md has no model: line after --lineup — it inherits the session model, and so does
//      reviewer.md, which is the independence property collapsing in silence" — not the predicted
//      "kept model: sonnet": the fixture's implementer ships with no model: at all, which is the shape
//      the real project had, so an unmapped role and a dropped insert branch fail identically. Both
//      end in the same place and it is the place that matters: two roles on one model.
//   the cmp -s guard removed, `cp` restored to unconditional .......................................
//     "install.sh overwrote a customized domain-critic.md — the file README tells users to write"
//   the awk insert branch dropped (only `grep -q '^model:'` files stamped) ..........................
//     "implementer.md has no model: line after --lineup — it inherits the session model, and so does
//      reviewer.md, which is the independence property collapsing in silence"
check('install.sh --lineup stamps the project roles and never clobbers a customized agent', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-stamp-'));
  const agents = path.join(tmp, '.claude/agents');
  fs.mkdirSync(path.join(tmp, '.agents'), { recursive: true });
  fs.mkdirSync(agents, { recursive: true });

  // A project line-up so this check does not depend on whatever the machine's global file says.
  fs.writeFileSync(path.join(tmp, '.agents/model-lineup.json'), JSON.stringify({
    version: 1,
    defaults: {
      architect: { model: 'claude-fable-5' }, orchestrator: { model: 'claude-fable-5' },
      implementer: { model: 'claude-opus-5' }, reviewer: { model: 'claude-fable-5' },
      preflight: { model: 'claude-sonnet-5' }, scorer: { model: 'claude-fable-5' },
      critic: { model: 'claude-sonnet-5' }, judge: { model: 'claude-fable-5' },
    },
  }));

  const MARK = 'CUSTOM-DOMAIN-CONTRACT-DO-NOT-CLOBBER';
  const fm = (name, extra) => `---\nname: ${name}\ndescription: "fixture"\n${extra}---\n\nbody\n`;
  fs.writeFileSync(path.join(agents, 'domain-critic.md'), fm('domain-critic', 'model: sonnet\n').replace('body', MARK));
  fs.writeFileSync(path.join(agents, 'implementer.md'), fm('implementer', ''));      // no model: at all
  fs.writeFileSync(path.join(agents, 'reviewer.md'), fm('reviewer', 'model: opus\n')); // same family as implementer
  fs.writeFileSync(path.join(agents, 'no-frontmatter.md'), '# not an agent\nprose\n');

  execFileSync('sh', [path.join(ROOT, 'install.sh'), '--target', 'claude', '--lineup',
    '--skip-graphify', '--yes'], { cwd: tmp, stdio: 'pipe' });

  const modelOf = (f) => {
    const src = fs.readFileSync(path.join(agents, f), 'utf8');
    const block = /^---\n([\s\S]*?)\n---/.exec(src);
    return block ? (/^model:\s*(\S+)/m.exec(block[1]) || [])[1] : undefined;
  };

  if (!fs.readFileSync(path.join(agents, 'domain-critic.md'), 'utf8').includes(MARK)) {
    throw new Error('install.sh overwrote a customized domain-critic.md — the file README tells users to write');
  }

  const impl = modelOf('implementer.md');
  const rev = modelOf('reviewer.md');
  if (!impl) {
    throw new Error('implementer.md has no model: line after --lineup — it inherits the session model, and so does reviewer.md, which is the independence property collapsing in silence');
  }
  if (impl !== 'opus') throw new Error(`implementer.md kept model: ${impl} — the stamper skipped the role D25a is about`);
  if (!rev) throw new Error('reviewer.md lost its model: line');
  // The property, not the literal: whatever the line-up resolves to, these two may never be the same.
  const { familyOf } = require(path.join(ROOT, 'scripts/model-lineup.js'));
  const ALIAS = { fable: 'claude-fable-5', opus: 'claude-opus-5', sonnet: 'claude-sonnet-5', haiku: 'claude-haiku-4-5-20251001' };
  const famOf = (a) => familyOf({ model: ALIAS[a] || a });
  if (famOf(impl) === famOf(rev)) {
    throw new Error(`after --lineup, implementer (${impl}) and reviewer (${rev}) resolve to the same family ${famOf(impl)} — D25a passed on the line-up and failed on the files`);
  }
  if (modelOf('no-frontmatter.md') !== undefined) {
    throw new Error('a file with no frontmatter was stamped — Claude Code never registers it, so the model: line is decoration on prose');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  return `implementer=${impl} · reviewer=${rev} (${famOf(impl)} ≠ ${famOf(rev)}) · custom agent preserved · frontmatter-less file left alone`;
});

const GLYPH = { pass: '✓', fail: '✗', skip: '⊘' };
let failed = 0, skipped = 0;
for (const r of results) {
  if (r.state === 'fail') failed++;
  if (r.state === 'skip') skipped++;
  console.log(`${GLYPH[r.state]} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
const passed = results.length - failed - skipped;
console.log(`${passed}/${results.length} checks passed${skipped ? ` · ${skipped} NOT VERIFIED (⊘ above — not green, just unrun)` : ''}`);
process.exit(failed ? 1 : 0);
