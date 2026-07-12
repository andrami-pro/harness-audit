#!/bin/sh
# harness-audit installer — copies the skill folder to the directory your
# coding agent reads, then bootstraps the Graphify code graph the loops query
# instead of grepping the repo cold. The plugin path (Claude Code) needs no
# installer for the loops/agents themselves:
#   /plugin marketplace add andrami-pro/harness-audit
#   /plugin install harness-audit@harness-audit
#
# Usage:
#   ./install.sh --target claude       # project-level  .claude/skills/
#   ./install.sh --target claude-user  # user-level     ~/.claude/skills/
#   ./install.sh --target cursor       # project-level  .cursor/skills/
#   ./install.sh --target kilo         # user-level     ~/.kilo/skills/
#   ./install.sh --target antigravity  # project-level  .agents/skills/
#   ./install.sh --target pi           # project-level  .pi/skills/ + .pi/prompts/ (4) + .pi/agents/ (7) — see NOTE below
#   ./install.sh --target opencode     # project-level  .opencode/{commands,agents}/ — the 5 loop
#                                       # commands + 7 agents, native (OpenCode has Task tool)
#   ./install.sh --target kilo-loops   # project-level  .kilo/{commands,agents}/ — same port,
#                                       # separate from the `kilo` skill-only target above
#
#   --skip-graphify   degraded mode: skip the Graphify check entirely.
#                      The audit still runs but marks the Graphify criterion
#                      FAIL instead of aborting — critics fall back to grep.
#   --yes             non-interactive: answer yes to the Graphify install
#                      prompt without asking (for CI); also auto-confirms a
#                      SOFT model-lineup guardrail (see --lineup below).
#                      Does NOT bypass the --target pi subagent gate below —
#                      that gate is hard, not confirmable (see NOTE on pi).
#   --lineup [path]   resolve scripts/model-lineup.js (D25) for $TARGET and
#                      re-stamp the `model:` frontmatter of commands/*.md and
#                      agents/*.md before copying them alongside the skill.
#                      Without a path: merges ~/.agents/model-lineup.json
#                      (global) with .agents/model-lineup.json (this project,
#                      overrides the global). With a path: uses that file
#                      as-is, no merge — meant for a specific test lineup.
#                      Omitting --lineup entirely leaves today's defaults
#                      intact: no lineup resolution, no frontmatter rewrite.
#   --skip-subagent-check   --target pi only. Generate .pi/agents/ even
#                      though the pi-subagents extension isn't detected.
#                      These agents WILL NOT dispatch until it's installed —
#                      this flag exists for testing the port, not for normal
#                      use. See NOTE on pi below.
#
# NOTE on --target pi: Pi's core has no Task tool — per pi.dev, "Pi ships with
# powerful defaults but skips features like sub-agents". All 5 loop commands
# in this repo dispatch subagents, so a Pi port only works through the
# third-party pi-subagents extension (github.com/nicobailon/pi-subagents,
# `pi install npm:pi-subagents`). --target pi checks for it before writing
# anything: found → ports 4 of the 5 commands/*.md to .pi/prompts/ (Pi's own
# prompt-template format, a native discovery location, invoked the same way,
# by typing /orchestrate etc.) and all 7 agents/*.md to .pi/agents/ in the
# pi-subagents schema; missing → fails with the install command, unless
# --skip-subagent-check is passed, in which case it writes the same files
# with a loud warning that they are inert without the extension — nothing
# here dispatches a subagent without it, commands included.
# session-review is the 5th command and does NOT port: it shells out to
# ${CLAUDE_PLUGIN_ROOT}/scripts/loop-stats.js and reads Claude Code's own
# transcripts. See PI_UNPORTABLE_COMMANDS in scripts/port-loops.js.
#
# Project-level targets install into the CURRENT working directory's project.

