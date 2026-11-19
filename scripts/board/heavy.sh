#!/usr/bin/env bash
# Run one heavy command budgeted + measured (docs/ops/SESSION-BOARD.md → Heavy wrapper):
#   scripts/board/heavy.sh [--wait SEC] -- <cmd…>
# Takes a heavy slot (waits only when limits.json enforce:true and the budget is over hard or the class's
# concurrency cap is full — load tests are never capped), samples the
# container + the command's process subtree at 1 Hz, and appends the peaks to board/history/events-*.jsonl.
# stdout/stderr pass straight through; the exit code is the command's (128+sig if signalled).
# Env: HEAVY_LABEL (label; never argv), HEAVY_CLASS (override), HEAVY_DURATION (stop after N s, e.g. dev),
#      HEAVY_GUARD=1 (enforce the stop conditions — load tests only), HEAVY_LOADTEST=1 (a load-test run
#      that manages its own stops, e.g. edge.sh). Either marks the event loadTest:true, which report and
#      staleness leave out of the per-class costs.
#      HEAVY_SLOT_CLASS=test|test-fast (the slot's class when it differs from the event's: pnpm gate:fast's outer
#      run logs gate-wide but holds a `test` slot), HEAVY_NOSLOT=<pid> (a step inside that run: measured and logged,
#      no slot — honoured only while <pid> is a live slot's heavy.sh and an ancestor, else it takes a slot).
#      The command gets HEAVY_WRAPPER=<this heavy.sh's pid>, for its own steps' HEAVY_NOSLOT, and HEAVY_DETAIL_DIR, a
#      dir whose vitest-*.json / devcheck.json it may leave for the event (SESSION-BOARD.md → Perf fields).
#      HEAVY_DETAIL=0 turns every perf field off (the A/B switch that measures their cost).
set -u
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
. "$SB_SCRIPTS/lease.sh"

wait_sec=
while [ $# -gt 0 ]; do
  case "$1" in
    --wait) wait_sec="$2"; shift 2 ;;
    --) shift; break ;;
    *) break ;;
  esac
