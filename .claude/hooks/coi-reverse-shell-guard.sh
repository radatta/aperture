#!/bin/bash
# PreToolUse hook on Bash — DENIES command shapes that COI's security monitor
# classifies as a CRITICAL "reverse shell", which KILLS THE WHOLE CONTAINER; the
# right move is to stop emitting the shape, not to disarm the detector.
#
# Mechanism, observed kills and why the fix is not `auto_kill_on_critical = false`:
# docs/ops/COI-INCIDENTS.md → Incident F.
#
# ---------------------------------------------------------------------------
# IMPLEMENTATION CONSTRAINT — READ BEFORE EDITING
#
# This script must never place a flagged pattern into a process's argv. An
# earlier version used `echo "$COMMAND" | grep -qE '...socat...tcp...'` and
# `jq -n --arg reason "<text mentioning python -c>"`. Both put the literals on a
# command line, so the guard itself could trip the detector it exists to avoid.
#
# Therefore: match with `case` (a shell builtin, no process), and pass the deny
# message to jq over STDIN via printf (also a builtin) rather than as --arg.
# jq's own argv holds only the filter, which contains no flagged substring.
# Do not reintroduce grep/sed/awk here.
# ---------------------------------------------------------------------------
#
# KNOWN FALSE POSITIVE: matching is substring-based, so writing a file whose
# *contents* mention these strings is blocked too, even though no such process
# would spawn. Use the Write/Edit tools for that — they don't go through Bash.
# Over-blocking is the correct bias; the failure mode this prevents is the
# container dying.
#
# See docs/ops/COI-SANDBOX.md → "Container killed — the CRITICAL path is a different
# animal", and docs/ops/COI-INCIDENTS.md → Incident F.

set -euo pipefail

# Only meaningful inside a COI container. No-op on the Mac or in the Lima VM.
case "$(hostname)" in
  coi-*) ;;
  *) exit 0 ;;
esac

INPUT=$(cat)
# jq's argv here is only the filter — no flagged substrings.
COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""')

# Lowercase, mirroring COI's own strings.ToLower before matching.
LC=${COMMAND,,}

deny() {
  # Message travels over stdin, never argv. printf is a builtin.
  printf '%s' "$1" | jq -Rs '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:.}}'
  exit 0
}

HEREDOC_HINT='Use a heredoc instead — it runs as "python3 -", which is not on the list:

  python3 - <<'"'"'PY'"'"'
  import json, sys
  ...
  PY

For JSON, jq is installed and matches nothing. If you are writing file CONTENT that
merely mentions these strings, use the Write/Edit tools rather than Bash.'

# Interpreter one-liners. COI gates these on any ":" in the command, which nearly
# every real invocation satisfies — so deny unconditionally rather than trying to
# predict the gate.
case "$LC" in
  *"python -c"*|*"python3 -c"*)
    deny "Blocked: \`python -c\` is on COI's hardcoded reverse-shell pattern list, and a match is CRITICAL — it KILLS the container, with no repeat latch. Any \`:\` in the command satisfies its network heuristic (a dict, a slice like \`v[-5:]\`, a URL, a timestamp).

$HEREDOC_HINT" ;;
  *"perl -e"*|*"perl -mio"*|*"php -r"*|*"ruby -e"*|*"ruby -rsocket"*)
    deny "Blocked: that interpreter one-liner is on COI's reverse-shell pattern list (process.go:249-290) and will KILL the container. Pipe a quoted heredoc into the interpreter's stdin instead, or use jq for JSON." ;;
esac

# These bypass COI's network gate and fire unconditionally.
case "$LC" in
  *"bash -i"*|*"sh -i"*)
    deny "Blocked: \`bash -i\` / \`sh -i\` match COI's reverse-shell list unconditionally — no colon needed — and KILL the container. Run the command directly instead of through an interactive shell." ;;
esac

# Explicit network-shell shapes. Claude should never emit these; worth stopping on
# regardless of what COI would do.
case "$LC" in
  *"nc -e"*|*"nc.traditional -e"*|*"nc.openbsd -e"*|*"ncat -e"*|*"socat"*|*"/dev/tcp/"*|*"/dev/udp/"*|*"socket.socket"*|*"fsockopen"*|*"powershell"*|*"system.net.sockets"*)
    deny "Blocked: that is a reverse-shell shape (netcat / socat / shell network redirect). COI treats it as CRITICAL and kills the container, and it should not be needed for development work." ;;
esac

# Everything else passes through silently.
exit 0
