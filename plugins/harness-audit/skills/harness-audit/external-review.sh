#!/bin/sh
# Adversarial review by a model Claude Code cannot dispatch (any provider `pi` serves, e.g. OpenRouter).
# The develop-phase workflow calls this from its Review phase when reviewerModel is provider-qualified
# (`openrouter/<vendor>/<model>`); it can also be run by hand from the repo root.
#
#   scripts/external-review.sh <provider/model>
#
# Input the reviewer sees: its role file + the rubric + `git diff HEAD` + untracked files. Nothing else —
# never the implementer's reasoning. Tools are read-only (read, grep, find, ls): it can open files to
# check a claim, never write or run a command.
# Output: the review on stdout; the LAST line is APPROVED or REJECTED (the workflow compares it whole).
# Env: REVIEWER_FILE (default .claude/agents/reviewer.md), RUBRIC_FILE (default harness-rubric.md),
#      MAX_DIFF_BYTES (default 300000), REVIEW_TIMEOUT (seconds, default 900).
set -eu
MODEL="${1:?usage: external-review.sh <provider/model>}"
REVIEWER_FILE="${REVIEWER_FILE:-.claude/agents/reviewer.md}"
RUBRIC_FILE="${RUBRIC_FILE:-harness-rubric.md}"
MAX_DIFF_BYTES="${MAX_DIFF_BYTES:-300000}"
REVIEW_TIMEOUT="${REVIEW_TIMEOUT:-900}"

cd "$(git rev-parse --show-toplevel)"
command -v pi >/dev/null || { echo "external-review: pi not found (needed to reach $MODEL)" >&2; exit 2; }
[ -f "$REVIEWER_FILE" ] || { echo "external-review: $REVIEWER_FILE not found" >&2; exit 2; }
[ -f "$RUBRIC_FILE" ] || { echo "external-review: $RUBRIC_FILE not found" >&2; exit 2; }

PROMPT=$(mktemp)
trap 'rm -f "$PROMPT"' EXIT
{
  # Role file without its YAML frontmatter.
  awk 'n>=2{print} /^---$/{n++}' "$REVIEWER_FILE"
  printf '\n## %s\n\n' "$RUBRIC_FILE"
  cat "$RUBRIC_FILE"
  printf '\n## Diff to review (git diff HEAD)\n\n```diff\n'
  git diff HEAD | head -c "$MAX_DIFF_BYTES"
  printf '\n```\n\n## New files (untracked)\n\n'
  git ls-files --others --exclude-standard | while read -r f; do
    printf '### %s\n```\n' "$f"; head -c 20000 "$f"; printf '\n```\n'
  done
  printf '\nYou may read repository files (read, grep, find, ls) to verify a claim.\n'
  printf 'Forbidden: reading outside this repository, or .env*, *secret*, and any git-ignored file.\n'
  printf 'Format: [PASS|FAIL] criterion — concrete evidence. Last line, alone: APPROVED or REJECTED\n'
} > "$PROMPT"

T=""
command -v timeout >/dev/null && T="timeout $REVIEW_TIMEOUT"
$T pi -p --no-session --model "$MODEL" --tools read,grep,find,ls @"$PROMPT" "Do the review."
