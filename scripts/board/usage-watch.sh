#!/bin/bash
# The hub's usage stop watcher (the maintainer, 2026-11-17: soft stop everything at 58 %, hard stop at 60). Reads the
# usage meter every intervalSec and exits ONLY on a line, so the hub wakes just then:
#   7 = soft stop (>= softPct)   8 = hard stop (>= hardPct, checked first)   78 = a limits.json key is missing or bad
#   2 = a bad argument or override
# Thresholds: limits.json → watchers.usage; APERTURE_USAGE_SOFT / _HARD in the env override them. After a soft stop the
# hub restarts it with --hard-only, which watches the hard line alone. Writes usage-now.json each reading; logs
# usage-watch.log. No fresh row at all (no session active, overnight) is quiet: usage-now.json's `at` shows its age.
# The account % = the max weekly used_percentage among meter rows from the last freshSec: a stale session reports an
# old value, a fresh row the account's live one, so the max over fresh rows is never below the truth.
# Run: timeout 65m scripts/board/usage-watch.sh [--hard-only]   (124 = an hour, nothing happened: restart it)
set -u
source "$(dirname "${BASH_SOURCE[0]}")/watch-lib.sh"
W=usage-watch
HARD_ONLY=0
case "${1:-}" in
  --hard-only) HARD_ONLY=1 ;;
  '') ;;
  *) echo "usage: usage-watch.sh [--hard-only]" >&2; exit 2 ;;
esac
SOFT=${APERTURE_USAGE_SOFT:-$(wl_need $W .watchers.usage.softPct)} || exit 78
HARD=${APERTURE_USAGE_HARD:-$(wl_need $W .watchers.usage.hardPct)} || exit 78
EVERY=$(wl_int $W .watchers.usage.intervalSec) || exit 78
FRESH=$(wl_int $W .watchers.usage.freshSec) || exit 78
for v in "$SOFT" "$HARD"; do [[ "$v" =~ ^[0-9]+(\.[0-9]+)?$ ]] || { echo "$W: APERTURE_USAGE_SOFT/_HARD must be numbers" >&2; exit 2; }; done
sb_init_dirs

while :; do
  now=$(date +%s)
  cut=$(date -d "@$((now - FRESH))" +%Y-%m-%dT%H:%M:%S)
  pct=$(wl_meter_rows 400 | jq --arg cut "$cut" \
    '[.[] | select((.ts | strings)[0:19] >= $cut) | .rl?.seven_day?.used_percentage? | numbers] | max // empty' 2>/dev/null)
  if [ -n "$pct" ]; then
    jq -n --argjson p "$pct" --argjson at "$now" --argjson s "$SOFT" --argjson h "$HARD" \
      '{pct:$p, at:$at, soft:$s, hard:$h}' | sb_write "$BOARD_DIR/usage-now.json"
    if awk -v p="$pct" -v h="$HARD" 'BEGIN{exit !(p+0 >= h+0)}'; then wl_say $W "$(wl_at +%H:%M) HARD $pct"; exit 8; fi
    if [ "$HARD_ONLY" = 0 ] && awk -v p="$pct" -v s="$SOFT" 'BEGIN{exit !(p+0 >= s+0)}'; then
      wl_say $W "$(wl_at +%H:%M) SOFT $pct"; exit 7
    fi
  fi
  sleep "$EVERY"
done
