#!/bin/bash
# Edge test — the only script that pushes toward failure (docs/ops/SESSION-BOARD.md → Measurement protocol).
# Adds one looping `pnpm test` instance every EDGE_STEP s (30) until a stop condition fires, a run exits
# ≥ 128, or EDGE_MAX (12) instances run; then stops every instance by PID, waits for anon to settle, and
# writes board/history/edge-<date>-<HHMM>.json (per step: n, peaks, PSI, memory.events deltas, exits, and
# the head of any failed run's output).
#   edge.sh --detach   run in tmux window `board-edge` (a refused clone() can hit the driving session too)
#   edge.sh            run in the foreground
# Refuses while another session was working in the last 5 min (EDGE_FORCE=1, with the user's say-so).
# Quiet-window only: other sessions exited, Playwright installed beforehand, no /curl-class shapes anywhere.
set -u
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

if [ "${1:-}" = --detach ]; then
  tmux new-window -d -n board-edge "bash '$SB_SCRIPTS/measure/edge.sh'; echo 'edge done — press enter'; read -r _" &&
    echo "edge: running in tmux window board-edge → $BOARD_DIR/history/edge-$(sb_today)-*.json"
  exit $?
fi

STEP="${EDGE_STEP:-30}" MAX="${EDGE_MAX:-12}"  # EDGE_CMD (default `pnpm test`) swaps the job for dry runs
read -r -a TREES <<<"${MATRIX_TREES:-$SB_REPO $SB_REPO/../board-matrix-b $SB_REPO/../board-matrix-c}"
present=(); for t in "${TREES[@]}"; do [ -d "$t/node_modules" ] && present+=("$t"); done
[ "${#present[@]}" -gt 0 ] || { echo "edge: no installed tree (matrix.sh setup)" >&2; exit 2; }
TREES=("${present[@]}")
eval "$(sb_thresholds)"
me=$( [ -n "${CLAUDE_PID:-}" ] && echo "$CLAUDE_PID" || sb_claude_pid "$PPID" ) || me=0

