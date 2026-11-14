#!/usr/bin/env bash
# The real dev locks for the board, read-only — no bot key, no token mint, no node (docs/ops/SESSION-BOARD.md → Dev
# lock line). Two slots (INFRA §2): refs/locks/dev (slot A) → board/devlock.json, refs/locks/devb (slot B) →
# board/devlock.devb.json, the same shape.
#   devlock.sh refresh [--max-age SEC] [--timeout SEC]   peek at GitHub and cache both (each skipped while its cache is
#                                                        younger than max-age, 60 s by default)
#   devlock.sh line                                      one line from the caches, slot A first: free · held · EXPIRED ·
#                                                        stale · unknown, then ` · devb: …` once devb has a cache
# The bot writes the same caches on every lock read or change (scripts/src/bot/lock-cache.ts). A failed peek keeps the
# old cache and marks it failedAt, failedWhy (git's or the tag read's last error line) and failedBy (the caller);
# a good read writes the cache afresh, without them. Nothing here ever fails its caller. Test seam: APERTURE_DEVLOCK_SOURCE=file:<path>
# stands in for GitHub — slot A's tag message at <path>, devb's at <path>.devb (holder JSON), an empty file for
# "no ref", a missing file for a failed fetch.
set -u
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
STALE_SEC=300
_cache() { if [ "$1" = dev ]; then echo "$BOARD_DIR/devlock.json"; else echo "$BOARD_DIR/devlock.$1.json"; fi; }

# Both refs in one `ls-remote`, made at most once per refresh and only when a cache is due: REFS holds its output,
# REFS_RC its status (unset until asked), REFS_ERR why it failed (git's last stderr line, or the timeout).
REFS='' REFS_RC='' REFS_ERR=''
_refs() {
  [ -n "$REFS_RC" ] && return "$REFS_RC"
  local err; err=$(mktemp 2>/dev/null) || err=/dev/null
  REFS=$(timeout "$1" git -C "$SB_REPO" ls-remote origin refs/locks/dev refs/locks/devb 2>"$err"); REFS_RC=$?
  if [ "$REFS_RC" = 124 ]; then REFS_ERR="timed out after $1 s"
  elif [ "$REFS_RC" != 0 ]; then REFS_ERR=$(tail -n 1 "$err" 2>/dev/null | cut -c1-160); REFS_ERR=${REFS_ERR:-exit $REFS_RC}; fi
  [ "$err" = /dev/null ] || rm -f "$err"
  return "$REFS_RC"
}

# → the holder JSON (or null: no ref, or an unreadable holder — both mean the next acquire takes it) on stdout;
# 1 when GitHub couldn't be asked, 2 when this machine can't ask (no `timeout`: the Mac). Each network call is bounded
# by $1 seconds: one ls-remote for both slots, then a tag read per held slot. The repo comes from identifiers.json
# (jq, no node), as bot/config.ts's REPO_SLUG does.
_peek() {
  local to="$1" slot="$2" src="${APERTURE_DEVLOCK_SOURCE:-}" ref msg f
  if [ "${src#file:}" != "$src" ]; then
    f="${src#file:}"; [ "$slot" = dev ] || f="$f.$slot"
    [ -f "$f" ] || { echo "source file missing" >&2; return 1; }
    msg=$(cat "$f")
  else
    command -v timeout >/dev/null || return 2  # the Mac has none: no peek there, and the container's cache stands
    _refs "$to" || { echo "ls-remote: $REFS_ERR" >&2; return 1; }
    ref=$(awk -v r="refs/locks/$slot" '$2 == r {print $1}' <<<"$REFS")
    msg=
    [ -z "$ref" ] || msg=$(timeout "$to" gh api "repos/$(jq -r .repo "$SB_REPO/identifiers.json")/git/tags/$ref" --jq .message 2>/dev/null) || return 1
  fi
  [ -n "$msg" ] || { echo null; return 0; }
  jq -c 'if (.branch | type) == "string" and (.sha | type) == "string" and (.expiresAt | type) == "string"
    then {branch, sha, expiresAt} else null end' <<<"$msg" 2>/dev/null || echo null
}

cmd_refresh() {
  local max=60 to=4 slot
  while [ $# -gt 0 ]; do
    case "$1" in
      --max-age) max="${2:-$max}"; shift 2 2>/dev/null || shift ;;
      --timeout) to="${2:-$to}"; shift 2 2>/dev/null || shift ;;
      *) shift ;;
    esac
  done
  [ -d "$BOARD_DIR" ] || return 0
  for slot in dev devb; do _refresh_one "$slot" "$max" "$to"; done
  return 0
}

