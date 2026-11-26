#!/usr/bin/env node
// harness-panel — one readable page that answers "is the harness helping?", built from files already on
// this machine: the Claude Code transcripts, the gate log, and an optional quota snapshot. Zero tokens,
// no model. It counts; it never quotes a prompt, so the page can be shown to someone else.
//
//   node harness-panel.js [--since 60d] [--lang en|es] [--out <file>] [--open] [--web-fonts]
//                         [--quota-file <json>] [--no-coach] [--json]
//
// The coach notes: ~/.claude/harness-coach.json (HARNESS_COACH_FILE) holds what a model wrote after reading how
// the operator worked that week — { generatedAt, period, insights: [{ title, evidence, action, snippet, kind }] }.
// This script only renders that file; writing it costs a model call and is someone else's job. The notes may
// paraphrase the operator's prompts, so --no-coach leaves them out of a page meant for other eyes.
//
// --web-fonts adds one Google Fonts stylesheet link (the only network request the page can make, and it
// carries no data). Without it the page uses the fonts installed on the machine.
// --quota-file: a JSON snapshot { at, rate_limits: { seven_day: { used_percentage, resets_at } } }, the
// shape Claude Code hands a statusline. HARNESS_QUOTA_FILE sets it too.
//
// What the numbers are not: a comparison with a session that had no harness. They say what the harness
// did (caught, delivered, blocked) and how the operator worked, from what was logged.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i === -1 ? undefined : argv[i + 1]; };
const has = (n) => argv.includes(n);
const HOME = os.homedir();
const DAYS = Number.parseInt(flag('--since') || '60', 10) || 60;
const LANG = flag('--lang') === 'es' ? 'es' : 'en';
const NOW = Date.now();
const CUTOFF = NOW - DAYS * 86400000;
const PROJECTS = process.env.HARNESS_PROJECTS_DIR || path.join(HOME, '.claude', 'projects');
const GATE_LOG = process.env.HARNESS_GATE_LOG || path.join(HOME, '.claude', 'gate-log.ndjson');
const QUOTA = flag('--quota-file') || process.env.HARNESS_QUOTA_FILE;
const COACH = process.env.HARNESS_COACH_FILE || path.join(HOME, '.claude', 'harness-coach.json');
const OUT = flag('--out') || path.join(process.env.XDG_CACHE_HOME || path.join(HOME, '.cache'), 'harness-audit', 'panel', 'index.html');

// ---- read ---------------------------------------------------------------------------------------
const norm = (s) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim();
const clean = (s) => s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>|<task-notification>[\s\S]*?<\/task-notification>|<([a-z-]+)>[\s\S]*?<\/\1>|\[Image[^\]]*\]/g, ' ').trim();
const CONTINUE = /^(dale|continua|sigue|ok|okay|vale|si|listo|go on|continue|yes|go|proceed|keep going|vas y|oui|d accord)\b/;
const CORRECT = /^no\b|te dije|ya te|otra vez|no era eso|no es lo que|i said|not what i|that s wrong|again\b|je t ai dit/;
const STATUS = /como vamos|como va\b|avisame cuando|how is it going|any update|status\?|ou en est/;
const SIMPLER = /no entend|mas simple|explicame|i m lost|simpler|plus simple/;
const HARNESS_COMMANDS = ['harness-audit', 'dashboard-harness', 'session-review', 'iterate', 'orchestrate', 'review-loop', 'skill-loop', 'develop-phase', 'develop-spec'];

const d = {
  sessions: 0, prompts: 0, continuations: 0, correctionSessions: new Set(), statusAsks: 0, simplerSessions: new Set(), modelSwitches: 0,
  skills: new Map(), commands: new Map(), specRuns: new Map(), plans: new Map(), gateBlocksSeen: 0,
};
const bump = (m, k, n = 1) => m.set(k, (m.get(k) || 0) + n);

function scanFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  d.sessions += 1;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (j.isSidechain || j.isMeta) continue;
    const raw = j.message && j.message.content;
    // A typed prompt arrives as a string or as text blocks; a tool result has no text block and is not a prompt.
    const c = j.type === 'user' && Array.isArray(raw) ? raw.filter((b) => b && b.type === 'text').map((b) => b.text || '').join(' ') : raw;
    if (j.type === 'user' && typeof c === 'string') {
      for (const m of c.matchAll(/<command-name>\/?([^<]+)<\/command-name>/g)) {
        const name = m[1].trim().split(':').pop();
        if (name === 'model') d.modelSwitches += 1;
        bump(d.commands, name);
      }
      const note = /<task-notification>[\s\S]*?<task-id>(.*?)<\/task-id>[\s\S]*?<result>([\s\S]*)<\/result>/.exec(c);
      if (note && !d.specRuns.has(note[1])) {
        let r = null;
        try { r = JSON.parse(note[2]); } catch { /* a result that is not JSON is not a waves run */ }
        if (r && r.handoff && (r.plan || r.brief)) d.specRuns.set(note[1], r);
      }
      const p = clean(c);
      if (!p || p.startsWith('Base directory for this skill') || p.startsWith('[Request interrupted') || p.includes('SYSTEM NOTIFICATION')) continue;
      d.prompts += 1;
      const n = norm(p).slice(0, 300);
      if (n.length <= 30 && CONTINUE.test(n)) d.continuations += 1;
      if (CORRECT.test(n)) d.correctionSessions.add(file);
      if (STATUS.test(n)) d.statusAsks += 1;
      if (SIMPLER.test(n)) d.simplerSessions.add(file);
    } else if (Array.isArray(c)) {
      for (const b of c) {
        if (!b || b.type !== 'tool_use') continue;
        if (b.name === 'Skill' && b.input && b.input.skill) { const s = String(b.input.skill).split(':').pop(); bump(d.skills, s); bump(d.commands, s); }
        if (b.name === 'Workflow' && b.input) { const n = String(b.input.name || path.basename(String(b.input.scriptPath || ''), '.js')).split(':').pop(); if (n) bump(d.commands, n); }
      }
    }
  }
}

