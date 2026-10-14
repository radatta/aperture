#!/bin/bash
# SessionEnd — marks this session gone on the shared-container board, drops its heavy slots, and flags a
# dev lease it holds `holderGone` (the lease itself lives until its TTL). docs/ops/SESSION-BOARD.md.
INPUT=$(cat)
B="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts/board" 2>/dev/null && pwd)" || exit 0
[ -f "$B/lib.sh" ] || exit 0
. "$B/lib.sh"
[ -d "${BOARD_DIR%/*}" ] && [ -r "$CG/memory.stat" ] || exit 0  # container-only: no cgroup (Mac, CI) → nothing to do

SID=$(printf '%s' "$INPUT" | jq -r '.session_id // ""' 2>/dev/null)
PID=$(sb_claude_pid "$PPID") || exit 0
bash "$B/board.sh" end --pid "$PID" --sid "$SID" >/dev/null 2>&1
exit 0
