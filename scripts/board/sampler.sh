#!/usr/bin/env bash
# Background usage sampler: one tick every SAMPLER_INTERVAL s (30) → board/history/samples-<date>.jsonl,
# plus board/status.line. One per container (flock, waited for up to 5 s: status/json probes hold it for
# microseconds); started by `board.sh sampler start`, dies with the container. Bash, one awk and a few jq per tick
# (sessions, slots, lane phases); reads /proc/<pid>/{stat,cmdline} only (shape rules: lib.sh).
#   sampler.sh          run forever
#   sampler.sh --once   one tick, no lock (tests, probe)
#   sampler.sh --print  compute a tick to stdout; writes nothing (board.sh status/json)
#   sampler.sh --prev-path  where the previous tick's counters live (tests check a fake cgroup's is its own)
#   sampler.sh --probe  one RTT probe to the dev origin → <prev>.net (the loop runs it in the background; tests)
set -u
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

interval="${SAMPLER_INTERVAL:-30}"
page=$(getconf PAGESIZE); hz=$(getconf CLK_TCK)
work="${TMPDIR:-/tmp}/aperture-sampler.$$"
# The previous tick's counters. A fake cgroup (tests) keeps its own beside it: sharing the live sampler's
# file once fed it a test's usage_usec, and the next real tick divided all the container's CPU time by a few
# seconds (thousands of "cores").
prev="${APERTURE_SAMPLER_PREV:-${APERTURE_CGROUP_DIR:+$APERTURE_CGROUP_DIR/sampler.prev}}"
prev="${prev:-/tmp/aperture-sampler.prev}"
# The RTT probe's host (SESSION-BOARD.md → Perf fields → net): the dev origin, from the tracked identifiers, only on the
# real board in a coi container — never a test's fake board. APERTURE_PROBE_HOST stands in (tests).
probe_host="${APERTURE_PROBE_HOST:-}"
if [ -z "$probe_host" ] && [ "$BOARD_DIR" = "$SB_HOME_BOARD" ] && sb_in_container; then
  probe_host=$(jq -r '.domains.dev // empty' "$SB_REPO/identifiers.json" 2>/dev/null)
fi
[[ "$probe_host" =~ ^[a-z0-9.-]+$ ]] || probe_host=

# One HEAD over plain http: CloudFront answers it with its own redirect at the edge, so no origin, S3 or Lambda request
# is made (a CloudFront request, inside its always-free tier). Writes "epoch dnsMs connMs ttfbMs code" (code 0 = no
# answer: times "-"). Any other answer than the edge redirect turns the probe off (<prev>.net.off, one log line)
# rather than risk an origin request; a sampler restart tries again.
probe() {
  local out code dns conn ttfb xc now
  [ -n "$probe_host" ] && [ ! -e "$prev.net.off" ] || return 0
  now=$(sb_epoch)
  out=$(curl -s -I -m 5 -o /dev/null -w '%{http_code} %{time_namelookup} %{time_connect} %{time_starttransfer} %header{x-cache}' \
    "http://$probe_host/" 2>/dev/null)
  read -r code dns conn ttfb xc <<<"$out"
  if [[ "$code" =~ ^[1-9][0-9][0-9]$ ]] && [ "$xc" != "Redirect from cloudfront" ]; then
    echo "sampler: probe off — http://$probe_host/ answered $code, x-cache '${xc}', not CloudFront's edge redirect" >&2
    : >"$prev.net.off"
    return 0
  fi
  [[ "$code" =~ ^[1-9][0-9][0-9]$ ]] || { code=0 dns=- conn=- ttfb=-; }
  [ "$code" = 0 ] || read -r dns conn ttfb < <(awk -v a="$dns" -v b="$conn" -v c="$ttfb" 'BEGIN { printf "%d %d %d\n", a * 1000, b * 1000, c * 1000 }')
  printf '%s %s %s %s %s\n' "$now" "$dns" "$conn" "$ttfb" "$code" >"$prev.net.tmp" && mv -f "$prev.net.tmp" "$prev.net"
}


