#!/bin/bash
# PostCompact hook — saves compaction's own summary to localNotes/handoffs/compact-<YYYY-MM-DD-HHMM>-<sid8>.md.
# Free (no model call) and the only record of what compaction actually produced: the summary otherwise
# lives only inside the session, which is how a fabricated instruction in one goes unaudited
# (anthropics/claude-code#46602). Read-only toward the repo; always exits 0, prints nothing.
# Pairs with precompact-handoff.sh; see docs/ops/COMPACTION-HANDOFF.md.

set -uo pipefail

[ -n "${APERTURE_HANDOFF_FORK:-}" ] && exit 0  # a handoff fork's own compaction isn't worth keeping
INPUT=$(cat)
source "${BASH_SOURCE[0]%/*}/_hook-common.sh"; hook_cd "$INPUT" || exit 0
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

SID=$(jq -r '.session_id // empty' <<<"$INPUT" 2>/dev/null)
[[ "$SID" =~ ^[0-9a-f]{8}-[0-9a-f-]{27}$ ]] || exit 0
SUMMARY=$(jq -r '.compact_summary // empty' <<<"$INPUT" 2>/dev/null)
[ -n "$SUMMARY" ] || exit 0

mkdir -p localNotes/handoffs || exit 0
{
  printf '# Compaction summary — %s\n\n' "$(date '+%Y-%m-%d %H:%M %Z')"
  printf 'Session: %s · Trigger: %s\n\n' "$SID" "$(jq -r '.trigger // "unknown"' <<<"$INPUT" 2>/dev/null)"
  printf '%s\n' "$SUMMARY"
} > "localNotes/handoffs/compact-$(date +%Y-%m-%d-%H%M)-${SID:0:8}.md"
exit 0
