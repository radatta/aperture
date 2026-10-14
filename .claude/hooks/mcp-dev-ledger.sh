#!/bin/bash
# Pre/PostToolUse hook on the aperture-dev MCP task tools — the id ledger that makes "delete what this session
# created" safe without asking each time (CLAUDE.md → Aperture MCP connector, standing approval 2).
#   PostToolUse create_task | create_tasks | split_task → record each NEW task id from the server's response
#   PostToolUse update_task (parentId)                 → track parts, so a delete can't cascade into others
#   PreToolUse  delete_task → DENY unless the id was recorded and no unrecorded task is (or may be) its part
#   PostToolUse delete_task → record `deleted` for the id and the parts the server deleted with it
# Deleting a parent deletes its parts server-side, so a recorded parent is deletable only while every part it
# has came through here: a split's parent is recorded only when the split task was recorded and standalone
# (the split made that parent), and attaching an unrecorded task under a recorded parent marks it `tainted`.
# Ids only — never a title or a marker word. Prod (`aperture`) is never matched. Fails closed for deletes.
# Ledger: <main checkout>/localNotes/devcheck/mcp-ledger.dev.jsonl. Format: docs/ops/DEV-CHECK.md → Ledgers.

set -uo pipefail

INPUT=$(cat)
MSG="aperture-dev deletes are limited to task ids this hook recorded from a create response (CLAUDE.md → Aperture MCP connector). Never delete by title or marker — ask the user."

# Without jq nothing below can be read; a delete must not slip through on that.
if ! command -v jq >/dev/null 2>&1; then
  case "$INPUT" in
    *'"hook_event_name":"PostToolUse"'*|*'"hook_event_name": "PostToolUse"'*) exit 0 ;;
    *mcp__aperture-dev__delete_task*)
      printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"aperture-dev delete blocked: jq is missing, so the ledger cannot be checked."}}'
      exit 0 ;;
  esac
  exit 0
fi

EVENT=$(printf '%s' "$INPUT" | jq -r '.hook_event_name // ""')
TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // ""')
SID=$(printf '%s' "$INPUT" | jq -r '.session_id // ""')

deny() {
  printf '%s' "$1" | jq -Rs '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:.}}'
  exit 0
}

case "$TOOL" in
  mcp__aperture-dev__create_task|mcp__aperture-dev__create_tasks|mcp__aperture-dev__split_task|mcp__aperture-dev__update_task|mcp__aperture-dev__delete_task) ;;
  *) exit 0 ;;
esac

source "${BASH_SOURCE[0]%/*}/_hook-common.sh"
LEDGER=""
if hook_cd "$INPUT"; then
  COMMON=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) && LEDGER="${COMMON%/*}/localNotes/devcheck/mcp-ledger.dev.jsonl"
fi

# Anything that isn't a PostToolUse is treated as the Pre check — a missing event name must not allow a delete.
if [ "$EVENT" != "PostToolUse" ]; then
  [ "$TOOL" = "mcp__aperture-dev__delete_task" ] || exit 0
  ID=$(printf '%s' "$INPUT" | jq -r '.tool_input.id // ""')
  [ -n "$ID" ] && [ -n "$LEDGER" ] && [ -f "$LEDGER" ] || deny "$MSG (no ledger, or no id.)"
  VERDICT=$(jq -rs --arg id "$ID" '
    if any(.[]; .op == "created" and .id == $id) | not then "unrecorded"
    elif any(.[]; .op == "tainted" and .id == $id) then "tainted"
    else "ok" end' "$LEDGER" 2>/dev/null)
  case "$VERDICT" in
    ok) exit 0 ;;
    tainted) deny "$MSG $ID has a part this hook never recorded — deleting it would delete that part too." ;;
    *) deny "$MSG $ID was never recorded." ;;
  esac
fi

