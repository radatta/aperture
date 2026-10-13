#!/bin/bash
# Background usage sampler: one tick every SAMPLER_INTERVAL s (30) → board/history/samples-<date>.jsonl,
# plus board/status.line. One per container (flock); started by `board.sh sampler start`, dies with the
# container. Pure bash + one awk per tick; reads /proc/<pid>/{stat,cmdline} only (shape rules: lib.sh).
#   sampler.sh          run forever
#   sampler.sh --once   one tick, no lock (tests, probe)
#   sampler.sh --print  compute a tick to stdout; writes nothing (board.sh status/json)
set -u
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

interval="${SAMPLER_INTERVAL:-30}"
page=$(getconf PAGESIZE); hz=$(getconf CLK_TCK)
work="${TMPDIR:-/tmp}/aperture-sampler.$$"
prev="${APERTURE_SAMPLER_PREV:-/tmp/aperture-sampler.prev}"


tick() {  # $1 = print → stdout only, nothing written
  sb_init_dirs
  local panes="$work.panes" sess="$work.sess" slots="$work.slots" line pOut="$prev.new" sOut="$BOARD_DIR/status.line.tmp"
  [ "${1:-}" = print ] && pOut=/dev/null sOut=/dev/null
  : >"$panes"; : >"$sess"; : >"$slots"; touch "$prev"
  [ -n "${TMUX:-}" ] || [ -S "/tmp/tmux-$(id -u)/default" ] &&
    tmux list-panes -a -F $'#{window_name}\t#{pane_pid}' >"$panes" 2>/dev/null
  compgen -G "$BOARD_DIR/sessions/*.json" >/dev/null &&
    jq -r '[.pid, .sid // "", .name // "", .branch // "", (if .lastPromptAt or .lastStopAt then .state // "" else "" end)] | @tsv' "$BOARD_DIR"/sessions/*.json >"$sess" 2>/dev/null
  compgen -G "$BOARD_DIR/leases/heavy/*.json" >/dev/null &&
    jq -r '[.pid, .label // .class] | @tsv' "$BOARD_DIR"/leases/heavy/*.json >"$slots" 2>/dev/null
  line=$(sb_procs args | awk -f "$SB_SCRIPTS/sample.awk" \
    -v t="$(sb_now)" -v ep="$(sb_epoch)" -v interval="$interval" -v page="$page" -v hz="$hz" \
    -v anon="$(cg_anon)" -v file="$(cg_file)" -v current="$(cg_current)" -v high="$(cg_high)" \
    -v pids="$(cg_pids)" -v pidsMax="$(cg_pids_max)" -v usage="$(cg_usage_usec)" \
    -v psiMemSome="$(cg_psi memory some)" -v psiMemFull="$(cg_psi memory full)" -v psiCpuSome="$(cg_psi cpu some)" \
    -v oomKill="$(cg_oom_kill)" -v highEvents="$(cg_high_events)" \
    -v prevOut="$pOut" -v statusOut="$sOut" -v F1="$panes" -v F2="$sess" -v F3="$slots" -v F4="$prev" \
    "$panes" "$sess" "$slots" "$prev" -)
  rm -f "$panes" "$sess" "$slots"
  [ "${1:-}" = print ] && { printf '%s\n' "$line"; return; }
  mv -f "$prev.new" "$prev" 2>/dev/null
  mv -f "$BOARD_DIR/status.line.tmp" "$BOARD_DIR/status.line" 2>/dev/null
  [ -n "$line" ] && sb_append samples "$line"
}

if [ "${1:-}" = --once ]; then tick; exit 0; fi
if [ "${1:-}" = --print ]; then tick print; exit 0; fi

exec 8>>/tmp/aperture-sampler.lock
flock -n 8 || exit 0
printf '%s\n' "$$" >/tmp/aperture-sampler.pid
trap 'rm -f "$work".*; exit 0' TERM INT
while :; do
  tick
  sleep "$interval" & wait $!
done
