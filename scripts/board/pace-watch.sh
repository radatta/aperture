#!/bin/bash
# The hub's pace watcher (2026-11-17; replaced throttle-watch + recover-watch). Samples the container every intervalSec,
# averages the last windowSamples, writes pace.json every tick (the `pnpm lanes start` gate reads it:
# docs/ops/LANES.md → The pace gate) and EXITS ONLY ON A TRANSITION, so the hub wakes just then:
#   3 = trip (calm → hot)   0 = recovered (hot → calm)   5 = a held lane's resume trigger met   4 = hot for hotExitSec
#   6 = idle capacity and a ready autoStart lane (start it, or say why not)   78 = a limits.json key is missing
# The hub owns pace-control.json ({state: calm|hot, since: <epoch>, held, triggers: [{lane, load5Below}]}) and
# queue.json; both are read-only here. Thresholds: limits.json → watchers.pace, plus four of the gate's `pace` keys
# (psiMemFullMax, psiCpuBelow, anonMiBBelow, minSamples) so the trip and the gate share them. What each means:
# docs/ops/SESSION-BOARD.md → Watchers.
# Run: timeout 65m scripts/board/pace-watch.sh   (124 = an hour, nothing happened: restart it)
set -u
source "$(dirname "${BASH_SOURCE[0]}")/watch-lib.sh"
W=pace-watch
k() { wl_need $W ".watchers.pace.$1"; }
ki() { wl_int $W ".watchers.pace.$1"; }
EVERY=$(ki intervalSec) || exit 78
WINDOW=$(ki windowSamples) || exit 78
TRIP_ANON=$(k tripAnonMiB) || exit 78
TRIP_CORES=$(k tripCores) || exit 78
CPU_HOLD=$(ki tripCpuHoldSec) || exit 78
REC_L5=$(k recoverLoad5Below) || exit 78
REC_MIN=$(ki recoverMinSec) || exit 78
HOT_MAX=$(ki hotExitSec) || exit 78
IDLE_L5=$(k idleLoad5Below) || exit 78
IDLE_ANON=$(k idleAnonMiBBelow) || exit 78
IDLE_HOLD=$(ki idleHoldSec) || exit 78
IDLE_FROM=$(k idleFromHour) || exit 78
IDLE_EVERY=$(ki idleEverySec) || exit 78
PSI_MEM=$(wl_need $W .pace.psiMemFullMax) || exit 78
PSI_CPU=$(wl_need $W .pace.psiCpuBelow) || exit 78
REC_ANON=$(wl_need $W .pace.anonMiBBelow) || exit 78
FLOOR=$(wl_int $W .pace.minSamples) || exit 78
[[ "$IDLE_FROM" =~ ^([0-9]|1[0-9]|2[0-3])$ ]] || { echo "$W: limits.json .watchers.pace.idleFromHour must be an hour 0-23" | tee -a "$BOARD_DIR/$W.log" >&2; exit 78; }
sb_init_dirs
OUT=$BOARD_DIR/pace.json CTL=$BOARD_DIR/pace-control.json

anon=() cores=() pcpu=() cpuhot_at=0 idle_at=0
avg() { printf '%s\n' "$@" | awk '{s+=$1} END{if(NR) printf "%.2f", s/NR; else print 0}'; }
push() { local -n a=$1; a+=("$2"); [ "${#a[@]}" -gt "$WINDOW" ] && a=("${a[@]:1}"); }
is() { awk "BEGIN{exit !($1)}"; } # a numeric test; every value spliced in is checked numeric first
u_prev=$(cg_usage_usec) t_prev=$(date +%s)

