#!/bin/bash
# The hub's self-check (docs/ops/HUB.md → The hub's duties; docs/ops/TOWER.md → Board freshness). Hub only: the
# session named in scripts/board/hub.json; every other session pays one jq and exits. A nudge, never a gate: no
# `decision`, never exit 2, every failure exits 0 silently.
#   board-hub-nudge.sh start   UserPromptSubmit: marks where the turn begins; hands the model a nudge left pending
#   board-hub-nudge.sh stop    Stop: checks the turn just ended; shows the nudge now (systemMessage) and leaves it
#                              for the next turn's context
#   board-hub-nudge.sh check   stdin: one turn's transcript lines; env TURN_PROMPT (the turn's prompt) and TURN_REPLY
#                              (its final reply; else the transcript's last text) → the ids that fire. The fixtures and
#                              the false-positive budget use this, the same matcher stop uses. HUB_NUDGE_LOG=1 also
#                              logs them, as stop does (the fixtures).
# Every nudge shown is logged (F258): one line per check fired in $BOARD_DIR/history/nudges-<day>.jsonl,
# {t, check, match, session}: `match` is what fired it, at most 60 characters of the reply (the tag, for pace), never
# the prompt's text. A count of how often each fired, for weighing the hook's help against its cost.
# Text (prompts, replies) reaches jq through the environment, never argv: COI reads every process's argv.
# Registered in user settings, not the repo's (.claude/hooks/README.md → Board hooks): the main checkout's copy.
# Stop takes the reply from `last_assistant_message`: the transcript may lag the final message (hooks docs).
# What it checks (CHECKS below, one table to tune): the self-checks from the 11-17 prod retro, plus the board itself
# — lanes messaged and queue.json untouched this turn.
INPUT=$(cat)
B="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts/board" 2>/dev/null && pwd)" || exit 0
[ -f "$B/lib.sh" ] || exit 0
. "$B/lib.sh"

# id · what in the reply fires it (case-insensitive) · what in the same turn clears it · the nudge
read -r -d '' CHECKS <<'JSON'
[
  {"id": "cant", "re": "\\b(doesn'?t|does not|won'?t) (support|allow|work)\\b|\\bnot (available|supported)\\b|\\bno way (to|of)\\b|\\bisn'?t possible\\b|\\bwant me to (check|look|search)\\b",
   "clear": "searched", "say": "you said something can't be done or isn't supported with no search this turn: search-specialist first, name the source"},
  {"id": "eta", "re": "\\b[0-9]{1,2}:[0-9]{2} ?[–-] ?[0-9]{1,2}:[0-9]{2}\\b|\\b[0-9]+(\\.[0-9]+)? ?%|\\b[0-9.]+ ?[x×] (faster|slower)\\b",
   "clear": "from", "say": "an ETA, % or rate with no \"(from: …)\": say where it comes from (measured, the lane's fresh estimate) or mark it a guess"},
  {"id": "env", "re": "\\b(unreachable|flak(e|y)|unrelated)\\b",
   "clear": "checked", "say": "a lane's environment claim (unreachable / flake / unrelated) relayed with no check of a primary source this turn"},
  {"id": "pace", "prompt": "\\[(pr-open|merged)\\]",
   "clear": "pace", "say": "a [pr-open] or [merged] handled without reading pace.json: is there a lane to start, or why not"}
]
JSON