set -eu

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$ROOT_DIR/skills/harness-audit"
TARGET=""
SKIP_GRAPHIFY=0
ASSUME_YES=0
SKIP_SUBAGENT_CHECK=0
LINEUP_REQUESTED=0
LINEUP_FILE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="${2:-}"; shift 2 ;;
    --skip-graphify) SKIP_GRAPHIFY=1; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    --skip-subagent-check) SKIP_SUBAGENT_CHECK=1; shift ;;
    --lineup)
      LINEUP_REQUESTED=1
      shift
      case "${1:-}" in
        ''|--*) ;;
        *) LINEUP_FILE="$1"; shift ;;
      esac
      ;;
    *) echo "error: unknown argument '$1'" >&2; exit 1 ;;
  esac
done

[ -n "$TARGET" ] || { echo "Usage: ./install.sh --target {claude|claude-user|cursor|kilo|antigravity|pi|opencode|kilo-loops} [--skip-graphify] [--yes] [--lineup [path]] [--skip-subagent-check]" >&2; exit 1; }
[ -d "$SRC_DIR" ] || { echo "error: $SRC_DIR not found (run from the repo root)" >&2; exit 1; }

case "$TARGET" in
  claude)       DEST=".claude/skills/harness-audit" ;;
  claude-user)  DEST="$HOME/.claude/skills/harness-audit" ;;
  cursor)       DEST=".cursor/skills/harness-audit" ;;
  kilo)         DEST="$HOME/.kilo/skills/harness-audit" ;;
  antigravity)  DEST=".agents/skills/harness-audit" ;;
  pi)           DEST=".pi/skills/harness-audit" ;;
  # loops-only targets: no skill copy here. OpenCode/Kilo already read .claude/skills/ natively
  # (per the PRD's F9 research), and Kilo's skill-only path lives under the `kilo` target above.
  opencode)     DEST="" ;;
  kilo-loops)   DEST="" ;;
  *) echo "error: unknown target '$TARGET' (use claude|claude-user|cursor|kilo|antigravity|pi|opencode|kilo-loops)" >&2; exit 1 ;;
esac

if [ -n "$DEST" ]; then
  mkdir -p "$DEST"
  cp -R "$SRC_DIR"/. "$DEST"/

  echo "✓ harness-audit installed at $DEST"
  echo "  Files: $(ls "$DEST" | tr '\n' ' ')"
  case "$TARGET" in
    claude|claude-user) echo "  Invoke with: /harness-audit (or just ask for a harness audit)" ;;
    kilo) echo "  Tip: Kilo can also read ~/.claude/skills — see kilo.jsonc 'skills.paths'." ;;
    *) echo "  The skill follows the open Agent Skills standard (agentskills.io)." ;;
  esac
  echo "  Note: the security hooks only load via the Claude Code plugin install, not via skill copy."
fi

# ── Graphify bootstrap (D21) ──────────────────────────────────────────────
# The critics, scorer, and the audit itself query the Graphify graph instead
# of grepping the repo. Missing it is not fatal — it degrades the audit
# (Graphify criterion FAILs, critics fall back to grep) but never aborts.
echo ""
if [ "$SKIP_GRAPHIFY" -eq 1 ]; then
  echo "⚠ --skip-graphify: running in degraded mode. The audit will mark the"
  echo "  Graphify criterion FAIL and critics will grep the repo cold instead"
  echo "  of querying a graph. Install later with: uv tool install graphifyy"
elif command -v graphify >/dev/null 2>&1; then
  if [ -f "graphify-out/graph.json" ]; then
    echo "✓ Graphify CLI found, graph already exists at graphify-out/graph.json"
  else
    echo "→ Graphify CLI found, no graph yet — bootstrapping (local AST, no network)…"
    graphify extract . --code-only
  fi
