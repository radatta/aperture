#!/bin/bash
# Sourced by the hub's watchers (pace-, usage-, context- and merge-watch.sh; docs/ops/SESSION-BOARD.md → Watchers).
# Each watcher loops, writes its board file every tick, and EXITS ONLY when the hub should wake: the hub runs it as
# `timeout 65m <path>` in the background and restarts it after every exit but 73 (docs/ops/HUB.md → Watchers).
# Each holds a lock in the board dir (wl_singleton): 73 = another copy has it, 75 = held by no copy on file (a stopped
# copy's child: start again in a minute), 74 = the lock or pid file is unusable.
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

# One copy of a watcher per board dir: an flock on fd 8 for the life of the process, its pid beside the lock.
# Call it plainly (never in $(…) or a pipeline: the lock would die with the subshell), after the argument and limits
# checks and before the first state write. A second copy exits 73 naming the holder, or 75 when the holder isn't the
# pid on file (never "a copy runs" unproven: the hub restarts after 75, not after 73); the kernel frees the lock when
# the holder is gone, so a lock and a pid file left behind are taken over. Only the long child, the tick's sleep,
# starts with `8>&-` (a copy stopped by pid would leave it holding the lock); the 2 s wait rides out the rest.
wl_singleton() {
  local lock="$BOARD_DIR/$1.lock" pidf="$BOARD_DIR/$1.pid" rc pid=
  { exec 8>>"$lock"; } 2>/dev/null || { echo "$1: cannot open $lock" | tee -a "$BOARD_DIR/$1.log" >&2; exit 74; }
  flock -w 2 8 2>/dev/null
  rc=$?
  if [ "$rc" -eq 1 ]; then
    { read -r pid <"$pidf"; } 2>/dev/null
    if [[ "$pid" =~ ^[0-9]+$ ]] && [ "/proc/$pid/fd/8" -ef "$lock" ]; then
      echo "$1: already running as pid $pid ($lock)" | tee -a "$BOARD_DIR/$1.log" >&2
      exit 73
    fi
    echo "$1: $lock is held, but not by the pid in $pidf: a stopped copy's child may still hold it" | tee -a "$BOARD_DIR/$1.log" >&2
    exit 75
  fi
  [ "$rc" -eq 0 ] || { echo "$1: flock failed ($rc) on $lock" | tee -a "$BOARD_DIR/$1.log" >&2; exit 74; }
  echo $$ | sb_write "$pidf" || { echo "$1: cannot write $pidf" | tee -a "$BOARD_DIR/$1.log" >&2; exit 74; }
}

# The names of the live sessions whose hook state is working (sessions/<pid>.json, board.sh heartbeat), or nothing.
# grep -h '' ends each file's line, so a torn file can't swallow the next one; fromjson? drops it alone.
wl_working() {
  local pid start name out=
  while IFS=$'\t' read -r pid start name; do
    sb_alive "$pid" "$start" && out+="${out:+, }$name"
  done < <(grep -h '' "$BOARD_DIR"/sessions/*.json 2>/dev/null | jq -Rr 'fromjson? | objects
    | select(.state == "working" and (.pid | type) == "number" and (.pidStart | type) == "string" and .pidStart != "")
    | [(.pid | floor), .pidStart, ((.name // "") | tostring | gsub("[[:cntrl:]]"; " ") | .[0:40] | if . == "" then "?" else . end)] | @tsv' 2>/dev/null)
  printf '%s' "$out"
}

# Epoch of the newest row in the two newest meter files that passes jq test $1 (a row the caller can use), or
# nothing. The row's own offset is applied (jq's fromdateiso8601 reads only the Z form). Streams the files whole and
# takes the largest epoch, so no row order is assumed and a torn line drops alone: a tail can be 40 minutes of rows
# with no weekly %. ~1 s of CPU on a 38 MB day, and it runs only on a blind tick past the hold.
wl_meter_last() {
  local files=("$USAGE_DIR"/meter-*.jsonl)
  [ -e "${files[0]}" ] || return 0
  local n=${#files[@]} pick=("${files[@]: -2}")
  [ "$n" -ge 2 ] || pick=("${files[0]}")
  cat "${pick[@]}" 2>/dev/null | jq -Rn "def ok: $1;"'
    def ep: (capture("^(?<d>[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(?<s>[+-])(?<h>[0-9]{2}):(?<m>[0-9]{2})$")
      | ((.d + "Z" | fromdateiso8601) - (if .s == "-" then -1 else 1 end) * ((.h | tonumber) * 3600 + (.m | tonumber) * 60)))? // empty;
    reduce (inputs | fromjson? | objects | select(ok) | .ts | strings | ep) as $e (null; if . == null or $e > . then $e else . end) // empty' 2>/dev/null
}

# A tick with no reading (a dead status-line logger would leave the stop lines blind). Exits 13 when a live
# session is working, such ticks have added up to freshSec since this copy's last reading (ticks, not the clock: a
# paused VM must not count), the newest usable row is staleSec old or there is none, and neither meter watcher said
# so in the last staleSec (meter-stale-fired; an unwritable one is 74 with the line, as pace's stop-fired).
wl_blind=0
wl_meter_ok() { wl_blind=0; }
wl_meter_blind() { # <watcher> <staleSec> <freshSec> <intervalSec> <jq test of a usable row>
  local who fired last since
  who=$(wl_working)
  [ -n "$who" ] || return 0
  if [ "$wl_blind" -lt "$3" ]; then wl_blind=$((wl_blind + $4)); return 0; fi
  fired=$(cat "$BOARD_DIR/meter-stale-fired" 2>/dev/null)
  [[ "$fired" =~ ^[1-9][0-9]{0,11}$ ]] && [ "$fired" -le "$now" ] || fired=0 # no leading 0: $((…)) reads octal
  [ $((now - fired)) -ge "$2" ] || return 0
  last=$(wl_meter_last "$5")
  [[ "$last" =~ ^[1-9][0-9]{0,11}$ ]] || last=0
  [ $((now - last)) -ge "$2" ] || return 0
  since="no usable row in the two newest meter files"
  [ "$last" -eq 0 ] || since="last usable row $(date -d "@$last" '+%m-%d %H:%M')"
  echo "$now" | sb_write "$BOARD_DIR/meter-stale-fired" ||
    { wl_say "$1" "$(wl_at +%H:%M) METER STALE $since, but meter-stale-fired is unwritable"; exit 74; }
  wl_say "$1" "$(wl_at +%H:%M) METER STALE $since, working: $who"
  exit 13
}
