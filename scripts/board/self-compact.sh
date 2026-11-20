#!/bin/bash
# A lane compacts itself at a boundary where it waits anyway (docs/ops/COMPACTION-HANDOFF.md → Self-compact).
#   request       the lane's last tool call: checks it may, then leaves a flag for this session's Stop
#   stop <pid>    the Stop heartbeat runs MAIN's committed copy, detached: claims the flag, re-checks, spawns send
#   send <pid> <tick> <prompt-at>   (detached) types `/compact` into the session's own empty box, then Enter
# Off unless main's committed limits.json says `lanes.selfCompact: true` and $BOARD_DIR/self-compact/off is absent.
# `stop` and `send` print nothing and always exit 0; every step logs one line to $BOARD_DIR/self-compact.log.
# The only tmux target is this session's own pane ($TMUX_PANE, checked against the claude pid) and the only text
# typed is the literal `/compact`. Nothing read from a file reaches an argv but validated numbers.
set -u
export LC_ALL=C GIT_OPTIONAL_LOCKS=0
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

SC="$BOARD_DIR/self-compact"
LOG="$BOARD_DIR/self-compact.log"
BRANCH_RE='^[a-z0-9][a-z0-9-]{0,62}$'
STAMP_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
RULE=$'\xe2\x94\x80'   # ─
PROMPT=$'\xe2\x9d\xaf' # ❯
NBSP=$'\xc2\xa0'
LOG_BRANCH=-
WHY=

usage() { echo "usage: self-compact.sh request | stop <pid> | send <pid> <tick> <prompt-at>" >&2; exit 2; }
log() { [ -d "$BOARD_DIR" ] && printf '%s %s pid=%s branch=%s reason=%s\n' "$(sb_now)" "$1" "${2:--}" "$LOG_BRANCH" "${3:--}" >>"$LOG"; return 0; }