let dirs = [];
try { dirs = fs.readdirSync(PROJECTS, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { /* no transcripts on this machine */ }
for (const dir of dirs) {
  let files = [];
  try { files = fs.readdirSync(path.join(PROJECTS, dir.name)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
  for (const f of files) {
    const full = path.join(PROJECTS, dir.name, f);
    try { if (fs.statSync(full).mtimeMs >= CUTOFF) scanFile(full); } catch { /* unreadable: skipped */ }
  }
}

// ---- waves runs -----------------------------------------------------------------------------------
const CAUSES = [
  ['preflight', /Preflight (failed|skipped)|preflight .* (fails|skips)/i, false],
  ['setup', /not found|worktree not ready|does not exist|did not start|nothing ran/i, false],
  ['review', /\[FAIL\]/, true],
  ['dead', /half-finished/i, false],
  ['conflict', /not merged/i, false],
  ['ticket', /BLOCKER/, true],
];
const spec = { runs: 0, landed: 0, blocked: 0, causes: Object.fromEntries(CAUSES.map(([k]) => [k, 0])), widths: new Map(), plans: 0, tickets: 0, withBlocker: 0 };
for (const r of d.specRuns.values()) {
  const plan = r.plan;
  if (plan && Array.isArray(plan.waves) && plan.waves.length) {
    const key = `${plan.root}|${JSON.stringify(plan.waves)}`;
    if (!d.plans.has(key)) {
      d.plans.set(key, true); spec.plans += 1;
      const byId = new Map((plan.tickets || []).map((t) => [t.id, t]));
      for (const w of plan.waves) { bump(spec.widths, Math.min(w.length, 4)); for (const id of w) { spec.tickets += 1; if ((byId.get(id)?.blockedBy || []).length) spec.withBlocker += 1; } }
    }
  }
  const m = /^(\d+) landed, (\d+) blocked/.exec(String(r.handoff.summary || ''));
  if (m) {
    spec.runs += 1; spec.landed += Number(m[1]); spec.blocked += Number(m[2]);
    for (const part of String(r.handoff.blocker || '').split(' · ')) { const hit = CAUSES.find(([, re]) => re.test(part)); if (hit) spec.causes[hit[0]] += 1; }
  } else if (r.handoff.status === 'complete') {
    spec.runs += 1; spec.landed += Number((/Landed \((\d+)\)/.exec(String(r.brief || '')) || [0, 0])[1]);
  }
}
const waves = [...spec.widths.values()].reduce((a, b) => a + b, 0);

// ---- gate log ---------------------------------------------------------------------------------------
const gate = { repos: new Map(), catches: 0, fixed: 0, first: null };
try {
  for (const line of fs.readFileSync(GATE_LOG, 'utf8').split('\n')) {
    if (!line) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    const t = Date.parse(r.ts); if (!(t >= CUTOFF)) continue;
    if (!gate.first || t < gate.first) gate.first = t;
    const s = gate.repos.get(r.repo) || { catches: 0, open: false };
    if (r.result === 'green') { if (s.open) { gate.fixed += 1; s.open = false; } }
    else if (r.result === 'blocked') { if (!s.open) { s.catches += 1; gate.catches += 1; } s.open = true; }
    else if (r.result === 'gave-up') s.open = false;
    gate.repos.set(r.repo, s);
  }
} catch { /* no gate log yet */ }

// ---- quota ---------------------------------------------------------------------------------------
let quota = null;
try {
  const w = JSON.parse(fs.readFileSync(QUOTA, 'utf8')).rate_limits.seven_day;
  const left = w.resets_at * 1000 - NOW;
  if (typeof w.used_percentage === 'number' && left > 0 && left <= 7 * 86400000) {
    const elapsed = Math.round((1 - left / (7 * 86400000)) * 100);
    quota = { used: Math.round(w.used_percentage), elapsed, ahead: Math.round(w.used_percentage) - elapsed, daysLeft: Math.round(left / 8640000) / 10 };
  }
} catch { /* no snapshot: the card is left out */ }

// ---- coach notes ---------------------------------------------------------------------------------------
let coach = null;
if (!has('--no-coach')) {
  try {
    const c = JSON.parse(fs.readFileSync(COACH, 'utf8'));
    const insights = (Array.isArray(c.insights) ? c.insights : []).filter((i) => i && typeof i.title === 'string' && typeof i.action === 'string').slice(0, 6);
    if (insights.length) coach = { insights, period: String(c.period || ''), ageDays: Math.max(0, Math.floor((NOW - Date.parse(c.generatedAt)) / 86400000)) };
  } catch { /* no notes yet: the section is left out */ }
}

// ---- derived ---------------------------------------------------------------------------------------
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const topSkills = [...d.skills.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
const unused = HARNESS_COMMANDS.filter((c) => !d.commands.get(c));
const perWave = waves ? spec.tickets / waves : 0;
const friction = CAUSES.filter(([, , working]) => !working).reduce((n, [k]) => n + spec.causes[k], 0);
const working = CAUSES.filter(([, , w]) => w).reduce((n, [k]) => n + spec.causes[k], 0);
const data = {
  days: DAYS, sessions: d.sessions, prompts: d.prompts, continuations: d.continuations, continuationPct: pct(d.continuations, d.prompts),
  correctionSessions: d.correctionSessions.size, statusAsks: d.statusAsks, simplerSessions: d.simplerSessions.size, modelSwitches: d.modelSwitches,
  spec: { runs: spec.runs, landed: spec.landed, blocked: spec.blocked, causes: spec.causes, friction, working, plans: spec.plans, waves, perWave: Math.round(perWave * 10) / 10,
    widths: [1, 2, 3, 4].map((w) => spec.widths.get(w) || 0), tickets: spec.tickets, withBlocker: spec.withBlocker },
  gate: { catches: gate.catches, fixed: gate.fixed, since: gate.first ? new Date(gate.first).toISOString().slice(0, 10) : null, repos: [...gate.repos.entries()].map(([repo, s]) => [repo, s.catches]).filter(([, n]) => n).sort((a, b) => b[1] - a[1]).slice(0, 5) },
  topSkills, unused, quota, coach: coach ? { insights: coach.insights.length, ageDays: coach.ageDays } : null,
};
if (has('--json')) { console.log(JSON.stringify(data, null, 2)); process.exit(0); }

// ---- words ---------------------------------------------------------------------------------------
const T = {
  en: {
    eyebrow: (n) => `Harness · last ${n} days`, title: 'Is my harness<br>helping me?', updated: (s) => `Updated ${new Date(NOW).toISOString().slice(0, 10)} · ${s} sessions`,
    delivered: 'Tickets delivered', deliveredSub: (l, b) => `of ${l + b} worked. ${b} were blocked.`, noRuns: 'No waves run in this window.',
    caught: 'Failures the gate caught', caughtSub: (f, s) => `${f} fixed before the turn ended. Logged since ${s}.`, noGate: 'The gate log is empty: it starts counting on the next red gate.',
    perWave: 'Tickets per wave', perWaveSub: (one, all) => `${one} of ${all} waves hold a single ticket.`, noPlans: 'No waves plan in this window.',
    cont: 'Prompts that only say "go on"', contSub: (a, b) => `${a} of ${b} prompts.`,
    coach: 'What I noticed in how you work', coachBy: (p, a) => `From your sessions${p ? `, ${p}` : ''}. Written ${a === 0 ? 'today' : `${a} day(s) ago`}.`, coachStale: 'These notes are more than a week old.', evidence: 'What I saw', action: 'What I would change', kinds: { rule: 'Rule to paste', command: 'Command', habit: 'Habit' },
    proposal: 'This week', decide: 'It runs only if you say so.',
    why: 'Why tickets get blocked', whySub: (f, w) => `${f} of ${f + w} blocks are harness plumbing, not code quality.`, noBlocks: 'No blocked ticket in this window.',
    cause: { preflight: 'Checks red in the worktree', setup: 'Config or setup', review: 'The reviewer rejected the code', dead: 'The implementer died midway', conflict: 'Merge conflict', ticket: 'Ticket impossible as written' },
    legendF: 'Harness friction', legendW: 'The harness doing its job',
    waves: 'How parallel your waves are', wavesSub: (w, p, b, t) => `${w} waves in ${p} plans. ${b} of ${t} tickets wait on another.`, width: ['1 ticket', '2 at once', '3 at once', '4 or more'],
    how: 'How you work', corr: 'Sessions where you corrected the agent', status: 'Times you asked "how is it going?"', model: 'Model switches by hand', simpler: 'Asked for a simpler explanation', sess: 'sessions',
    use: 'What you actually use', noSkills: 'No skill was invoked in this window.', unused: (n) => `${n} harness commands with no use: `, allUsed: 'Every harness command was used at least once.',
    gate: 'The gate, by project', quota: 'Weekly quota', quotaSub: (q) => `${q.used}% used with ${q.elapsed}% of the week gone. ${q.daysLeft} days left.`, quotaOk: 'On pace.', quotaHot: (n) => `${n} points ahead of the week: consider economy mode.`,
    foot: 'Counted from local transcripts and the gate log. Nothing here compares against a session without the harness.',
  },
  es: {
    eyebrow: (n) => `Arnés · últimos ${n} días`, title: '¿Me está ayudando<br>mi arnés?', updated: (s) => `Actualizado ${new Date(NOW).toISOString().slice(0, 10)} · ${s} sesiones`,
    delivered: 'Tickets entregados', deliveredSub: (l, b) => `de ${l + b} trabajados. ${b} quedaron bloqueados.`, noRuns: 'Ninguna corrida de oleadas en este periodo.',
    caught: 'Fallos que atrapó el portero', caughtSub: (f, s) => `${f} arreglados antes de terminar el turno. Registro desde ${s}.`, noGate: 'El registro del portero está vacío: empieza a contar en el próximo fallo.',
    perWave: 'Tickets por oleada', perWaveSub: (one, all) => `${one} de ${all} oleadas llevan un solo ticket.`, noPlans: 'Ningún plan de oleadas en este periodo.',
    cont: 'Prompts solo para «seguir»', contSub: (a, b) => `${a} de ${b} prompts.`,
    coach: 'Lo que noté en tu forma de trabajar', coachBy: (p, a) => `De tus sesiones${p ? `, ${p}` : ''}. Escrito ${a === 0 ? 'hoy' : `hace ${a} día(s)`}.`, coachStale: 'Estas notas tienen más de una semana.', evidence: 'Lo que vi', action: 'Lo que cambiaría', kinds: { rule: 'Regla para pegar', command: 'Comando', habit: 'Hábito' },
    proposal: 'Propuesta de la semana', decide: 'Solo se lanza si tú dices que sí.',
    why: 'Por qué se bloquean los tickets', whySub: (f, w) => `${f} de ${f + w} bloqueos son fontanería del arnés, no calidad del código.`, noBlocks: 'Ningún ticket bloqueado en este periodo.',
    cause: { preflight: 'Pruebas en rojo dentro del worktree', setup: 'Configuración o preparación', review: 'El revisor rechazó el código', dead: 'El implementador murió a medias', conflict: 'Conflicto al fusionar', ticket: 'Ticket imposible tal como estaba escrito' },
    legendF: 'Fricción del arnés', legendW: 'El arnés haciendo su trabajo',
    waves: 'Qué tan paralelas son tus oleadas', wavesSub: (w, p, b, t) => `${w} oleadas en ${p} planes. ${b} de ${t} tickets esperan a otro.`, width: ['1 ticket', '2 a la vez', '3 a la vez', '4 o más'],
    how: 'Cómo trabajas', corr: 'Sesiones donde corregiste al agente', status: 'Veces que preguntaste «¿cómo vamos?»', model: 'Cambios de modelo a mano', simpler: 'Pediste una explicación más simple', sess: 'sesiones',
    use: 'Lo que de verdad usas', noSkills: 'Ningún skill invocado en este periodo.', unused: (n) => `${n} comandos del arnés sin uso: `, allUsed: 'Todos los comandos del arnés se usaron al menos una vez.',
    gate: 'El portero, por proyecto', quota: 'Cuota semanal', quotaSub: (q) => `${q.used} % usado con el ${q.elapsed} % de la semana transcurrido. Quedan ${String(q.daysLeft).replace('.', ',')} días.`, quotaOk: 'Vas a ritmo.', quotaHot: (n) => `${n} puntos por delante de la semana: considera el modo economía.`,
    foot: 'Contado desde los transcripts locales y el registro del portero. Nada aquí compara contra una sesión sin arnés.',
  },
}[LANG];

// One proposal, chosen by rule from what the window shows; the ISO week rotates among those that apply.
const proposals = [];
if (topSkills[0] && topSkills[0][1] >= 20) proposals.push(LANG === 'es'
  ? [`Mide <em>${topSkills[0][0]}</em>: lo usaste ${topSkills[0][1]} veces y nunca se comprobó si mejora el resultado.`, 'Comparación a ciegas, con y sin el skill. Coste medio.', `/skill-loop ${topSkills[0][0]}`]
  : [`Measure <em>${topSkills[0][0]}</em>: used ${topSkills[0][1]} times, never checked against not using it.`, 'A blind comparison, with and without the skill. Medium cost.', `/skill-loop ${topSkills[0][0]}`]);
if (waves >= 5 && perWave < 1.7) proposals.push(LANG === 'es'
  ? [`Tus oleadas van casi en fila: ${data.spec.perWave} tickets por oleada.`, 'En el próximo plan, lee qué dependencias marca como evitables antes de aprobarlo.', 'develop-spec (plan)']
  : [`Your waves run almost in a line: ${data.spec.perWave} tickets per wave.`, 'On the next plan, read which dependencies it marks avoidable before you approve.', 'develop-spec (plan)']);
if (d.prompts >= 50 && data.continuationPct >= 20) proposals.push(LANG === 'es'
  ? [`El ${data.continuationPct} % de tus prompts solo dice «sigue».`, 'El agente se detiene a pedir permiso demasiado: una regla en tu configuración lo corrige.', '/session-review']
  : [`${data.continuationPct}% of your prompts only say "go on".`, 'The agent stops to ask too often: one rule in your config fixes it.', '/session-review']);
if (friction > working && friction >= 5) proposals.push(LANG === 'es'
  ? [`${friction} tickets se bloquearon por fontanería, no por su código.`, 'Comprueba que las pruebas del proyecto pasan en un checkout limpio.', 'preflight · worktree limpio']
  : [`${friction} tickets were blocked by plumbing, not by their code.`, "Check that the project's gate passes in a clean checkout.", 'preflight · clean worktree']);
const week = Math.floor((NOW / 86400000 + 3) / 7);
const proposal = proposals.length ? proposals[week % proposals.length] : null;

// ---- page ---------------------------------------------------------------------------------------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (n) => (Number.isInteger(n) ? n.toLocaleString(LANG === 'es' ? 'de-DE' : 'en-US') : LANG === 'es' ? String(n).replace('.', ',') : String(n));
const kpi = (label, value, sub, tone) => `<div class="card kpi"><span class="mono lab">${label}</span><span class="num ${tone}">${value}</span><span class="sub">${sub}</span></div>`;
const bars = (rows, max) => rows.map(([label, n, tone]) => `<div class="bar"><span>${esc(label)}</span><div class="track"><i class="f-${tone || 'ok'}" style="width:${Math.max(2, Math.round((n / max) * 100))}%"></i></div></div><span class="mono n">${n}</span>`).join('');

const causeRows = CAUSES.map(([k, , w]) => [T.cause[k], spec.causes[k], w ? 'ok' : 'warn']).filter(([, n]) => n).sort((a, b) => b[1] - a[1]);
const maxW = Math.max(1, ...data.spec.widths);
const html = `<!doctype html>
<html lang="${LANG}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${LANG === 'es' ? 'Panel del arnés' : 'Harness panel'}</title>
${has('--web-fonts') ? '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&family=Archivo:wght@400;500;600&family=Martian+Mono:wght@400;500&display=swap">' : ''}
<style>
:root{--bg:#FAFAF6;--card:#FFFFFF;--ink:#14201A;--dim:rgba(20,32,26,.82);--meta:#626F68;--line:rgba(20,32,26,.12);--ok:#047857;--warn:#A16207;--mint:#00E599;--panel:#0A1F14;--soft:#E8F5EC}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:'Archivo',system-ui,sans-serif;padding:56px 24px 72px}
main{max-width:1120px;margin:0 auto;display:flex;flex-direction:column;gap:40px}
.mono{font-family:'Martian Mono',ui-monospace,monospace}.serif{font-family:'Source Serif 4',Georgia,serif}
header{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-end;gap:16px;border-bottom:1px solid rgba(20,32,26,.2);padding-bottom:24px}
h1{margin:10px 0 0;font:400 52px/1.02 'Source Serif 4',Georgia,serif;letter-spacing:-.02em}h2{margin:0;font:600 22px/1.2 'Source Serif 4',Georgia,serif}
.eyebrow{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--meta)}.stamp{font-size:12px;color:var(--meta)}
.grid{display:grid;gap:16px}.g4{grid-template-columns:repeat(auto-fit,minmax(230px,1fr))}.g2{grid-template-columns:repeat(auto-fit,minmax(340px,1fr))}.g3{grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:28px;display:flex;flex-direction:column;gap:16px}.card.soft{background:var(--soft)}
.kpi{padding:24px;gap:8px}.lab{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--meta)}.num{font:400 56px/1 'Source Serif 4',Georgia,serif}.num.ok{color:var(--ok)}.num.warn{color:var(--warn)}
.sub,.note{margin:0;font-size:14px;line-height:1.45;color:var(--dim)}
.prop{background:var(--panel);color:#FAFAF6;border-radius:12px;padding:32px;display:flex;flex-wrap:wrap;gap:24px;align-items:center}
.prop>div:first-child{flex:999 1 420px;min-width:0;display:flex;flex-direction:column;gap:10px}.prop>div:last-child{flex:1 1 200px;display:flex;flex-direction:column;gap:8px}
.prop .eyebrow{color:var(--mint)}.prop h2{font:400 30px/1.15 'Source Serif 4',Georgia,serif}.prop p{margin:0;font-size:15px;line-height:1.5;color:rgba(250,250,246,.72)}
.cmd{font-size:13px;background:#14201A;border:1px solid rgba(250,250,246,.16);border-radius:6px;padding:12px 14px;overflow-wrap:anywhere}
.bars{display:grid;grid-template-columns:minmax(0,1fr) 36px;gap:10px 12px;align-items:center;font-size:14px}.bar{display:flex;flex-direction:column;gap:4px}
.track{height:10px}.track i{display:block;height:10px;border-radius:3px}.f-ok{background:var(--ok)}.f-warn{background:var(--warn)}.n{text-align:right;font-size:13px}
.legend{display:flex;flex-wrap:wrap;gap:16px;font-size:13px;color:var(--meta)}.legend span{display:flex;align-items:center;gap:6px}.legend i{width:10px;height:10px;border-radius:2px}
.cols{display:flex;align-items:flex-end;gap:16px;height:190px}.cols div{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:6px;height:100%}
.cols i{display:block;width:100%;border-radius:4px 4px 0 0;background:var(--ok)}.cols div:first-child i{background:var(--ink)}.colsx{display:flex;gap:16px;font-size:13px;text-align:center}.colsx span{flex:1}
.rows div{display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding:12px 0;border-top:1px solid var(--line);font-size:15px}.rows .mono{white-space:nowrap;font-size:13px}.stack{display:flex;flex-direction:column;gap:16px}
.meter{height:12px;border-radius:999px;background:var(--line);position:relative}.meter i{position:absolute;inset:0 auto 0 0;border-radius:999px}.meter b{position:absolute;top:-4px;bottom:-4px;width:2px;background:var(--ink)}
.coach{display:flex;flex-direction:column;gap:20px}.coach>div:first-child{display:flex;flex-direction:column;gap:6px}.coach h2{font:400 34px/1.1 'Source Serif 4',Georgia,serif;letter-spacing:-.01em}
.ins{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:28px;display:grid;grid-template-columns:44px minmax(0,1fr);gap:8px 20px}
.ins .no{font:400 40px/1 'Source Serif 4',Georgia,serif;color:var(--ok)}.ins h3{margin:0;font:600 22px/1.2 'Source Serif 4',Georgia,serif}
.ins .body{grid-column:2;display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:20px}.ins .body>div{display:flex;flex-direction:column;gap:6px}
.ins p{margin:0;font-size:15px;line-height:1.5;color:var(--dim)}.snip{grid-column:2;display:flex;flex-direction:column;gap:6px}
.snip pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:400 12.5px/1.55 'Martian Mono',ui-monospace,monospace;background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:14px 16px;color:var(--ink)}
@media (max-width:560px){.ins{grid-template-columns:1fr}.ins .body,.snip{grid-column:1}}
footer{font-size:13px;color:var(--meta);border-top:1px solid var(--line);padding-top:16px}
</style></head><body><main>
<header><div><span class="mono eyebrow">${T.eyebrow(DAYS)}</span><h1>${T.title}</h1></div><span class="mono stamp">${T.updated(d.sessions)}</span></header>
<section class="grid g4">
${spec.runs ? kpi(T.delivered, spec.landed, T.deliveredSub(spec.landed, spec.blocked), 'ok') : kpi(T.delivered, '—', T.noRuns, '')}
${gate.first ? kpi(T.caught, gate.catches, T.caughtSub(gate.fixed, data.gate.since), 'ok') : kpi(T.caught, '—', T.noGate, '')}
${waves ? kpi(T.perWave, fmt(data.spec.perWave), T.perWaveSub(data.spec.widths[0], waves), perWave < 1.7 ? 'warn' : 'ok') : kpi(T.perWave, '—', T.noPlans, '')}
${kpi(T.cont, `${data.continuationPct}${LANG === 'es' ? ' %' : '%'}`, T.contSub(fmt(d.continuations), fmt(d.prompts)), data.continuationPct >= 20 ? 'warn' : 'ok')}
</section>
${coach ? `<section class="coach"><div><span class="mono eyebrow">${T.coachBy(esc(coach.period), coach.ageDays)}${coach.ageDays > 7 ? ` ${T.coachStale}` : ''}</span><h2>${T.coach}</h2></div>
${coach.insights.map((i, n) => `<article class="ins"><span class="no">${n + 1}</span><h3>${esc(i.title)}</h3>
<div class="body"><div><span class="mono lab">${T.evidence}</span><p>${esc(i.evidence || '')}</p></div><div><span class="mono lab">${T.action}</span><p>${esc(i.action)}</p></div></div>
${i.snippet ? `<div class="snip"><span class="mono lab">${T.kinds[i.kind] || T.kinds.habit}</span><pre>${esc(i.snippet)}</pre></div>` : ''}</article>`).join('\n')}</section>` : ''}
${proposal ? `<section class="prop"><div><span class="mono eyebrow">${T.proposal}</span><h2>${proposal[0]}</h2><p>${proposal[1]}</p></div><div><span class="mono cmd">${esc(proposal[2])}</span><span class="sub" style="color:rgba(250,250,246,.72)">${T.decide}</span></div></section>` : ''}
<section class="grid g2">
<div class="card"><div><h2>${T.why}</h2><p class="note" style="margin-top:6px">${causeRows.length ? T.whySub(friction, working) : T.noBlocks}</p></div>
${causeRows.length ? `<div class="bars">${bars(causeRows, causeRows[0][1])}</div><div class="legend"><span><i class="f-warn"></i>${T.legendF}</span><span><i class="f-ok"></i>${T.legendW}</span></div>` : ''}</div>
<div class="card soft"><div><h2>${T.waves}</h2><p class="note" style="margin-top:6px">${waves ? T.wavesSub(waves, spec.plans, spec.withBlocker, spec.tickets) : T.noPlans}</p></div>
${waves ? `<div class="cols">${data.spec.widths.map((n) => `<div><span class="mono n">${n}</span><i style="height:${Math.max(n ? 3 : 0, Math.round((n / maxW) * 100))}%"></i></div>`).join('')}</div><div class="colsx">${T.width.map((w) => `<span>${w}</span>`).join('')}</div>` : ''}</div>
</section>
<section class="grid g3">
<div class="card"><h2>${T.how}</h2><div class="rows">
<div><span>${T.corr}</span><span class="mono">${d.correctionSessions.size} / ${d.sessions}</span></div>
<div><span>${T.status}</span><span class="mono">${d.statusAsks}</span></div>
<div><span>${T.model}</span><span class="mono">${d.modelSwitches}</span></div>
<div><span>${T.simpler}</span><span class="mono">${d.simplerSessions.size} ${T.sess}</span></div></div></div>
<div class="card"><h2>${T.use}</h2>${topSkills.length ? `<div class="bars">${bars(topSkills.map(([s, n]) => [s, n, 'ok']), topSkills[0][1])}</div>` : `<p class="note">${T.noSkills}</p>`}
<p class="note">${unused.length ? T.unused(unused.length) + unused.map((u) => `<span class="mono" style="font-size:12px">/${esc(u)}</span>`).join(' ') : T.allUsed}</p></div>
<div class="stack">
${quota ? `<div class="card"><h2>${T.quota}</h2><div class="meter"><i class="f-${quota.ahead > 10 ? 'warn' : 'ok'}" style="width:${Math.min(100, quota.used)}%"></i><b style="left:${quota.elapsed}%"></b></div><p class="note">${T.quotaSub(quota)}</p><p class="note"><strong>${quota.ahead > 10 ? T.quotaHot(quota.ahead) : T.quotaOk}</strong></p></div>` : ''}
<div class="card"><h2>${T.gate}</h2>${data.gate.repos.length ? `<div class="bars">${bars(data.gate.repos.map(([r, n]) => [r, n, 'ok']), data.gate.repos[0][1])}</div><p class="note">${T.caughtSub(gate.fixed, data.gate.since)}</p>` : `<p class="note">${T.noGate}</p>`}</div>
</div>
</section>
<footer>${T.foot}</footer>
</main></body></html>
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html);
// A link the terminal makes clickable, not a path to go and find.
console.log(`file://${OUT.split(path.sep).map(encodeURIComponent).join('/')}`);
if (has('--open')) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  try { spawn(cmd, process.platform === 'win32' ? ['/c', 'start', '', OUT] : [OUT], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref(); } catch { /* no display: the path above is the answer */ }
}
