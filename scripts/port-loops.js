#!/usr/bin/env node
// port-loops.js — F9: mechanical frontmatter transform for the commands/agents that ship the five
// loops, ported to OpenCode, Kilo Code, and Pi (via the pi-subagents extension). install.sh does the
// gating/UX (interactive prompts, --skip-subagent-check); this file only knows how to read the
// Claude Code schema and write the target's own schema. No YAML dependency: every frontmatter line
// in commands/*.md and agents/*.md is a flat `key: value` pair (verified against the whole corpus
// before this file was written) — a line without a `:` is refused rather than guessed at.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

function parseFrontmatter(src) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(src);
  if (!m) throw new Error('missing or malformed --- frontmatter block');
  const [, fmBlock, body] = m;
  const fm = [];
  for (const line of fmBlock.split('\n')) {
    if (!line.trim()) continue;
    const idx = line.indexOf(':');
    if (idx === -1) {
      throw new Error(`frontmatter line has no ':' — this parser only reads flat key: value pairs, `
        + `not multi-line YAML: "${line}"`);
    }
    fm.push([line.slice(0, idx).trim(), line.slice(idx + 1).trim()]);
  }
  return { fm, body };
}

// `value` is either a plain string (single-line `key: value`) or a plain object, serialized as a
// one-level-deep nested block (`permission:` is the only field this port ever nests).
function serializeFrontmatter(pairs, body) {
  const lines = [];
  for (const [k, v] of pairs) {
    if (v && typeof v === 'object') {
      lines.push(`${k}:`);
      for (const [pk, pv] of Object.entries(v)) lines.push(`  ${pk}: ${pv}`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  return `---\n${lines.join('\n')}\n---\n${body}`;
}

const get = (fm, key) => (fm.find(([k]) => k === key) || [])[1];

// Claude Code tool token -> destination tool id per target family. Only tokens this repo's own
// commands/agents actually declare are listed (verified against every commands/*.md and agents/*.md
// in this repo, 2026-07-12); a token outside this map is dropped, not guessed at — a fabricated tool
// id fails silently at the target's own resolution step, a dropped one is reported by this script.
//   permission: the OpenCode/Kilo Code `permission:` key this tool gates (both share the same
//     vocabulary — verified against opencode.ai/docs/agents and kilo.ai/docs/customize/agent-permissions,
//     2026-07-12).
//   pi: the pi-subagents `tools:` builtin id (verified against github.com/nicobailon/pi-subagents
//     README, 2026-07-12). `null` = no verified equivalent.
const TOOL_MAP = {
  Read: { permission: 'read', pi: 'read' },
  Write: { permission: 'edit', pi: 'write' },
  Edit: { permission: 'edit', pi: 'edit' },
  Grep: { permission: 'grep', pi: 'grep' },
  Glob: { permission: 'glob', pi: null },
  Bash: { permission: 'bash', pi: 'bash' },
  Task: { permission: 'task', pi: 'subagent' },
  WebSearch: { permission: 'websearch', pi: null },
  AskUserQuestion: { permission: 'question', pi: null },
};

// "Task, Read, Bash(git diff:*), Bash(mkdir:*)" -> ["Task", "Read", "Bash", "Bash"]. The `Bash(pattern:*)`
// per-command sub-scoping Claude Code supports has no destination in either target's `permission`/`tools`
// vocabulary (both gate whole categories, not individual shell commands) — collapsed to the base token.
function parseToolList(raw) {
  return raw.split(',').map((t) => t.trim().replace(/\(.*\)$/, '')).filter(Boolean);
}

// OpenCode and Kilo Code share one schema for both commands and agents (verified against
// opencode.ai/docs/commands, opencode.ai/docs/agents, and kilo.ai/docs/customize/{workflows,custom-subagents},
// 2026-07-12 — Kilo Code's newer engine mirrors OpenCode's config shape field for field).

// A command's ONLY carried field is `description`. `argument-hint` is Claude Code's `/command`
// autocomplete hint and has no OpenCode/Kilo Code equivalent.
//
// `allowed-tools` has no destination on a COMMAND in either target — permission lives on the AGENT
// schema there, not the command (see transformAgentOpenCodeKilo).
//
// `disable-model-invocation` — Claude Code's auto-dispatch veto, and the ONLY thing standing between
// the model and firing /review-loop, /iterate or /session-review on its own — has no equivalent field
// in either target. It is DROPPED, and dropping it is a real loss of a guardrail, not a formatting
// detail: two of those loops are token-hungry (cost) and the third analyses the human (consent). This
// function reports it as a dropped field so install.sh can warn about it at the point of install, and
// README §Compatibility carries the standing caveat. Neither target offers anything to translate it
// into; the honest move is to say so, loudly, in both places.
const COMMAND_DROPPED_GUARDRAIL = 'disable-model-invocation';

function transformCommandOpenCodeKilo(fm) {
  const description = get(fm, 'description');
  if (!description) throw new Error('command missing description');
  const dropped = [];
  if (get(fm, COMMAND_DROPPED_GUARDRAIL)) dropped.push(COMMAND_DROPPED_GUARDRAIL);
  return { fm: [['description', description]], dropped };
}

function transformAgentOpenCodeKilo(fm) {
  const description = get(fm, 'description');
  const model = get(fm, 'model');
  const toolsRaw = get(fm, 'tools');
  if (!description) throw new Error('agent missing description');
  const out = [['description', description], ['mode', 'subagent']];
  // `model` is carried verbatim — it is still the Claude Code short alias (sonnet/fable/opus), which
  // neither OpenCode nor Kilo can resolve: they want a `provider/model` id. Without `--lineup` (F11)
  // re-stamping this line, the field is an unresolvable placeholder, not a working pin. README
  // §Option 4 says so and tells the reader to run --lineup; the field is kept rather than omitted
  // because --lineup's re-stamp is a `sed` on an existing `^model:` line, and omitting it here would
  // leave --lineup with nothing to stamp.
  if (model) out.push(['model', model]);
  const permission = {};
  const dropped = [];
  if (toolsRaw) {
    for (const t of parseToolList(toolsRaw)) {
      const mapped = TOOL_MAP[t];
      if (mapped && mapped.permission) permission[mapped.permission] = 'allow';
      else dropped.push(t);
    }
  }
  if (Object.keys(permission).length) out.push(['permission', permission]);
  return { fm: out, dropped };
}

// Pi's agents (via the pi-subagents extension) do not fit the OpenCode/Kilo schema at all — `name` is
// required (Pi's discovery keys agents by filename AND frontmatter `name`), and there is no `mode` or
// `permission` field, just a flat `tools:` allowlist (verified against
// github.com/nicobailon/pi-subagents README "Agent frontmatter" section, 2026-07-12).
function transformAgentPi(fm) {
  const name = get(fm, 'name');
  const description = get(fm, 'description');
  const model = get(fm, 'model');
  const toolsRaw = get(fm, 'tools');
  if (!name) throw new Error('agent missing name (required by pi-subagents agent frontmatter)');
  if (!description) throw new Error('agent missing description');
  const out = [['name', name], ['description', description]];
  const dropped = [];
  if (toolsRaw) {
    const mapped = [...new Set(parseToolList(toolsRaw).map((t) => TOOL_MAP[t] && TOOL_MAP[t].pi)
      .filter((v, i, arr) => { if (v) return true; dropped.push(parseToolList(toolsRaw)[i]); return false; }))];
    if (mapped.length) out.push(['tools', mapped.join(', ')]);
  }
  // Same unresolvable-alias caveat as the OpenCode/Kilo transform above, and the same reason for
  // keeping the field: --lineup re-stamps `^model:` in place, so an omitted line is an unstampable one.
  if (model) out.push(['model', model]);
  // Every one of this repo's agents receives ONLY the artifacts named in its prompt, never the
  // conversation that produced them (the independence property every critic/scorer prompt states
  // explicitly) — the same contract Claude Code's Task tool already enforces by always starting
  // subagents fresh. `defaultContext: fresh` is the pi-subagents field that encodes exactly that,
  // not a guessed default.
  out.push(['defaultContext', 'fresh']);
  return { fm: out, dropped };
}

// Pi's own slash-command mechanism IS prompt templates (`.pi/prompts/*.md`, discovered per
// docs/prompt-templates.md of @earendil-works/pi-coding-agent — verified 2026-07-13). "Pi has no Task
// tool" (true) was read, in F9, as "the loop commands cannot port to Pi" — that inference was wrong: a
// prompt template's body is just instructions to whatever session expands it, and a session with the
// pi-subagents extension installed has the `subagent` tool. pi-subagents ships its own loop prompt
// template this way (`prompts/review-loop.md` in the pi-subagents package, invoked as `/review-loop`) —
// that file is this port's reference for both the frontmatter shape and the body's dispatch vocabulary.
// So commands DO cross to Pi now, gated on the same extension the agents already require.
// A prompt template's frontmatter carries `description` AND `argument-hint` — the hint renders before
// the description in Pi's autocomplete dropdown (docs/prompt-templates.md, "Argument Hints"). Both are
// ported. `allowed-tools` has no destination (a prompt template borrows whatever tools the expanding
// session already has — it does not gate them per-template) and `disable-model-invocation` has no
// destination either — but unlike the OpenCode/Kilo transform, dropping the latter is NOT reported as a
// lost guardrail: a prompt template only ever expands when something types `/name` in the editor or
// passes it through the SDK/RPC `prompt` path (docs/usage.md:34, docs/rpc.md:765) — never as a tool call
// the model itself can make. Verified against Pi's built-in tool list (docs/usage.md:208:
// read/bash/edit/write/grep/find/ls, no command-invocation tool) and the pi-subagents tool surface (its
// README's full tool-call reference has no "run this prompt template" action) — nothing lets the model
// fire one on its own. So neither field is tracked in `dropped`: nothing here used to work and now does not.
//
// $ARGUMENTS is NOT rewritten. It is a real, working substitution in Pi's own prompt-template engine
// ("$@ or $ARGUMENTS for all args joined", docs/prompt-templates.md) — every one of this repo's commands
// already uses it (`Artifacts under review: **$ARGUMENTS**`, etc.) and it resolves in Pi exactly as it
// does in Claude Code. Left untouched, on purpose.
const PI_COMMAND_DROPPED_FIELDS = ['allowed-tools', 'disable-model-invocation'];

// Pi's prompt-template loader parses frontmatter as STRICT YAML and drops a file that fails to parse —
// silently, with no error, no log line: the template simply never appears in `/`-autocomplete. Three of
// this repo's descriptions contain an inline `: ` (`Cost: medium`, `converge: the`, `keep. Cost:`), which
// in a plain YAML scalar is a mapping indicator, not text — so `/orchestrate`, `/iterate` and
// `/skill-loop` were written to disk and then thrown away by the loader. Measured, not reasoned:
// `pi --mode rpc` + `get_commands` listed only 2 of the 5 as `source: "prompt"` until these values were
// quoted. Every Pi frontmatter value this port emits is therefore a double-quoted YAML scalar.
//
// pi-subagents' AGENT loader is a different, lenient line-based parser (its src/agents/frontmatter.ts
// matches `^([\w-]+):\s*(.*)$` and takes the rest of the line verbatim), so agents/*.md — one of which
// has the same inline `: ` — are unaffected and are left unquoted.
const yamlQuote = (v) => JSON.stringify(String(v));

// session-review does NOT port to Pi, and this is the honest half of the port rather than a gap in it.
// Its step 1 shells out to `node "${CLAUDE_PLUGIN_ROOT}/scripts/loop-stats.js"` — a variable that only
// exists inside the Claude Code plugin runtime, pointing at a script `--target pi` does not install —
// and its data source is the transcripts Claude Code writes (its own description says so), not Pi's
// sessions, which live elsewhere in a different format. Ported, it would be a template that looks like a
// working loop and dies on its first command. That is precisely the failure mode this port refuses.
const PI_UNPORTABLE_COMMANDS = new Set(['session-review']);

// Task-tool-specific body text, replaced with the pi-subagents `subagent` tool's own vocabulary — every
// pair below is a literal substring verified against commands/*.md, 2026-07-13. A pair that matches
// nothing in a given file is simply a no-op there; nothing here touches $ARGUMENTS, rounds, stop
// conditions, findings aggregation, or any of the orchestration logic itself.
const PI_COMMAND_BODY_SUBSTITUTIONS = [
  // orchestrate.md, review-loop.md, skill-loop.md: "launch N in one message, N Task calls" (Claude
  // Code needs N separate tool_use blocks to run them in parallel). pi-subagents runs an array of
  // `tasks` inside ONE `subagent` call in parallel (see its README's "Parallel" example) — a closer
  // match to "must run in parallel, must not see each other" than N separate calls would even be.
  ['one message, four Task calls', 'one `subagent` call with four parallel tasks'],
  ['one message, five Task calls', 'one `subagent` call with five parallel tasks'],
  // orchestrate.md, review-loop.md: the seat table's column header names the Claude Code Task
  // parameter (`subagent_type`); pi-subagents' equivalent parameter is `agent`.
  ['| subagent_type | seat |', '| agent | seat |'],
  // iterate.md: same header, different table shape (sequential seats, not a parallel panel).
  ['`subagent_type`', '`agent`'],
  // orchestrate.md, review-loop.md, iterate.md: the project-defined fallback agent's file path.
  ['.claude/agents/implementer.md', '.pi/agents/implementer.md'],
  // orchestrate.md, review-loop.md, iterate.md: "...as the harness reported it when each Task
  // returned."
  ['it when each Task returned.', 'it when each subagent run returned.'],
  // skill-loop.md: same fact, wrapped across a line so it needs its own pair.
  ['when its Task\nreturns:', 'when its subagent run\nreturns:'],
  // skill-loop.md: AskUserQuestion has no Pi builtin or pi-subagents equivalent (neither tool map lists
  // one) — Pi is an interactive session by default, so asking the human is just the next reply, not a
  // dedicated tool call.
  ['confirm them with **AskUserQuestion**\nbefore spending a token',
    'confirm them with the human directly — ask in your reply and wait for their answer\nbefore spending a token'],
  // session-review.md: a single Task call to one agent, not a table row.
  ['Send **one** `Task` to a single agent', 'Run **one** `subagent` call to a single agent'],
  // orchestrate.md, review-loop.md: both shell out to the plugin's own loop-gate.js — the deterministic
  // seam that refuses a seat's malformed findings and refuses to guess a half-written run's state. No
  // target but Claude Code installs this repo's scripts/, and `${CLAUDE_PLUGIN_ROOT}` is a Claude Code
  // plugin-runtime variable that expands to nothing anywhere else. Ported verbatim, both blocks would be
  // a command that looks like a gate and silently does nothing — the exact failure this port refuses (it
  // is why /session-review is withheld outright). Degraded to the hand-check instead, and disclosed:
  // README §Compatibility carries the capability row, and HARNESS_CAPABILITIES below is its authority.
  ['```bash\nnode "${CLAUDE_PLUGIN_ROOT:-.claude}/scripts/loop-gate.js" resume docs/harness-dev/loop-runs/<run-slug>/\n```',
    '```text\nThis target does not install the plugin\'s loop-gate.js. Check the run directory by hand:\nlist docs/harness-dev/loop-runs/<run-slug>/ and read the round-<n>.json files it holds. Rounds must\nbe the contiguous sequence 1..n; a gap, an unreadable file, or an aggregate JSON already present is\nAMBIGUOUS_RUN_STATE — stop and hand it to the human rather than reconciling it yourself.\n```'],
  ['```bash\nnode "${CLAUDE_PLUGIN_ROOT:-.claude}/scripts/loop-gate.js" check-findings <file> --root . --seat <seat>\n```',
    '```text\nThis target does not install the plugin\'s loop-gate.js. Check each seat\'s JSON by hand against the\ncontract in its agent file: the fixed severity ladder (blocker|major|minor), a "file" that exists in\nthe repo, a "line" inside that file (0 = file-wide), a non-empty summary and fix, and no "id" or\n"critic" the seat assigned itself. This is a real loss: the checks are mechanical, and a chair doing\nthem by eye is the party the gate existed to be independent of.\n```'],
];

function transformCommandPi(fm, body) {
  const description = get(fm, 'description');
  if (!description) throw new Error('command missing description');
  const out = [['description', yamlQuote(description)]];
  // The source may already quote it ("[max-iterations, default 5]"); strip that before re-quoting, or
  // the emitted value is a YAML string whose own content is a pair of quotes.
  const hint = get(fm, 'argument-hint');
  if (hint) out.push(['argument-hint', yamlQuote(hint.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1'))]);
  let outBody = body;
  for (const [from, to] of PI_COMMAND_BODY_SUBSTITUTIONS) outBody = outBody.split(from).join(to);
  return { fm: out, dropped: [], body: outBody };
}

// What the port DESTROYS, per target, as data — because until now the same facts lived in three places
// that had no way to disagree out loud: this file's transforms, install.sh's echo blocks, and README
// §Compatibility. Three copies of a caveat drift, and the one that drifts is always the one the user
// reads. So the table is the authority: install.sh prints it (`--capabilities <target>`) instead of
// hardcoding its own wording, and validate.js binds every row to the README prose that has to disclose
// it. Adding a row here fails the gate until the README carries it too.
//
// `readmeMarker` is a regex source, matched against README §Compatibility — not against the whole file.
// A caveat that is technically present three sections away from the install instructions is a caveat
// hidden from the person who needs it.
//
// Only losses the PORT causes belong here. Claude Code-only conveniences the port never touches (the
// hooks, the dashboard) are documented in the README and are not this table's subject.
const CAP_MODEL_ALIAS = {
  id: 'model-alias',
  readmeMarker: 'model:',
  warning: [
    "⚠ The 'model:' line in each ported agent is still a Claude alias (sonnet/fable/opus), which this",
    '  target cannot resolve. Re-run with --lineup to stamp real provider/model ids, or edit by hand.',
  ],
};

const CAP_LOOP_GATE = {
  id: 'loop-gate',
  readmeMarker: 'loop-gate',
  warning: [
    '⚠ /orchestrate and /review-loop lose their deterministic gate. On Claude Code both shell out to',
    "  the plugin's scripts/loop-gate.js, which refuses a seat's findings when they anchor at a file",
    '  that does not exist or a line past the end of one, recomputes the score from the criteria table,',
    '  and refuses to guess the state of a half-written run. This target installs no scripts/, so those',
    '  steps are ported as hand-checks the chair performs on itself — which is the party the gate was',
    '  independent of. The rounds still run; the arithmetic and the anchor checks are no longer verified.',
  ],
};

const OPENCODE_KILO_LOST = [
  {
    id: 'manual-only-veto',
    readmeMarker: 'disable-model-invocation',
    warning: [
      '⚠ The manual-only guardrail does NOT cross over. In Claude Code, /review-loop,',
      "  /iterate and /session-review ship with 'disable-model-invocation: true' — the model",
      '  may suggest them, never fire them. Neither OpenCode nor Kilo Code has an equivalent',
      '  field, so on this target all three are auto-dispatchable by the model: two of them',
      '  are token-hungry, and /session-review analyses YOU. Put the restriction in your',
      '  AGENTS.md and check it holds — nothing enforces it locally anymore.',
    ],
  },
  {
    id: 'allowed-tools',
    readmeMarker: 'allowed-tools',
    warning: [
      "⚠ SKILL.md's 'allowed-tools' is ignored by this target, silently — no error, no log line.",
      '  Any skill whose safety story leans on that field loses the guardrail the moment it crosses.',
    ],
  },
  CAP_MODEL_ALIAS,
  CAP_LOOP_GATE,
];

const HARNESS_CAPABILITIES = {
  opencode: { label: 'OpenCode', lost: OPENCODE_KILO_LOST },
  'kilo-loops': { label: 'Kilo Code', lost: OPENCODE_KILO_LOST },
  pi: {
    label: 'Pi',
    // Pi does NOT lose the manual-only veto — a prompt template only expands on a typed /name, so the
    // guarantee holds with no field to carry it. A row here would be a caveat about nothing.
    //
    // /session-review's withholding is also absent on purpose, and it is the one loss with a mechanism
    // of its own already: run() reports it per file at port time from PI_UNPORTABLE_COMMANDS, and
    // validate.js binds that same constant to the README. A row here would print it a second time —
    // and two mechanisms disclosing one fact is how they start disagreeing.
    lost: [
      {
        id: 'websearch-correctness',
        readmeMarker: 'correctness-critic[\\s\\S]{0,300}WebSearch',
        warning: [
          '⚠ correctness-critic lost WebSearch (pi-subagents has no verified equivalent builtin).',
          '  Its whole job is checking claims against the web; on Pi it cannot. Install',
          '  pi-web-access and add its tools to that agent\'s frontmatter, or do not rely on it here.',
        ],
      },
      {
        id: 'model-alias',
        readmeMarker: 'model:`? line is still a Claude Code alias on Pi',
        warning: [
          "⚠ The 'model:' line in each ported agent (and none of the commands, which carry no",
          '  model: field) is still a Claude alias (sonnet/fable/opus), which pi-subagents cannot',
          '  resolve. Re-run with --lineup to stamp real provider/model ids, or edit by hand.',
        ],
      },
      CAP_LOOP_GATE,
    ],
  },
};

function capabilityReport(target) {
  const cap = HARNESS_CAPABILITIES[target];
  if (!cap) throw new Error(`port-loops.js: no capability data for target '${target}'`);
  return cap.lost.map((l) => l.warning.join('\n')).join('\n\n');
}

function destDirsFor(target) {
  switch (target) {
    case 'opencode': return { commands: '.opencode/commands', agents: '.opencode/agents' };
    case 'kilo-loops': return { commands: '.kilo/commands', agents: '.kilo/agents' };
    case 'pi': return { commands: '.pi/prompts', agents: '.pi/agents' };
    default: throw new Error(`port-loops.js: unknown target '${target}' (use opencode|kilo-loops|pi)`);
  }
}

// Drops are reported PER FILE, never as one aggregated set: "dropped: WebSearch" tells a user that
// some capability went missing somewhere, which is not actionable. "correctness-critic.md: WebSearch"
// tells them the fact-checking critic — the one whose entire job is verifying claims against the web —
// can no longer reach the web on this target. Same information, and only one of the two can be acted on.
function portDir(srcDir, destDir, transform, skip = new Set()) {
  fs.mkdirSync(destDir, { recursive: true });
  const files = fs.readdirSync(srcDir)
    .filter((f) => f.endsWith('.md') && !skip.has(path.basename(f, '.md'))).sort();
  const dropped = [];
  for (const f of files) {
    const { fm, body } = parseFrontmatter(fs.readFileSync(path.join(srcDir, f), 'utf8'));
    // `transform` always receives (fm, body) — the OpenCode/Kilo/Pi-agent transforms only touch fm and
    // return no `.body`, so they fall back to the untouched source body below. transformCommandPi is
    // the only transform that also rewrites `.body` (Task-tool vocabulary -> subagent vocabulary).
    const result = transform(fm, body);
    if (result.dropped.length) dropped.push({ file: f, fields: result.dropped });
    fs.writeFileSync(path.join(destDir, f), serializeFrontmatter(result.fm, result.body !== undefined ? result.body : body));
  }
  return { count: files.length, dropped };
}

function run(target, root) {
  const dest = destDirsFor(target);
  const dropped = [];
  const skipped = [];
  let commandCount = 0;
  if (dest.commands) {
    const commandTransform = target === 'pi' ? transformCommandPi : transformCommandOpenCodeKilo;
    const skip = target === 'pi' ? PI_UNPORTABLE_COMMANDS : new Set();
    const r = portDir(path.join(root, 'commands'), dest.commands, commandTransform, skip);
    commandCount = r.count;
    dropped.push(...r.dropped);
    skipped.push(...skip);
  }
  const agentTransform = target === 'pi' ? transformAgentPi : transformAgentOpenCodeKilo;
  const agentResult = portDir(path.join(root, 'agents'), dest.agents, agentTransform);
  dropped.push(...agentResult.dropped);
  return { commandCount, agentCount: agentResult.count, dropped, skipped };
}

function main() {
  const argv = process.argv.slice(2);
  const opt = (name, def) => { const i = argv.indexOf(name); return i === -1 || i === argv.length - 1 ? def : argv[i + 1]; };
  const target = opt('--target', null);
  const root = opt('--root', process.cwd());
  // install.sh's loss warnings are this table read aloud, not a second copy of it.
  const capTarget = opt('--capabilities', null);
  if (capTarget) {
    try {
      process.stdout.write(`${capabilityReport(capTarget)}\n`);
    } catch (e) {
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    }
    return;
  }
  if (!target) {
    process.stderr.write('usage: port-loops.js --target <opencode|kilo-loops|pi> [--root <repoRoot>]\n'
      + '       port-loops.js --capabilities <opencode|kilo-loops|pi>\n');
    process.exit(1);
  }
  try {
    const { commandCount, agentCount, dropped, skipped } = run(target, root);
    process.stdout.write(`✓ ported ${commandCount} command(s) + ${agentCount} agent(s) to ${target}\n`);
    for (const name of skipped) {
      process.stdout.write(`⚠ /${name} NOT ported to ${target}: it shells out to `
        + '`${CLAUDE_PLUGIN_ROOT}/scripts/loop-stats.js` (a Claude Code plugin-runtime variable, and a\n'
        + `    script this target does not install) and reads Claude Code's transcripts, not ${target}'s\n`
        + '    sessions. Ported, it would look like a working loop and die on its first command.\n');
    }
    if (dropped.length) {
      process.stdout.write('⚠ fields with no equivalent on this target, dropped per file:\n');
      for (const { file, fields } of dropped) {
        process.stdout.write(`    ${file}: ${fields.join(', ')}\n`);
      }
    }
  } catch (e) {
    process.stderr.write(`port-loops.js: ${e.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  parseFrontmatter, serializeFrontmatter, transformCommandOpenCodeKilo, transformAgentOpenCodeKilo,
  transformAgentPi, transformCommandPi, PI_COMMAND_DROPPED_FIELDS, PI_COMMAND_BODY_SUBSTITUTIONS,
  PI_UNPORTABLE_COMMANDS, destDirsFor, TOOL_MAP, parseToolList, run,
  HARNESS_CAPABILITIES, capabilityReport,
};
