#!/bin/bash
# The zero-token phase logger: one pass over the lane status files (board/lanes/*.json), appending a row to the usage
# dir's phase-log.jsonl for each lane phase change. No Claude, no hub wake; the sampler's loop runs it every tick.
# Row shape and rules: docs/ops/USAGE-METER.md → Phase log. Nothing on stdout; trouble goes to <board>/phase-log.log.
# Run: scripts/board/phase-log.sh --once     APERTURE_PHASE_LOG / APERTURE_PHASE_STATE override the two files.
set -u
[ "$#" -eq 1 ] && [ "$1" = --once ] || { echo "usage: phase-log.sh --once" >&2; exit 2; }
source "$(dirname "${BASH_SOURCE[0]}")/watch-lib.sh"
W=phase-log
LOG="${APERTURE_PHASE_LOG:-$USAGE_DIR/phase-log.jsonl}"
STATE="${APERTURE_PHASE_STATE:-$BOARD_DIR/phase-log.state}"
LANE_RE='^[a-z0-9][a-z0-9-]{0,62}$' # lanes.ts BRANCH_RE: the file is <branch>.json
say() { echo "$(date +%FT%T%z) $1" >>"$BOARD_DIR/$W.log" 2>/dev/null; }
command -v jq >/dev/null && command -v flock >/dev/null || { say "jq or flock missing"; exit 0; }
# One pass at a time: a manual --once, or the old sampler's last child during a restart, would read the same state.
exec 9>"$STATE.lock" 2>/dev/null && flock -n 9 || exit 0

# The last pass's view: lane \t phase \t phaseSince
declare -A was_p=() was_s=()
if [ -r "$STATE" ]; then
  while IFS=$'\t' read -r l p s; do
    [[ "$l" =~ $LANE_RE && "$p" =~ ^[a-z]+$ ]] && { was_p[$l]=$p; was_s[$l]=$s; }
  done <"$STATE"
fi

declare -A now_p=() now_s=()
rows=()
bad=
pct=unset
row() { # lane from to ts
  if [ "$pct" = unset ]; then
    local fresh cut
    pct=null
    fresh=$(sb_limit .watchers.usage.freshSec)
    if [[ "$fresh" =~ ^[1-9][0-9]*$ ]]; then
      cut=$(date -d "@$(( $(date +%s) - fresh ))" +%Y-%m-%dT%H:%M:%S)
      pct=$(wl_meter_rows 400 | jq --arg cut "$cut" \
        '[.[] | select((.ts | strings)[0:19] >= $cut) | .rl?.seven_day?.used_percentage? | numbers] | max // null' 2>/dev/null)
      [[ "$pct" =~ ^[0-9]+(\.[0-9]+)?$ ]] || pct=null
    else
      say "limits.json .watchers.usage.freshSec missing or bad: pct null"
    fi
  fi
  local r
  # a refused fork (the pids ceiling) gives an empty row: mark the pass bad, so the state stays and the next pass retries
  [ -n "$4" ] && r=$(jq -nc --arg lane "$1" --arg from "$2" --arg to "$3" --arg ts "$4" --argjson pct "$pct" \
    '{v:1, lane:$lane, from:($from | select(. != "") // null), to:($to | select(. != "") // null), ts:$ts, pct:$pct}') &&
    [ -n "$r" ] || { bad=1; return; }
  rows+=("$r")
}

for f in "$BOARD_DIR"/lanes/*.json; do
  [ -e "$f" ] || continue
  l=${f##*/}; l=${l%.json}
  [[ "$l" =~ $LANE_RE ]] || continue
  p= s=
  IFS=$'\t' read -r p s < <(jq -r 'select(.phase | strings) | [.phase, (.phaseSince | strings // "")] | @tsv' "$f" 2>/dev/null)
  if ! [[ "${p:-}" =~ ^[a-z]+$ ]]; then # a write caught mid-way, or not a lane file: judge it next pass
    if [ -n "${was_p[$l]+x}" ]; then now_p[$l]=${was_p[$l]}; now_s[$l]=${was_s[$l]}; fi
    continue
  fi
  now_p[$l]=$p; now_s[$l]=$s
  if [ "${was_p[$l]-}" != "$p" ] || [ "${was_s[$l]-}" != "$s" ]; then
    row "$l" "${was_p[$l]-}" "$p" "${s:-$(sb_now)}"
  fi
done
# gone = not seen by the loop above (a torn file is carried in now_p), never a second look at the disk
for l in "${!was_p[@]}"; do
  [ -n "${now_p[$l]+x}" ] || row "$l" "${was_p[$l]}" "" "$(sb_now)"
done
[ -z "$bad" ] || { say "a row failed to build; state kept, retried next pass"; exit 0; }

if [ "${#rows[@]}" -gt 0 ]; then
  mkdir -p "$(dirname "$LOG")" 2>/dev/null
  # a torn last line (a write cut short) would swallow this pass's first row
  nl=; [ -s "$LOG" ] && [ -n "$(tail -c1 "$LOG" 2>/dev/null)" ] && nl=$'\n'
  printf '%s' "$nl" >>"$LOG" 2>/dev/null && printf '%s\n' "${rows[@]}" >>"$LOG" 2>/dev/null ||
    { say "cannot append to $LOG; state kept, retried next pass"; exit 0; }
fi
tmp="$STATE.tmp.$$"
{ for l in "${!now_p[@]}"; do printf '%s\t%s\t%s\n' "$l" "${now_p[$l]}" "${now_s[$l]}"; done; } >"$tmp" 2>/dev/null &&
  mv -f "$tmp" "$STATE" 2>/dev/null || { rm -f "$tmp" 2>/dev/null; say "cannot write $STATE: the next pass repeats these rows"; }
exit 0