# The main checkout: the common git dir minus `/.git`.
main_root() {
  local gc
  gc=$(git -C "$SB_SCRIPTS" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
  case "$gc" in */.git) printf '%s' "${gc%/.git}" ;; *) return 1 ;; esac
}
# Main's committed switch — never the working copy, the env or a branch's limits.json.
switch_on() {
  [ ! -e "$SC/off" ] || return 1
  [ "$(git -C "$MAIN" show HEAD:scripts/board/limits.json 2>/dev/null | jq -r '.lanes.selfCompact == true' 2>/dev/null)" = true ]
}
hub_name() { git -C "$MAIN" show HEAD:scripts/board/hub.json 2>/dev/null | jq -r '.name // empty' 2>/dev/null; }
# The record field $2 of session $1.
rec() { jq -r --arg k "$2" '.[$k] // empty | tostring' "$BOARD_DIR/sessions/$1.json" 2>/dev/null; }
# $TMUX_PANE is this session's own pane: its pane process is the claude pid or claude's parent (board.sh me_ident's rule).
own_pane() {
  local pp ps
  [[ "${TMUX_PANE:-}" =~ ^%[0-9]+$ ]] || return 1
  pp=$(timeout 2 tmux display-message -p -t "$TMUX_PANE" '#{pane_pid}' 2>/dev/null) || return 1
  read -r ps _ < <(sb_stat "$1") || return 1
  [ -n "$pp" ] && { [ "$pp" = "$1" ] || [ "$pp" = "$ps" ]; }
}
# A lane at a boundary, from directory $1: its own worktree under main's .claude/worktrees/, a lane-shaped branch with
# a lane file written in the last 10 min, a clean tree, and not the hub (branch, worktree and the record's name).
# Sets LOG_BRANCH; on failure sets WHY to the reason (no subshell, so LOG_BRANCH reaches the log).
lane_ok() {
  local top branch hub st
  top=$(git -C "$1" rev-parse --show-toplevel 2>/dev/null) || { WHY=not-lane; return 1; }
  [ "$top" = "$MAIN/.claude/worktrees/${top##*/}" ] || { WHY=not-lane; return 1; }
  branch=$(git -C "$top" branch --show-current 2>/dev/null)
  [[ "$branch" =~ $BRANCH_RE ]] || { WHY=not-lane; return 1; }
  LOG_BRANCH=$branch
  hub=$(hub_name)
  [ -n "$hub" ] && [ "$branch" != "$hub" ] && [ "${top##*/}" != "$hub" ] && [ "$(rec "$2" name)" != "$hub" ] || { WHY=hub; return 1; }
  [ -n "$(find "$BOARD_DIR/lanes/$branch.json" -mmin -10 2>/dev/null)" ] || { WHY=lane-file-stale; return 1; }
  st=$(git -C "$top" status --porcelain 2>/dev/null) || { WHY=dirty; return 1; }
  [ -z "$st" ] || { WHY=dirty; return 1; }
}
# The input box, from a capture of the pane: busy | none | empty | compact | other. The box is the last `❯` line with
# a `─` rule directly above and below it (measured on 2.1.329). Busy markers are read only in the footer below the
# box and the few lines above it, so a conversation that quotes them doesn't read as busy.
box_state() {
  local -a L
  local i n b=-1 s
  mapfile -t L < <(timeout 2 tmux capture-pane -p -t "$TMUX_PANE" 2>/dev/null) || { echo none; return; }
  n=${#L[@]}
  for ((i = n - 2; i >= 1; i--)); do
    [[ "${L[i]}" == "$PROMPT"* && "${L[i+1]}" == "$RULE"* && "${L[i-1]}" == "$RULE"* ]] && { b=$i; break; }
  done
  [ "$b" -ge 0 ] || { echo none; return; }
  for ((i = (b > 5 ? b - 5 : 0); i < n; i++)); do
    [ "$i" -ge $((b - 1)) ] && [ "$i" -le $((b + 1)) ] && continue
    case "${L[i]}" in *"esc to interrupt"* | *"background agent"* | *"to manage"*) echo busy; return ;; esac
  done
  s=${L[b]#"$PROMPT"}; s=${s//"$NBSP"/}; s=${s//[[:space:]]/}
  case "$s" in "") echo empty ;; /compact) echo compact ;; *) echo other ;; esac
}
# send's guard, before each key: the switch, the same process, its own pane, idle on the board, no prompt since.
send_guard() {
  switch_on && sb_alive "$1" "$2" && own_pane "$1" && [ "$(rec "$1" state)" = idle ] && [ "$(rec "$1" lastPromptAt)" = "$3" ]
}

cmd_request() {
  local pid ps tick at box
  refuse() { log refuse "${pid:-}" "$1"; echo "self-compact: refused ($1)"; exit 1; }
  [ -z "${APERTURE_HANDOFF_FORK:-}" ] || refuse fork
  MAIN=$(main_root) || refuse not-lane
  switch_on || refuse off
  pid=$(sb_claude_pid "$PPID") || refuse no-claude
  read -r ps tick < <(sb_stat "$pid") || refuse no-claude
  [ "$(rec "$pid" pidStart)" = "$tick" ] || refuse no-record
  at=$(rec "$pid" lastPromptAt)
  [[ "$at" =~ $STAMP_RE ]] || refuse no-record
  own_pane "$pid" || refuse pane
  lane_ok "$(pwd)" "$pid" || refuse "$WHY"
  box=$(box_state)
  [ "$box" = empty ] || refuse "box-$box"
  mkdir -p "$SC" || refuse io
  find "$SC" -maxdepth 1 \( -name '*.req' -o -name '*.claim.*' \) -mmin +15 -delete 2>/dev/null
  printf '1 %s %s %s\n' "$tick" "$(sb_epoch)" "$at" | sb_write "$SC/$pid.req" || refuse io
  log request "$pid"
  echo "self-compact: requested; end the turn now"
}

