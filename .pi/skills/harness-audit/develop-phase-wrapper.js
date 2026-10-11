export const meta = {
  name: 'develop-phase',
  description: 'Project wrapper around the global develop-phase loop (harness-loops): this file is the project config, the loop lives in the plugin.',
}

// This file is the project's config, and only that. The loop (scout → analyst → implementer → reviewer →
// preflight → commit) is one global script that the harness-loops plugin keeps current, so an improvement
// reaches every project at once. Change the config here; never copy the loop into the project.
// Per-run args override any key below: { task, maxIter, preparer, reviewerModel, analystModel, commit, routeByJev, … }
const CONFIG = {
  lang: '__LANG__',
  preflight: '__PREFLIGHT__',
  models: __MODELS__,
  context: __CONTEXT__,
  forbidden: __FORBIDDEN__,
  commit: false,
  // true: Jev may move the implementer's tier when its confidence clears the measured threshold — down one tier
  // at most and never below sonnet. Read README §Jev (harness-loops) first; the run's `routing` says what it did.
  routeByJev: false,
}

// Where the global script is. workflow() only loads a file the session can already read, so first the copy
// harness-loops keeps inside this project (.claude/harness/, ignored by git), then the one under $HOME
// (readable when that directory is added to the session; workflow() does not expand `~`), then the plugin's
// own workflow by name.
const GLOBAL = [
  { scriptPath: '.claude/harness/develop-phase.js' },
  { scriptPath: '__HOME__/.claude/harness/develop-phase.js' },
  'harness-loops:develop-phase',
]
// A run launched by hand may pass its args as a JSON string; anything else that is a string is the task.
const parsed = typeof args === 'string' && /^\s*\{/.test(args) ? (() => { try { return JSON.parse(args) } catch { return null } })() : null
const runArgs = parsed ?? (args && typeof args === 'object' ? args : typeof args === 'string' ? { task: args } : {})
const merged = { ...CONFIG, ...runArgs, models: { ...CONFIG.models, ...(runArgs.models ?? {}) } }
for (const ref of GLOBAL) {
  try {
    return await workflow(ref, merged)
  } catch (e) {
    // Only "not there" moves on to the next place. An error from inside the loop is the loop's, and a
    // second attempt would run the seats twice.
    if (!/not found|no workflow with that name|can already read/i.test(String(e && e.message))) throw e
  }
}
return {
  task: merged.task, iterations: 0, approved: false, preflightPassed: false, commit: null,
  handoff: {
    status: 'blocked',
    summary: 'The global develop-phase script was not found',
    evidence: [],
    blocker: 'Install the harness-loops plugin and start a new session in this project (it copies the loop to .claude/harness/), or run install.sh --target claude from the harness-audit repository',
  },
  nextStep: 'Install harness-loops, then re-run',
}