tick() {  # $1 = print → stdout only, nothing written
  sb_init_dirs
  local panes="$work.panes" sess="$work.sess" slots="$work.slots" lanes="$work.lanes" line f pOut="$prev.new" sOut="$BOARD_DIR/status.line.tmp"
  local -a live=()
  [ "${1:-}" = print ] && pOut=/dev/null sOut=/dev/null
  : >"$panes"; : >"$sess"; : >"$slots"; : >"$lanes"; touch "$prev"
  [ -n "${TMUX:-}" ] || [ -S "/tmp/tmux-$(id -u)/default" ] &&
    tmux list-panes -a -F $'#{window_name}\t#{pane_pid}' >"$panes" 2>/dev/null
  compgen -G "$BOARD_DIR/sessions/*.json" >/dev/null &&
    jq -r '[.pid, .sid // "", .name // "", .branch // "", (if .lastPromptAt or .lastStopAt then .state // "" else "" end)] | @tsv' "$BOARD_DIR"/sessions/*.json >"$sess" 2>/dev/null
  # Each lane's phase (`pnpm board lane`), so the budget's phase units can be re-measured (SESSION-BOARD.md →
  # Budget). One jq over them all; a half-written file stops that jq there, dropping the rest, so then one per file.
  if compgen -G "$BOARD_DIR/lanes/*.json" >/dev/null &&
    ! jq -r 'select(.branch and .phase) | [.branch, .phase] | @tsv' "$BOARD_DIR"/lanes/*.json >"$lanes" 2>/dev/null; then
    for f in "$BOARD_DIR"/lanes/*.json; do
      jq -r 'select(.branch and .phase) | [.branch, .phase] | @tsv' "$f" 2>/dev/null
    done >"$lanes"
  fi
  mapfile -t live < <(sb_live_slots)  # a dead wrapper's slot is not a running job (lib.sh)
  [ "${#live[@]}" -eq 0 ] ||
    jq -r '[.pid, .label // .class] | @tsv' "${live[@]}" >"$slots" 2>/dev/null
  local epr=${EPOCHREALTIME:-}; epr=${epr/,/.} # µs clock, '.' whatever the locale; unset before bash 5: awk falls back to seconds
  # The perf fields' reads, builtins only (a tick is ~100 ms: 1% is a millisecond, so no fork).
  local steal= l1= rq= up= net=
  read -r _ _ _ _ _ _ _ _ steal _ 2>/dev/null <"$SB_PROC/stat"  # cpu user nice system idle iowait irq softirq steal
  read -r l1 _ _ rq _ 2>/dev/null <"$SB_PROC/loadavg"; rq=${rq%/*}
  read -r up _ 2>/dev/null <"$SB_PROC/uptime"; up=${up%.*}
  read -r net 2>/dev/null <"$prev.net"
  line=$(sb_procs args | awk -f "$SB_SCRIPTS/sample.awk" \
    -v t="$(sb_now)" -v ep="$(sb_epoch)" -v epr="$epr" -v interval="$interval" -v page="$page" -v hz="$hz" \
    -v anon="$(cg_anon)" -v file="$(cg_file)" -v current="$(cg_current)" -v high="$(cg_high)" \
    -v pids="$(cg_pids)" -v pidsMax="$(cg_pids_max)" -v usage="$(cg_usage_usec)" -v cpus="$(cg_cpus)" \
    -v psiMemSome="$(cg_psi memory some)" -v psiMemFull="$(cg_psi memory full)" -v psiCpuSome="$(cg_psi cpu some)" \
    -v oomKill="$(cg_oom_kill)" -v highEvents="$(cg_high_events)" -v dev="$(jq -r --argjson now "$(sb_epoch)" '.holder | select(. and (.expiresAt | sub("\\.[0-9]+"; "") | fromdate) > $now) | .branch' "$BOARD_DIR/devlock.json" 2>/dev/null)" \
    -v prevOut="$pOut" -v statusOut="$sOut" -v F1="$panes" -v F2="$sess" -v F3="$slots" -v F4="$prev" -v F5="$lanes" \
    -v steal="$steal" -v load1="$l1" -v runq="$rq" -v upSec="$up" -v net="$net" \
    "$panes" "$sess" "$slots" "$prev" "$lanes" -)
  rm -f "$panes" "$sess" "$slots" "$lanes"
  [ "${1:-}" = print ] && { printf '%s\n' "$line"; return; }
  mv -f "$prev.new" "$prev" 2>/dev/null
  mv -f "$BOARD_DIR/status.line.tmp" "$BOARD_DIR/status.line" 2>/dev/null
  [ -n "$line" ] && sb_append samples "$line"
}

if [ "${1:-}" = --prev-path ]; then printf '%s\n' "$prev"; exit 0; fi
if [ "${1:-}" = --once ]; then tick; exit 0; fi
if [ "${1:-}" = --print ]; then tick print; exit 0; fi
if [ "${1:-}" = --probe ]; then probe; exit 0; fi

exec 8>>"$SAMPLER_LOCK"
flock -w 5 8 || exit 0  # another sampler holds it; a probe's hold is over in microseconds
printf '%s\n' "$$" >"$SAMPLER_PID"
trap 'rm -f "$work".*; exit 0' TERM INT
rm -f "$prev.net.off"
n=0
while :; do
  tick
  # Something may sweep /tmp; `board.sh sampler stop` needs the pid.
  [ -s "$SAMPLER_PID" ] || printf '%s\n' "$$" >"$SAMPLER_PID"
  # File overlaps across worktrees every 5th tick (~2.5 min): git is cheap, but not per prompt. Skipped
  # while the last one still runs. Background children close fd 8, or they'd hold the singleton lock
  # after the sampler is stopped and `sampler restart` would find it taken.
  if [ $((n % 5)) -eq 0 ] && ! { [ -n "${ov:-}" ] && kill -0 "$ov" 2>/dev/null; }; then
    node "$SB_REPO/scripts/src/board/cli.ts" overlap "$SB_REPO" "$BOARD_DIR" >/dev/null 2>&1 8>&- &
    ov=$!
  fi
  # The real dev lock every 10th tick (~5 min), read-only and timed out (devlock.sh); same fd 8 rule.
  if [ $((n % 10)) -eq 0 ] && ! { [ -n "${dl:-}" ] && kill -0 "$dl" 2>/dev/null; }; then
    APERTURE_DEVLOCK_CALLER=sampler bash "$SB_SCRIPTS/devlock.sh" refresh --max-age 240 >/dev/null 2>&1 8>&- &
    dl=$!
  fi
  # The RTT probe, once a tick after it, in the background (≤ 5 s); same fd 8 rule.
  if [ -n "$probe_host" ] && ! { [ -n "${np:-}" ] && kill -0 "$np" 2>/dev/null; }; then
    probe 8>&- 2>>"$BOARD_DIR/sampler.log" &
    np=$!
  fi
  n=$((n + 1))
  sleep "$interval" 8>&- & wait $!
done
