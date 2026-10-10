#!/bin/sh
# dp-tail.sh — follows whichever <seat>.live.log in a develop-phase-pi.js run dir was written to most
# recently, switching to the new one the moment a new seat becomes active. Used as the "active agent"
# pane in dp-tmux.sh; also runnable by hand: dp-tail.sh <runDir>.
set -eu
RUN_DIR="${1:?usage: dp-tail.sh <runDir>}"
CURRENT=""
PID=""

cleanup() { [ -n "$PID" ] && kill "$PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

while true; do
  LATEST=$(ls -t "$RUN_DIR"/*.live.log 2>/dev/null | head -1 || true)
  if [ -n "$LATEST" ] && [ "$LATEST" != "$CURRENT" ]; then
    [ -n "$PID" ] && kill "$PID" 2>/dev/null || true
    clear
    printf '\033[1m── %s ──\033[0m\n' "$(basename "$LATEST" .live.log)"
    tail -n +1 -F "$LATEST" &
    PID=$!
    CURRENT="$LATEST"
  fi
  sleep 1
done
