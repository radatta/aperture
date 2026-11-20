#!/bin/bash
# UserPromptSubmit (`board-heartbeat.sh working`) and Stop (`board-heartbeat.sh idle`) — keeps this
# session's state, branch and name on the shared-container board current. docs/ops/SESSION-BOARD.md.
# Hot path: git + tmux (~5 ms) and one jq write. Fail-open, silent. On Stop, a lane's self-compact hand-off (below).
INPUT=$(cat)
B="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts/board" 2>/dev/null && pwd)" || exit 0
[ -f "$B/lib.sh" ] || exit 0
. "$B/lib.sh"
[ -d "${BOARD_DIR%/*}" ] && [ -r "$CG/memory.stat" ] || exit 0  # container-only: no cgroup (Mac, CI) → nothing to do

STATE="${1:-working}"
# \x1f, not a tab: whitespace IFS would drop an empty leading field and shift CWD into SID.
IFS=$'\x1f' read -r SID CWD SHA < <(printf '%s' "$INPUT" | jq -r '[.session_id // "", .cwd // "", (.stop_hook_active | if . == false then "false" else "other" end)] | join("\u001f")' 2>/dev/null)
PID=$(sb_claude_pid "$PPID") || exit 0
bash "$B/board.sh" heartbeat "$STATE" --pid "$PID" --sid "$SID" --cwd "${CWD:-$(pwd)}" >/dev/null 2>&1
# Self-compact hand-off (docs/ops/COMPACTION-HANDOFF.md → Self-compact): Stop only, not a Stop a stop hook continued,
# only with this session's request flag, and only MAIN's script, whose two files on disk (it and the lib.sh it
# sources) hash to HEAD's blobs — raw bytes (no filters, no replace refs, no global or system config, for these two
# calls only), not `git diff`: an empty diff
# proves nothing about a missing path, and a skip-worktree or assume-unchanged flag hides an edit from it. Detached,
# stdio on /dev/null, its exit ignored: it can never fail or delay Stop. No flag: one stat.
[ "$STATE" = idle ] && [ "$SHA" = false ] && [ -e "$BOARD_DIR/self-compact/$PID.req" ] || exit 0
export GIT_OPTIONAL_LOCKS=0
unset $(git rev-parse --local-env-vars 2>/dev/null) # GIT_DIR, GIT_COMMON_DIR, …: main comes from this script's path
raw_git() { GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_NO_REPLACE_OBJECTS=1 git -C "$MAIN" "$@" 2>/dev/null; }
GC=$(git -C "$B" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
case "$GC" in */.git) MAIN=${GC%/.git} ;; *) exit 0 ;; esac
for F in self-compact.sh lib.sh; do
  H=$(raw_git rev-parse -q --verify "HEAD:scripts/board/$F") && [ -n "$H" ] || exit 0
  [ "$(raw_git hash-object --no-filters -- "scripts/board/$F")" = "$H" ] || exit 0
done
setsid -f timeout -k 1 10 bash "$MAIN/scripts/board/self-compact.sh" stop "$PID" </dev/null >/dev/null 2>&1
exit 0
