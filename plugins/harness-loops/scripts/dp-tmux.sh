#!/bin/sh
# dp-tmux.sh — opens a live view of a develop-phase-pi.js run: a detached tmux session with the
# hand-off bus on top and the currently active agent's log on the bottom.
#
#   dp-tmux.sh <runDir> [sessionName]
#
# ALWAYS creates a new, uniquely-named session and never touches any existing tmux session, window or
# pane — including the one running `pi` itself, if any. That is deliberate: splitting the pane a TUI is
# drawing into would corrupt it. Attaching is a separate step the human does in another terminal/tab, or
# the caller reports the session name and `develop-phase-pi.js` prints the attach command.
#
# Prints the session name on stdout (nothing else) on success; prints one line to stderr and exits 0,
# never 1, when tmux is missing or a session could not be created — a live view is a convenience, never
# a reason to fail the run that asked for it.
set -eu
RUN_DIR="${1:?usage: dp-tmux.sh <runDir> [sessionName]}"
SESSION="${2:-dp-$(basename "$RUN_DIR" | tail -c 8)}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

command -v tmux >/dev/null 2>&1 || { echo "dp-tmux: tmux not installed — no live view (see docs/loops.md, §Live view)" >&2; exit 0; }
mkdir -p "$RUN_DIR"
: > "$RUN_DIR/bus.log" 2>/dev/null || true

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "$SESSION"
  exit 0
fi

if ! tmux new-session -d -s "$SESSION" -n develop-phase "tail -n +1 -F '$RUN_DIR/bus.log'" 2>/tmp/dp-tmux-err.$$; then
  echo "dp-tmux: could not start a session — $(cat /tmp/dp-tmux-err.$$ 2>/dev/null)" >&2
  rm -f /tmp/dp-tmux-err.$$
  exit 0
fi
rm -f /tmp/dp-tmux-err.$$
tmux split-window -v -t "$SESSION:develop-phase" -l 70% "$SCRIPT_DIR/dp-tail.sh '$RUN_DIR'" 2>/dev/null || true
tmux select-pane -t "$SESSION:develop-phase.0" -T "bus" 2>/dev/null || true
tmux select-pane -t "$SESSION:develop-phase.1" -T "agente activo" 2>/dev/null || true
echo "$SESSION"
