#!/usr/bin/env bash
# SessionStart hook (all projects): tell Claude and the user when this repo's harness
# baseline is older than the current one in ~/.claude/harness-baseline/VERSION.
# Silent when the repo is up to date or is not a git repo.
set -uo pipefail

input=$(cat)
dir=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)
dir=${dir:-${CLAUDE_PROJECT_DIR:-$PWD}}
root=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null) || exit 0
[ "$root" = "$HOME" ] && exit 0

current=$(tr -d '[:space:]' < "$HOME/.claude/harness-baseline/VERSION" 2>/dev/null) || exit 0
[ -n "$current" ] || exit 0
have=""
[ -f "$root/.claude/harness-baseline" ] && have=$(tr -d '[:space:]' < "$root/.claude/harness-baseline")

[ "$have" = "$current" ] && exit 0
[ -n "$have" ] && [ "$(printf '%s\n%s\n' "$have" "$current" | sort -V | tail -1)" = "$have" ] && exit 0

state=${have:-ninguno}
jq -n --arg p "$(basename "$root")" --arg have "$state" --arg cur "$current" '{
  systemMessage: ("Arnés de " + $p + ": baseline " + $have + ", el actual es " + $cur + ". Ponlo al día con /arnes-al-dia."),
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: ("El baseline de arnés de este repo (" + $have + ") es anterior al actual (" + $cur + "). En tu primera respuesta díselo al usuario en una línea y ofrécele /arnes-al-dia; no lo ejecutes sin que lo pida. Lo que trae cada versión está en ~/.claude/harness-baseline/CHANGELOG.md.")
  }
}'
