#!/bin/sh
# harness-audit installer — copies the skill folder to the directory your
# coding agent reads. The plugin path (Claude Code) needs no installer:
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
# Project-level targets install into the CURRENT working directory's project.

set -eu

SRC_DIR="$(cd "$(dirname "$0")" && pwd)/skills/harness-audit"
TARGET="${2:-}"

[ "${1:-}" = "--target" ] || { echo "Usage: ./install.sh --target {claude|claude-user|cursor|kilo|antigravity}" >&2; exit 1; }
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
