#!/bin/bash
# Run one heavy command budgeted + measured (docs/ops/SESSION-BOARD.md → Heavy wrapper):
#   scripts/board/heavy.sh [--wait SEC] -- <cmd…>
# Takes a heavy slot (waits only when limits.json enforce:true and the budget is over hard), samples the
# container + the command's process subtree at 1 Hz, and appends the peaks to board/history/events-*.jsonl.
# stdout/stderr pass straight through; the exit code is the command's (128+sig if signalled).
# Env: HEAVY_LABEL (label; never argv), HEAVY_CLASS (override), HEAVY_DURATION (stop after N s, e.g. dev),
#      HEAVY_GUARD=1 (enforce the stop conditions — load tests only).
set -u
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

wait_sec=
while [ $# -gt 0 ]; do
  case "$1" in
    --wait) wait_sec="$2"; shift 2 ;;
    --) shift; break ;;
    *) break ;;
  esac
done
[ $# -gt 0 ] || { echo "usage: heavy.sh [--wait SEC] -- <cmd…>" >&2; exit 2; }

cmd="$*"
class="${HEAVY_CLASS:-$(sb_classify "$cmd")}"
label="${HEAVY_LABEL:-$class}"
me=$$
read -r _ me_start < <(sb_stat "$me")
owner=$( [ -n "${CLAUDE_PID:-}" ] && echo "$CLAUDE_PID" || sb_claude_pid "$PPID" ) || owner=0
work="${TMPDIR:-/tmp}/aperture-heavy.$me"
eval "$(sb_thresholds)"

# Container-only tuning, per limits.json `tuning.test` (null until measured — answer 3: no guessing).
if [ "$class" = test ] && sb_in_container; then
  wc=$(sb_limit '.tuning.test.workspaceConcurrency'); mw=$(sb_limit '.tuning.test.maxWorkers')
  [ -n "$mw" ] && export VITEST_MAX_WORKERS="$mw"
  if [ -n "$wc" ] && [ "$cmd" = "pnpm test" ]; then set -- pnpm -r --workspace-concurrency="$wc" test; cmd="$*"; fi
fi

# Slot: test-file and other are measured but take none.
slot=
if [ "$class" != test-file ] && [ "$class" != other ]; then
  slot="$BOARD_DIR/leases/heavy/$owner-$me.json"
  if [ "$(type -t lease_heavy_acquire)" = function ]; then
    lease_heavy_acquire "$slot" "$owner" "$class" "$label" "$cmd" "$me" "$me_start" "${wait_sec:-}" || exit $?
  else
    sb_init_dirs
    jq -nc --argjson pid "$owner" --arg class "$class" --arg label "$label" --argjson wp "$me" --arg ws "$me_start" \
      --arg now "$(sb_now)" '{v:1, pid:$pid, class:$class, label:$label, wrapperPid:$wp, wrapperStart:$ws, startedAt:$now}' | sb_write "$slot"
  fi
fi

# Descendants of $1 (inclusive) with their threads/rss — one awk over one /proc pass.
subtree() {
  sb_procs | awk -F'\t' -v root="$1" -v page="$(getconf PAGESIZE)" '
    { pp[$1] = $2; th[$1] = $4; rs[$1] = $5 }
    END { for (p in pp) { q = p; for (n = 0; n < 64 && q > 1; n++) { if (q == root) { print p; t += th[p]; r += rs[p] * page; break } q = pp[q] } }
          printf "T %d %d\n", t, r }'
}
kill_tree() {  # by PID, deepest-last is fine: TERM all, then KILL survivors
  local p list
  list=$(subtree "$1" | awk '$1 != "T"')
  for p in $list; do kill -TERM "$p" 2>/dev/null; done
  sleep 3
  for p in $list; do kill -KILL "$p" 2>/dev/null; done
}

pids0=$(cg_pids); anon0=$(cg_anon); oom0=$(cg_oom_kill); high0=$(cg_high_events)
t0=$(date +%s%3N)

"$@" &
child=$!

# 1 Hz sampler (subshell): tracks peaks, renews the slot, enforces stop conditions under HEAVY_GUARD=1.
(
  pk_pids=$pids0 pk_anon=$anon0 pk_cur=0 pk_thr=0 pk_rss=0 pk_psi=0 pk_cores=0 hot=0 n=0
  u0=$(cg_usage_usec); tp=$(date +%s%3N)
  while kill -0 "$child" 2>/dev/null; do
    p=$(cg_pids); a=$(cg_anon); c=$(cg_current); psi=$(cg_psi memory full); u=$(cg_usage_usec); tn=$(date +%s%3N)
    read -r _ thr rss < <(subtree "$child" | tail -n 1)
    cores=$(awk -v du=$((u - u0)) -v dt=$((tn - tp)) 'BEGIN{printf "%.2f", (dt > 0 ? du / (dt * 1000) : 0)}')
    u0=$u; tp=$tn
    [ "$p" -gt "$pk_pids" ] && pk_pids=$p
    [ "$a" -gt "$pk_anon" ] && pk_anon=$a
    [ "${c:-0}" -gt "$pk_cur" ] && pk_cur=$c
    [ "${thr:-0}" -gt "$pk_thr" ] && pk_thr=$thr
    [ "${rss:-0}" -gt "$pk_rss" ] && pk_rss=$rss
    awk -v a="$psi" -v b="$pk_psi" 'BEGIN{exit !(a > b)}' && pk_psi=$psi
    awk -v a="$cores" -v b="$pk_cores" 'BEGIN{exit !(a > b)}' && pk_cores=$cores
    echo "$pk_pids $pk_anon $pk_cur $pk_thr $pk_rss $pk_psi $pk_cores" >"$work.peak"
    n=$((n + 1))
    if [ -n "$slot" ] && [ $((n % 30)) -eq 0 ] && [ -f "$slot" ]; then
      jq -c --arg now "$(sb_now)" '.renewedAt = $now' "$slot" | sb_write "$slot"
    fi
    if [ -n "${HEAVY_DURATION:-}" ] && [ $(( (tn - t0) / 1000 )) -ge "$HEAVY_DURATION" ]; then
      echo duration >"$work.stop"; kill_tree "$child"; break
    fi
    if [ "${HEAVY_GUARD:-0}" = 1 ]; then
      awk -v a="$psi" -v k="$PSI_KILL" 'BEGIN{exit !(a > k)}' && hot=$((hot + 1)) || hot=0
      reason=
      [ "$p" -gt "$PIDS_HARD" ] && reason="pids $p > hard $PIDS_HARD"
      [ "$a" -gt "$ANON_HARD" ] && reason="anon $(sb_gib "$a") GiB > hard $(sb_gib "$ANON_HARD")"
      [ "$hot" -ge 2 ] && reason="psi full $psi > $PSI_KILL twice"
      if [ -n "$reason" ]; then
        echo "$reason" >"$work.stop"; echo "heavy: GUARD stop — $reason" >&2; kill_tree "$child"; break
      fi
    fi
    sleep 1
  done
) &
mon=$!

on_signal() { kill_tree "$child"; }
trap 'on_signal; trap - TERM; sig=15' TERM
trap 'on_signal; trap - INT; sig=2' INT
sig=
wait "$child"; code=$?
# `wait` returns early when a trapped signal arrives — wait again for the real exit.
while kill -0 "$child" 2>/dev/null; do wait "$child"; code=$?; done
t1=$(date +%s%3N)
kill "$mon" 2>/dev/null; wait "$mon" 2>/dev/null
[ -n "$slot" ] && rm -f "$slot"

read -r pk_pids pk_anon pk_cur pk_thr pk_rss pk_psi pk_cores 2>/dev/null <"$work.peak" ||
  { pk_pids=$pids0 pk_anon=$anon0 pk_cur=0 pk_thr=0 pk_rss=0 pk_psi=0 pk_cores=0; }
stop=$(cat "$work.stop" 2>/dev/null)
rm -f "$work.peak" "$work.stop"
oomd=$(( $(cg_oom_kill) - oom0 )); highd=$(( $(cg_high_events) - high0 ))
signal=null; [ "$code" -gt 128 ] && signal=$((code - 128))

verdict=clean
if [ "$code" = 134 ] && [ "$pk_pids" -ge $((PIDS_MAX * 95 / 100)) ]; then verdict=pids-ceiling
elif [ "$code" = 137 ] && [ "$oomd" -gt 0 ]; then verdict=cgroup-oom
elif [ "$code" = 137 ]; then verdict=outside-cgroup
elif awk -v a="$pk_psi" -v k="$PSI_KILL" 'BEGIN{exit !(a > k)}' || [ "$highd" -gt 0 ]; then verdict=throttled
fi
[ "$stop" = duration ] && code=0 && signal=null
[ -n "$stop" ] && [ "$stop" != duration ] && verdict=guard-stop

reg="$BOARD_DIR/sessions/$owner.json"
name=$(jq -r '.name // empty' "$reg" 2>/dev/null); branch=$(jq -r '.branch // empty' "$reg" 2>/dev/null)
[ -n "$branch" ] || branch=$(git branch --show-current 2>/dev/null)
mix=$(tail -n 1 "$BOARD_DIR/history/samples-$(sb_today).jsonl" 2>/dev/null | jq -c '.mix' 2>/dev/null)
event=$(jq -nc --arg t "$(sb_now)" --argjson pid "$owner" --arg name "$name" --arg branch "$branch" \
  --arg label "$label" --arg class "$class" --arg cmd "${cmd:0:160}" --argjson exit "$code" --argjson signal "$signal" \
  --argjson wall "$(( (t1 - t0) / 100 ))" \
  --argjson dPids "$((pk_pids - pids0))" --argjson dAnon "$(( (pk_anon - anon0) / 1048576 ))" \
  --argjson pkPids "$pk_pids" --argjson pkAnon "$((pk_anon / 1048576))" --argjson pkCur "$((pk_cur / 1048576))" \
  --argjson thr "$pk_thr" --argjson rss "$((pk_rss / 1048576))" --argjson cores "$pk_cores" \
  --argjson pids0 "$pids0" --argjson anon0 "$((anon0 / 1048576))" --argjson pidsMax "$PIDS_MAX" \
  --argjson highMiB "$((MEM_HIGH / 1048576))" --argjson oomd "$oomd" --argjson highd "$highd" \
  --argjson psi "$pk_psi" --arg verdict "$verdict" --arg stop "$stop" --argjson mix "${mix:-null}" \
  --arg guard "${HEAVY_GUARD:-0}" '
  {v: 1, t: $t, pid: $pid, name: $name, branch: $branch, label: $label, class: $class, cmd: $cmd,
   exit: $exit, signal: $signal, wallSec: ($wall / 10),
   peak: {dPids: $dPids, dAnonMiB: $dAnon, pids: $pkPids, anonMiB: $pkAnon, currentMiB: $pkCur,
          subtreeThr: $thr, subtreeRssMiB: $rss, cores: $cores},
   before: {pids: $pids0, anonMiB: $anon0}, limits: {pidsMax: $pidsMax, highMiB: $highMiB},
   oomKillDelta: $oomd, highDelta: $highd, psiFullMax: $psi, mix: $mix, verdict: $verdict,
   stop: (if $stop == "" then null else $stop end), guard: ($guard == "1")}')
sb_append events "$event"
printf '%s\n' "$event" | jq -r '"heavy: \(.label) exit \(.exit) · \(.wallSec)s · pids +\(.peak.dPids) (peak \(.peak.pids)/\(.limits.pidsMax)) · anon +\(.peak.dAnonMiB) MiB (peak \(.peak.anonMiB)/\(.limits.highMiB)) · subtree \(.peak.subtreeThr) thr / \(.peak.subtreeRssMiB) MiB · \(.peak.cores) cores · psi \(.psiFullMax) · \(.verdict)"' >&2
[ -n "$sig" ] && exit $((128 + sig))
exit "$code"
