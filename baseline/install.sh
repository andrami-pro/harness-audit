#!/usr/bin/env bash
# Copies the user-level harness baseline from this folder to where Claude Code and Pi read it.
# This folder is the source; the copies under ~/.claude and ~/.pi are what the tools run.
#
#   baseline/install.sh           copy; a destination that differs is kept as <file>.bak-<date> first
#   baseline/install.sh --check   copy nothing; list files that differ and exit 1 if any do
#
# Copies, not symlinks: a symlink into a working tree breaks the Stop hook whenever the repository
# is on a branch without this folder, or is moved.
set -euo pipefail

src=$(cd "$(dirname "$0")" && pwd)
check=false
[ "${1:-}" = "--check" ] && check=true

# source (relative to this folder) -> destination
pairs=(
  "VERSION:$HOME/.claude/harness-baseline/VERSION"
  "CHANGELOG.md:$HOME/.claude/harness-baseline/CHANGELOG.md"
  "deny.json:$HOME/.claude/harness-baseline/deny.json"
  "commands/arnes-al-dia.md:$HOME/.claude/commands/arnes-al-dia.md"
  "hooks/baseline-check.sh:$HOME/.claude/hooks/baseline-check.sh"
  "hooks/verify-on-stop.sh:$HOME/.claude/hooks/verify-on-stop.sh"
)
# Pi is optional: only when it is installed on this machine.
[ -d "$HOME/.pi/agent/extensions" ] && pairs+=("pi/harness-baseline.ts:$HOME/.pi/agent/extensions/harness-baseline.ts")

drift=0
for pair in "${pairs[@]}"; do
  from="$src/${pair%%:*}"
  to="${pair#*:}"
  if [ -f "$to" ] && cmp -s "$from" "$to"; then
    continue
  fi
  drift=1
  if $check; then
    [ -f "$to" ] && echo "differs: $to" || echo "missing: $to"
    continue
  fi
  mkdir -p "$(dirname "$to")"
  if [ -f "$to" ]; then
    cp -p "$to" "$to.bak-$(date +%Y-%m-%d)"
    echo "updated: $to (previous kept as $(basename "$to").bak-$(date +%Y-%m-%d))"
  else
    echo "created: $to"
  fi
  cp "$from" "$to"
  case "$to" in *.sh) chmod +x "$to" ;; esac
done

if $check; then
  [ $drift -eq 0 ] && echo "baseline: installed copies match this folder"
  exit $drift
fi
[ $drift -eq 0 ] && echo "baseline: nothing to do, installed copies already match"
exit 0
