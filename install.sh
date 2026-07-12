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
#
#   --skip-graphify   degraded mode: skip the Graphify check entirely.
#                      The audit still runs but marks the Graphify criterion
#                      FAIL instead of aborting — critics fall back to grep.
#   --yes             non-interactive: answer yes to the Graphify install
#                      prompt without asking (for CI).
#
# Project-level targets install into the CURRENT working directory's project.

set -eu

SRC_DIR="$(cd "$(dirname "$0")" && pwd)/skills/harness-audit"
TARGET=""
SKIP_GRAPHIFY=0
ASSUME_YES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="${2:-}"; shift 2 ;;
    --skip-graphify) SKIP_GRAPHIFY=1; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    *) echo "error: unknown argument '$1'" >&2; exit 1 ;;
  esac
done

[ -n "$TARGET" ] || { echo "Usage: ./install.sh --target {claude|claude-user|cursor|kilo|antigravity} [--skip-graphify] [--yes]" >&2; exit 1; }
[ -d "$SRC_DIR" ] || { echo "error: $SRC_DIR not found (run from the repo root)" >&2; exit 1; }

case "$TARGET" in
  claude)       DEST=".claude/skills/harness-audit" ;;
  claude-user)  DEST="$HOME/.claude/skills/harness-audit" ;;
  cursor)       DEST=".cursor/skills/harness-audit" ;;
  kilo)         DEST="$HOME/.kilo/skills/harness-audit" ;;
  antigravity)  DEST=".agents/skills/harness-audit" ;;
  *) echo "error: unknown target '$TARGET' (use claude|claude-user|cursor|kilo|antigravity)" >&2; exit 1 ;;
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
