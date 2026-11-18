#!/bin/bash
# Sourced by the hub's watchers (pace-watch.sh, usage-watch.sh, context-watch.sh; docs/ops/SESSION-BOARD.md → Watchers).
# Each watcher loops, writes its board file every tick, and EXITS ONLY when the hub should wake: the hub runs it as
# `timeout 65m <path>` in the background and restarts it after every exit (docs/ops/HUB.md → Watchers).
#
# Time comes only from `date +%s` (once per tick) and `date -d @<epoch> +FMT` — never bash's own clock — and the
# pause is a plain `sleep`, so the fixture tests' PATH shims drive the clock (scripts/src/board/watchers.test.ts).
# History files are named by LOCAL day with local-offset times, as before the move: not sb_append (UTC).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

USAGE_DIR="${APERTURE_USAGE_DIR:-${BOARD_DIR%/*}/usage}" # the status-line logger's meter-<day>.jsonl files
LOADAVG="${APERTURE_LOADAVG:-/proc/loadavg}"

# A number from limits.json, or exit 78 naming the key: every threshold has one home, so no built-in default.
# Use as `X=$(wl_need <who> .watchers.pace.tripCores) || exit 78` — an exit inside $(…) only leaves the subshell.
wl_need() {
  local v
  v=$(sb_limit "$2")
  if [[ "$v" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then printf '%s' "$v"; return 0; fi
  echo "$1: limits.json $2 missing or not a number ($LIMITS_JSON)" | tee -a "$BOARD_DIR/$1.log" >&2
  return 1
}
# The same for a whole number of at least 1 — seconds and counts, which shell arithmetic reads.
wl_int() {
  local v
  v=$(sb_limit "$2")
  if [[ "$v" =~ ^[1-9][0-9]*$ ]]; then printf '%s' "$v"; return 0; fi
  echo "$1: limits.json $2 missing or not a whole number >= 1 ($LIMITS_JSON)" | tee -a "$BOARD_DIR/$1.log" >&2
  return 1
}
wl_num() { [[ "${1:-}" =~ ^[0-9]+(\.[0-9]+)?$ ]]; }

# PSI avg10 of line $2 (some|full) in $CG/$1.pressure, or nothing when the file or line is missing — unlike lib.sh's
# cg_psi, whose 0 would read as "no pressure" to a watcher that must fail closed.
wl_psi() {
  local kind a rest
  while read -r kind a rest || [ -n "$kind" ]; do
    [ "$kind" = "$2" ] && { printf '%s' "${a#avg10=}"; return; }
  done 2>/dev/null <"$CG/$1.pressure"
}

wl_at() { date -d "@$now" "$@"; }                    # a format of this tick's clock
wl_say() { echo "$2" | tee -a "$BOARD_DIR/$1.log"; } # a wake line: the hub reads stdout, the log keeps it
wl_hist() { printf '%s\n' "$2" >>"$BOARD_DIR/history/$1-$(wl_at +%F).jsonl"; }

# The last $1 rows of the two newest meter files (name order is date order), torn lines dropped, as one JSON array.
# Two files, so a session whose latest row is in yesterday's file still counts just after midnight.
wl_meter_rows() {
  local files=("$USAGE_DIR"/meter-*.jsonl)
  [ -e "${files[0]}" ] || { echo '[]'; return; }
  local n=${#files[@]} pick=("${files[@]: -2}")
  [ "$n" -ge 2 ] || pick=("${files[0]}")
  tail -q -n "$1" "${pick[@]}" 2>/dev/null | jq -Rn '[inputs | fromjson? | objects]'
}
