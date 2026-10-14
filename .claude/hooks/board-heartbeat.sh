#!/bin/bash
# UserPromptSubmit (`board-heartbeat.sh working`) and Stop (`board-heartbeat.sh idle`) — keeps this
# session's state on the shared-container board current and renews a dev lease it holds.
# docs/ops/SESSION-BOARD.md. Hot path: one jq write, no node, no git. Fail-open, silent.
INPUT=$(cat)
B="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts/board" 2>/dev/null && pwd)" || exit 0
[ -f "$B/lib.sh" ] || exit 0
. "$B/lib.sh"
[ -d "${BOARD_DIR%/*}" ] && [ -r "$CG/memory.stat" ] || exit 0  # container-only: no cgroup (Mac, CI) → nothing to do

STATE="${1:-working}"
# \x1f, not a tab: whitespace IFS would drop an empty leading field and shift CWD into SID.
IFS=$'\x1f' read -r SID CWD < <(printf '%s' "$INPUT" | jq -r '[.session_id // "", .cwd // ""] | join("\u001f")' 2>/dev/null)
PID=$(sb_claude_pid "$PPID") || exit 0
bash "$B/board.sh" heartbeat "$STATE" --pid "$PID" --sid "$SID" --cwd "${CWD:-$(pwd)}" >/dev/null 2>&1
exit 0
