#!/bin/bash
# The hub's context watcher (the maintainer's lines, 2026-11-17: a session over 40 % context is flagged, 50 is urgent).
# Every intervalSec: each session's latest meter row from the last freshSec (the status-line logger writes
# ctx = current_usage), tokens = input + cache_creation + cache_read, pct = tokens / windowTokens. Writes ctx.json
# (every session, sorted by pct: the hub and the web tower read it) and a history line. Exits:
#   9 = a session reached urgentPct and wasn't alerted in the last realertSec (ctx-alerted.json keeps when each was)
#   78 = a limits.json key is missing or bad   2 = an argument (it takes none) or a bad override
# Thresholds: limits.json → watchers.context (flagPct is the tower's warn line; this script only checks it sits below
# urgent); APERTURE_CTX_WINDOW / _URGENT in the env override. windowTokens is the lanes' model's window (1M).
# Run: timeout 65m scripts/board/context-watch.sh   (124 = an hour, nothing happened: restart it)
set -u
[ $# -eq 0 ] || { echo "usage: context-watch.sh (no arguments; docs/ops/HUB.md → Watchers)" >&2; exit 2; }
source "$(dirname "${BASH_SOURCE[0]}")/watch-lib.sh"
W=context-watch
WINDOW=${APERTURE_CTX_WINDOW:-$(wl_int $W .watchers.context.windowTokens)} || exit 78
LIM_URGENT=$(wl_need $W .watchers.context.urgentPct) || exit 78
URGENT=${APERTURE_CTX_URGENT:-$LIM_URGENT}
FLAG=$(wl_need $W .watchers.context.flagPct) || exit 78
EVERY=$(wl_int $W .watchers.context.intervalSec) || exit 78
REALERT=$(wl_int $W .watchers.context.realertSec) || exit 78
FRESH=$(wl_int $W .watchers.context.freshSec) || exit 78
[[ "$WINDOW" =~ ^[1-9][0-9]*$ ]] || { echo "$W: APERTURE_CTX_WINDOW must be a whole number >= 1" >&2; exit 2; }
wl_num "$URGENT" || { echo "$W: APERTURE_CTX_URGENT must be a number" >&2; exit 2; }
awk -v f="$FLAG" -v u="$LIM_URGENT" 'BEGIN{exit !(f+0 <= u+0)}' || { echo "$W: limits.json flagPct $FLAG is above urgentPct $LIM_URGENT" | tee -a "$BOARD_DIR/$W.log" >&2; exit 78; }
sb_init_dirs
A=$BOARD_DIR/ctx-alerted.json
[ -f "$A" ] || echo '{}' >"$A"

while :; do
  now=$(date +%s)
  cut=$(date -d "@$((now - FRESH))" +%Y-%m-%dT%H:%M:%S)
  wl_meter_rows 1500 | jq --arg cut "$cut" --argjson w "$WINDOW" '
    [.[] | select((.ts | strings)[0:19] >= $cut and (.ctx | type) == "object" and (.name | type) == "string")]
    | group_by(.name) | map(max_by(.ts)) | map({name, ts:.ts[11:16],
        tokens:(((.ctx.input_tokens | numbers) // 0) + ((.ctx.cache_creation_input_tokens | numbers) // 0)
          + ((.ctx.cache_read_input_tokens | numbers) // 0))})
    | map(. + {pct: ((.tokens * 1000 / $w | floor) / 10)}) | sort_by(-.pct)' 2>/dev/null | sb_write "$BOARD_DIR/ctx.json"
  l=$(jq -c --arg t "$(wl_at -Iseconds)" '{t:$t, sessions:.}' "$BOARD_DIR/ctx.json" 2>/dev/null) && wl_hist ctx "$l"
  # An unreadable alerted file counts as none alerted: a corrupt file must not silence every alert.
  al=$(jq -c 'if type == "object" then . else {} end' "$A" 2>/dev/null) || al='{}'
  [ -n "$al" ] || al='{}'
  hit=$(jq -c --argjson al "$al" --argjson u "$URGENT" --argjson now "$now" --argjson re "$REALERT" '
    [.[] | select(.pct >= $u) | select((($al[.name] // 0) + $re) < $now) | {name, pct}]' "$BOARD_DIR/ctx.json" 2>/dev/null)
  if [ -n "$hit" ] && [ "$hit" != '[]' ]; then
    # Stamp only the sessions alerted now: another session's 6 h timer must not move.
    jq -n --argjson al "$al" --argjson hit "$hit" --argjson now "$now" '$al + ([$hit[] | {(.name): $now}] | add)' |
      sb_write "$A"
    wl_say $W "$(wl_at +%H:%M) URGENT $(jq -r 'map("\(.name) \(.pct)%") | join(", ")' <<<"$hit")"
    exit 9
  fi
  sleep "$EVERY"
done
