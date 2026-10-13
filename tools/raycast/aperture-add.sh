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

# Quick-add: one line → the server's parse_task (Claude Haiku, the same parse as the app's quick add —
# docs/areas/tasks/quick-add.md) → create_task → one backlog task, both via the /mcp endpoint. The model
# only parses; this script does the one write. If the parse fails the line is still added, raw, with a
# loud toast. Needs only curl, jq and security (macOS 15+). Setup: tools/raycast/README.md.
set -uo pipefail

APERTURE_URL="${APERTURE_URL:-https://aperture.rahuldatta.dev}"
KEYCHAIN_SERVICE="${APERTURE_KEYCHAIN_SERVICE:-aperture-agent-token}"
MAYBE_ADDED="it may have been added — check the app before retrying"

# Raycast's compact toast shows only the last stdout line, so the reason is flattened onto one.
fail() { echo "Failed: $(printf '%s' "$1" | tr '\r\n' '  ')"; exit 1; }
# A title cut to toast length.
short() { jq -rn --arg t "$1" 'if ($t | length) > 40 then $t[0:40] + "…" else $t end'; }

# https only — the request carries a secret. Loopback http is allowed for a local stub test.
case "$APERTURE_URL" in
  *@*) fail "$APERTURE_URL has a user@ part — refusing to send a secret to it" ;;
  https://* | http://127.0.0.1:* | http://localhost:*) ;;
  *) fail "$APERTURE_URL must start with https:// — a secret would be sent in cleartext" ;;
esac
command -v jq >/dev/null || fail "jq not found — needs macOS 15+ or brew install jq"

# Trim surrounding whitespace; the server stores the title verbatim and would accept a blank one.
line="${1:-}"
line="${line#"${line%%[![:space:]]*}"}"
line="${line%"${line##*[![:space:]]}"}"
[ -n "$line" ] || fail "empty title — type something to add"

token="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -w 2>/dev/null)" \
  || fail "no token in Keychain item \"$KEYCHAIN_SERVICE\" — see tools/raycast/README.md"

out="$(mktemp)"
err="$(mktemp)"
trap 'rm -f "$out" "$err"' EXIT

# mcp TOOL ARGS_JSON MAX_TIME — one stateless MCP tools/call; sets rc (curl exit) and status (HTTP), the
# body lands in $out. The token goes in via a process-substituted header file, built right on the curl
# line (bash 3.2 can close one passed through a function), so it never appears in the process list.
mcp() {
  rc=0
  status="$(curl -sS --max-time "$3" -o "$out" -w '%{http_code}' -X POST "$APERTURE_URL/mcp" \
    -H 'content-type: application/json' -H @<(printf 'x-aperture-agent-token: %s\n' "$token") \
    --data-binary "$(jq -n --arg name "$1" --argjson args "$2" \
      '{jsonrpc: "2.0", id: 1, method: "tools/call", params: {name: $name, arguments: $args}}')" \
    2>"$err")" || rc=$?
  curl_msg="$(sed 's/^curl: ([0-9]*) //' "$err")"
}
# The tool's result (its JSON text) on a clean 200, else nothing.
mcp_result() {
  [ "$rc" = 0 ] && [ "$status" = 200 ] \
    && jq -ce 'select(.error == null and .result.isError != true) | .result.content[0].text | fromjson' "$out" 2>/dev/null
}

# --- parse: the server's parse_task; sets args/dropped/cat_label, or raw_reason ------------------------
# The server owns the prompt, the API key, the category list and "today" (the app's 4am day start), and
# validates the model's fields — so what comes back is ready for create_task. Its model budget is ≤ 8s.
args=""
dropped='[]'
cat_label="no category"
raw_reason=""
mcp parse_task "$(jq -cn --arg t "$line" '{text: $t}')" 12
if parsed="$(mcp_result)" && [ -n "$parsed" ]; then
  if [ "$(jq -r '.ok' <<<"$parsed")" = "true" ]; then
    args="$(jq -c '.input' <<<"$parsed")"
    dropped="$(jq -c '.dropped' <<<"$parsed")"
    cat_label="$(jq -r '.categoryLabel // "no category"' <<<"$parsed")"
  else
    raw_reason="$(jq -r '.reason + (if .detail then ": " + .detail else "" end)' <<<"$parsed")"
  fi
elif [ "$rc" = 28 ]; then
  raw_reason="parse timed out"
elif [ "$rc" != 0 ]; then
  raw_reason="parse unreachable: $curl_msg"
else
  raw_reason="parse failed: $(jq -r '.error.message // .result.content[0].text // empty' "$out" 2>/dev/null || true)"
  [ "$raw_reason" != "parse failed: " ] || raw_reason="parse failed: HTTP $status"
fi
[ -n "$args" ] || args="$(jq -cn --arg t "$line" '{title: $t}')"

# --- create ------------------------------------------------------------------------------------------
mcp create_task "$args" 10
# A param error (-32602) is thrown before any write (tools.ts arg parsing → RpcParamError), so a parsed
# attempt the server rejects is safe to resend raw: a gap between the parse and create_task can't turn a
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
  # Saved, but not as parsed: exit 1 so Raycast shows it red.
  echo "Added RAW (couldn't parse: $(printf '%s' "$raw_reason" | tr '\r\n' '  ')): $(short "$line")"
  exit 1
fi

# What was saved, as the server returned it, so a wrong guess is visible at once.
jq -rn --argjson t "$task" --argjson dropped "$dropped" --arg cat "$cat_label" --arg title "$(short "$(jq -r '.title' <<<"$task")")" '
  def wday: split("-") | map(tonumber) as [$y, $m, $d]
    | (if $m < 3 then $y - 1 else $y end) as $yy
    | (($yy + ($yy / 4 | floor) - ($yy / 100 | floor) + ($yy / 400 | floor)
        + [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4][$m - 1] + $d) % 7)
    | ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][.] + " \($m)/\($d)";
  ["Added: \($title)", (if $t.categoryId then $cat else "no category" end)]
    + (if $t.dueDay then ["due \($t.dueDay | wday)" + (if $t.dueTime then " \($t.dueTime)" else "" end)] else [] end)
    + (if $t.estimateMin then ["\($t.estimateMin)m"] else [] end)
    + (if $t.notes then ["+notes"] else [] end)
    + (if $t.gcalSyncError then ["calendar sync failed"] else [] end)
    + $dropped
  | join(" · ")'