# Who is asking, for the per-caller backoff: board.sh status, the sampler and the web tower say so; any other caller
# is its parent's process name.
CALLER="${APERTURE_DEVLOCK_CALLER:-$(sb_comm "$PPID")}"
CALLER="${CALLER:-unknown}"

_refresh_one() {
  local slot="$1" max="$2" to="$3" CACHE t h before f by rc src why errf
  CACHE=$(_cache "$slot")
  before=$(jq -r '.t // empty' "$CACHE" 2>/dev/null)
  t=$(jq -r '.t | sub("\\.[0-9]+"; "") | fromdate' "$CACHE" 2>/dev/null)
  [ -n "$t" ] && [ $(( $(sb_epoch) - t )) -lt "$max" ] && return 0
  # A peek that failed under a minute ago, for this caller (or an older cache that doesn't say who): don't make it
  # wait on GitHub again. Another caller still asks — one broken caller (the tmux bar with no HOME, 2026-11-14)
  # once kept every other one from ever refreshing.
  f=$(jq -r '.failedAt // empty | fromdate' "$CACHE" 2>/dev/null)
  by=$(jq -r '.failedBy // empty' "$CACHE" 2>/dev/null)
  [ -n "$f" ] && { [ -z "$by" ] || [ "$by" = "$CALLER" ]; } && [ $(( $(sb_epoch) - f )) -lt 60 ] && return 0
  # The shared ls-remote runs here, in this shell: _peek's $( ) subshell couldn't keep its answer for the next slot.
  src="${APERTURE_DEVLOCK_SOURCE:-}"
  if [ "${src#file:}" = "$src" ] && command -v timeout >/dev/null; then _refs "$to"; fi
  errf=$(mktemp 2>/dev/null) || errf=/dev/null
  h=$(_peek "$to" "$slot" 2>"$errf"); rc=$?
  why=$(tail -n 1 "$errf" 2>/dev/null | cut -c1-160); [ "$errf" = /dev/null ] || rm -f "$errf"
  [ "$rc" = 2 ] && return 0
  if [ "$rc" = 0 ]; then
    # The bot wrote while we were asking GitHub: its write is newer than our answer, so keep it.
    [ "$(jq -r '.t // empty' "$CACHE" 2>/dev/null)" = "$before" ] || return 0
    jq -nc --argjson h "$h" --arg t "$(sb_now)" '{v: 1, t: $t, source: "peek", holder: $h}' | sb_write "$CACHE"
  elif [ -f "$CACHE" ] && [ "$(jq -r '.t // empty' "$CACHE" 2>/dev/null)" = "$before" ]; then
    jq -c --arg f "$(sb_now)" --arg why "${why:-tag read failed}" --arg by "$CALLER" \
      '.failedAt = $f | .failedWhy = $why | .failedBy = $by' "$CACHE" 2>/dev/null | sb_write "$CACHE"
  fi
  return 0
}

# Expiry is judged here, at read time — the cache never stores a verdict. The holder's session comes from the board.
# Slot A's text is unchanged (readers grep it); devb's follows as ` · devb: …` once it has a cache.
cmd_line() {
  local a b
  a=$(_line "$(_cache dev)" "dev lock")
  if [ -f "$(_cache devb)" ]; then b=$(_line "$(_cache devb)" "devb"); echo "$a · $b"; else echo "$a"; fi
}

_line() {
  local CACHE="$1" label="$2"
  [ -f "$CACHE" ] || { echo "$label: unknown (offline, no cache)"; return 0; }
  jq -r --arg label "$label" --argjson now "$(sb_epoch)" --argjson stale "$STALE_SEC" \
    --slurpfile reg <(cat "$BOARD_DIR"/sessions/*.json 2>/dev/null) '
    def ep: sub("\\.[0-9]+"; "") | fromdate;
    def hm: ep | strflocaltime("%H:%M");
    (if ($now - (.t | ep)) > $stale then " (as of \(.t | hm)\(if .failedAt then ", refresh failed" else "" end))" else "" end) as $old |
    if .holder == null then "\($label): free\($old)"
    else .holder as $h |
      ([$reg[] | select(.branch == $h.branch and .state != "gone") | .name] | first) as $s |
      if ($h.expiresAt | ep) <= $now then "\($label): \($h.branch) — EXPIRED \($h.expiresAt | hm), the next acquire takes it over\($old)"
      else "\($label): \($h.branch)\(if $s then " (\($s))" else "" end) until \($h.expiresAt | hm)\($old)" end
    end' "$CACHE" 2>/dev/null || echo "$label: unknown (unreadable cache)"
}

case "${1:-line}" in
  refresh) shift; cmd_refresh "$@" ;;
  line) cmd_line ;;
  *) sed -n '5,8p' "${BASH_SOURCE[0]}"; exit 2 ;;
esac
