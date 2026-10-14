#!/bin/bash
# PreToolUse on Bash — the session board's heavy-command guard (docs/ops/SESSION-BOARD.md → Hooks).
#   - touches sessions/<pid>.tool (last-tool heartbeat);
#   - a heavy command not already under heavy.sh → ALLOW with a one-line offer to run it through
#     scripts/board/heavy.sh (once per class per session, or whenever another heavy job is running);
#   - DENY only when limits.json has enforce:true AND the predicted load is past the measured hard line.
# Never a reason to skip tests or the UI pass: below the measured edge this hook only ever offers.
# Matching is `case` on the lowercased command (no grep), like coi-reverse-shell-guard.sh. Fail-open.
INPUT=$(cat)
B="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts/board" 2>/dev/null && pwd)" || exit 0
[ -f "$B/lib.sh" ] || exit 0
. "$B/lib.sh"
[ -d "${BOARD_DIR%/*}" ] && [ -r "$CG/memory.stat" ] || exit 0  # container-only: no cgroup (Mac, CI) → nothing to do

CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)
PID=$(sb_claude_pid "$PPID") && [ -d "$BOARD_DIR/sessions" ] && : >"$BOARD_DIR/sessions/$PID.tool"

LC=${CMD,,}
case "$LC" in
  *heavy.sh*) exit 0 ;;                        # already wrapped
  "git "*|"gh "*|"echo "*|"printf "*) exit 0 ;;  # text that merely mentions a heavy command
esac
CLASS=$(sb_classify "$CMD")
case "$CLASS" in test|typecheck|lint|build|dev|ui) ;; *) exit 0 ;; esac

emit() {  # $1 decision (allow|deny), $2 message — message over stdin, never argv
  if [ "$1" = deny ]; then
    printf '%s' "$2" | jq -Rs '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: .}}'
  else
    printf '%s' "$2" | jq -Rs '{hookSpecificOutput: {hookEventName: "PreToolUse", additionalContext: .}}'
  fi
  exit 0
}

NOW=$(cat "$BOARD_DIR/status.line" 2>/dev/null)
# Running heavy jobs, not counting dev servers — a long-lived one would make every command an offer.
OTHERS=$(grep -L '"class":"dev"' "$BOARD_DIR"/leases/heavy/*.json 2>/dev/null | wc -l)

# The measured edge — only when enforcing, and only worth a node start once live load is past soft.
if [ "$(sb_limit '.enforce')" = true ]; then
  eval "$(sb_thresholds)"
  p=$(cg_pids); a=$(cg_anon)
  if [ "${p:-0}" -gt "$PIDS_SOFT" ] || [ "${a:-0}" -gt "$ANON_SOFT" ]; then
    . "$B/lease.sh"
    dec=$(sb_locked _heavy_try "" 0 "$CLASS" guard 0 0 2>/dev/null)  # "" = decide only, no slot
    if [ "$(jq -r .wait <<<"$dec" 2>/dev/null)" = true ]; then
      emit deny "$(jq -r --arg c "$CLASS" --arg now "$NOW" '"Held at the measured edge: this \($c) job would take the container to \(.predicted.pids) pids / \(.predicted.anonMiB) MiB, past the hard line (\(.thresholds.pidsHard) / \(.thresholds.anonHardMiB)). Board: \($now). Run it as `scripts/board/heavy.sh -- <cmd>` — it waits up to 90 s for room, then runs or says who holds it; `scripts/board/board.sh status` shows who is running what."' <<<"$dec")"
    fi
  fi
fi

# The offer: first heavy command of each class in this session, or any time someone else is running one.
mark="$BOARD_DIR/sessions/${PID:-none}.nudged"
if [ "$OTHERS" -gt 0 ] || ! grep -qx "$CLASS" "$mark" 2>/dev/null; then
  [ -n "${PID:-}" ] && echo "$CLASS" >>"$mark"
  running=; [ "$OTHERS" -gt 0 ] && running=" · $OTHERS heavy job(s) running now"
  short=${CMD:0:120}; [ "${#CMD}" -gt 120 ] && short="$short…"
  emit allow "Heavy command ($CLASS): consider \`scripts/board/heavy.sh -- $short\` — same output and exit code, plus its peak memory/threads in the board history and a budget slot other sessions can see. Board now: ${NOW:-sampler not running}$running."
fi
exit 0