done
[ $# -gt 0 ] || { echo "usage: heavy.sh [--wait SEC] -- <cmd…>" >&2; exit 2; }

ts0=${EPOCHREALTIME:-}; ts0=${ts0/[.,]/}  # µs, before the slot wait (waitSec); empty before bash 5
cmd="$*"
class="${HEAVY_CLASS:-$(sb_classify "$cmd")}"
label="${HEAVY_LABEL:-$class}"
me=$$
read -r _ me_start < <(sb_stat "$me")
owner=$( [ -n "${CLAUDE_PID:-}" ] && echo "$CLAUDE_PID" || sb_claude_pid "$PPID" ) || owner=0
work="${TMPDIR:-/tmp}/aperture-heavy.$me"
# a reused pid's leftovers (a stale `duration` stop would turn a failure into exit 0)
[ -d "$work.d" ] && { rm -f "${work:?}.d"/* "${work:?}.d"/.[!.]* 2>/dev/null; rmdir "$work.d" 2>/dev/null; }
rm -f "${work:?}".* 2>/dev/null
eval "$(sb_thresholds)"

# Container-only tuning, per limits.json `tuning.test` (`maxWorkers: 4` since 2026-11-13 — SESSION-BOARD.md → Results).
# test-fast (a pre-gate-parallel gate:fast's per-package runs) takes the same cap, unless its caller set one.
if { [ "$class" = test ] || [ "$class" = test-fast ]; } && sb_in_container; then
  wc=$(sb_limit '.tuning.test.workspaceConcurrency'); mw=$(sb_limit '.tuning.test.maxWorkers')
  if [ -n "$mw" ] && { [ "$class" = test ] || [ -z "${VITEST_MAX_WORKERS:-}" ]; }; then export VITEST_MAX_WORKERS="$mw"; fi
  if [ -n "$wc" ] && [ "$cmd" = "pnpm test" ]; then set -- pnpm -r --workspace-concurrency="$wc" test; cmd="$*"; fi
fi

# A step inside a slotted run (pnpm gate:fast) names that run's heavy.sh in HEAVY_NOSLOT. Honoured only while that
# pid is our ancestor and holds a live slot — a `test` one for a `test`-slot job: never a way past the cap.
noslot_held() {
  local w="${HEAVY_NOSLOT:-}" p=$$ ps st i f c
  [[ "$w" =~ ^[0-9]+$ ]] || return 1
  for ((i = 0; i < 32; i++)); do
    read -r ps st < <(sb_stat "$p") || return 1
    [ "$ps" = "$w" ] && break
    [ "$ps" -gt 1 ] 2>/dev/null || return 1
    p=$ps
  done
  [ "$ps" = "$w" ] || return 1
  for f in "$BOARD_DIR"/leases/heavy/*.json; do
    [ -e "$f" ] || continue
    read -r p c < <(jq -r '"\(.wrapperPid) \(.class)"' "$f" 2>/dev/null)
    [ "$p" = "$w" ] && sb_slot_live "$f" || continue
    [ "$slot_class" != test ] || [ "$c" = test ]
    return
  done
  return 1
}

# Slot: test-file and other are measured but take none, nor does a step inside a slotted run. HEAVY_SLOT_CLASS may
# only raise a slot to `test-fast` or `test` (a `test` job's slot stays `test`).
slot_class=$class
case "${HEAVY_SLOT_CLASS:-}" in
  '') ;;
  test) slot_class=test ;;
  test-fast) [ "$class" = test ] || slot_class=test-fast ;;
  *) echo "heavy: HEAVY_SLOT_CLASS=${HEAVY_SLOT_CLASS} ignored (test or test-fast only)" >&2 ;;
esac
noslot=0
if [ -n "${HEAVY_NOSLOT:-}" ]; then
  if noslot_held; then noslot=1
  else echo "heavy: HEAVY_NOSLOT=${HEAVY_NOSLOT} is no live slot above this run — taking a slot" >&2
  fi
fi
slot=
if [ "$slot_class" != test-file ] && [ "$slot_class" != other ] && [ "$noslot" = 0 ]; then
  slot="$BOARD_DIR/leases/heavy/$owner-$me.json"
  lease_heavy_acquire "$slot" "$owner" "$slot_class" "$label" "$cmd" "$me" "$me_start" "${wait_sec:-}" || exit $?
fi

# Descendants of the PIDs in $1 (space-separated, inclusive) with their threads/rss — one awk over one /proc pass.
subtree() {
  sb_procs | awk -F'\t' -v roots="$1" -v page="$(getconf PAGESIZE)" '
    BEGIN { k = split(roots, rr, " "); for (i = 1; i <= k; i++) R[rr[i]] = 1 }
    { pp[$1] = $2; th[$1] = $4; rs[$1] = $5 }
    END { for (p in pp) { q = p; for (n = 0; n < 64 && q > 1; n++) { if (q in R) { print p; t += th[p]; r += rs[p] * page; break } q = pp[q] } }
          printf "T %d %d\n", t, r }'
}
# By PID until the subtree is empty: TERM for ~3 s, then KILL. Each pass re-walks from every PID seen so
# far — forks after the first pass are caught, and so are orphans that reparented away from the root.
kill_tree() {
  local seen="$1" live p i sig
  for ((i = 0; i < 10; i++)); do
    live=$(subtree "$seen" | awk '$1 != "T"' | tr '\n' ' ')
    [ -n "${live// /}" ] || return 0
    seen="$seen $live"
    sig=TERM; [ "$i" -ge 6 ] && sig=KILL
    for p in $live; do kill -"$sig" "$p" 2>/dev/null; done
    sleep 0.5
  done
}

# Perf fields (SESSION-BOARD.md → Perf fields). Before the fork: builtins (plus a mkdir the first time), so the run
# starts from the caches as they were; the git half runs beside the command, outside wallSec. A class that isn't a
# plain word (it names a file and goes into the JSON) gets none.
detail=1; [ "${HEAVY_DETAIL:-1}" = 0 ] && detail=0
[[ "$class" =~ ^[a-z][a-z-]*$ ]] || detail=0
# kinds: the caches this class reads. roll: whether it moves their baseline — a gate's outer run only reports the
# state its steps start from (its tsc and eslint steps roll their own).
kinds= roll=1
case "$class" in
  typecheck | gate-typecheck) kinds=tsc ;;
  lint | gate-lint) kinds=eslint ;;
  warm) kinds="tsc eslint" ;;
  gate-narrow | gate-wide) kinds="tsc eslint" roll=0 ;;
esac
top= cdir= tsc_ex=- eslint_ex=-
if [ "$detail" = 1 ] && [ -n "$kinds" ]; then
  d=$PWD
  while [ -n "$d" ] && [ ! -e "$d/.git" ]; do d=${d%/*}; done
  [ -n "$d" ] && [ -d "$d/node_modules" ] && top=$d
fi
# The detail dir is for what a test or devcheck run leaves; a tsc or eslint run (or a gate's outer run, whose steps
# have their own) leaves nothing, so it gets none — and never an outer run's, inherited.
dd= mk=()
[ "$detail" = 1 ] && [ -z "$kinds" ] && dd="$work.d" mk+=("$dd")
[ -n "$top" ] && cdir="$top/node_modules/.cache/aperture-heavy" && { [ -d "$cdir" ] || mk+=("$cdir"); }
[ "${#mk[@]}" -eq 0 ] || mkdir -p "${mk[@]}" 2>/dev/null || dd= cdir= top=
if [ -n "$dd" ]; then export HEAVY_DETAIL_DIR="$dd"; else unset HEAVY_DETAIL_DIR; fi

pids0=$(cg_pids); anon0=$(cg_anon); oom0=$(cg_oom_kill); high0=$(cg_high_events)
t0=$(date +%s%3N)

# Traps before the fork, so a signal in the gap can't kill the wrapper and orphan the command (subshells
# and background children reset caught traps, so neither the command nor the monitor inherits these).
child= sig=
on_signal() { [ -n "$child" ] && kill_tree "$child"; }
trap 'on_signal; trap - TERM; sig=15' TERM
trap 'on_signal; trap - INT; sig=2' INT
trap 'on_signal; trap - HUP; sig=1' HUP
HEAVY_WRAPPER=$me "$@" &
child=$!
[ -n "$sig" ] && kill_tree "$child"  # signalled before $child was known

# Beside the command: which caches exist (read in its first milliseconds: tsc and eslint take over 100 ms to start, and
# write their caches at the end), the sha and, per cache, the paths changed since this worktree's last run of that
# kind (changed since its tracked state, or untracked, and missing or newer than the last run's start). Lines:
# "E tscExisted eslintExisted", "S sha", "K kind lastSha lastAgeSec changed changedSrc changedCfg" ("-" unknown).
# start.<pid> is this run's start as an mtime on the caches' own mount (a /tmp stamp would compare across two clocks),
# made here in its first milliseconds: what a rewritten buildinfo, or the next run's changed file, is newer than.
# <kind>.last is "sha start.<pid>" of the last run of that kind that ended well — one builtin write at the end, so the
# run's own path has no fork; a stamp no .last names and no live run owns is swept here, off that path.
cj=
if [ -n "$top" ]; then
  (
    cd "$top" || exit 0
    : >"$cdir/start.$me"
    te=0 ee=false
    for f in "${SB_TSBUILDINFO[@]}"; do [ -e "$f" ] && te=$((te + 1)); done
    [ -e node_modules/.cache/eslint/.eslintcache ] && ee=true
    echo "E $te $ee"
    export GIT_OPTIONAL_LOCKS=0
    sha=$(timeout 5 git rev-parse HEAD 2>/dev/null)
    [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || sha=-
    echo "S $sha"
    untracked=$(timeout 5 git ls-files -o --exclude-standard 2>/dev/null)
    printf -v now '%(%s)T' -1
    for k in $kinds; do
      last= lref= age=- n=- src=- cfg=-
      read -r last lref 2>/dev/null <"$cdir/$k.last"
      ref="$cdir/$lref"
      if [[ "$last" =~ ^[0-9a-f]{40}$ && "$lref" =~ ^start\.[0-9]+$ ]] && [ -f "$ref" ]; then
        m=$(stat -c %Y "$ref" 2>/dev/null) && age=$((now - m)) && [ "$age" -ge 0 ] || age=-
        # --no-renames: a `git mv` lists its old path too (missing, so counted); its new one keeps the old mtime
        if timeout 5 git cat-file -e "$last^{commit}" 2>/dev/null &&
          list=$(timeout 5 git diff --no-renames --name-only "$last" -- 2>/dev/null); then
          n=0 src=0 cfg=0
          while IFS= read -r p; do
            [ -n "$p" ] || continue
            [ -e "$p" ] && ! [ "$p" -nt "$ref" ] && continue
            n=$((n + 1))
            case "$p" in *.ts | *.tsx | *.mts | *.cts | *.js | *.jsx | *.mjs | *.cjs) src=$((src + 1)) ;; esac
            case "${p##*/}" in tsconfig*.json | package.json | pnpm-lock.yaml | eslint.config.*) cfg=$((cfg + 1)) ;; esac
          done < <(printf '%s\n%s\n' "$list" "$untracked" | sort -u)
        fi
      else last=-; fi
      echo "K $k $last $age $n $src $cfg"
    done
    # The sweep: stamps a stopped, failed-to-start or superseded run left.
    keep=" start.$me "
    for k in tsc eslint; do lref=; read -r _ lref 2>/dev/null <"$cdir/$k.last" && keep+="$lref "; done
    gone=()
    for p in "$cdir"/start.*; do
      n=${p##*/}
      [[ "$keep" == *" $n "* ]] || kill -0 "${n#start.}" 2>/dev/null || gone+=("$p")
    done
    [ "${#gone[@]}" -eq 0 ] || rm -f "${gone[@]}"
  ) >"$work.cache" 2>/dev/null </dev/null &
  cj=$!
fi

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
    echo "$pk_pids $pk_anon $pk_cur $pk_thr $pk_rss $pk_psi $pk_cores" >"$work.peak.tmp" && mv -f "$work.peak.tmp" "$work.peak"
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
      [ -n "$c" ] && [ "$MEM_HIGH" -gt 0 ] && [ "$c" -gt $((MEM_HIGH - CURRENT_GUARD)) ] && [ "$hot" -ge 1 ] &&
        reason="memory.current within $((CURRENT_GUARD / 1048576)) MiB of memory.high with PSI rising"
      if [ -n "$reason" ]; then
        echo "$reason" >"$work.stop"; echo "heavy: GUARD stop — $reason" >&2; kill_tree "$child"; break
      fi
    fi
    sleep 1
  done
) &
mon=$!