else
  DO_INSTALL=0
  if [ "$ASSUME_YES" -eq 1 ]; then
    DO_INSTALL=1
  elif [ -t 0 ]; then
    printf '%s' "Graphify not found. Install now via 'uv tool install graphifyy'? [Y/n] "
    read -r REPLY || REPLY=""
    case "$REPLY" in
      [nN]*) DO_INSTALL=0 ;;
      *) DO_INSTALL=1 ;;
    esac
  else
    # Non-interactive shell without --yes or --skip-graphify: default to install,
    # same as an interactive Enter — this installer never silently skips the check.
    DO_INSTALL=1
  fi

  if [ "$DO_INSTALL" -eq 1 ]; then
    if command -v uv >/dev/null 2>&1; then
      echo "→ uv tool install graphifyy"
      uv tool install graphifyy
    elif command -v pipx >/dev/null 2>&1; then
      echo "→ uv not found, falling back to: pipx install graphifyy"
      pipx install graphifyy
    elif command -v pip >/dev/null 2>&1; then
      echo "→ uv/pipx not found, falling back to: pip install graphifyy"
      pip install graphifyy
    else
      echo "⚠ none of uv/pipx/pip found — cannot install Graphify automatically."
      echo "  Install one of them, then: uv tool install graphifyy"
      echo "  Continuing in degraded mode (Graphify criterion will FAIL)."
    fi
    if command -v graphify >/dev/null 2>&1; then
      echo "→ Graphify installed — bootstrapping the graph (local AST, no network)…"
      graphify extract . --code-only
    fi
  else
    echo "⚠ Skipping Graphify install. Continuing in degraded mode — the audit"
    echo "  will mark the Graphify criterion FAIL and critics will grep the repo"
    echo "  cold. Install later with: uv tool install graphifyy"
  fi
fi

