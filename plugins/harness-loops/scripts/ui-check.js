#!/usr/bin/env node
// ui-check.js — opens a project's interface in a real browser and checks it against UI rules that hold for any
// web app: layout on a still screen, and what the interface answers after a button is pressed.
//
// Why rules and not a model looking at screenshots: measured 2026-11-16 on the Tama OS shell (54 screens), six
// geometry rules caught a conversation squeezed to 64-142 px that every unit test had passed, while a vision
// judge (Jev) scored that screen 0.20-0.32, the same as healthy ones. A rule answers the same way every run and
// costs no tokens; a model is kept for what no rule covers (PRD-006).
//
// Every rule starts at `warn`: it was calibrated on one project (571 alarms → 9 before the false positives were
// removed). A project promotes a rule to `block` in its config once it is quiet there. Exit codes:
//   0  no blocking violation (warnings may be printed)
//   2  at least one blocking violation
//   1  usage or runtime error
//   3  could not run: no Playwright, no browser, or the app never answered — NOT VERIFIED, never a pass
//
// Zero dependencies of its own: Playwright and axe-core are resolved from the project, then from the global npm
// root. The browser is Playwright's own; when that build is missing, the newest cached Chromium is used.
//
// Usage: node ui-check.js [--config .harness/ui-check.json] [--url URL] [--routes a,b] [--serve "cmd"]
//                          [--interactions] [--json out.json] [--shots dir] [--quiet]

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');

// ── The rules ────────────────────────────────────────────────────────────────────────────────────────────────
// id → what it protects, in one line. The id is what a config names; the line is what the report prints.
const RULES = {
  'page-scrolls-sideways': 'the page never scrolls sideways',
  'scroll-area-squeezed': 'a scroll area that hides most of its content keeps a usable height',
  'conversation-starved': 'a conversation or feed keeps at least 40% of its panel and 240 px',
  'text-cut-silently': 'text is never cut without an ellipsis or a way to scroll',
  'control-off-screen': 'buttons, links and fields stay inside the window',
  'controls-overlap': 'two controls never sit on top of each other',
  'text-over-text': 'two pieces of text never print over each other',
  'tap-target-small': 'on a phone, controls are at least 24 × 24 px',
  accessibility: 'no serious or critical WCAG 2.2 AA violation (axe-core)',
  'console-error': 'the browser console shows no error',
  'request-failed': 'no request fails or answers 4xx/5xx',
  'silent-click': 'a pressed button answers with something visible within one second',
  'change-unannounced': 'the answer is announced: the button changes, a status message appears, or something opens',
  'abrupt-insert': 'the answer does not shove the rest of the screen (layout shift ≤ 0.05)',
  'error-unannounced': 'an error appears in an announced region (role=alert/status), not as loose red text',
}
const LEVELS = ['off', 'warn', 'block']

// Labels a probe never presses: pressing every button is safe on demo data, not on a real account.
const UNSAFE = /delet|borr|elimin|supprim|remov|quitar|destroy|purge|reset|log ?out|sign ?out|cerrar sesi|d[ée]connex|pay|pag(ar|o)|buy|compr|deploy|desplegar|publish|publicar|merge|fusionar|drop/i

