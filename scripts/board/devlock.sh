#!/usr/bin/env bash
# The real dev lock (refs/locks/dev) for the board, read-only — no bot key, no token mint, no node
# (docs/ops/SESSION-BOARD.md → Dev lock line).
#   devlock.sh refresh [--max-age SEC] [--timeout SEC]   peek at GitHub and cache board/devlock.json (skipped while
#                                                        the cache is younger than max-age, 60 s by default)
#   devlock.sh line                                      one line from the cache: free · held · EXPIRED · stale · unknown
# The bot writes the same cache on every lock read or change (scripts/src/bot/lock-cache.ts). A failed peek keeps the
# old cache and marks it failedAt; nothing here ever fails its caller. Test seam: APERTURE_DEVLOCK_SOURCE=file:<path>
# stands in for GitHub — the tag message (holder JSON), an empty file for "no ref", a missing file for a failed fetch.
set -u
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
CACHE="$BOARD_DIR/devlock.json"
STALE_SEC=300

# → the holder JSON (or null: no ref, or an unreadable holder — both mean the next acquire takes it) on stdout;
# non-zero when GitHub couldn't be asked. Each network call is bounded by $1 seconds. The repo is spelled out here
# because this is shell-only (no node): it's config.ts's OWNER/REPO.
_peek() {
  local to="$1" src="${APERTURE_DEVLOCK_SOURCE:-}" ref msg
  if [ "${src#file:}" != "$src" ]; then
    [ -f "${src#file:}" ] || return 1
    msg=$(cat "${src#file:}")
  else
    ref=$(timeout "$to" git -C "$SB_REPO" ls-remote origin refs/locks/dev 2>/dev/null) || return 1
    msg=
    [ -z "$ref" ] || msg=$(timeout "$to" gh api "repos/radatta/aperture/git/tags/${ref%%[[:space:]]*}" --jq .message 2>/dev/null) || return 1
  fi
  [ -n "$msg" ] || { echo null; return 0; }
  jq -c 'if (.branch | type) == "string" and (.sha | type) == "string" and (.expiresAt | type) == "string"
    then {branch, sha, expiresAt} else null end' <<<"$msg" 2>/dev/null || echo null
}

cmd_refresh() {
  local max=60 to=4 t h before
  while [ $# -gt 0 ]; do
    case "$1" in
      --max-age) max="$2"; shift 2 ;;
      --timeout) to="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  [ -d "$BOARD_DIR" ] || return 0
  before=$(jq -r '.t // empty' "$CACHE" 2>/dev/null)
  t=$(jq -r '.t | sub("\\.[0-9]+"; "") | fromdate' "$CACHE" 2>/dev/null)
  [ -n "$t" ] && [ $(( $(sb_epoch) - t )) -lt "$max" ] && return 0
  if h=$(_peek "$to"); then
    # The bot wrote while we were asking GitHub: its write is newer than our answer, so keep it.
    [ "$(jq -r '.t // empty' "$CACHE" 2>/dev/null)" = "$before" ] || return 0
    jq -nc --argjson h "$h" --arg t "$(sb_now)" '{v: 1, t: $t, source: "peek", holder: $h}' | sb_write "$CACHE"
  elif [ -f "$CACHE" ]; then
    jq -c --arg f "$(sb_now)" '.failedAt = $f' "$CACHE" 2>/dev/null | sb_write "$CACHE"
  fi
  return 0
}

# Expiry is judged here, at read time — the cache never stores a verdict. The holder's session comes from the board.
cmd_line() {
  [ -f "$CACHE" ] || { echo "dev lock: unknown (offline, no cache)"; return 0; }
  jq -r --argjson now "$(sb_epoch)" --argjson stale "$STALE_SEC" \
    --slurpfile reg <(cat "$BOARD_DIR"/sessions/*.json 2>/dev/null) '
    def ep: sub("\\.[0-9]+"; "") | fromdate;
    def hm: ep | strflocaltime("%H:%M");
    (if ($now - (.t | ep)) > $stale then " (as of \(.t | hm)\(if .failedAt then ", refresh failed" else "" end))" else "" end) as $old |
    if .holder == null then "dev lock: free\($old)"
    else .holder as $h |
      ([$reg[] | select(.branch == $h.branch and .state != "gone") | .name] | first) as $s |
      if ($h.expiresAt | ep) <= $now then "dev lock: \($h.branch) — EXPIRED \($h.expiresAt | hm), the next acquire takes it over\($old)"
      else "dev lock: \($h.branch)\(if $s then " (\($s))" else "" end) until \($h.expiresAt | hm)\($old)" end
    end' "$CACHE" 2>/dev/null || echo "dev lock: unknown (unreadable cache)"
}

case "${1:-line}" in
  refresh) shift; cmd_refresh "$@" ;;
  line) cmd_line ;;
  *) sed -n '4,6p' "${BASH_SOURCE[0]}"; exit 2 ;;
esac
