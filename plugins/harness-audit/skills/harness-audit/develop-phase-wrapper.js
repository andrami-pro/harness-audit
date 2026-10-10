export const meta = {
  name: 'develop-phase',
  description: 'Project wrapper around the global develop-phase loop (harness-loops): this file is the project config, the loop lives in the plugin.',
}

// This file is the project's config, and only that. The loop (scout → analyst → implementer → reviewer →
// preflight → commit) is one global script that the harness-loops plugin keeps current, so an improvement
// reaches every project at once. Change the config here; never copy the loop into the project.
// Per-run args override any key below: { task, maxIter, preparer, reviewerModel, analystModel, commit, … }
const CONFIG = {
  lang: '__LANG__',
  preflight: '__PREFLIGHT__',
  models: __MODELS__,
  context: __CONTEXT__,
  forbidden: __FORBIDDEN__,
  commit: false,
}

// Where the global script is: the copy harness-loops keeps at ~/.claude/harness/ (workflow() does not
// expand `~`, so the path is absolute), then the plugin's own workflow by name.
const GLOBAL = [{ scriptPath: '__HOME__/.claude/harness/develop-phase.js' }, 'harness-loops:develop-phase']
const runArgs = args && typeof args === 'object' ? args : typeof args === 'string' ? { task: args } : {}
const merged = { ...CONFIG, ...runArgs, models: { ...CONFIG.models, ...(runArgs.models ?? {}) } }
for (const ref of GLOBAL) {
  try {
    return await workflow(ref, merged)
  } catch (e) {
    // Only "not there" moves on to the next place. An error from inside the loop is the loop's, and a
    // second attempt would run the seats twice.
    if (!/not found|no workflow with that name/i.test(String(e && e.message))) throw e
  }
}
return {
  task: merged.task, iterations: 0, approved: false, preflightPassed: false, commit: null,
  handoff: {
    status: 'blocked',
    summary: 'The global develop-phase script was not found',
    evidence: [],
    blocker: 'Install the harness-loops plugin and start a new session (it copies the script to ~/.claude/harness/), or run install.sh --target claude from the harness-audit repository',
  },
  nextStep: 'Install harness-loops, then re-run',
}