while :; do
  sleep "$EVERY"
  now=$(date +%s) u=$(cg_usage_usec)
  # No loadavg is no tick: pace.json goes stale, and the start gate fails closed on a stale file.
  l5=
  read -r _ l5 _ 2>/dev/null <"$LOADAVG"
  wl_num "$l5" || continue
  push cores "$(awk -v a="${u_prev:-0}" -v b="${u:-0}" -v dt=$((now > t_prev ? now - t_prev : 1)) 'BEGIN{printf "%.2f", (b-a)/dt/1e6}')"
  u_prev=$u t_prev=$now
  # Unreadable cgroup values count as 0, as before the move; never an arithmetic error that ends the watcher.
  an=$(cg_anon) pc=$(cg_psi cpu some) pmem=$(cg_psi memory full)
  [[ "$an" =~ ^[0-9]+$ ]] || an=0
  wl_num "$pc" || pc=0
  wl_num "$pmem" || pmem=0
  push anon "$((an / 1048576))"
  push pcpu "$pc"
  # Mac load history (mac-stats.json keeps only the latest reading).
  l=$(jq -c --arg l5 "$l5" '{t, mac:.load, cpus, memFreePct:.mem.freePct, vm:$l5}' "$BOARD_DIR/mac-stats.json" 2>/dev/null) &&
    wl_hist mac-load "$l"
  A=$(avg "${anon[@]}") C=$(avg "${cores[@]}") P=$(avg "${pcpu[@]}")
  state=$(jq -r '.state // "calm"' "$CTL" 2>/dev/null) || state=calm
  since=$(jq -r '.since // 0 | numbers' "$CTL" 2>/dev/null) || since=0
  [ -n "$state" ] || state=calm
  [ -n "$since" ] || since=0
  jq -n --arg st "$state" --argjson hb "$now" --argjson pid $$ --argjson a "$A" --argjson c "$C" --argjson p "$P" \
    --argjson pm "$pmem" --argjson l5 "$l5" --argjson n "${#anon[@]}" \
    '{state:$st, heartbeat:$hb, pid:$pid, samples:$n, avg:{anonMiB:$a, cores:$c, psiCpu:$p}, psiMemFull:$pm, load5:$l5}' |
    sb_write "$OUT"
  l=$(jq -c --arg t "$(wl_at -Iseconds)" '{t:$t} + .' "$OUT" 2>/dev/null) && wl_hist vm-pace "$l"
  [ "${#anon[@]}" -lt "$FLOOR" ] && continue
  line="$(wl_at +%H:%M) $state · anon avg $A · cores avg $C · psi avg $P · load5 $l5"
  if [ "$state" = calm ]; then
    if is "$A+0 >= $TRIP_ANON || $pmem+0 > $PSI_MEM"; then wl_say $W "$line · TRIP memory"; exit 3; fi
    if is "$C+0 >= $TRIP_CORES || $P+0 >= $PSI_CPU"; then
      [ "$cpuhot_at" -eq 0 ] && cpuhot_at=$now
      [ $((now - cpuhot_at)) -ge "$CPU_HOLD" ] && { wl_say $W "$line · TRIP cpu (5 min)"; exit 3; }
    else cpuhot_at=0; fi
  else
    cpuhot_at=0 # a hold starts afresh once the hub marks it calm again
    # per-lane triggers while hot (e.g. a lane that resumes the moment load5 < 20)
    hit=$(jq -r --argjson l5 "$l5" '[.triggers[]? | select($l5 < .load5Below) | .lane] | join(",")' "$CTL" 2>/dev/null)
    [ -n "$hit" ] && { wl_say $W "$line · TRIGGER $hit"; exit 5; }
    if [ $((now - since)) -ge "$REC_MIN" ] && is "$l5+0 < $REC_L5 && $A+0 < $REC_ANON"; then
      wl_say $W "$line · RECOVERED"; exit 0
    fi
    [ $((now - since)) -ge "$HOT_MAX" ] && { wl_say $W "$line · HOT 60 min"; exit 4; }
  fi
  # 6 = idle capacity with a ready autoStart lane: calm, load5 and anon avg under the idle lines for idleHoldSec, from
  # idleFromHour to midnight (no overnight starts), at most once per idleEverySec (idle-fired holds the last epoch). A
  # ready entry: its note doesn't start LOW or HOLD, and none of its `after` lanes is still in devQueue or autoStart.
  if [ "$state" = calm ] && is "$l5+0 < $IDLE_L5 && $A+0 < $IDLE_ANON"; then
    [ "$idle_at" -eq 0 ] && idle_at=$now
    h=$(wl_at +%H) last=$(cat "$BOARD_DIR/idle-fired" 2>/dev/null)
    [[ "$last" =~ ^[0-9]+$ ]] || last=0
    if [ $((now - idle_at)) -ge "$IDLE_HOLD" ] && [ $((10#$h)) -ge "$IDLE_FROM" ] && [ $((now - last)) -ge "$IDLE_EVERY" ]; then
      ready=$(jq -r '([.devQueue[]?.branch] + [.autoStart[]?.branch]) as $live | [.autoStart[]? | select((.note // "") | test("^(LOW|HOLD)") | not) | select(all(.after[]?; . as $x | $live | index($x) | not)) | .branch] | join(",")' "$BOARD_DIR/queue.json" 2>/dev/null)
      [ -n "$ready" ] && { echo "$now" >"$BOARD_DIR/idle-fired"; wl_say $W "$line · IDLE ready=$ready"; exit 6; }
    fi
  else idle_at=0; fi
  [ $((now / EVERY % WINDOW)) -eq 0 ] && echo "$line" >>"$BOARD_DIR/$W.log"
done
