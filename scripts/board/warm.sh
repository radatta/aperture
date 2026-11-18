#!/usr/bin/env bash
# Warm a new lane's tsc -b and eslint caches in the background, so its first typecheck and lint don't pay the cold
# run (docs/ops/LANES.md → Start, step 9):
#   warm.sh <log>      `pnpm lanes start` runs this detached (setsid -f), cwd = the new worktree: output to <log>,
#                      then one heavy.sh slot (class warm, --wait 0: a busy box skips, logged as gaveUp)
#   warm.sh --steps    heavy.sh's command: `pnpm typecheck`, then `pnpm lint`, each niced, one at a time
# It yields: once a heavy slot of this worktree's own (its gate, a typecheck under heavy.sh) is live, it stops its
# heavy.sh, so two tsc -b or two eslint never write one cache at once. A bare `pnpm typecheck` isn't seen.
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "${1:-}" != --steps ]; then
  log="${1:?usage: warm.sh <log> | --steps}"
  mkdir -p "$(dirname "$log")" || exit 1
  exec </dev/null >>"$log" 2>&1
  for v in "${!HEAVY_@}"; do unset "$v"; done  # a caller's class, slot or noslot must not reach this run
  echo "warm: $(date -u +%Y-%m-%dT%H:%M:%SZ) typecheck + lint in $PWD"
  # CLAUDE_PID=0: no Claude owns this job, so heavy.sh names it by the cwd's branch, not the hub's session.
  CLAUDE_PID=0 HEAVY_CLASS=warm HEAVY_LABEL="warm:$(git branch --show-current 2>/dev/null)" \
    HEAVY_DURATION="${WARM_MAX_SEC:-300}" exec "$here/heavy.sh" --wait 0 -- bash "$here/warm.sh" --steps
fi

. "$here/lib.sh"
me="${HEAVY_WRAPPER:-}"

# A live slot whose heavy.sh runs in this worktree, other than ours: the lane is at work.
lane_busy() {
  local f wp cwd
  while read -r f; do
    wp=$(jq -r '.wrapperPid' "$f" 2>/dev/null)
    [ -n "$wp" ] && [ "$wp" != "$me" ] || continue
    cwd=$(readlink "/proc/$wp/cwd" 2>/dev/null) || continue
    case "$cwd/" in "$PWD"/*) echo "$(jq -r '.label // .class' "$f" 2>/dev/null) (pid $wp)"; return 0 ;; esac
  done < <(sb_live_slots)
  return 1
}

yield() {
  echo "warm: yielding to $1"
  [ -n "$me" ] && kill -TERM "$me"  # heavy.sh stops its whole subtree, frees the slot and logs exit 143
  exit 143
}

rc=0
for step in typecheck lint; do
  b=$(lane_busy) && yield "$b"
  t0=$(date +%s%3N)
  nice -n 10 pnpm --silent "$step" &
  p=$!
  while kill -0 "$p" 2>/dev/null; do
    b=$(lane_busy) && yield "$b"
    sleep 1
  done
  wait "$p"; c=$?
  ms=$(( $(date +%s%3N) - t0 ))
  printf 'warm: %s exit %d · %d.%d s\n' "$step" "$c" $((ms / 1000)) $((ms % 1000 / 100))
  [ "$rc" = 0 ] && rc=$c
done
exit "$rc"
