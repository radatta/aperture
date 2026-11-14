#!/usr/bin/env bash
# Background usage sampler: one tick every SAMPLER_INTERVAL s (30) → board/history/samples-<date>.jsonl,
# plus board/status.line. One per container (flock, waited for up to 5 s: status/json probes hold it for
# microseconds); started by `board.sh sampler start`, dies with the container. Pure bash + one awk per tick; reads /proc/<pid>/{stat,cmdline} only (shape rules: lib.sh).
#   sampler.sh          run forever
#   sampler.sh --once   one tick, no lock (tests, probe)
#   sampler.sh --print  compute a tick to stdout; writes nothing (board.sh status/json)
#   sampler.sh --prev-path  where the previous tick's counters live (tests check a fake cgroup's is its own)
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


tick() {  # $1 = print → stdout only, nothing written
  sb_init_dirs
  local panes="$work.panes" sess="$work.sess" slots="$work.slots" line pOut="$prev.new" sOut="$BOARD_DIR/status.line.tmp"
  local -a live=()
  [ "${1:-}" = print ] && pOut=/dev/null sOut=/dev/null
  : >"$panes"; : >"$sess"; : >"$slots"; touch "$prev"
  [ -n "${TMUX:-}" ] || [ -S "/tmp/tmux-$(id -u)/default" ] &&
    tmux list-panes -a -F $'#{window_name}\t#{pane_pid}' >"$panes" 2>/dev/null
  compgen -G "$BOARD_DIR/sessions/*.json" >/dev/null &&
    jq -r '[.pid, .sid // "", .name // "", .branch // "", (if .lastPromptAt or .lastStopAt then .state // "" else "" end)] | @tsv' "$BOARD_DIR"/sessions/*.json >"$sess" 2>/dev/null
  mapfile -t live < <(sb_live_slots)  # a dead wrapper's slot is not a running job (lib.sh)
  [ "${#live[@]}" -eq 0 ] ||
    jq -r '[.pid, .label // .class] | @tsv' "${live[@]}" >"$slots" 2>/dev/null
  local epr=${EPOCHREALTIME:-}; epr=${epr/,/.} # µs clock, '.' whatever the locale; unset before bash 5: awk falls back to seconds
  line=$(sb_procs args | awk -f "$SB_SCRIPTS/sample.awk" \
    -v t="$(sb_now)" -v ep="$(sb_epoch)" -v epr="$epr" -v interval="$interval" -v page="$page" -v hz="$hz" \
    -v anon="$(cg_anon)" -v file="$(cg_file)" -v current="$(cg_current)" -v high="$(cg_high)" \
    -v pids="$(cg_pids)" -v pidsMax="$(cg_pids_max)" -v usage="$(cg_usage_usec)" -v cpus="$(cg_cpus)" \
    -v psiMemSome="$(cg_psi memory some)" -v psiMemFull="$(cg_psi memory full)" -v psiCpuSome="$(cg_psi cpu some)" \
    -v oomKill="$(cg_oom_kill)" -v highEvents="$(cg_high_events)" -v dev="$(jq -r --argjson now "$(sb_epoch)" '.holder | select(. and (.expiresAt | sub("\\.[0-9]+"; "") | fromdate) > $now) | .branch' "$BOARD_DIR/devlock.json" 2>/dev/null)" \
    -v prevOut="$pOut" -v statusOut="$sOut" -v F1="$panes" -v F2="$sess" -v F3="$slots" -v F4="$prev" \
    "$panes" "$sess" "$slots" "$prev" -)
  rm -f "$panes" "$sess" "$slots"
  [ "${1:-}" = print ] && { printf '%s\n' "$line"; return; }
  mv -f "$prev.new" "$prev" 2>/dev/null
  mv -f "$BOARD_DIR/status.line.tmp" "$BOARD_DIR/status.line" 2>/dev/null
  [ -n "$line" ] && sb_append samples "$line"
}

if [ "${1:-}" = --prev-path ]; then printf '%s\n' "$prev"; exit 0; fi
if [ "${1:-}" = --once ]; then tick; exit 0; fi
if [ "${1:-}" = --print ]; then tick print; exit 0; fi

exec 8>>"$SAMPLER_LOCK"
flock -w 5 8 || exit 0  # another sampler holds it; a probe's hold is over in microseconds
printf '%s\n' "$$" >"$SAMPLER_PID"
trap 'rm -f "$work".*; exit 0' TERM INT
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
  n=$((n + 1))
  sleep "$interval" 8>&- & wait $!
done