[ -n "$LEDGER" ] || exit 0
# The MCP result arrives as content blocks ({content:[{type:"text",text:"<json>"}]} or the bare array), or
# already parsed. Normalise to the JSON the tool returned; anything unparsable records nothing. The exact shape
# Claude Code hands a hook hasn't been pinned against a live call — a mismatch records nothing, so deletes deny.
RESULT=$(printf '%s' "$INPUT" | jq -c '
  .tool_response
  | if type == "object" and has("content") then .content else . end
  | if type == "array" then (map(select(.type == "text") | .text) | first // "null") else . end
  | if type == "string" then (try fromjson catch null) else . end' 2>/dev/null) || exit 0
LINES=""
recorded() { [ -f "$LEDGER" ] && jq -es --arg id "$1" 'any(.[]; .op == "created" and .id == $id)' "$LEDGER" >/dev/null 2>&1; }
# The parent a recorded task last had (created with, or reparented to); empty when none.
parent_of() { jq -rs --arg id "$1" '[.[] | select(.id == $id and (.op == "created" or .op == "reparented"))] | last | .parent // ""' "$LEDGER" 2>/dev/null; }
add() { LINES+="$(jq -nc --arg op "$1" --arg id "$2" --arg parent "${3:-}" '{op:$op, id:$id} + (if $parent == "" then {} else {parent:$parent} end)')"$'\n'; }

case "$TOOL" in
  mcp__aperture-dev__create_task)
    ID=$(printf '%s' "$RESULT" | jq -r '.id? // empty')
    [ -n "$ID" ] && add created "$ID" "$(printf '%s' "$INPUT" | jq -r '.tool_input.parentId // ""')" ;;
  mcp__aperture-dev__create_tasks)
    while IFS=$'\t' read -r id parent; do [ -n "$id" ] && add created "$id" "$parent"; done < <(
      printf '%s' "$RESULT" | jq -r 'if type == "array" then .[] | [(.id? // ""), (.parentId? // "")] | @tsv else empty end') ;;
  mcp__aperture-dev__split_task)
    ORIG=$(printf '%s' "$RESULT" | jq -r '.original.id? // empty')
    PARENT=$(printf '%s' "$RESULT" | jq -r '.parent.id? // empty')
    FOLLOW=$(printf '%s' "$RESULT" | jq -r '.followUp.id? // empty')
    [ -n "$FOLLOW" ] && add created "$FOLLOW" "$PARENT"
    if [ -n "$ORIG" ] && [ -n "$PARENT" ]; then
      if recorded "$ORIG"; then
        # A recorded standalone task's split made this parent; a recorded part's parent already existed.
        [ -z "$(parent_of "$ORIG")" ] && add created "$PARENT" && add reparented "$ORIG" "$PARENT"
      elif recorded "$PARENT"; then
        add tainted "$PARENT"
      fi
    fi ;;
  mcp__aperture-dev__update_task)
    printf '%s' "$INPUT" | jq -e '.tool_input | has("parentId")' >/dev/null 2>&1 || exit 0
    ID=$(printf '%s' "$INPUT" | jq -r '.tool_input.id // ""')
    NEWP=$(printf '%s' "$INPUT" | jq -r '.tool_input.parentId // ""')
    [ -n "$ID" ] || exit 0
    if recorded "$ID"; then add reparented "$ID" "$NEWP"
    elif [ -n "$NEWP" ] && recorded "$NEWP"; then add tainted "$NEWP"
    fi ;;
  mcp__aperture-dev__delete_task)
    while IFS= read -r id; do [ -n "$id" ] && add deleted "$id"; done < <(
      printf '%s' "$RESULT" | jq -r '.deleted? // empty, (.parts? // [] | .[])') ;;
esac
[ -n "$LINES" ] || exit 0

mkdir -p "${LEDGER%/*}" 2>/dev/null || exit 0
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf '%s' "$LINES" | jq -c --arg t "$NOW" --arg via "mcp:${TOOL##*__}" --arg sid "$SID" \
  '{t:$t} + . + {via:$via, session:$sid}' >>"$LEDGER"
exit 0