# A turn's lines → the ids that fire; with HUB_NUDGE_MATCH=1, "<id>\t<what matched>" instead.
check() {
  jq -R 'fromjson? // empty' | TURN_PROMPT="${TURN_PROMPT:-}" TURN_REPLY="${TURN_REPLY:-}" CHECKS="$CHECKS" jq -rs '
    ($ENV.CHECKS | fromjson) as $checks | $ENV.TURN_PROMPT as $prompt
    | [.[] | select(.type == "assistant") | .message.content[]? | select(type == "object")] as $b
    | ([$b[] | .type] | indices("tool_use") | last) as $last
    | (if $ENV.TURN_REPLY != "" then $ENV.TURN_REPLY
       else [$b[(($last // -1) + 1):][] | select(.type == "text") | .text] | join("\n") end) as $reply
    | [$b[] | select(.type == "tool_use")] as $tools
    | {
        searched: any($tools[]; .name == "WebSearch" or .name == "WebFetch"
          or ((.name == "Agent" or .name == "Task") and (.input.subagent_type // "") == "search-specialist")),
        checked: any($tools[]; .name == "Read" or .name == "Bash" or .name == "Grep" or .name == "Glob"),
        pace: any($tools[]; (.input | tostring) | test("pace\\.json")),
        from: ($reply | test("\\(from:"; "i"))
      } as $did
    | $checks[] as $c
    | select(if $c.re then ($reply | test($c.re; "i")) else ($prompt | test($c.prompt; "i")) end)
    | select($did[$c.clear] | not)
    | if $ENV.HUB_NUDGE_MATCH == "1" then
        "\($c.id)\t\((if $c.re then $reply | match($c.re; "i") else $prompt | match($c.prompt; "i") end).string
          | gsub("[\\t\\n\\r]"; " ") | .[0:60])"
      else $c.id end'
}

# "<id>\t<what matched>" lines → one history line each (text through the environment: COI reads argv)
nudge_log() {
  local id m
  while IFS=$'\t' read -r id m; do
    [ -n "$id" ] || continue
    sb_append nudges "$(T="$(sb_now)" ID="$id" M="$m" S="${1:-}" jq -nc '{t: $ENV.T, check: $ENV.ID, match: $ENV.M, session: $ENV.S}')"
  done
}

if [ "${1:-}" = check ]; then
  hits=$(printf '%s\n' "$INPUT" | HUB_NUDGE_MATCH=1 check)
  [ "${HUB_NUDGE_LOG:-}" = 1 ] && printf '%s\n' "$hits" | nudge_log "${HUB_NUDGE_SESSION:-}"
  printf '%s\n' "$hits" | cut -f1 | grep -v '^$'
  exit 0
fi

[ -r "$CG/memory.stat" ] || exit 0 # container only
PID=$(sb_claude_pid "$PPID") || exit 0
hub=$(jq -r '.name // empty' "$B/hub.json" 2>/dev/null)
[ -n "$hub" ] && [ "$hub" = "$(jq -r '.name // empty' "$BOARD_DIR/sessions/$PID.json" 2>/dev/null)" ] || exit 0

turn="$BOARD_DIR/hub-turn" pending="$BOARD_DIR/hub-nudge"
tp=$(printf '%s' "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)
qmt() { stat -c %Y "$BOARD_DIR/queue.json" 2>/dev/null || echo 0; }

case "${1:-}" in
  start)
    size=$(stat -c %s "$tp" 2>/dev/null || echo 0)
    printf '%s' "$INPUT" | jq -c --argjson size "$size" --argjson q "$(qmt)" \
      '{size: $size, queue: $q, prompt: ((.prompt // "") | .[0:2000])}' >"$turn.tmp" 2>/dev/null && mv -f "$turn.tmp" "$turn"
    if [ -s "$pending" ]; then
      jq -Rs '{hookSpecificOutput: {hookEventName: "UserPromptSubmit", additionalContext: ("Hub self-check from your last turn: " + .)}}' "$pending" 2>/dev/null
      rm -f "$pending"
    fi
    ;;
  stop)
    [ "$(printf '%s' "$INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null)" = true ] && exit 0
    [ -r "$tp" ] && [ -r "$turn" ] || exit 0
    read -r off q0 < <(jq -r '"\(.size) \(.queue)"' "$turn" 2>/dev/null)
    [[ "$off" =~ ^[0-9]+$ ]] || exit 0
    slice=$(tail -c +"$((off + 1))" "$tp" 2>/dev/null)
    mapfile -t hits < <(printf '%s\n' "$slice" | TURN_PROMPT=$(jq -r '.prompt // ""' "$turn") \
      TURN_REPLY=$(printf '%s' "$INPUT" | jq -r '.last_assistant_message // ""') HUB_NUDGE_MATCH=1 check 2>/dev/null)
    # the board: lanes messaged (or a merge relayed) and queue.json not written this turn — at most once in 10 min
    if [ "$(qmt)" = "$q0" ] && printf '%s\n' "$slice" | grep -qF '"name":"SendMessage"'; then
      last=$(stat -c %Y "$pending.board" 2>/dev/null || echo 0)
      [ $(($(sb_epoch) - last)) -ge 600 ] && { hits+=($'board\tSendMessage, queue.json untouched'); touch "$pending.board"; }
    fi
    [ "${#hits[@]}" -gt 0 ] || exit 0
    ids=("${hits[@]%%$'\t'*}")
    printf '%s\n' "${hits[@]}" | nudge_log "$hub"
    msg=$(for id in "${ids[@]}"; do
      if [ "$id" = board ]; then echo "- board: you messaged lanes this turn and queue.json is untouched: does the plan, devQueue or mergeOrder need the news?"
      else jq -r --arg id "$id" '.[] | select(.id == $id) | "- \(.id): \(.say)"' <<<"$CHECKS"; fi
    done)
    printf '%s\n' "$msg" >"$pending"
    jq -n --arg m "$msg" '{systemMessage: ("hub self-check:\n" + $m)}'
    ;;
esac
exit 0
