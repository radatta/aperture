#!/bin/bash
# Pre/PostToolUse hook on the aperture-dev MCP task tools — the id ledger that makes "delete what this session
# created" safe without asking each time (CLAUDE.md → Aperture MCP connector, standing approval 2).
#   PostToolUse create_task | create_tasks | split_task → record each NEW task id from the server's response
#   PreToolUse  update_task (parentId set)             → record the attach BEFORE the call (it can half-apply)
#   PostToolUse update_task (parentId null)            → record a detach once it succeeded
#   PreToolUse  delete_task → DENY unless the id was recorded and no unrecorded task is (or may be) its part
#   PostToolUse delete_task → record `deleted` for the id and the parts the server deleted with it
# Deleting a parent deletes its parts server-side, so a recorded parent is deletable only while every part it
# has came through here: a split's parent is recorded only when the split task was recorded and standalone
# (the split made that parent), and attaching an unrecorded task under a recorded parent marks it `tainted`.
# A taint never clears (fail closed): that parent stays undeletable by the standing approval. A corrupt ledger
# reads as "unknown", which taints rather than records.
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

LINES=""
# Whether the ledger has a `created` line for $1: yes / no / unknown (unreadable or corrupt ledger).
rec_state() {
  [ -f "$LEDGER" ] || { echo no; return; }
  local out
  out=$(jq -rs --arg id "$1" 'any(.[]; .op == "created" and .id == $id)' "$LEDGER" 2>/dev/null) || { echo unknown; return; }
  [ "$out" = "true" ] && echo yes || echo no
}
# The parent a recorded task last had (created with, or reparented to); empty when none.
parent_of() { jq -rs --arg id "$1" '[.[] | select(.id == $id and (.op == "created" or .op == "reparented"))] | last | .parent // ""' "$LEDGER" 2>/dev/null; }
add() { LINES+="$(jq -nc --arg op "$1" --arg id "$2" --arg parent "${3:-}" '{op:$op, id:$id} + (if $parent == "" then {} else {parent:$parent} end)')"$'\n'; }
flush() {
  [ -n "$LINES" ] && [ -n "$LEDGER" ] || return 0
  mkdir -p "${LEDGER%/*}" 2>/dev/null || return 0
  printf '%s' "$LINES" | jq -c --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg via "mcp:${TOOL##*__}" --arg sid "$SID" \
    '{t:$t} + . + {via:$via, session:$sid}' >>"$LEDGER"
}

# Anything that isn't a PostToolUse is treated as the Pre check — a missing event name must not allow a delete.
if [ "$EVENT" != "PostToolUse" ]; then
  case "$TOOL" in
    mcp__aperture-dev__update_task)
      # An attach is recorded BEFORE the call: update_task applies fields in order and can fail after the
      # parentId landed, and a failed call gets no PostToolUse. Recording an attach that then didn't happen only
      # costs an extra deny later; missing one that did could let a delete cascade into the user's task.
      [ -n "$LEDGER" ] || exit 0
      NEWP=$(printf '%s' "$INPUT" | jq -r '.tool_input.parentId // ""')
      ID=$(printf '%s' "$INPUT" | jq -r '.tool_input.id // ""')
      [ -n "$NEWP" ] && [ -n "$ID" ] || exit 0
      case "$(rec_state "$ID")" in
        yes) add reparented "$ID" "$NEWP" ;;
        *) [ "$(rec_state "$NEWP")" = no ] || add tainted "$NEWP" ;;
      esac
      flush; exit 0 ;;
    mcp__aperture-dev__delete_task) ;;
    *) exit 0 ;;
  esac
  ID=$(printf '%s' "$INPUT" | jq -r '.tool_input.id // ""')
  [ -n "$ID" ] && [ -n "$LEDGER" ] && [ -f "$LEDGER" ] || deny "$MSG (no ledger, or no id.)"
  VERDICT=$(jq -rs --arg id "$ID" '
    if any(.[]; .op == "created" and .id == $id) | not then "unrecorded"
    elif any(.[]; .op == "tainted" and .id == $id) then "tainted"
    else "ok" end' "$LEDGER" 2>/dev/null)
  case "$VERDICT" in
    ok) exit 0 ;;
    tainted) deny "$MSG $ID has a part this hook never recorded — deleting it would delete that part too." ;;
    *) deny "$MSG $ID was never recorded (or the ledger is unreadable)." ;;
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
      case "$(rec_state "$ORIG")" in
        # A recorded standalone task's split made this parent; a recorded part's parent already existed.
        # "Standalone" is the ledger's view, kept conservative by recording attaches before the call.
        yes) [ -z "$(parent_of "$ORIG")" ] && add created "$PARENT" && add reparented "$ORIG" "$PARENT" ;;
        *) [ "$(rec_state "$PARENT")" = no ] || add tainted "$PARENT" ;;
      esac
    fi ;;
  mcp__aperture-dev__update_task)
    # Attaches were recorded in Pre; a detach only once it succeeded (recording one that failed would make
    # the task look standalone, and a later split would then record a parent it didn't make).
    ID=$(printf '%s' "$INPUT" | jq -r '.tool_input.id // ""')
    printf '%s' "$INPUT" | jq -e '.tool_input | has("parentId") and .parentId == null' >/dev/null 2>&1 || exit 0
    [ -n "$ID" ] && [ "$(rec_state "$ID")" = yes ] && add reparented "$ID" "" ;;
  mcp__aperture-dev__delete_task)
    while IFS= read -r id; do [ -n "$id" ] && add deleted "$id"; done < <(
      printf '%s' "$RESULT" | jq -r '.deleted? // empty, (.parts? // [] | .[])') ;;
esac
flush
exit 0