wait "$child"; code=$?
# `wait` returns early when a trapped signal arrives — wait again for the real exit.
while kill -0 "$child" 2>/dev/null; do wait "$child"; code=$?; done
t1=$(date +%s%3N)
# A guard/duration stop is the monitor's own kill_tree — let it finish its KILL pass rather than cut it short.
if [ -e "$work.stop" ]; then wait "$mon" 2>/dev/null; else kill "$mon" 2>/dev/null; wait "$mon" 2>/dev/null; fi
[ -n "$slot" ] && rm -f "$slot"
[ -n "$cj" ] && wait "$cj" 2>/dev/null  # its git calls are each under timeout 5

read -r pk_pids pk_anon pk_cur pk_thr pk_rss pk_psi pk_cores 2>/dev/null <"$work.peak" ||
  { pk_pids=$pids0 pk_anon=$anon0 pk_cur=0 pk_thr=0 pk_rss=0 pk_psi=0 pk_cores=0; }
stop=$(cat "$work.stop" 2>/dev/null)
# What the command left in HEAVY_DETAIL_DIR: vitest-<pid>.json lines (scripts/src/board/vitest-stats.ts, one per vitest
# process, summed here; transform is null if any process couldn't read it) and devcheck.json
# (scripts/src/devcheck/heavy-detail.ts, passed through: its last object). A bad file is skipped.
vitest=null devcheck=null
if [ -n "$dd" ] && [ -d "$dd" ]; then
  vf=("$dd"/vitest-*.json)
  [ -e "${vf[0]}" ] && vitest=$(cat "${vf[@]}" 2>/dev/null | jq -cRn '[inputs | fromjson? | objects | select(.files | type == "number")]
    | if length == 0 then null else
      {runs: length, files: (map(.files) | add), tests: (map(.tests // 0) | add), failed: (map(.failed // 0) | add),
       skipped: (map(.skipped // 0) | add),
       ms: ({wall: (map(.wallMs // 0) | max)} + reduce (.[].ms // {} | to_entries[]) as $e ({}; .[$e.key] += ($e.value // 0))
            + {transform: (if any(.[]; .ms.transform | type != "number") then null else map(.ms.transform) | add end)}),
       pkgs: (reduce .[] as $r ({}; .[$r.pkg // "?"] |= {files: ((.files // 0) + $r.files), tests: ((.tests // 0) + ($r.tests // 0)),
                                                        wallMs: ([.wallMs // 0, $r.wallMs // 0] | max)}))} end' 2>/dev/null)
  [ -s "$dd/devcheck.json" ] && devcheck=$(jq -cs 'map(objects) | last // empty' "$dd/devcheck.json" 2>/dev/null)
  rmdir "$dd" 2>/dev/null || { rm -f "${dd:?}"/* "${dd:?}"/.[!.]* 2>/dev/null; rmdir "$dd" 2>/dev/null; }
fi
[ -n "$vitest" ] || vitest=null
[ -n "$devcheck" ] || devcheck=null
csha=-; rew=0; declare -A cline=()
if [ -n "$top" ]; then
  [ -f "$work.cache" ] && while read -r a b c; do
    case "$a" in E) tsc_ex=$b eslint_ex=$c ;; S) csha=$b ;; K) cline[$b]=$c ;; esac
  done <"$work.cache"
  if [ -f "$cdir/start.$me" ]; then
    for f in "${SB_TSBUILDINFO[@]}"; do [ "$top/$f" -nt "$cdir/start.$me" ] && rew=$((rew + 1)); done
  else rew=-; fi
fi
rm -f "${work:?}".* 2>/dev/null
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

# The perf fields' JSON (SESSION-BOARD.md → Perf fields), merged into the event; {} under HEAVY_DETAIL=0.
jn() { [[ "$1" =~ ^[0-9]+(\.[0-9]+)?$ ]] && printf '%s' "$1" || printf null; }
perf='{}'
if [ "$detail" = 1 ]; then
  wait_sec=null
  [ -n "$ts0" ] && w=$(( t0 - ts0 / 1000 )) && [ "$w" -ge 0 ] && wait_sec="$((w / 1000)).$((w % 1000 / 100))"
  # First job of this class since the VM booted (boot_id) or the container started (its pid 1's start tick — a counter,
  # so a clock step after the Mac sleeps can't move it): a cold page cache. upSec, the container's uptime, rides along.
  up= bid= p1= first=null
  read -r up _ 2>/dev/null <"$SB_PROC/uptime"; up=${up%.*}
  read -r bid 2>/dev/null <"$SB_PROC/sys/kernel/random/boot_id"
  read -r p1 2>/dev/null <"$SB_PROC/1/stat" && read -ra p1f <<<"${p1##*) }" && p1=${p1f[19]:-}
  if [[ "$bid" =~ ^[0-9a-f-]+$ && "$p1" =~ ^[0-9]+$ ]]; then
    mb=; read -r mb 2>/dev/null <"$BOARD_DIR/boot/$class"
    if [ "$mb" = "$bid:$p1" ]; then first=false
    else
      first=true
      { [ -d "$BOARD_DIR/boot" ] || mkdir -p "$BOARD_DIR/boot"; } && printf '%s\n' "$bid:$p1" >"$BOARD_DIR/boot/$class"
    fi
  fi
  cache=null
  if [ -n "$top" ]; then
    [[ "$csha" =~ ^[0-9a-f]{40}$ ]] && cache="{\"sha\":\"$csha\"" || { csha=; cache='{"sha":null'; }
    cold=false
    for k in $kinds; do
      read -r last age n src cfg <<<"${cline[$k]:-- - - - -}"
      [[ "$last" =~ ^[0-9a-f]{40}$ ]] && lj="\"$last\"" fk=false || lj=null fk=true
      [ "${cline[$k]+x}" ] || fk=null  # the background job never reported: unknown
      cache+=",\"$k\":{\"lastSha\":$lj,\"lastAgeSec\":$(jn "$age"),\"first\":$fk,\"changed\":$(jn "$n"),"
      cache+="\"changedSrc\":$(jn "$src"),\"changedCfg\":$(jn "$cfg"),"
      if [ "$k" = tsc ]; then
        cache+="\"of\":${#SB_TSBUILDINFO[@]},\"existed\":$(jn "$tsc_ex"),\"rewritten\":$(jn "$rew")}"
        if ! [[ "$tsc_ex" =~ ^[0-9]+$ ]]; then cold=null
        elif [ "$cold" = false ] && [ "$tsc_ex" -lt "${#SB_TSBUILDINFO[@]}" ]; then cold=true; fi
      else
        case "$eslint_ex" in
          true) cache+="\"existed\":true}" ;;
          false) cache+="\"existed\":false}"; [ "$cold" = null ] || cold=true ;;
          *) cache+="\"existed\":null}"; cold=null ;;
        esac
      fi
    done
    cache+=",\"cold\":$cold}"
    # Roll forward: the next run counts changes since this run's start. Not after a stop or a signal to the command or
    # to heavy.sh (a cache may be half-written), nor from a gate's outer run, nor without a sha or a stamp. A builtin
    # write: a torn read is a reader's "no last run".
    if [ "$roll" = 1 ] && [ -z "$stop" ] && [ "$signal" = null ] && [ -z "$sig" ] && [ -n "$csha" ] &&
      [ -f "$cdir/start.$me" ]; then
      for k in $kinds; do printf '%s start.%s\n' "$csha" "$me" >"$cdir/$k.last"; done
    fi
  fi
  sj=null; [ -n "$slot" ] && sj="\"$slot_class\""
  perf="{\"waitSec\":$wait_sec,\"slot\":$sj,\"boot\":{\"upSec\":$(jn "$up"),\"first\":$first},\"cache\":$cache,"
  perf+="\"vitest\":$vitest,\"devcheck\":$devcheck}"  # a part that isn't JSON shows as perfInvalid, never silence
fi

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
  --arg guard "${HEAVY_GUARD:-0}" --arg lt "${HEAVY_LOADTEST:-0}" --arg perf "$perf" '
  {v: 1, t: $t, kind: "job", pid: $pid, name: $name, branch: $branch, label: $label, class: $class, cmd: $cmd,
   exit: $exit, signal: $signal, wallSec: ($wall / 10),
   peak: {dPids: $dPids, dAnonMiB: $dAnon, pids: $pkPids, anonMiB: $pkAnon, currentMiB: $pkCur,
          subtreeThr: $thr, subtreeRssMiB: $rss, cores: $cores},
   before: {pids: $pids0, anonMiB: $anon0}, limits: {pidsMax: $pidsMax, highMiB: $highMiB},
   oomKillDelta: $oomd, highDelta: $highd, psiFullMax: $psi, mix: $mix, verdict: $verdict,
   stop: (if $stop == "" then null else $stop end), guard: ($guard == "1"),
   loadTest: ($guard == "1" or $lt == "1")} + (if $perf == "{}" then {} else ($perf | fromjson? // {perfInvalid: true}) end)')
sb_append events "$event"
printf '%s\n' "$event" | jq -r '"heavy: \(.label) exit \(.exit) · \(.wallSec)s · pids +\(.peak.dPids) (peak \(.peak.pids)/\(.limits.pidsMax)) · anon +\(.peak.dAnonMiB) MiB (peak \(.peak.anonMiB)/\(.limits.highMiB)) · subtree \(.peak.subtreeThr) thr / \(.peak.subtreeRssMiB) MiB · \(.peak.cores) cores · psi \(.psiFullMax) · \(.verdict)"' >&2
[ -n "$sig" ] && exit $((128 + sig))
exit "$code"
