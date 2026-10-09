#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Add Aperture Task
# @raycast.mode compact
# @raycast.packageName Aperture
# @raycast.argument1 { "type": "text", "placeholder": "e.g. aperture, fix login bug due fri 30m" }

# Optional parameters:
# @raycast.icon ✅
# @raycast.description Add a backlog task to Aperture (prod by default); Haiku picks out category, due date and estimate.

# Quick-add: one line → Haiku parses it into create_task fields → one backlog task via the /mcp endpoint
# (docs/areas/mcp). Haiku only parses — it has no tools; this script does every write. If the parse fails
# the line is still added, raw, with a loud toast. Needs only curl, jq and security (macOS 15+).
# Setup: tools/raycast/README.md.
set -uo pipefail

APERTURE_URL="${APERTURE_URL:-https://aperture.rahuldatta.dev}"
ANTHROPIC_URL="${ANTHROPIC_URL:-https://api.anthropic.com}"
KEYCHAIN_SERVICE="${APERTURE_KEYCHAIN_SERVICE:-aperture-agent-token}"
ANTHROPIC_KEYCHAIN_SERVICE="${ANTHROPIC_KEYCHAIN_SERVICE:-anthropic-api-key}"
# One category cache per stage — the ids differ, and a prod id must never land on a dev task.
host="${APERTURE_URL#*://}"
CATEGORIES="$HOME/Library/Caches/aperture-raycast/categories-$(printf '%s' "${host%%/*}" | tr -c 'A-Za-z0-9.-' '_').json"
MODEL="claude-haiku-5-5"
MAYBE_ADDED="it may have been added — check the app before retrying"

# Raycast's compact toast shows only the last stdout line, so the reason is flattened onto one.
fail() { echo "Failed: $(printf '%s' "$1" | tr '\r\n' '  ')"; exit 1; }
# A title cut to toast length.
short() { jq -rn --arg t "$1" 'if ($t | length) > 40 then $t[0:40] + "…" else $t end'; }

# https only — both requests carry a secret. Loopback http is allowed for the stub test.
for url in "$APERTURE_URL" "$ANTHROPIC_URL"; do
  case "$url" in
    *@*) fail "$url has a user@ part — refusing to send a secret to it" ;;
    https://* | http://127.0.0.1:* | http://localhost:*) ;;
    *) fail "$url must start with https:// — a secret would be sent in cleartext" ;;
  esac
done
command -v jq >/dev/null || fail "jq not found — needs macOS 15+ or brew install jq"

# Trim surrounding whitespace; the server stores the title verbatim and would accept a blank one.
line="${1:-}"
line="${line#"${line%%[![:space:]]*}"}"
line="${line%"${line##*[![:space:]]}"}"
[ -n "$line" ] || fail "empty title — type something to add"

token="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -w 2>/dev/null)" \
  || fail "no token in Keychain item \"$KEYCHAIN_SERVICE\" — see tools/raycast/README.md"
api_key="$(security find-generic-password -s "$ANTHROPIC_KEYCHAIN_SERVICE" -w 2>/dev/null)" || api_key=""

out="$(mktemp)"
err="$(mktemp)"
trap 'rm -f "$out" "$err"' EXIT

# post URL BODY MAX_TIME SECRET_HEADER SECRET [CURL_ARG…] — sets rc (curl exit) and status (HTTP); the
# body lands in $out. The secret goes in via a process-substituted header file, built right on the curl
# line (bash 3.2 can close one passed through a function), so it never appears in the process list.
post() {
  local url="$1" body="$2" max="$3" name="$4" secret="$5"
  shift 5
  rc=0
  status="$(curl -sS --max-time "$max" -o "$out" -w '%{http_code}' -X POST "$url" \
    -H 'content-type: application/json' ${1+"$@"} -H @<(printf '%s: %s\n' "$name" "$secret") \
    --data-binary "$body" 2>"$err")" || rc=$?
  curl_msg="$(sed 's/^curl: ([0-9]*) //' "$err")"
}
# One stateless MCP tools/call: mcp TOOL ARGS_JSON MAX_TIME.
mcp() {
  post "$APERTURE_URL/mcp" "$(jq -n --arg name "$1" --argjson args "$2" \
    '{jsonrpc: "2.0", id: 1, method: "tools/call", params: {name: $name, arguments: $args}}')" "$3" \
    x-aperture-agent-token "$token"
}
# The tool's result (its JSON text) on a clean 200, else nothing.
mcp_result() {
  [ "$rc" = 0 ] && [ "$status" = 200 ] \
    && jq -ce 'select(.error == null and .result.isError != true) | .result.content[0].text | fromjson' "$out" 2>/dev/null
}

# --- categories: cached a day (they rarely change); a stale copy beats none when the refresh fails ------
cat_note=""
refresh_categories() {
  [ -n "$(find "$CATEGORIES" -mmin -1440 2>/dev/null)" ] && return
  local fresh tmp
  mcp list_categories '{}' 4
  if fresh="$(mcp_result | jq -c 'map(select(.active != false) | {id, label})')" && [ -n "$fresh" ]; then
    mkdir -p "$(dirname "$CATEGORIES")"
    tmp="$(mktemp "$CATEGORIES.XXXXXX")" && printf '%s\n' "$fresh" >"$tmp" && mv "$tmp" "$CATEGORIES"
  elif [ -f "$CATEGORIES" ]; then
    cat_note="categories: stale"
  else
    cat_note="categories: unavailable"
  fi
}

# --- parse: Haiku turns the line into create_task fields; sets parsed, or raw_reason --------------------
parsed=""
raw_reason=""
parse_line() {
  local cats ids schema system req stop today max
  cats="$(cat "$CATEGORIES" 2>/dev/null)"
  [ -n "$cats" ] || cats='[]'
  ids="$(jq -c 'map(.id)' <<<"$cats")"
  # The app's day starts at 4am (Settings dayStartHour's default; no MCP tool reads it), so at 1am
  # "today" is still yesterday — the same day the app's Today chip means.
  today="$(TZ=America/Los_Angeles jq -rn 'now - 4 * 3600 | localtime | strftime("%Y-%m-%d (%A)")')"
  # Long lines come back as long notes: allow more time for them, up to 10s.
  max=$((4 + ${#line} / 400))
  [ "$max" -le 10 ] || max=10
  # Structured outputs don't take numeric or length constraints — the field rules are checked in validate.
  schema="$(jq -n --argjson ids "$ids" '
    def nullable(s): {anyOf: [s, {type: "null"}]};
    {type: "object", additionalProperties: false,
     required: ["title", "notes", "categoryId", "dueDay", "dueTime", "estimateMin"],
     properties: {
       title: {type: "string"},
       notes: nullable({type: "string"}),
       categoryId: (if ($ids | length) > 0 then nullable({type: "string", enum: $ids}) else {type: "null"} end),
       dueDay: nullable({type: "string", format: "date"}),
       dueTime: nullable({type: "string", description: "HH:MM, 24h"}),
       estimateMin: nullable({type: "integer"})}}')"
  system="You turn one quick-capture line into fields for a task tracker. Today is $today in America/Los_Angeles.
Categories (id: label) — use the id, or null if none clearly matches:
$(jq -r 'if length == 0 then "(none — categoryId must be null)" else .[] | "\(.id): \(.label)" end' <<<"$cats")
Rules:
- title: short and imperative-ish, at most 80 characters, in the user's own words. Strip the parsed meta: a leading category word (\"aperture,\"), due phrases (\"due tmw\", \"by friday\") and estimates (\"30m\", \"2h\").
- notes: if the line has more detail than fits the title, move the rest here with light cleanup only (fix obvious typos, keep the user's wording and order). Otherwise null.
- dueDay: YYYY-MM-DD, only if the user gave a day (\"tmw\" = tomorrow, a weekday name = the next such day, \"today\" = today). Otherwise null.
- dueTime: HH:MM 24h, only if a clock time was given and dueDay is set. Otherwise null.
- estimateMin: whole minutes, only if the user gave an estimate. Never invent one. Otherwise null.
- Set a field only when the user stated it. Do not add tasks, advice or commentary."
  req="$(jq -n --arg model "$MODEL" --arg system "$system" --arg line "$line" --argjson schema "$schema" \
    '{model: $model, max_tokens: 2048, thinking: {type: "disabled"},
      output_config: {effort: "low", format: {type: "json_schema", schema: $schema}},
      system: $system, messages: [{role: "user", content: $line}]}')"
  post "$ANTHROPIC_URL/v1/messages" "$req" "$max" x-api-key "$api_key" -H 'anthropic-version: 2023-06-01'
  if [ "$rc" = 28 ]; then raw_reason="timeout"; return; fi
  if [ "$rc" != 0 ]; then raw_reason="$curl_msg"; return; fi
  if [ "$status" != 200 ]; then
    raw_reason="HTTP $status $(jq -r '.error.message // empty' "$out" 2>/dev/null)"
    return
  fi
  stop="$(jq -r '.stop_reason // empty' "$out" 2>/dev/null)"
  if [ "$stop" != end_turn ]; then raw_reason="${stop:-no stop_reason}"; return; fi
  parsed="$(jq -ce 'first(.content[] | select(.type == "text") | .text) | fromjson | objects' "$out" 2>/dev/null)" \
    || { parsed=""; raw_reason="bad JSON"; }
}

# --- validate: keep each field the server would accept; a bad one is dropped and named in the toast ------
# Prints {args, dropped}. Only a blank title is unusable — that falls to the raw path.
validate() {
  local cats
  cats="$(cat "$CATEGORIES" 2>/dev/null)"
  [ -n "$cats" ] || cats='[]'
  jq -c --argjson cats "$cats" '
    def trim: sub("^\\s+"; "") | sub("\\s+$"; "");
    def realday: test("^[0-9]{4}-[0-9]{2}-[0-9]{2}$") and (split("-") | map(tonumber) as [$y, $m, $d]
      | $m >= 1 and $m <= 12 and $d >= 1
      and $d <= [31, (if ($y % 4 == 0 and $y % 100 != 0) or $y % 400 == 0 then 29 else 28 end),
                 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][$m - 1]);
    def clock: test("^([0-9]|[01][0-9]|2[0-3]):[0-5][0-9]$");
    def pad: if test("^[0-9]:") then "0" + . else . end;
    def str: type == "string";
    . as $p
    | {args: {title: (if ($p.title | str) then $p.title | trim else "" end)}, dropped: []}
    | if ($p.notes | str) and ($p.notes | trim) != "" then
        .args.notes = ($p.notes | trim | .[0:5000])
        | if ($p.notes | trim | length) > 5000 then .dropped += ["notes cut"] else . end
      else . end
    | if $p.categoryId == null then .
      elif ($p.categoryId | str) and ([$cats[].id] | index($p.categoryId)) != null then .args.categoryId = $p.categoryId
      else .dropped += ["unknown category"] end
    | if $p.dueDay == null then .
      elif ($p.dueDay | str) and ($p.dueDay | realday) then .args.dueDay = $p.dueDay
      else .dropped += ["dropped due day"] end
    | if $p.dueTime == null then .
      elif ($p.dueTime | str) and ($p.dueTime | clock) and .args.dueDay != null then .args.dueTime = ($p.dueTime | pad)
      else .dropped += ["dropped due time"] end
    | if $p.estimateMin == null then .
      elif ($p.estimateMin | type) == "number" and $p.estimateMin >= 0 and ($p.estimateMin | floor) == $p.estimateMin
      then .args.estimateMin = $p.estimateMin
      else .dropped += ["dropped estimate"] end' <<<"$parsed"
}

args=""
dropped='[]'
if [ -z "$api_key" ]; then
  raw_reason="no API key in Keychain \"$ANTHROPIC_KEYCHAIN_SERVICE\""
else
  refresh_categories
  parse_line
  if [ -n "$parsed" ]; then
    checked="$(validate)" || checked=""
    if [ -n "$checked" ] && [ -n "$(jq -r '.args.title' <<<"$checked")" ]; then
      args="$(jq -c '.args' <<<"$checked")"
      dropped="$(jq -c '.dropped' <<<"$checked")"
    else
      raw_reason="empty title"
    fi
  fi
fi
[ -n "$args" ] || args="$(jq -cn --arg t "$line" '{title: $t}')"

# --- create ------------------------------------------------------------------------------------------
mcp create_task "$args" 10
# A param error (-32602) is thrown before any write (tools.ts arg parsing → RpcParamError), so a parsed
# attempt the server rejects is safe to resend raw: a gap between validate and the server can't turn a
# good capture into a hard failure, or a duplicate.
if [ -z "$raw_reason" ] && [ "$rc" = 0 ] && [ "$status" = 200 ] \
  && [ "$(jq -r '.error.code // empty' "$out" 2>/dev/null)" = "-32602" ]; then
  raw_reason="server rejected it: $(jq -r '.error.message' "$out")"
  mcp create_task "$(jq -cn --arg t "$line" '{title: $t}')" 10
fi

# Only a failure before the request went out (URL, DNS, connect, TLS) is a sure "nothing was added".
# A timeout or dropped reply can land after the task saved, and a blind retry would duplicate it.
case "$rc" in
  0) ;;
  3 | 6 | 7 | 35 | 60) fail "can't reach $APERTURE_URL — $curl_msg" ;;
  *) fail "no response ($curl_msg) — $MAYBE_ADDED" ;;
esac

reason="$(jq -r '.error // empty' "$out" 2>/dev/null || head -c 200 "$out")"
case "$status" in
  200) ;;
  401) fail "token rejected (HTTP 401) — the Keychain token doesn't match this stage's AGENT_TOKEN" ;;
  5*) fail "HTTP $status — ${reason:-no details}; $MAYBE_ADDED" ;;
  *) fail "HTTP $status — ${reason:-no details}" ;;
esac

# MCP reports errors inside a 200: a protocol error as .error, a tool failure as .result.isError.
rpc_error="$(jq -r '.error.message // empty' "$out" 2>/dev/null)"
[ -z "$rpc_error" ] || fail "$rpc_error"
if [ "$(jq -r '.result.isError // false' "$out" 2>/dev/null)" = "true" ]; then
  fail "$(jq -r '.result.content[0].text // "unknown error"' "$out")"
fi

task="$(jq -ce '.result.content[0].text | fromjson | objects' "$out" 2>/dev/null)" \
  || fail "unexpected response — $(head -c 200 "$out")"

if [ -n "$raw_reason" ]; then
  echo "Added RAW (couldn't parse: $(printf '%s' "$raw_reason" | tr '\r\n' '  ')): $(short "$line")"
  exit 0
fi

# What was saved, as the server returned it, so a wrong guess is visible at once.
cats="$(cat "$CATEGORIES" 2>/dev/null)"
[ -n "$cats" ] || cats='[]'
jq -rn --argjson t "$task" --argjson cats "$cats" --argjson dropped "$dropped" --arg title "$(short "$(jq -r '.title' <<<"$task")")" --arg note "$cat_note" '
  def wday: split("-") | map(tonumber) as [$y, $m, $d]
    | (if $m < 3 then $y - 1 else $y end) as $yy
    | (($yy + ($yy / 4 | floor) - ($yy / 100 | floor) + ($yy / 400 | floor)
        + [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4][$m - 1] + $d) % 7)
    | ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][.] + " \($m)/\($d)";
  ([$cats[] | select(.id == $t.categoryId) | .label] | first // "no category") as $cat
  | ["Added: \($title)", $cat]
    + (if $t.dueDay then ["due \($t.dueDay | wday)" + (if $t.dueTime then " \($t.dueTime)" else "" end)] else [] end)
    + (if $t.estimateMin then ["\($t.estimateMin)m"] else [] end)
    + (if $t.notes then ["+notes"] else [] end)
    + (if $t.gcalSyncError then ["calendar sync failed"] else [] end)
    + $dropped
    + (if $note != "" then [$note] else [] end)
  | join(" · ")'
