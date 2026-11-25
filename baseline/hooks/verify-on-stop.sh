#!/usr/bin/env bash
# Stop hook (all projects): run the project's own verification gate before Claude
# may finish a turn, and send Claude back to fix it (exit 2) when the gate fails.
#
# Which gate runs, first match wins:
#   1. <repo>/.claude/verify.sh       (executable; the project decides what "green" means)
#   2. package.json script "preflight" (run with the package manager the lockfile implies)
#   3. nothing: projects without a gate are left alone.
#
# The gate only runs when the working tree changed since its last green run, so
# turns that only talk do not pay for it. It blocks only in repos where the gate has
# passed at least once, so breakage that predates the session is reported, not
# enforced. After 3 consecutive failures on the same tree it lets Claude stop and
# tells the user, instead of looping.
#
# Every run of the gate appends one line to ~/.claude/gate-log.ndjson (HARNESS_GATE_LOG overrides):
# repo, gate, result, attempt, seconds. A turn skipped because the tree did not change writes nothing.
# Results: green | blocked (red, Claude sent back) | red-unenforced (never green in this repo) |
# gave-up (3 failures on the same tree).
# `baseline/gate-stats.js` reads it; nothing else does, and nothing leaves the machine.
set -uo pipefail

input=$(cat)
dir=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)
dir=${dir:-${CLAUDE_PROJECT_DIR:-$PWD}}
root=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$root" || exit 0

if [ -x .claude/verify.sh ]; then
  gate=(./.claude/verify.sh)
elif [ -f package.json ] && jq -e '.scripts.preflight' package.json >/dev/null 2>&1; then
  if   [ -f pnpm-lock.yaml ]; then gate=(pnpm -s preflight)
  elif [ -f yarn.lock ];      then gate=(yarn -s preflight)
  elif [ -f bun.lockb ] || [ -f bun.lock ]; then gate=(bun run preflight)
  else gate=(npm run -s preflight); fi
else
  exit 0
fi

state_dir="${HARNESS_VERIFY_STATE:-$HOME/.cache/claude-verify}"
gate_log="${HARNESS_GATE_LOG:-$HOME/.claude/gate-log.ndjson}"
log_run() { # result attempt seconds
  jq -cn --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg repo "$(basename "$root")" --arg root "$root" \
    --arg gate "${gate[*]}" --arg result "$1" --argjson attempt "${2:-1}" --argjson seconds "${3:-0}" \
    '{ts:$ts,repo:$repo,root:$root,gate:$gate,result:$result,attempt:$attempt,seconds:$seconds}' \
    >> "$gate_log" 2>/dev/null || true
}
mkdir -p "$state_dir"
key=$(printf '%s' "$root" | sha1sum | cut -c1-16)
fingerprint=$(
  {
    git rev-parse HEAD 2>/dev/null
    git diff HEAD 2>/dev/null
    git ls-files -o --exclude-standard -z 2>/dev/null | xargs -0 -r stat -c '%n %Y %s' 2>/dev/null
  } | sha1sum | cut -c1-40
)

[ "$(cat "$state_dir/$key.ok" 2>/dev/null)" = "$fingerprint" ] && exit 0

# Block at most once per reply. When a background agent keeps editing the tree, the fingerprint changes every time and
# the 3-failure brake below never fires: each re-run blocked again, and the extra load made slow tests fail
# (2026-11-16, 9 blocks in a row while develop-phase was working on the same worktree).
if [ "$(printf '%s' "$input" | jq -r '.stop_hook_active // false' 2>/dev/null)" = "true" ]; then
  jq -n --arg g "${gate[*]}" '{systemMessage: ("verify-on-stop: `" + $g + "` falló en esta respuesta; no vuelvo a bloquear hasta la siguiente.")}'
  exit 0
fi

started=$SECONDS
out=$("${gate[@]}" 2>&1)
status=$?
took=$((SECONDS - started))

if [ $status -eq 0 ]; then
  printf '%s' "$fingerprint" > "$state_dir/$key.ok"
  rm -f "$state_dir/$key.fail"
  log_run green 1 "$took"
  exit 0
fi

if [ ! -f "$state_dir/$key.ok" ]; then
  log_run red-unenforced 1 "$took"
  jq -n --arg g "${gate[*]}" '{systemMessage: ("verify-on-stop: `" + $g + "` falla y nunca ha pasado en verde en este repo, así que no bloqueo: el fallo puede ser anterior a esta sesión. Cuando esté en verde una vez, cada regresión hará volver a Claude.")}'
  exit 0
fi

last_fp=""; count=0
[ -f "$state_dir/$key.fail" ] && read -r last_fp count < "$state_dir/$key.fail"
[ "$last_fp" = "$fingerprint" ] && count=$((count + 1)) || count=1
printf '%s %s\n' "$fingerprint" "$count" > "$state_dir/$key.fail"

if [ "$count" -ge 3 ]; then
  log_run gave-up "$count" "$took"
  jq -n --arg g "${gate[*]}" '{systemMessage: ("verify-on-stop: `" + $g + "` sigue fallando tras 3 intentos sobre el mismo árbol; Claude se detiene. Revísalo a mano.")}'
  exit 0
fi

log_run blocked "$count" "$took"
{
  echo "La verificación del proyecto falló (\`${gate[*]}\`, exit $status). Arregla lo que la rompe antes de terminar; si el fallo no tiene que ver con tu cambio, dilo en vez de taparlo."
  echo "--- últimas líneas ---"
  printf '%s\n' "$out" | tail -n 40
} >&2
exit 2
