#!/bin/bash
# SessionEnd — marks this session gone on the shared-container board and drops its heavy slots.
# docs/ops/SESSION-BOARD.md. (A dev lock it holds lives on GitHub until its TTL.)
INPUT=$(cat)
B="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts/board" 2>/dev/null && pwd)" || exit 0
[ -f "$B/lib.sh" ] || exit 0
. "$B/lib.sh"
[ -d "${BOARD_DIR%/*}" ] && [ -r "$CG/memory.stat" ] || exit 0  # container-only: no cgroup (Mac, CI) → nothing to do

SID=$(printf '%s' "$INPUT" | jq -r '.session_id // ""' 2>/dev/null)
PID=$(sb_claude_pid "$PPID") || exit 0
bash "$B/board.sh" end --pid "$PID" --sid "$SID" >/dev/null 2>&1
exit 0
