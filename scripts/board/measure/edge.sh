#!/usr/bin/env bash
# Edge test — the only script that pushes toward failure (docs/ops/SESSION-BOARD.md → Measurement protocol).
# Adds one looping `pnpm test` instance every EDGE_STEP s (30) until a stop condition fires, a run fails
# (any exit but 0 / 143 — the gate was green, so the load caused it), or EDGE_MAX (12) instances run; then stops every instance by PID, waits for anon to settle, and
# writes board/history/edge-<date>-<HHMM>.json (per step: n launched / alive, peaks, PSI, memory.events
# deltas, exits; and the head of the first failed run's output). Its job events carry loadTest:true, so
# report/staleness leave them out of the per-class costs.
#   edge.sh --detach   run detached (setsid), progress in history/edge-<date>.log — a refused clone() can hit the driving session too
#   edge.sh            run in the foreground
# Refuses while any other session is live, or was working in the last 5 min (EDGE_FORCE=1, with the user's say-so).
# Quiet-window only: other sessions exited, Playwright installed beforehand, no /curl-class shapes anywhere.
set -u
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

me=$( [ -n "${CLAUDE_PID:-}" ] && echo "$CLAUDE_PID" || sb_claude_pid "$PPID" ) || me=0
# Quiet window only (other sessions exited) — checked before detaching, so a refusal reaches the caller.
# Refuses while any other claude session is live now, or was working in any of the last 10 samples (5 min,
# across the UTC day boundary). Hook state alone isn't trusted: a session whose hooks stopped firing reads
# `idle` while it runs a gate. Can't read the board → refuse: this script pushes the container to failure.
if [ "${EDGE_FORCE:-0}" != 1 ]; then
  cant() { echo "edge: can't read the board — refusing (EDGE_FORCE=1 overrides)" >&2; exit 3; }
  now=$(bash "$SB_SCRIPTS/sampler.sh" --print) && jq -e . >/dev/null 2>&1 <<<"$now" || cant
  live=$(jq -r --argjson me "$me" '[.sessions[] | select(.pid != $me) | .name] | join(", ")' <<<"$now") || cant
  [ -z "$live" ] || { echo "edge: refusing — other sessions are live: $live (quiet window: exit them; EDGE_FORCE=1 overrides)" >&2; exit 3; }
  mapfile -t recent < <(ls -1 "$BOARD_DIR"/history/samples-*.jsonl 2>/dev/null | sort | tail -n 2)
  # Line by line, skipping a torn line from a concurrent append rather than failing the whole read.
  others=$( { [ "${#recent[@]}" -eq 0 ] || cat "${recent[@]}" | tail -n 10; printf '%s\n' "$now"; } |
    jq -Rrs --argjson me "$me" '[split("\n")[] | fromjson? // empty | .sessions[]? |
      select(.pid != $me and .state == "working") | .name] | unique | join(", ")') || cant
  [ -z "$others" ] || { echo "edge: refusing — working in the last 5 min: $others (EDGE_FORCE=1 overrides)" >&2; exit 3; }
fi

if [ "${1:-}" = --detach ]; then
  log="$BOARD_DIR/history/edge-$(sb_today).log"
  CLAUDE_PID=$me EDGE_FORCE=1 setsid nohup bash "$SB_SCRIPTS/measure/edge.sh" </dev/null >>"$log" 2>&1 &  # already checked
  echo "edge: running detached (pid $!), progress in $log → result $BOARD_DIR/history/edge-$(sb_today)-*.json"
  exit 0
fi

STEP="${EDGE_STEP:-30}" MAX="${EDGE_MAX:-12}"  # EDGE_CMD (default `pnpm test`) swaps the job for dry runs
read -r -a TREES <<<"$(sb_matrix_trees)"
present=(); for t in "${TREES[@]}"; do [ -d "$t/node_modules" ] && present+=("$t"); done
[ "${#present[@]}" -gt 0 ] || { echo "edge: no installed tree (matrix.sh setup)" >&2; exit 2; }
TREES=("${present[@]}")
eval "$(sb_thresholds)"

run="edge-$(sb_today)-$(date -u +%H%M)"
out="${TMPDIR:-/tmp}/aperture-$run"
mkdir -p "$out"
result="$BOARD_DIR/history/$run.json"
anon0=$(cg_anon); pids0=$(cg_pids); oom0=$(cg_oom_kill); high0=$(cg_high_events)

# One instance: `pnpm test` in a loop until $out/stop exists; each run's output in its own file. The wrapper
# runs in the background with its PID in $out/w.<i>, so stop_all reaches it even before it has a slot (or
# after SessionEnd dropped this session's slots). Any exit but 0 / 143 is a failure the load caused — the
# gate was green — and the main loop stops on it; the instance stops too, rather than spin on a red run.
instance() {
  local i="$1" tree="$2" r=0 code w
  while [ ! -e "$out/stop" ]; do
    r=$((r + 1))
    ( cd "$tree" && HEAVY_LABEL="$run#$i.$r" HEAVY_CLASS=test HEAVY_LOADTEST=1 exec bash scripts/board/heavy.sh -- ${EDGE_CMD:-pnpm test} ) >"$out/$i.$r.log" 2>&1 &
    w=$!; echo "$w" >"$out/w.$i"
    wait "$w"; code=$?
    echo "$i.$r $code" >>"$out/exits"
    [ "$code" = 0 ] || return
  done
}

steps='[]' n=0 hot=0 reason= launching=1
inst=()
stop_all() {
  touch "$out/stop"
  local p
  for p in "${inst[@]}"; do kill -TERM "$p" 2>/dev/null; done  # instance loops
  # heavy.sh wrappers trap TERM and stop their own subtrees; signal this run's, by the PIDs the instances wrote.
  for p in $(cat "$out"/w.* 2>/dev/null); do
    [ "$(sb_comm "$p")" = bash ] && kill -TERM "$p" 2>/dev/null
  done
  wait 2>/dev/null
}
trap 'reason="interrupted"; stop_all; exit 130' INT
trap 'reason="terminated"; stop_all; exit 143' TERM

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
    bad=$(awk '$2 != 0 && $2 != 143 { print $1 ":" $2; exit }' "$out/exits" 2>/dev/null)
    [ -n "$bad" ] && reason="run $bad failed (exit ${bad##*:}) under load"
    [ -n "$reason" ] && break
    sleep 1
  done
  exits=$(awk '{ printf "%s%s", (NR > 1 ? "," : ""), $2 }' "$out/exits" 2>/dev/null)
  alive=0; for p in "${inst[@]}"; do kill -0 "$p" 2>/dev/null && alive=$((alive + 1)); done
  steps=$(jq -c --argjson n "$n" --argjson alive "$alive" --argjson p "$pk_p" --argjson a "$((pk_a / 1048576))" --argjson c "$((pk_c / 1048576))" \
    --argjson psi "$pk_psi" --argjson oomd "$(( $(cg_oom_kill) - oom0 ))" --argjson highd "$(( $(cg_high_events) - high0 ))" \
    --argjson exits "[${exits}]" --arg t "$(sb_now)" \
    '. + [{t: $t, n: $n, alive: $alive, pids: $p, anonMiB: $a, currentMiB: $c, psiFullMax: $psi, oomKillDelta: $oomd, highDelta: $highd, exits: $exits}]' <<<"$steps")
  echo "edge: n=$n ($alive live) pids $pk_p/$PIDS_MAX anon $(sb_gib "$pk_a")/$(sb_gib "$MEM_HIGH") GiB psi $pk_psi${reason:+ — STOP: $reason}"
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
