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
#   ./install.sh --target pi           # project-level  .pi/{commands,agents}/ — see NOTE below
#
#   --skip-graphify   degraded mode: skip the Graphify check entirely.
#                      The audit still runs but marks the Graphify criterion
#                      FAIL instead of aborting — critics fall back to grep.
#   --yes             non-interactive: answer yes to the Graphify install
#                      prompt without asking (for CI); also auto-confirms a
#                      SOFT model-lineup guardrail (see --lineup below).
#   --lineup [path]   resolve scripts/model-lineup.js (D25) for $TARGET and
#                      re-stamp the `model:` frontmatter of commands/*.md and
#                      agents/*.md before copying them alongside the skill.
#                      Without a path: merges ~/.agents/model-lineup.json
#                      (global) with .agents/model-lineup.json (this project,
#                      overrides the global). With a path: uses that file
#                      as-is, no merge — meant for a specific test lineup.
#                      Omitting --lineup entirely leaves today's defaults
#                      intact: no lineup resolution, no frontmatter rewrite.
#
# NOTE on --target pi: Pi has no Task tool in core (subagents need its example
# extension, per the PRD's F9 research) — this target exists ONLY to exercise
# --lineup's multi-provider resolution end to end (D25/F11). It is not a real
# Pi port; that is F9's job.
#
# Project-level targets install into the CURRENT working directory's project.

set -eu

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$ROOT_DIR/skills/harness-audit"
TARGET=""
SKIP_GRAPHIFY=0
ASSUME_YES=0
LINEUP_REQUESTED=0
LINEUP_FILE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="${2:-}"; shift 2 ;;
    --skip-graphify) SKIP_GRAPHIFY=1; shift ;;
    --yes) ASSUME_YES=1; shift ;;
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

[ -n "$TARGET" ] || { echo "Usage: ./install.sh --target {claude|claude-user|cursor|kilo|antigravity|pi} [--skip-graphify] [--yes] [--lineup [path]]" >&2; exit 1; }
[ -d "$SRC_DIR" ] || { echo "error: $SRC_DIR not found (run from the repo root)" >&2; exit 1; }

case "$TARGET" in
  claude)       DEST=".claude/skills/harness-audit" ;;
  claude-user)  DEST="$HOME/.claude/skills/harness-audit" ;;
  cursor)       DEST=".cursor/skills/harness-audit" ;;
  kilo)         DEST="$HOME/.kilo/skills/harness-audit" ;;
  antigravity)  DEST=".agents/skills/harness-audit" ;;
  pi)           DEST=".pi/skills/harness-audit" ;;
  *) echo "error: unknown target '$TARGET' (use claude|claude-user|cursor|kilo|antigravity|pi)" >&2; exit 1 ;;
esac

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
    pi)          CMD_DEST=".pi/commands"; AGENT_DEST=".pi/agents" ;;
    *)           CMD_DEST=""; AGENT_DEST="" ;;
  esac

  if [ -n "$AGENT_DEST" ]; then
    mkdir -p "$CMD_DEST" "$AGENT_DEST"
    cp -R "$ROOT_DIR"/commands/. "$CMD_DEST"/
    cp -R "$ROOT_DIR"/agents/. "$AGENT_DEST"/

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
    echo "✓ commands/ + agents/ installed at $CMD_DEST and $AGENT_DEST — $STAMPED agent(s) re-stamped for target '$TARGET'"
  else
    echo "⚠ --lineup: no commands/agents install path for target '$TARGET' yet (that target gets loops via"
    echo "  the Claude Code plugin marketplace instead) — the skill copy above is unaffected."
  fi
fi
