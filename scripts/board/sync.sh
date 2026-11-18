#!/usr/bin/env bash
# The board's main sync, no tokens (docs/ops/TOWER.md → Main sync): every SYNC_INTERVAL s (120) `cli.ts sync-main` —
# fetch, move the main checkout to origin/main when it is clean, restart the web tower only when its code changed —
# then start the tower if it is down. One per container (flock); started by `board.sh sync start`, which
# `board.sh tower start` calls too, so the SessionStart hook and the tower's own minute tick keep it alive.
# Writes $BOARD_DIR/main-sync.json (the heartbeat the tower reads) and main-sync.log (only rounds that did something).
# Re-execs itself, same pid and lock, when this file or lib.sh changes on disk (a sync moved main under it).
#   sync.sh          run forever
#   sync.sh --once   one round, no lock (tests, `board.sh sync once`)
# Tests: APERTURE_SYNC_TOWER=off (no tower start).
set -u
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

interval="${SYNC_INTERVAL:-120}"
self="$SB_SCRIPTS/sync.sh"
stamp() { stat -c '%Y %s' "$self" "$SB_SCRIPTS/lib.sh" 2>/dev/null | tr '\n' ' '; }

round() {
  local out ok=true head
  # fd 8 is the singleton's lock: no child keeps it (a tower started from here would hold it past our death)
  # INIT_CWD is where sync-main finds the checkout: pinned, so one inherited from a pnpm parent never moves another
  out=$(cd "$SB_REPO" && INIT_CWD="$SB_REPO" timeout -k 5 150 node "$SB_REPO/scripts/src/board/cli.ts" sync-main 2>&1 8>&-) || ok=false
  head=$(git -C "$SB_REPO" rev-parse HEAD 2>/dev/null)
  if [ "${APERTURE_SYNC_TOWER:-on}" != off ] && ! bash "$SB_SCRIPTS/board.sh" tower status >/dev/null 2>&1 8>&-; then
    out+=$'\n'$(bash "$SB_SCRIPTS/board.sh" tower start 2>&1 8>&-)
  fi
  sb_init_dirs
  jq -nc --arg t "$(sb_now)" --argjson pid "$$" --argjson ok "$ok" --arg head "$head" --arg msg "$out" \
    '{v: 1, t: $t, pid: $pid, ok: $ok, head: $head, msg: ($msg | split("\n") | map(select(. != "")) | join(" · ") | .[0:300])}' \
    >"$BOARD_DIR/main-sync.json.tmp.$$" && mv -f "$BOARD_DIR/main-sync.json.tmp.$$" "$BOARD_DIR/main-sync.json"
  # the log keeps what moved, restarted, started or failed; a quiet round leaves no line
  printf '%s\n' "$out" | grep -v -E '^$|already at|restart not needed' | sed "s/^/$(date '+%m-%d %H:%M') /" >>"$BOARD_DIR/main-sync.log"
  "$ok"
}

if [ "${1:-}" = --once ]; then round; exit; fi

# A re-exec keeps fd 8 (and so the lock); a fresh start opens it.
[ -n "${APERTURE_SYNC_REEXEC:-}" ] || exec 8>>"$SYNC_LOCK"
flock -w 5 8 || exit 0 # another sync holds it (a status probe's hold is over in microseconds)
printf '%s\n' "$$" >"$SYNC_PID"
trap 'kill "$nap" 2>/dev/null; exit 0' TERM INT
nap=""
born=$(stamp)
while :; do
  round
  sleep "$interval" 8>&- &
  nap=$!
  wait "$nap"
  now=$(stamp)
  if [ "$now" != "$born" ] && [ -r "$self" ]; then
    printf '%s re-exec (pid %s): sync.sh or lib.sh changed\n' "$(date '+%m-%d %H:%M')" "$$" >>"$BOARD_DIR/main-sync.log"
    APERTURE_SYNC_REEXEC=1 exec bash "$self"
  fi
done
