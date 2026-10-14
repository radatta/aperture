#!/bin/bash
# Pre/PostToolUse hook on the aperture-dev MCP task tools — the id ledger that makes "delete what this session
# created" safe without asking each time (CLAUDE.md → Aperture MCP connector, standing approval 2).
#   PostToolUse create_task | create_tasks | split_task → append every new task id from the server's response
#   PreToolUse  delete_task → DENY unless the id has a `created` line in the ledger (fail closed)
#   PostToolUse delete_task → append `deleted` for the id and the parts the server deleted with it
# Ids only — never a title or a marker word (an AI rewrites titles). Prod (`aperture`) is never matched.
# Ledger: <main checkout>/localNotes/devcheck/mcp-ledger.dev.jsonl, shared by every worktree and session.
# The dev check's own ledger (ledger.dev.jsonl) is separate: it covers the test user's partition, this one
# the MCP agent's. docs/ops/DEV-CHECK.md → Ledgers.

set -uo pipefail

INPUT=$(cat)
EVENT=$(printf '%s' "$INPUT" | jq -r '.hook_event_name // ""')
TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // ""')
SID=$(printf '%s' "$INPUT" | jq -r '.session_id // ""')

deny() {
  printf '%s' "$1" | jq -Rs '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:.}}'
  exit 0
}

case "$TOOL" in
  mcp__aperture-dev__create_task|mcp__aperture-dev__create_tasks|mcp__aperture-dev__split_task|mcp__aperture-dev__delete_task) ;;
  *) exit 0 ;;
esac

source "${BASH_SOURCE[0]%/*}/_hook-common.sh"
LEDGER=""
if hook_cd "$INPUT"; then
  COMMON=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) && LEDGER="${COMMON%/*}/localNotes/devcheck/mcp-ledger.dev.jsonl"
fi

if [ "$EVENT" = "PreToolUse" ]; then
  [ "$TOOL" = "mcp__aperture-dev__delete_task" ] || exit 0
  ID=$(printf '%s' "$INPUT" | jq -r '.tool_input.id // ""')
  MSG="aperture-dev deletes are limited to task ids this hook recorded from a create response (CLAUDE.md → Aperture MCP connector). Never delete by title or marker — ask the user."
  [ -n "$ID" ] && [ -n "$LEDGER" ] && [ -f "$LEDGER" ] || deny "$MSG (no ledger, or no id.)"
  jq -e --arg id "$ID" 'select(.op == "created" and .id == $id)' "$LEDGER" >/dev/null 2>&1 \
    || deny "$MSG $ID was never recorded."
  exit 0
fi

[ "$EVENT" = "PostToolUse" ] && [ -n "$LEDGER" ] || exit 0
# The MCP result arrives as content blocks ({content:[{type:"text",text:"<json>"}]} or the bare array), or
# already parsed. Normalise to the JSON the tool returned; anything unparsable records nothing.
RESULT=$(printf '%s' "$INPUT" | jq -c '
  .tool_response
  | if type == "object" and has("content") then .content else . end
  | if type == "array" then (map(select(.type == "text") | .text) | first // "null") else . end
  | if type == "string" then (try fromjson catch null) else . end' 2>/dev/null) || exit 0

case "$TOOL" in
  mcp__aperture-dev__create_task) OP=created; IDS=$(printf '%s' "$RESULT" | jq -r '.id? // empty') ;;
  mcp__aperture-dev__create_tasks) OP=created; IDS=$(printf '%s' "$RESULT" | jq -r 'if type == "array" then .[].id? // empty else empty end') ;;
  # A standalone split makes a NEW parent; the follow-up is always new; the original existed before.
  mcp__aperture-dev__split_task) OP=created; IDS=$(printf '%s' "$RESULT" | jq -r '.parent.id? // empty, .followUp.id? // empty') ;;
  mcp__aperture-dev__delete_task) OP=deleted; IDS=$(printf '%s' "$RESULT" | jq -r '.deleted? // empty, (.parts? // [] | .[])') ;;
esac
[ -n "${IDS:-}" ] || exit 0

mkdir -p "${LEDGER%/*}" 2>/dev/null || exit 0
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
while IFS= read -r id; do
  [ -n "$id" ] && jq -nc --arg t "$NOW" --arg op "$OP" --arg id "$id" --arg via "mcp:${TOOL##*__}" --arg sid "$SID" \
    '{t:$t, op:$op, id:$id, via:$via, session:$sid}' >>"$LEDGER"
done <<<"$IDS"
exit 0
