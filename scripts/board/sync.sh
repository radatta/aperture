#!/usr/bin/env bash
# The board's main sync, no tokens (docs/ops/TOWER.md → Main sync): every SYNC_INTERVAL s (120) `cli.ts sync-main` —
# fetch, move the main checkout to origin/main when it is clean, restart the web tower only when its code changed —
# then start the tower if it is down. One per container (flock); started by `board.sh sync start`, which
# `board.sh tower start` calls too, so the SessionStart hook and the tower's own minute tick keep it alive.
# Writes $BOARD_DIR/main-sync.json (the heartbeat the tower reads) and main-sync.log (only rounds that did something).
# Re-execs itself, same pid and lock, when this file or lib.sh changes on disk (a sync moved main under it).
#   bash sync.sh          run forever
#   bash sync.sh --once   one round, no lock (tests, `board.sh sync once`)
# Tests: APERTURE_SYNC_TOWER=off (no tower start).
set -u
case "${1:-}" in '' | --once) ;; *) echo "usage: bash sync.sh [--once]" >&2; exit 2 ;; esac
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE # an inherited git target would point every git here elsewhere

interval="${SYNC_INTERVAL:-120}"
self="$SB_SCRIPTS/sync.sh"
stamp() { stat -c '%Y %s' "$self" "$SB_SCRIPTS/lib.sh" 2>/dev/null | tr '\n' ' '; }

round() {
  local out ok=true head rc
  # fd 8 is the singleton's lock: no child keeps it (a tower started from here would hold it past our death)
  # INIT_CWD is where sync-main finds the checkout: pinned, so one inherited from a pnpm parent never moves another;
  # no inherited GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE either. The budget: a 20 s main-lock wait (a busy checkout
  # waits for the next round), the 60 s fetch, the switch, the 30 s restart lock and the restart all fit under 240 s,
  # so the timeout's KILL is for a hang, never a slow switch.
  out=$(cd "$SB_REPO" && INIT_CWD="$SB_REPO" APERTURE_MAIN_LOCK_WAIT=20 \
    timeout -k 5 240 node "$SB_REPO/scripts/src/board/cli.ts" sync-main 2>&1 8>&-)
  rc=$?
  # 75: the main checkout was busy (a lanes start): not a failure, the next round tries
  if [ "$rc" = 75 ]; then out+=$'\n'"main checkout busy: next round"; elif [ "$rc" != 0 ]; then ok=false; fi
  head=$(git -C "$SB_REPO" rev-parse HEAD 2>/dev/null)
  if [ "${APERTURE_SYNC_TOWER:-on}" != off ] && ! bash "$SB_SCRIPTS/board.sh" tower status >/dev/null 2>&1 8>&-; then
    out+=$'\n'$(bash "$SB_SCRIPTS/board.sh" tower start 2>&1 8>&-)
  fi
  sb_init_dirs
  jq -nc --arg t "$(sb_now)" --argjson pid "$$" --argjson ok "$ok" --arg head "$head" --arg msg "$out" \
    '{v: 1, t: $t, pid: $pid, ok: $ok, head: $head, msg: ($msg | split("\n") | map(select(. != "")) | join(" · ") | .[0:300])}' \
    >"$BOARD_DIR/main-sync.json.tmp.$$" && mv -f "$BOARD_DIR/main-sync.json.tmp.$$" "$BOARD_DIR/main-sync.json"
  # the log keeps what moved, restarted, started or failed; a quiet round leaves no line
  printf '%s\n' "$out" | grep -v -E '^$|already at|restart not needed|busy' | sed "s/^/$(date '+%m-%d %H:%M') /" >>"$BOARD_DIR/main-sync.log"
  "$ok"
}

if [ "${1:-}" = --once ]; then round; exit; fi

# A re-exec keeps fd 8 (and so the lock): decided by the fd itself, never an env flag a child could inherit. A fresh
# start opens it; a lock file made by someone else without write for us still flocks read-only.
[ /proc/$$/fd/8 -ef "$SYNC_LOCK" ] || { exec 8>>"$SYNC_LOCK"; } 2>/dev/null || exec 8<"$SYNC_LOCK" || exit 1
flock -w 5 8 || exit 0 # another sync holds it (a status probe's hold is over in microseconds)
printf '%s\n' "$$" >"$SYNC_PID"
nap=""
trap '[ -n "$nap" ] && kill "$nap" 2>/dev/null; exit 0' TERM INT
born=$(stamp)
while :; do
  # its checkout is gone (a test's temp repo): never loop on nothing (a second look: a git switch may be mid-write)
  [ -r "$self" ] || { sleep 2 8>&-; [ -r "$self" ]; } || exit 0
  round
  sleep "$interval" 8>&- &
  nap=$!
  wait "$nap"
  nap="" # reaped: its pid may be anyone's now
  now=$(stamp)
  if [ "$now" != "$born" ] && [ -r "$self" ]; then
    printf '%s re-exec (pid %s): sync.sh or lib.sh changed\n' "$(date '+%m-%d %H:%M')" "$$" >>"$BOARD_DIR/main-sync.log"
    exec bash "$self"
  fi
done
