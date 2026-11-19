#!/usr/bin/env bash
# Warm a new lane's tsc -b and eslint caches in the background, so its first typecheck and lint don't pay the cold
# run (docs/ops/LANES.md → Start, step 9):
#   warm.sh <log>      `pnpm lanes start` runs this detached (setsid -f), cwd = the new worktree: output to <log>,
#                      then one heavy.sh slot (class warm, --wait 0: a busy box skips, logged as gaveUp), stopped
#                      after WARM_MAX_SEC (whole seconds, default 300)
#   warm.sh --steps    heavy.sh's command: `pnpm typecheck`, then `pnpm lint`, each niced, one at a time
# It yields: within about a second of a heavy slot of this worktree's own going live (its gate, a typecheck under
# heavy.sh), it stops its heavy.sh, which stops this whole subtree. A bare `pnpm typecheck` isn't seen, nor is a
# heavy.sh still waiting for its slot.
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "${1:-}" != --steps ]; then
  log="${1:?usage: warm.sh <log> | --steps}"
  mkdir -p "$(dirname "$log")" || exit 1
  exec </dev/null >>"$log" 2>&1
  for v in "${!HEAVY_@}"; do unset "$v"; done  # a caller's class, slot or noslot must not reach this run
  case "${WARM_MAX_SEC:-}" in '' | *[!0-9]* | 0*) max=300 ;; *) max=$WARM_MAX_SEC ;; esac  # 00 would stop it at once
  echo "warm: $(date -u +%Y-%m-%dT%H:%M:%SZ) typecheck + lint in $PWD (cap $max s)"
  # CLAUDE_PID=0: no Claude owns this job, so heavy.sh names it by the cwd's branch, not the hub's session.
  CLAUDE_PID=0 HEAVY_CLASS=warm HEAVY_LABEL="warm:$(git branch --show-current 2>/dev/null)" \
    HEAVY_DURATION="$max" exec "$here/heavy.sh" --wait 0 -- bash "$here/warm.sh" --steps
fi

. "$here/lib.sh"
# Our own heavy.sh, and only when it is our parent: HEAVY_WRAPPER is inherited by everything under any heavy run.
me="${HEAVY_WRAPPER:-}"
[ "$me" = "$PPID" ] || me=
step=

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

# heavy.sh's TERM (a yield, or its duration stop) reaches this script with the rest of its subtree: say so, since a
# duration stop's event reads exit 0.
trap 'echo "warm: ${step:-the run} stopped (a yield or the cap)"; exit 143' TERM

# Stay alive until heavy.sh has stopped the subtree: exiting first would orphan the running step, which its
# kill_tree then can't find (the yield's whole point is that two tsc -b or two eslint don't share a cache).
yield() {
  echo "warm: yielding to $1"
  if [ -n "$me" ]; then kill -TERM "$me"; wait; fi
  [ -n "${p:-}" ] && kill -TERM "$p" 2>/dev/null && wait "$p"  # no heavy.sh above us (a hand-run --steps)
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