cmd_stop() {
  local pid="${1:-}" input flag claim v tick epoch at age
  input=$(cat)
  [[ "$pid" =~ ^[0-9]+$ ]] && [ "$(sb_comm "$pid")" = claude ] || exit 0
  [ -z "${APERTURE_HANDOFF_FORK:-}" ] || exit 0
  MAIN=$(main_root) || exit 0
  switch_on || exit 0
  find "$SC" -maxdepth 1 \( -name '*.req' -o -name '*.claim.*' \) -mmin +15 -delete 2>/dev/null
  flag="$SC/$pid.req"
  [ -e "$flag" ] || exit 0
  [ "$(jq -r '.stop_hook_active // false' <<<"$input" 2>/dev/null)" = true ] && { log skip "$pid" stop-hook-active; exit 0; }
  claim="$SC/$pid.claim.$$"
  mv "$flag" "$claim" 2>/dev/null || exit 0  # the rename is atomic: a second Stop finds nothing to claim
  read -r v tick epoch at <"$claim" 2>/dev/null
  rm -f "$claim"
  log claim "$pid"
  [ "${v:-}" = 1 ] && [[ "${tick:-}" =~ ^[0-9]+$ && "${epoch:-}" =~ ^[0-9]+$ && "${at:-}" =~ $STAMP_RE ]] || { log skip "$pid" bad-flag; exit 0; }
  age=$(($(sb_epoch) - epoch))
  [ "$age" -ge 0 ] && [ "$age" -le 600 ] || { log skip "$pid" stale-flag; exit 0; }
  sb_alive "$pid" "$tick" && [ "$(rec "$pid" pidStart)" = "$tick" ] || { log skip "$pid" pid-changed; exit 0; }
  [ "$(rec "$pid" lastPromptAt)" = "$at" ] || { log skip "$pid" prompted; exit 0; }
  lane_ok "$(rec "$pid" cwd)" "$pid" || { log skip "$pid" "$WHY"; exit 0; }
  own_pane "$pid" || { log skip "$pid" pane; exit 0; }
  # A second detach: send must outlive this run's own timeout.
  setsid -f timeout -k 1 20 bash "$SB_SCRIPTS/self-compact.sh" send "$pid" "$tick" "$at" </dev/null >/dev/null 2>&1
  log spawn "$pid"
}

cmd_send() {
  local pid="${1:-}" tick="${2:-}" at="${3:-}" box
  [[ "$pid" =~ ^[0-9]+$ && "$tick" =~ ^[0-9]+$ && "$at" =~ $STAMP_RE ]] || exit 0
  [ "$(sb_comm "$pid")" = claude ] || exit 0
  MAIN=$(main_root) || exit 0
  sleep 2
  send_guard "$pid" "$tick" "$at" || { log skip "$pid" guard; exit 0; }
  box=$(box_state)
  [ "$box" = empty ] || { log skip "$pid" "box-$box"; exit 0; }
  timeout 2 tmux send-keys -t "$TMUX_PANE" -l /compact || { log skip "$pid" tmux; exit 0; }
  sleep 0.5
  send_guard "$pid" "$tick" "$at" || { log skip "$pid" guard; exit 0; }
  # Anything but exactly `/compact` in the box now: send no further key, not even a clear.
  [ "$(box_state)" = compact ] || { log skip "$pid" box-changed; exit 0; }
  timeout 2 tmux send-keys -t "$TMUX_PANE" Enter || { log skip "$pid" tmux; exit 0; }
  log sent "$pid"
}

case "${1:-}" in
  request) [ $# -eq 1 ] || usage; cmd_request ;;
  stop) [ $# -eq 2 ] || usage; cmd_stop "$2" ;;
  send) [ $# -eq 4 ] || usage; cmd_send "$2" "$3" "$4" ;;
  *) usage ;;
esac
exit 0