# ── Loop port: OpenCode / Kilo Code / Pi (F9) ───────────────────────────────
# opencode and kilo-loops are a mechanical frontmatter transform (both share one schema — see
# scripts/port-loops.js). pi is gated: its core has no Task tool, so the port only means anything
# with the third-party pi-subagents extension installed — see the NOTE at the top of this file.
case "$TARGET" in
  opencode|kilo-loops|pi)
    echo ""
    PORTER="$ROOT_DIR/scripts/port-loops.js"
    [ -f "$PORTER" ] || { echo "error: $PORTER not found (run from the repo root)" >&2; exit 1; }
    command -v node >/dev/null 2>&1 || { echo "error: --target $TARGET needs Node >= 18 to port commands/agents" >&2; exit 1; }

    if [ "$TARGET" = "pi" ]; then
      PI_SUBAGENTS_FOUND=0
      for f in "$HOME/.pi/agent/settings.json" "$(pwd)/.pi/settings.json"; do
        if [ -f "$f" ] && grep -q "pi-subagents" "$f" 2>/dev/null; then PI_SUBAGENTS_FOUND=1; fi
      done
      # `pi install npm:<pkg>` installs under npm/ — so the package lands in npm/node_modules/<pkg>,
      # not npm/<pkg>. Checking the latter is a check that can never fire.
      [ -d "$HOME/.pi/agent/npm/node_modules/pi-subagents" ] && PI_SUBAGENTS_FOUND=1
      [ -d "$(pwd)/.pi/npm/node_modules/pi-subagents" ] && PI_SUBAGENTS_FOUND=1

      if [ "$PI_SUBAGENTS_FOUND" -eq 0 ]; then
        echo "⚠ pi-subagents extension not found (checked ~/.pi/agent/settings.json,"
        echo "  ./.pi/settings.json, and both npm/ install dirs)."
        echo "  Pi's core has no sub-agent support — per pi.dev: \"Pi ships with powerful"
        echo "  defaults but skips features like sub-agents\". Every loop command in this"
        echo "  repo dispatches subagents (via the ported .pi/prompts/*.md), and all 7 agents"
        echo "  are just their dispatch targets — both would look like a working port and"
        echo "  dispatch nothing without it."
        echo "  Install it, then re-run this command:"
        echo "    pi install npm:pi-subagents"
        echo "  Verify with: pi list   (or: grep pi-subagents ~/.pi/agent/settings.json)"
        if [ "$SKIP_SUBAGENT_CHECK" -eq 1 ]; then
          echo ""
          echo "⚠⚠⚠ --skip-subagent-check: writing .pi/prompts/ and .pi/agents/ ANYWAY. Neither"
          echo "    dispatches until pi-subagents is installed — this port is INERT until then. ⚠⚠⚠"
        else
          echo ""
          # Hard, not confirmable (same shape as D25a): --yes is for SOFT prompts elsewhere in
          # this script, never for shipping files that silently don't do what they look like.
          echo "error: --target pi aborted — no working subagent dispatch without pi-subagents." >&2
          echo "  Re-run with --skip-subagent-check to write the (inert) files anyway." >&2
          exit 1
        fi
      else
        echo "✓ pi-subagents extension found"
      fi
    fi

    node "$PORTER" --target "$TARGET" --root "$ROOT_DIR"

    # No .pi/settings.json is written for --target pi, and that is a decision, not an omission: an
    # earlier draft of this installer merged a `prompts` entry into it and told the user that entry was
    # what made /orchestrate resolve. It is not. `.pi/prompts/*.md` is a NATIVE discovery location
    # (docs/prompt-templates.md), measured: deleting settings.json entirely and re-running
    # `pi --mode rpc` + get_commands still lists every template. The merge was real code doing nothing,
    # sold as the mechanism — so it is gone, along with the invalid-JSON edge case it needed.

    case "$TARGET" in
      opencode|kilo-loops)
        echo ""
        echo "⚠ The manual-only guardrail does NOT cross over. In Claude Code, /review-loop,"
        echo "  /iterate and /session-review ship with 'disable-model-invocation: true' — the model"
        echo "  may suggest them, never fire them. Neither OpenCode nor Kilo Code has an equivalent"
        echo "  field, so on this target all three are auto-dispatchable by the model: two of them"
        echo "  are token-hungry, and /session-review analyses YOU. Put the restriction in your"
        echo "  AGENTS.md and check it holds — nothing enforces it locally anymore."
        echo ""
        echo "⚠ The 'model:' line in each ported agent is still a Claude alias (sonnet/fable/opus),"
        echo "  which this target cannot resolve. Re-run with --lineup to stamp real provider/model"
        echo "  ids, or edit the files by hand."
        ;;
      pi)
        echo ""
        echo "✓ You got 4 of the 5 loop commands: /orchestrate, /skill-loop, /review-loop and /iterate are now"
        echo "  Pi prompt templates (.pi/prompts/*.md) — type /orchestrate etc. exactly as in Claude"
        echo "  Code. Each instructs the parent Pi session to dispatch the 7 ported agents"
        echo "  (.pi/agents/*.md) via the pi-subagents 'subagent' tool; rounds, stop conditions and"
        echo "  findings aggregation are unchanged from the source command. /session-review is NOT"
        echo "  among them — see the warning printed above."
        echo ""
        echo "⚠ Pi only loads project .pi/ resources AFTER you TRUST the project. Interactive Pi asks"
        echo "  on first start (or run /trust); non-interactive modes (-p, --mode json, --mode rpc)"
        echo "  never ask and skip them unless defaultProjectTrust is 'always' or you pass --approve."
        echo "  Until then these templates and agents are on disk and invisible."
        echo ""
        echo "⚠ This repo's /review-loop SHADOWS the /review-loop that pi-subagents itself ships"
        echo "  (project prompts win over package prompts). If you were using the extension's own"
        echo "  review loop, that name is now this repo's Loop 4. Rename either file to keep both."
        echo ""
        echo "⚠ The manual-only guardrail is preserved by CONSTRUCTION here, not by a matching field:"
        echo "  a prompt template only ever expands when something types /name — nothing exposed to"
        echo "  the model (no builtin tool, no pi-subagents tool) lets it invoke one itself. So"
        echo "  /review-loop and /iterate stay human-fired on Pi, unlike on OpenCode/Kilo Code where"
        echo "  the equivalent field is dropped outright."
        echo ""
        echo "⚠ correctness-critic lost WebSearch (pi-subagents has no verified equivalent builtin)."
        echo "  Its whole job is checking claims against the web; on Pi it cannot. Install"
        echo "  pi-web-access and add its tools to that agent's frontmatter, or do not rely on it here."
        echo ""
        echo "⚠ The 'model:' line in each ported agent (and none of the commands, which carry no"
        echo "  model: field) is still a Claude alias (sonnet/fable/opus), which pi-subagents cannot"
        echo "  resolve. Re-run with --lineup to stamp real provider/model ids, or edit by hand."
        ;;
    esac
    ;;
