#!/usr/bin/env node
// validate.js — the package's own preflight gate.
// A methodology that preaches executable rubrics must be able to say no to itself.
// Run: node scripts/validate.js   (exit 0 = releasable, non-zero = fix first)

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const results = [];
const check = (name, fn) => {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: detail || '' });
  } catch (e) {
    results.push({ name, ok: false, detail: e.message.split('\n')[0] });
  }
};
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const mustExist = (rel) => { if (!fs.existsSync(path.join(ROOT, rel))) throw new Error(`${rel} missing`); };
// Vacuous-safe glob: commands/ and agents/ don't exist yet (F2+ create them) — an absent
// or empty dir returns [] so callers degrade to a no-op PASS instead of crashing.
const globMd = (dir) => {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs).filter((f) => f.endsWith('.md')).map((f) => path.join(dir, f)).sort();
};
const hasFrontmatterField = (rel, field) => {
  const s = read(rel);
  if (!/^---\n/.test(s)) throw new Error(`${rel} missing frontmatter`);
  const fm = s.split('---')[1] ?? '';
  if (!new RegExp(`${field}:\\s*\\S+`).test(fm)) throw new Error(`${rel} frontmatter missing ${field}`);
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
  const s = read('skills/harness-audit/SKILL.md');
  if (!/^---\n/.test(s)) throw new Error('no frontmatter');
  const fm = s.split('---')[1];
  if (!/name:\s*\S+/.test(fm)) throw new Error('frontmatter missing name');
  if (!/description:\s*\S+/.test(fm)) throw new Error('frontmatter missing description');
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
  // D18: the invariant extends to commands/ and agents/ — vacuously satisfied while those
  // dirs don't exist yet (F2+ create them), so a missing dir must never crash this check.
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
  // D18: same extension to commands/ and agents/, same vacuous-safety.
  const files = ['skills/harness-audit/SKILL.md', 'WHITEPAPER.md', ...globMd('commands'), ...globMd('agents')];
  for (const rel of files) {
    const t = read(rel);
    if (/89\s*%/.test(t) && !/directional|illustrative|not (yet )?(independently )?reproduced/i.test(t)) {
      throw new Error(`${rel} cites 89% without a directional/unreproduced hedge`);
    }
  }
  return `${files.length} files scanned`;
});

check('every commands/*.md has frontmatter description (vacuous if none exist yet)', () => {
  const files = globMd('commands');
  for (const rel of files) hasFrontmatterField(rel, 'description');
  return files.length ? `${files.length} command(s) checked` : 'no commands/ yet';
});

check('every agents/*.md has frontmatter description (vacuous if none exist yet)', () => {
  const files = globMd('agents');
  for (const rel of files) hasFrontmatterField(rel, 'description');
  return files.length ? `${files.length} agent(s) checked` : 'no agents/ yet';
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

check('install.sh parses (sh -n)', () => {
  mustExist('install.sh');
  execFileSync('sh', ['-n', path.join(ROOT, 'install.sh')], { stdio: 'pipe' });
});

let failed = 0;
for (const r of results) {
  failed += r.ok ? 0 : 1;
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
console.log(`${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