// Runs inside the page. One self-contained function: Playwright serialises it, so it may not close over anything.
function staticRules(document, window) {
  const out = []
  const vw = window.innerWidth
  const vh = window.innerHeight
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return false
    const s = window.getComputedStyle(el)
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05
  }
  const name = (el) => {
    const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : ''
    const label = el.getAttribute && el.getAttribute('aria-label')
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls}${label ? `[${label.slice(0, 30)}]` : ''}`
  }
  // Really drawn where it claims to be: its own centre hits it (rules out skip links and parked elements).
  const hits = (el, x, y) => { const t = document.elementFromPoint(x, y); return !!t && (el.contains(t) || t.contains(el)) }
  const painted = (el) => { const r = el.getBoundingClientRect(); return hits(el, r.left + r.width / 2, r.top + r.height / 2) }
  // Drawn at least somewhere: a control half hidden under another still shows a corner.
  const paintedAnywhere = (el, box) => {
    const r = box || el.getBoundingClientRect()
    const dx = Math.min(2, r.width / 4), dy = Math.min(2, r.height / 4)
    return [[r.left + r.width / 2, r.top + r.height / 2], [r.left + dx, r.top + dy], [r.right - dx, r.top + dy], [r.left + dx, r.bottom - dy], [r.right - dx, r.bottom - dy]]
      .some(([x, y]) => hits(el, x, y))
  }
  const add = (rule, el, detail) => out.push({ rule, where: name(el), detail })
  // The part of an element the user can see: its box cut by every ancestor that clips (a scroll area, overflow hidden).
  const shown = (el) => {
    const r = el.getBoundingClientRect()
    let box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
    for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      if (window.getComputedStyle(p).overflow === 'visible') continue
      const q = p.getBoundingClientRect()
      box = { left: Math.max(box.left, q.left), top: Math.max(box.top, q.top), right: Math.min(box.right, q.right), bottom: Math.min(box.bottom, q.bottom) }
    }
    return { ...box, width: Math.max(0, box.right - box.left), height: Math.max(0, box.bottom - box.top) }
  }
  const CONTROL = /^(BUTTON|A|INPUT|SELECT|TEXTAREA)$/
  const pinned = (el) => {
    for (let p = el; p && p !== document.body; p = p.parentElement) if (/^(fixed|sticky)$/.test(window.getComputedStyle(p).position)) return true
    return false
  }

  const doc = document.documentElement
  if (doc.scrollWidth > vw + 1) add('page-scrolls-sideways', doc, `content ${doc.scrollWidth}px in a ${vw}px window`)

  const all = Array.from(document.body.querySelectorAll('*')).filter(visible)
  const texts = []
  for (const el of all) {
    const s = window.getComputedStyle(el)
    const r = el.getBoundingClientRect()
    const field = /^(TEXTAREA|INPUT|SELECT|PRE|CODE)$/.test(el.tagName)
    const ownText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim().length > 1)
    // Screen-reader-only helpers are clipped on purpose.
    const srOnly = r.width <= 2 || r.height <= 2 || (s.clip !== 'auto' && s.position === 'absolute') || s.clipPath !== 'none'

    if (/(auto|scroll)/.test(s.overflowY) && !field && el.scrollHeight >= el.clientHeight * 2 && el.clientHeight < 160 && el.clientHeight < vh * 0.25) {
      add('scroll-area-squeezed', el, `${el.clientHeight}px tall for ${el.scrollHeight}px of content`)
    }

    const role = el.getAttribute('role')
    if (role === 'log' || role === 'feed') {
      let panel = el.parentElement
      while (panel && panel !== document.body && !/^(SECTION|ARTICLE|ASIDE|MAIN|DIALOG)$/.test(panel.tagName)) panel = panel.parentElement
      const ph = panel ? panel.getBoundingClientRect().height : vh
      const share = Math.round((el.clientHeight / ph) * 100)
      if (vh >= 600 && (el.clientHeight < 240 || share < 40)) add('conversation-starved', el, `${el.clientHeight}px, ${share}% of its ${Math.round(ph)}px panel`)
    }

    const clamped = s.webkitLineClamp && s.webkitLineClamp !== 'none'
    if (ownText && !srOnly && !clamped && s.overflowX === 'hidden' && s.textOverflow !== 'ellipsis' && el.scrollWidth > el.clientWidth + 2) {
      add('text-cut-silently', el, `${el.scrollWidth - el.clientWidth}px of text hidden, no ellipsis`)
    }

    if (CONTROL.test(el.tagName) && r.right > 0 && (r.right > vw + 1 || r.left < -1) && r.top < vh && r.bottom > 0) {
      let p = el.parentElement
      let excused = false
      while (p && p !== document.body) {
        if (/(auto|scroll)/.test(window.getComputedStyle(p).overflowX)) { excused = true; break }
        p = p.parentElement
      }
      if (!excused) add('control-off-screen', el, `spans ${Math.round(r.left)}–${Math.round(r.right)}px in a ${vw}px window`)
    }

    if (vw <= 480 && /^(BUTTON|A|INPUT|SELECT)$/.test(el.tagName) && s.display !== 'inline' && (r.width < 24 || r.height < 24) && painted(el)) {
      add('tap-target-small', el, `${Math.round(r.width)}×${Math.round(r.height)} px`)
    }

    // The boxes of the glyphs themselves, from the element's own text nodes: a heading with an icon inside still
    // counts, and a wrapped inline span is its lines, not a box as wide as the paragraph.
    if (ownText && !srOnly && r.bottom > 0 && r.top < vh) {
      const v = shown(el)
      if (v.width > 2 && v.height > 2 && paintedAnywhere(el, v)) {
        const range = document.createRange()
        const boxes = Array.from(el.childNodes).filter((n) => n.nodeType === 3 && n.textContent.trim()).flatMap((n) => { range.selectNodeContents(n); return Array.from(range.getClientRects()) })
        const lines = boxes.map((q) => ({
          left: Math.max(q.left, v.left), top: Math.max(q.top, v.top), right: Math.min(q.right, v.right), bottom: Math.min(q.bottom, v.bottom),
        })).filter((q) => q.right - q.left > 2 && q.bottom - q.top > 2).map((q) => ({ ...q, width: q.right - q.left, height: q.bottom - q.top }))
        if (lines.length) texts.push([el, lines])
      }
    }
  }

  const overlap = (a, b) => {
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left)
    const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
    return w > 2 && h > 2 ? { w, h, cx: Math.max(a.left, b.left) + w / 2, cy: Math.max(a.top, b.top) + h / 2 } : null
  }

  // A button drawn inside a text field's box is a normal pattern; only controls that really paint count.
  const controls = all.filter((el) => CONTROL.test(el.tagName) && !/^(TEXTAREA|INPUT)$/.test(el.tagName) && paintedAnywhere(el)).slice(0, 400)
  const rects = controls.map((el) => el.getBoundingClientRect())
  for (let i = 0; i < controls.length; i++) {
    for (let j = i + 1; j < controls.length; j++) {
      if (controls[i].contains(controls[j]) || controls[j].contains(controls[i])) continue
      const o = overlap(rects[i], rects[j])
      if (!o || o.cy < 0 || o.cy > vh) continue
      const top = document.elementFromPoint(o.cx, o.cy)
      const onTop = top && controls[i].contains(top) ? i : top && controls[j].contains(top) ? j : -1
      if (onTop < 0) continue
      const under = onTop === i ? j : i
      // Content scrolling under a pinned bar (a bottom tab bar, a sticky header) is how scrolling works.
      if (pinned(controls[onTop]) && !pinned(controls[under])) continue
      const cover = (o.w * o.h) / (rects[under].width * rects[under].height)
      if (cover > 0.3) add('controls-overlap', controls[under], `${Math.round(cover * 100)}% hidden under ${name(controls[onTop])}`)
    }
  }

  const t = texts.slice(0, 500)
  for (let i = 0; i < t.length; i++) {
    for (let j = i + 1; j < t.length; j++) {
      const [a, la] = t[i], [b, lb] = t[j]
      if (a.contains(b) || b.contains(a) || pinned(a) !== pinned(b)) continue
      const clash = la.some((ra) => lb.some((rb) => {
        const o = overlap(ra, rb)
        return o && o.w > 3 && o.h > 3 && (o.w * o.h) / Math.min(ra.width * ra.height, rb.width * rb.height) > 0.3
      }))
      if (clash) add('text-over-text', a, `«${a.textContent.trim().slice(0, 20)}» over «${b.textContent.trim().slice(0, 20)}»`)
    }
  }
  const fields = all.filter((el) => /^(SELECT|INPUT|TEXTAREA)$/.test(el.tagName) && !pinned(el)).slice(0, 100)
  for (const f of fields) {
    const fr = f.getBoundingClientRect()
    for (const [a, la] of t) {
      if (f.contains(a) || a.contains(f) || (f.labels && Array.from(f.labels).some((l) => l.contains(a)))) continue
      for (const ra of la) {
        const o = overlap(ra, fr)
        if (!o || (o.w * o.h) / (ra.width * ra.height) <= 0.3) continue
        const top = document.elementFromPoint(o.cx, o.cy)
        if (top && f.contains(top)) { add('text-over-text', a, `«${a.textContent.trim().slice(0, 20)}» hidden under ${name(f)}`); break }
      }
    }
  }
  return out
}

// Runs inside the page, before a press: records every mutation and layout shift from now on.
function armProbe() {
  const w = window
  w.__uiProbe = { muts: [], shifts: 0, idle: new Set() }
  w.__uiProbe.obs = new MutationObserver((list) => { for (const m of list) w.__uiProbe.muts.push(m) })
  w.__uiProbe.obs.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
  try {
    // No hadRecentInput filter: the browser flags the shift a click causes, and that shift is the one measured here.
    w.__uiProbe.po = new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__uiProbe.shifts += e.value })
    w.__uiProbe.po.observe({ type: 'layout-shift' })
  } catch { w.__uiProbe.po = null }
}

// Whatever was already moving before the press (a clock, a spinner) is not an answer to it.
function settleProbe() {
  const p = window.__uiProbe
  for (const m of p.muts) p.idle.add(m.target.nodeType === 1 ? m.target : m.target.parentElement)
  p.muts = []
  p.shifts = 0
}

// Runs inside the page, one second after the press: what changed, and how it was announced.
function readProbe(id) {
  const p = window.__uiProbe
  p.obs.disconnect()
  if (p.po) p.po.disconnect()
  const LIVE = '[role=status],[role=alert],[aria-live],[role=log]'
  const btn = document.querySelector(`[data-ui-probe="${id}"]`)
  const el = (n) => (n.nodeType === 1 ? n : n.parentElement)
  const vis = (e) => {
    if (!e || !e.isConnected) return false
    const r = e.getBoundingClientRect()
    const s = getComputedStyle(e)
    return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none'
  }
  const real = p.muts.filter((m) => {
    const t = el(m.target)
    return t && !p.idle.has(t) && !(m.type === 'attributes' && m.attributeName === 'data-ui-probe')
  })
  let self = false, live = false, opened = false, other = false, red = null
  for (const m of real) {
    const t = el(m.target)
    if (btn && (btn === t || btn.contains(t))) { self = true; continue }
    if (t.closest(LIVE)) live = true
    const added = [...m.addedNodes].map(el).filter(vis)
    if (added.some((a) => a.matches?.('[role=dialog],dialog,[role=menu],[role=listbox],[popover]') || a.querySelector?.('[role=dialog],dialog,[role=menu],[role=listbox]'))) opened = true
    if (m.type === 'attributes' && /^(open|aria-expanded|aria-pressed|aria-selected|aria-checked|aria-current|hidden)$/.test(m.attributeName)) opened = true
    for (const a of added.length ? added : vis(t) ? [t] : []) {
      other = true
      if (red) continue
      for (const x of [a, ...a.querySelectorAll('*')].slice(0, 60)) {
        if (!vis(x) || x.closest(LIVE)) continue
        const own = [...x.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 2)
        const c = (getComputedStyle(x).color.match(/[\d.]+/g) || []).map(Number)
        if (own && c[0] > 150 && c[1] < 95 && c[2] < 95) { red = x.textContent.trim().slice(0, 70); break }
      }
    }
  }
  return { self: self || !btn || !btn.isConnected, live, opened, other, red, shift: Math.round(p.shifts * 1000) / 1000 }
}

// ── Plumbing ─────────────────────────────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { routes: null }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    const next = () => argv[++i]
    if (k === '--config') a.config = next()
    else if (k === '--url') a.url = next()
    else if (k === '--routes') a.routes = next().split(',').map((s) => s.trim()).filter(Boolean)
    else if (k === '--serve') a.serve = next()
    else if (k === '--interactions') a.interactions = true
    else if (k === '--json') a.json = next()
    else if (k === '--shots') a.shots = next()
    else if (k === '--quiet') a.quiet = true
    else if (k === '--help' || k === '-h') a.help = true
    else throw new Error(`unknown option ${k}`)
  }
  return a
}

// Config file, then flags. Unknown rule names and levels are refused: a typo would silently switch a rule off.
function loadConfig(args, cwd) {
  const file = args.config ?? (fs.existsSync(path.join(cwd, '.harness', 'ui-check.json')) ? '.harness/ui-check.json' : null)
  const fromFile = file ? JSON.parse(fs.readFileSync(path.resolve(cwd, file), 'utf8')) : {}
  const cfg = {
    url: args.url ?? fromFile.url,
    serve: args.serve ?? fromFile.serve ?? null,
    ready: fromFile.ready ?? 'body *',
    routes: args.routes ?? fromFile.routes ?? [''],
    viewports: fromFile.viewports ?? [[1280, 800], [390, 800]],
    colorSchemes: fromFile.colorSchemes ?? ['light'],
    interactions: {
      enabled: args.interactions === true || fromFile.interactions?.enabled === true,
      maxPerScreen: fromFile.interactions?.maxPerScreen ?? 12,
      routes: fromFile.interactions?.routes ?? null,
      skip: fromFile.interactions?.skip ?? [],
    },
    failRequests: fromFile.failRequests ?? [],
    rules: { ...Object.fromEntries(Object.keys(RULES).map((r) => [r, 'warn'])), ...(fromFile.rules ?? {}) },
    ignore: fromFile.ignore ?? [],
    file,
  }
  if (!cfg.url) throw new Error('no url: pass --url or set "url" in .harness/ui-check.json')
  for (const [rule, level] of Object.entries(cfg.rules)) {
    if (!RULES[rule]) throw new Error(`unknown rule "${rule}" in config — known: ${Object.keys(RULES).join(', ')}`)
    if (!LEVELS.includes(level)) throw new Error(`rule "${rule}": level "${level}" is not one of ${LEVELS.join(', ')}`)
  }
  return cfg
}

function resolveFrom(name, cwd) {
  const bases = [path.join(cwd, 'package.json'), __filename]
  try { bases.push(path.join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(), 'noop.js')) } catch { /* no npm */ }
  for (const base of bases) {
    try { return createRequire(base).resolve(name) } catch { /* next */ }
  }
  return null
}

function loadPlaywright(cwd) {
  for (const name of ['playwright', 'playwright-core', '@playwright/test']) {
    const p = resolveFrom(name, cwd)
    if (p) return require(p).chromium ? require(p) : null
  }
  return null
}

// Playwright's pinned browser build is often not the one downloaded (a global Playwright newer than the cache).
function cachedChromium() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), '.cache', 'ms-playwright')
  let dirs = []
  try { dirs = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1])) } catch { return null }
  for (const d of dirs) {
    for (const rel of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-win/chrome.exe']) {
      const exe = path.join(root, d, rel)
      if (fs.existsSync(exe)) return exe
    }
  }
  return null
}

async function launch(pw) {
  try { return await pw.chromium.launch() } catch (e) {
    const exe = process.env.UI_CHECK_CHROMIUM || cachedChromium()
    if (!exe) throw e
    return pw.chromium.launch({ executablePath: exe, args: ['--no-sandbox'] })
  }
}

async function reachable(url, ms) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    try { const r = await fetch(url, { redirect: 'manual' }); if (r.status < 500) return true } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

function serveStart(cmd, cwd) {
  const child = spawn(cmd, { cwd, shell: true, detached: true, stdio: 'ignore' })
  return () => { try { process.kill(-child.pid, 'SIGTERM') } catch { /* gone */ } }
}

const routeUrl = (base, route) => (/^https?:/.test(route) ? route : new URL(route, base).href)
const ignored = (cfg, v) => cfg.ignore.some((i) => (!i.rule || i.rule === v.rule) && (!i.where || `${v.screen} ${v.where}`.includes(i.where)))

// The first screen waits longer: a dev server compiles on first request (Vite took >15 s cold on Tama OS).
// A hash route on an app already loaded is reached the way a user reaches it, without a reload: reloading a Vite
// dev app for every screen exhausted Chromium (net::ERR_INSUFFICIENT_RESOURCES, a screen that never rendered).
// `fresh` forces a full load — the interaction probe needs each press to start from a clean state.
let warm = false
const base = (u) => u.split('#')[0]
async function openScreen(page, cfg, route, fresh = false) {
  const wait = warm ? 15000 : 90000
  const target = routeUrl(cfg.url, route)
  const hashRoute = target.includes('#') && base(target) === base(cfg.url)
  if (fresh || !hashRoute || base(page.url()) !== base(cfg.url)) {
    await page.goto(hashRoute ? base(target) : target, { waitUntil: 'domcontentloaded', timeout: wait })
    await page.locator(cfg.ready).first().waitFor({ timeout: wait })
  }
  if (hashRoute) {
    await page.evaluate((h) => { location.hash = h }, new URL(target).hash)
    await page.locator(cfg.ready).first().waitFor({ timeout: wait })
  }
  warm = true
  await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {})
  await page.waitForTimeout(400)
}

async function runStatic(browser, cfg, axeSrc, shotsDir, found, notReady) {
  let screens = 0
  for (const [width, height] of cfg.viewports) {
    for (const scheme of cfg.colorSchemes) {
      const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, reducedMotion: 'reduce' })
      const page = await ctx.newPage()
      let screen = ''
      page.on('console', (m) => { if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) found.push({ rule: 'console-error', screen, where: 'console', detail: m.text().slice(0, 140) }) })
      page.on('response', (r) => { if (r.status() >= 400 && !/\/favicon\.ico$/.test(r.url())) found.push({ rule: 'request-failed', screen, where: r.request().method(), detail: `${r.status()} ${r.url().slice(0, 120)}` }) })
      page.on('requestfailed', (r) => { if (!/ERR_ABORTED|ERR_INSUFFICIENT_RESOURCES/.test(r.failure()?.errorText ?? '')) found.push({ rule: 'request-failed', screen, where: r.method(), detail: `${r.failure()?.errorText} ${r.url().slice(0, 120)}` }) })
      for (const route of cfg.routes) {
        screen = `${width}x${height}${scheme === 'light' ? '' : ` ${scheme}`} ${route || '/'}`
        try { await openScreen(page, cfg, route) } catch (e) { notReady.push(`${screen} — never showed "${cfg.ready}": ${e.message.split('\n')[0]}`); continue }
        screens++
        for (const v of await page.evaluate(`(${staticRules.toString()})(document, window)`)) found.push({ ...v, screen })
        if (axeSrc) {
          const res = await page.evaluate(async (src) => {
            if (!window.axe) (0, eval)(src)
            return window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] }, resultTypes: ['violations'] })
          }, axeSrc)
          for (const v of res.violations.filter((x) => x.impact === 'serious' || x.impact === 'critical')) {
            found.push({ rule: 'accessibility', screen, where: v.nodes[0]?.target.join(' ').slice(0, 60) ?? '', detail: `${v.id} (${v.impact}) ×${v.nodes.length} — ${v.help}` })
          }
        }
        if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `${screen.replace(/[^\w.-]+/g, '_')}.png`) })
      }
      await ctx.close()
    }
  }
  return screens
}

async function runInteractions(browser, cfg, found) {
  const [width, height] = cfg.viewports[0]
  const routes = cfg.interactions.routes ?? cfg.routes
  const ctx = await browser.newContext({ viewport: { width, height } })
  for (const pattern of cfg.failRequests) await ctx.route(pattern, (r) => r.fulfill({ status: 500, body: '{"error":"ui-check: simulated failure"}', contentType: 'application/json' }))
  ctx.on('page', (p) => { if (p !== ctx.pages()[0]) p.close().catch(() => {}) })
  const page = await ctx.newPage()
  page.on('dialog', (d) => d.dismiss().catch(() => {}))
  let pressed = 0, skipped = 0
  for (const route of routes) {
    const screen = `${width}x${height} ${route || '/'}`
    try { await openScreen(page, cfg, route, true) } catch { continue }
    // The buttons are listed once, then each is pressed on a freshly loaded screen so one answer never leaks into the next.
    const labels = await page.evaluate(({ max, skip }) => {
      const scope = document.querySelector('main, [role=main]') || document.body
      const out = []
      for (const b of scope.querySelectorAll('button, [role=button]')) {
        const r = b.getBoundingClientRect()
        if (b.disabled || b.getAttribute('aria-disabled') === 'true' || r.width < 2 || r.height < 2) continue
        // A tab already selected and a drag handle legitimately do nothing on a plain click.
        if (/^(true|page)$/.test(b.getAttribute('aria-pressed') || b.getAttribute('aria-selected') || b.getAttribute('aria-current') || '')) continue
        if (/grab|move/.test(getComputedStyle(b).cursor)) continue
        if (skip.some((sel) => b.matches(sel))) continue
        const label = (b.getAttribute('aria-label') || b.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60)
        if (!label || out.includes(label)) continue
        out.push(label)
        if (out.length >= max) break
      }
      return out
    }, { max: cfg.interactions.maxPerScreen, skip: cfg.interactions.skip })
    for (const label of labels) {
      if (UNSAFE.test(label)) { skipped++; continue }
      try { await openScreen(page, cfg, route, true) } catch { continue }
      const id = `b${pressed}`
      const marked = await page.evaluate(({ label, id }) => {
        const scope = document.querySelector('main, [role=main]') || document.body
        for (const b of scope.querySelectorAll('button, [role=button]')) {
          const l = (b.getAttribute('aria-label') || b.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60)
          if (l === label && !b.disabled) { b.setAttribute('data-ui-probe', id); b.scrollIntoView({ block: 'center' }); return true }
        }
        return false
      }, { label, id })
      if (!marked) continue
      await page.evaluate(armProbe)
      await page.waitForTimeout(500)
      await page.evaluate(settleProbe)
      const before = page.url()
      let chooser = false
      const onChooser = () => { chooser = true }
      page.once('filechooser', onChooser)
      try { await page.locator(`[data-ui-probe="${id}"]`).click({ timeout: 2000 }) } catch { page.off('filechooser', onChooser); continue }
      pressed++
      await page.waitForTimeout(1000)
      page.off('filechooser', onChooser)
      const r = await page.evaluate(readProbe, id).catch(() => ({ self: true }))
      const navigated = page.url() !== before
      const where = `«${label}»`
      if (!(r.self || r.live || r.opened || r.other || navigated || chooser)) found.push({ rule: 'silent-click', screen, where, detail: 'nothing visible changed within 1 s' })
      else if (r.other && !r.self && !r.live && !r.opened && !navigated && !chooser) found.push({ rule: 'change-unannounced', screen, where, detail: 'the screen changed, but neither the button, a status region nor a dialog said so' })
      if (r.red) found.push({ rule: 'error-unannounced', screen, where, detail: `red text outside any alert/status region: «${r.red}»` })
      if (r.shift > 0.05) found.push({ rule: 'abrupt-insert', screen, where, detail: `layout shift ${r.shift}` })
    }
  }
  await ctx.close()
  return { pressed, skipped }
}

function report(cfg, found, stats, notes) {
  const byRule = {}
  const seen = new Set()
  for (const v of found) {
    const key = `${v.rule}|${v.screen}|${v.where}|${v.detail}`
    if (seen.has(key)) continue
    seen.add(key)
    const level = cfg.rules[v.rule]
    if (level === 'off' || ignored(cfg, v)) continue
    ;(byRule[v.rule] ||= { level, hits: [] }).hits.push(v)
  }
  const lines = [`ui-check: ${stats.screens} screen(s)${stats.pressed != null ? ` · ${stats.pressed} button(s) pressed${stats.unsafe ? `, ${stats.unsafe} skipped as unsafe` : ''}` : ''}`]
  const order = Object.entries(byRule).sort(([, a], [, b]) => (a.level === b.level ? b.hits.length - a.hits.length : a.level === 'block' ? -1 : 1))
  for (const [rule, { level, hits }] of order) {
    lines.push(`${level.toUpperCase().padEnd(5)} ${rule} (${hits.length}) — ${RULES[rule]}`)
    for (const h of hits.slice(0, 3)) lines.push(`      ${h.screen} ${h.where} — ${h.detail}`)
    if (hits.length > 3) lines.push(`      … ${hits.length - 3} more`)
  }
  for (const n of notes) lines.push(`SKIP  ${n}`)
  const blocking = order.filter(([, r]) => r.level === 'block').map(([rule]) => rule)
  const warnings = order.filter(([, r]) => r.level === 'warn').map(([rule]) => rule)
  lines.push(blocking.length ? `RESULT: FAIL — blocking: ${blocking.join(', ')}` : `RESULT: PASS${warnings.length ? ` — ${warnings.length} rule(s) warn` : ''}`)
  return { lines, blocking, warnings, byRule }
}

async function main(argv) {
  const args = parseArgs(argv)
  if (args.help) {
    process.stdout.write(`${fs.readFileSync(__filename, 'utf8').split('\n').filter((l) => l.startsWith('//')).slice(0, 22).map((l) => l.slice(3)).join('\n')}\n\nRules:\n${Object.entries(RULES).map(([k, v]) => `  ${k.padEnd(22)} ${v}`).join('\n')}\n`)
    return 0
  }
  const cwd = process.cwd()
  const cfg = loadConfig(args, cwd)
  const pw = loadPlaywright(cwd)
  if (!pw) { console.log('ui-check: NOT VERIFIED — Playwright not found in the project or the global npm root (npm i -D playwright-core)'); return 3 }
  const axePath = resolveFrom('axe-core', cwd)
  const axeSrc = axePath ? fs.readFileSync(path.join(path.dirname(axePath), 'axe.min.js'), 'utf8') : null
  const notes = axeSrc || cfg.rules.accessibility === 'off' ? [] : ['accessibility — axe-core not found (npm i -D axe-core)']

  const stop = cfg.serve ? serveStart(cfg.serve, cwd) : () => {}
  try {
    if (!(await reachable(cfg.url, cfg.serve ? 60000 : 5000))) { console.log(`ui-check: NOT VERIFIED — ${cfg.url} did not answer${cfg.serve ? ' after starting the server' : ' (start the app, or set "serve")'}`); return 3 }
    let browser
    try { browser = await launch(pw) } catch (e) { console.log(`ui-check: NOT VERIFIED — no browser could start: ${e.message.split('\n')[0]}`); return 3 }
    const found = []
    if (args.shots) fs.mkdirSync(args.shots, { recursive: true })
    const stats = {}
    const notReady = []
    try {
      stats.screens = await runStatic(browser, cfg, axeSrc, args.shots, found, notReady)
      if (!stats.screens) { console.log(`ui-check: NOT VERIFIED — no screen became ready:\n${notReady.slice(0, 3).join('\n')}`); return 3 }
      if (cfg.interactions.enabled) {
        const r = await runInteractions(browser, cfg, found)
        stats.pressed = r.pressed
        stats.unsafe = r.skipped
      }
    } finally {
      await browser.close()
    }
    notes.push(...notReady)
    const rep = report(cfg, found, stats, notes)
    if (args.json) fs.writeFileSync(args.json, JSON.stringify({ stats, blocking: rep.blocking, warnings: rep.warnings, skipped: notes, violations: rep.byRule }, null, 1))
    if (!args.quiet || rep.blocking.length) console.log(rep.lines.join('\n'))
    return rep.blocking.length ? 2 : 0
  } finally {
    stop()
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.log(`ui-check: error — ${e.message}`); process.exit(1) })
}

module.exports = { RULES, LEVELS, UNSAFE, staticRules, loadConfig, report, main }