esac

# ── Model line-up (D25/F11) ─────────────────────────────────────────────────
# Resolution happens HERE, at install time — the copies this writes are static, portable
# frontmatter, not a runtime indirection. Without --lineup none of this runs and today's
# defaults (whatever model: each agent already ships with) are untouched.
if [ "$LINEUP_REQUESTED" -eq 1 ]; then
  echo ""
  RESOLVER="$ROOT_DIR/scripts/model-lineup.js"
  [ -f "$RESOLVER" ] || { echo "error: $RESOLVER not found (run from the repo root)" >&2; exit 1; }
  command -v node >/dev/null 2>&1 || { echo "error: --lineup needs Node >= 18" >&2; exit 1; }

  if [ -n "$LINEUP_FILE" ]; then
    RESOLVE_ARGS="--file $LINEUP_FILE"
  else
    RESOLVE_ARGS="--global $HOME/.agents/model-lineup.json --project $(pwd)/.agents/model-lineup.json"
  fi

  LINEUP_TMP="${TMPDIR:-/tmp}/harness-audit-lineup.$$.json"
  trap 'rm -f "$LINEUP_TMP"' EXIT

  set +e
  # shellcheck disable=SC2086 — RESOLVE_ARGS is a controlled, space-separated flag pair.
  node "$RESOLVER" resolve --target "$TARGET" $RESOLVE_ARGS >"$LINEUP_TMP"
  RESOLVE_STATUS=$?
  set -e

  if [ "$RESOLVE_STATUS" -eq 2 ]; then
    # node already printed the HARD-violation reason to stderr — nothing left to say, and
    # nothing to prompt: D25a has no confirmable path.
    exit 1
  elif [ "$RESOLVE_STATUS" -ne 0 ]; then
    echo "error: model-lineup.js could not resolve the line-up (see above)." >&2
    exit 1
  fi
  echo "✓ model line-up resolved for target '$TARGET'"

  lineup_get() {
    node -e "const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); process.stdout.write(String($1))" "$LINEUP_TMP"
  }

  FALLBACK_COUNT="$(lineup_get 'd.providerFallbacks.length')"
  if [ "$FALLBACK_COUNT" -gt 0 ]; then
    echo "⚠ provider not supported by target '$TARGET' — falling back to the Anthropic default:"
    lineup_get 'd.providerFallbacks.map(f => `  role "${f.role}": provider "${f.provider}" (${f.model}) ignored`).join("\n")+"\n"'
  fi

  UNKNOWN_COUNT="$(lineup_get 'd.unknownModels.length')"
  if [ "$UNKNOWN_COUNT" -gt 0 ]; then
    echo "⚠ unrecognized model id(s), no guardrail data — proceeding: $(lineup_get 'd.unknownModels.join(", ")')"
  fi

  SOFT_COUNT="$(lineup_get 'd.softViolations.length')"
  i=0
  while [ "$i" -lt "$SOFT_COUNT" ]; do
    MSG="$(lineup_get "d.softViolations[$i].message")"
    S_ROLE="$(lineup_get "d.softViolations[$i].role")"
    S_MODEL="$(lineup_get "d.softViolations[$i].model")"
    echo ""
    echo "⚠ SOFT guardrail (D25b, confirmable — per project, never edits validate.js's invariant):"
    echo "  $MSG"
    CONFIRMED=0
    if [ "$ASSUME_YES" -eq 1 ]; then
      CONFIRMED=1
      echo "  --yes: auto-confirmed for this project."
    elif [ -t 0 ]; then
      printf '%s' "  Confirm for THIS project only? [y/N] "
      read -r REPLY || REPLY=""
      case "$REPLY" in
        [yY]*) CONFIRMED=1 ;;
        *) CONFIRMED=0 ;;
      esac
    else
      echo "  error: non-interactive shell without --yes — a SOFT guardrail cannot be confirmed" >&2
      echo "  silently. Re-run with --yes, or interactively, or fix the line-up." >&2
      exit 1
    fi
    if [ "$CONFIRMED" -eq 1 ]; then
      PROJECT_LINEUP_OUT="$(pwd)/.agents/model-lineup.json"
      node "$RESOLVER" record-exception --project "$PROJECT_LINEUP_OUT" --role "$S_ROLE" --model "$S_MODEL" \
        --note "confirmed via install.sh --lineup ($TARGET)" >/dev/null
      echo "  → confirmed, recorded in $PROJECT_LINEUP_OUT (this project only)."
    else
      echo "  error: install cancelled — SOFT guardrail not confirmed for role '$S_ROLE'." >&2
      exit 1
    fi
    i=$((i + 1))
  done

  # ── Re-stamp commands/*.md and agents/*.md, then install them alongside the skill ────
  case "$TARGET" in
    claude)      CMD_DEST=".claude/commands"; AGENT_DEST=".claude/agents" ;;
    claude-user) CMD_DEST="$HOME/.claude/commands"; AGENT_DEST="$HOME/.claude/agents" ;;
    # F9: pi/opencode/kilo-loops already have their own port step above (schema-transformed,
    # commands/ absent for pi) — this section only re-stamps model: on top of it, never re-copies.
    pi)          CMD_DEST=""; AGENT_DEST=".pi/agents" ;;
    opencode)    CMD_DEST=".opencode/commands"; AGENT_DEST=".opencode/agents" ;;
    kilo-loops)  CMD_DEST=".kilo/commands"; AGENT_DEST=".kilo/agents" ;;
    *)           CMD_DEST=""; AGENT_DEST="" ;;
  esac

  if [ -n "$AGENT_DEST" ]; then
    case "$TARGET" in
      pi|opencode|kilo-loops)
        # Re-copying commands/agents/. here would overwrite the F9 port's schema-transformed
        # files with raw Claude Code frontmatter — incompatible with OpenCode/Kilo/pi-subagents.
        [ -d "$AGENT_DEST" ] || { echo "error: $AGENT_DEST missing — the F9 port step must run before --lineup can re-stamp it" >&2; exit 1; }
        ;;
      *)
        mkdir -p "$CMD_DEST" "$AGENT_DEST"
        cp -R "$ROOT_DIR"/commands/. "$CMD_DEST"/
        cp -R "$ROOT_DIR"/agents/. "$AGENT_DEST"/
        ;;
    esac

    # Static role→file convention (not a frontmatter field): the four critics share one role,
    # the scorer is its own, skill-improver plays the editor/implementer role for Loop 2.
    # process-optimizer is intentionally absent — its model is pinned to sonnet (D8) and the
    # line-up never touches it. commands/*.md carry no model: field at all (they run in the
    # session's own model by design), so only agents/ is stamped.
    STAMPED=0
    for f in "$AGENT_DEST"/*.md; do
      [ -f "$f" ] || continue
      case "$(basename "$f")" in
        correctness-critic.md|domain-critic.md|safety-critic.md|style-critic.md) ROLE=critic ;;
        scorer.md) ROLE=scorer ;;
        skill-improver.md) ROLE=implementer ;;
        *) ROLE="" ;;
      esac
      [ -n "$ROLE" ] || continue
      STAMP="$(lineup_get "(d.resolved['$ROLE'] && d.resolved['$ROLE'].stamp) || ''")"
      [ -n "$STAMP" ] || continue
      if grep -q '^model:' "$f"; then
        sed -i "s#^model:.*#model: $STAMP#" "$f"
        STAMPED=$((STAMPED + 1))
      fi
    done
    if [ -n "$CMD_DEST" ]; then
      echo "✓ commands/ + agents/ installed at $CMD_DEST and $AGENT_DEST — $STAMPED agent(s) re-stamped for target '$TARGET'"
    else
      echo "✓ agents/ installed at $AGENT_DEST — $STAMPED agent(s) re-stamped for target '$TARGET' (no commands/ port for this target)"
    fi
  else
    echo "⚠ --lineup: no commands/agents install path for target '$TARGET' yet (that target gets loops via"
    echo "  the Claude Code plugin marketplace instead) — the skill copy above is unaffected."
  fi
fi