if [ "${EDGE_FORCE:-0}" != 1 ]; then
  others=$(bash "$SB_SCRIPTS/board.sh" json | jq -r --argjson me "$me" '
    .sample.sessions[] | select(.pid != $me and .name != "board-edge" and .state == "working") | .name')
  [ -z "$others" ] || { echo "edge: refusing — working now: $others (EDGE_FORCE=1 overrides)" >&2; exit 3; }
fi

run="edge-$(sb_today)-$(date -u +%H%M)"
out="${TMPDIR:-/tmp}/aperture-$run"
mkdir -p "$out"
result="$BOARD_DIR/history/$run.json"
anon0=$(cg_anon); pids0=$(cg_pids); oom0=$(cg_oom_kill); high0=$(cg_high_events)

# One instance: `pnpm test` in a loop until $out/stop exists; each run's output in its own file.
instance() {
  local i="$1" tree="$2" r=0 code fails=0
  while [ ! -e "$out/stop" ]; do
    r=$((r + 1))
    ( cd "$tree" && HEAVY_LABEL="$run#$i.$r" HEAVY_CLASS=test bash scripts/board/heavy.sh -- ${EDGE_CMD:-pnpm test} ) >"$out/$i.$r.log" 2>&1
    code=$?
    echo "$i.$r $code" >>"$out/exits"
    # A plain failure (a red test, not a signal) three times running: stop this instance, don't spin.
    if [ "$code" -ne 0 ] && [ "$code" -lt 128 ]; then fails=$((fails + 1)); [ "$fails" -ge 3 ] && return; sleep 2; else fails=0; fi
  done
}

steps='[]' n=0 hot=0 reason= launching=1
inst=()
stop_all() {
  touch "$out/stop"
  local p
  for p in "${inst[@]}"; do kill -TERM "$p" 2>/dev/null; done  # instance loops
  # heavy.sh wrappers trap TERM and stop their own subtrees; signal them by the PIDs their slots record.
  for p in $(jq -r '.wrapperPid' "$BOARD_DIR"/leases/heavy/*.json 2>/dev/null); do
    [ "$(sb_comm "$p")" = bash ] && kill -TERM "$p" 2>/dev/null
  done
  wait 2>/dev/null
}
trap 'reason="interrupted"; stop_all; exit 130' INT TERM

while :; do
  if [ "$launching" = 1 ] && [ "$n" -lt "$MAX" ]; then
    n=$((n + 1))
    instance "$n" "${TREES[$(( (n - 1) % ${#TREES[@]} ))]}" &
    inst+=($!)
  fi
  # Watch one step at 1 Hz.
  pk_p=0 pk_a=0 pk_c=0 pk_psi=0
  for ((s = 0; s < STEP; s++)); do
    p=$(cg_pids); a=$(cg_anon); c=$(cg_current); psi=$(cg_psi memory full)
    [ "$p" -gt "$pk_p" ] && pk_p=$p; [ "$a" -gt "$pk_a" ] && pk_a=$a; [ "${c:-0}" -gt "$pk_c" ] && pk_c=$c
    awk -v x="$psi" -v y="$pk_psi" 'BEGIN{exit !(x > y)}' && pk_psi=$psi
    awk -v x="$psi" -v k="$PSI_KILL" 'BEGIN{exit !(x > k)}' && hot=$((hot + 1)) || hot=0
    [ "$p" -gt "$PIDS_SOFT" ] && launching=0
    [ "$p" -gt "$PIDS_HARD" ] && reason="pids $p > hard $PIDS_HARD"
    [ "$a" -gt "$ANON_HARD" ] && reason="anon $(sb_gib "$a") GiB > hard $(sb_gib "$ANON_HARD") GiB"
    [ "$hot" -ge 2 ] && reason="psi full $psi > $PSI_KILL twice"
    [ -n "$c" ] && [ "$MEM_HIGH" -gt 0 ] && [ "$c" -gt $((MEM_HIGH - CURRENT_GUARD)) ] && [ "$hot" -ge 1 ] &&
      reason="memory.current within $((CURRENT_GUARD / 1048576)) MiB of memory.high with PSI rising"
    bad=$(awk '$2 >= 128 && $2 != 143 { print $1 ":" $2; exit }' "$out/exits" 2>/dev/null)
    [ -n "$bad" ] && reason="run $bad exited ≥ 128"
    [ -n "$reason" ] && break
    sleep 1
  done
  exits=$(awk '{ printf "%s%s", (NR > 1 ? "," : ""), $2 }' "$out/exits" 2>/dev/null)
  steps=$(jq -c --argjson n "$n" --argjson p "$pk_p" --argjson a "$((pk_a / 1048576))" --argjson c "$((pk_c / 1048576))" \
    --argjson psi "$pk_psi" --argjson oomd "$(( $(cg_oom_kill) - oom0 ))" --argjson highd "$(( $(cg_high_events) - high0 ))" \
    --argjson exits "[${exits}]" --arg t "$(sb_now)" \
    '. + [{t: $t, n: $n, pids: $p, anonMiB: $a, currentMiB: $c, psiFullMax: $psi, oomKillDelta: $oomd, highDelta: $highd, exits: $exits}]' <<<"$steps")
  echo "edge: n=$n pids $pk_p/$PIDS_MAX anon $(sb_gib "$pk_a")/$(sb_gib "$MEM_HIGH") GiB psi $pk_psi${reason:+ — STOP: $reason}"
  [ -n "$reason" ] && break
  [ "$launching" = 0 ] && [ "$n" -ge 1 ] && { reason="pids past soft $PIDS_SOFT — stopped launching"; break; }
  [ "$n" -ge "$MAX" ] && { reason="reached EDGE_MAX=$MAX without a stop condition"; break; }
done

stop_all
# Head of the first failed run's output (the "capture the head" rule).
head_txt=
if [ -n "${bad:-}" ]; then head_txt=$(head -n 20 "$out/${bad%%:*}.log" 2>/dev/null); fi
# Let anon settle back within 10 % of where it started (max 2 min).
for _ in $(seq 1 120); do [ "$(cg_anon)" -le $((anon0 * 11 / 10)) ] && break; sleep 1; done

jq -n --arg run "$run" --arg t "$(sb_now)" --arg reason "$reason" --argjson steps "$steps" \
  --argjson pids0 "$pids0" --argjson anon0 "$((anon0 / 1048576))" --argjson pidsMax "$PIDS_MAX" \
  --argjson highMiB "$((MEM_HIGH / 1048576))" --arg head "$head_txt" --argjson settled "$(( $(cg_anon) / 1048576 ))" '
  {v: 1, kind: "edge", run: $run, t: $t, stopReason: $reason, before: {pids: $pids0, anonMiB: $anon0},
   limits: {pidsMax: $pidsMax, highMiB: $highMiB}, steps: $steps, failedHead: (if $head == "" then null else $head end),
   settledAnonMiB: $settled}' | sb_write "$result"
echo "edge: $reason → $result"
