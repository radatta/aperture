#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Add Aperture Task
# @raycast.mode compact
# @raycast.packageName Aperture
# @raycast.argument1 { "type": "text", "placeholder": "Task title" }

# Optional parameters:
# @raycast.icon ✅
# @raycast.description Add a backlog task to Aperture (prod by default).

# Quick-add: one line → one backlog task, via the /mcp endpoint's create_task tool (docs/areas/mcp).
# Needs only curl, jq and security — all ship with macOS 15+. Setup: tools/raycast/README.md.
set -uo pipefail

APERTURE_URL="${APERTURE_URL:-https://aperture.rahuldatta.dev}"
KEYCHAIN_SERVICE="${APERTURE_KEYCHAIN_SERVICE:-aperture-agent-token}"
MAYBE_ADDED="it may have been added — check the app before retrying"

# Raycast's compact toast shows only the last stdout line, so the reason is flattened onto one.
fail() { echo "Failed: $(printf '%s' "$1" | tr '\r\n' '  ')"; exit 1; }

command -v jq >/dev/null || fail "jq not found — needs macOS 15+ or brew install jq"
case "$APERTURE_URL" in
  https://*) ;;
  *) fail "APERTURE_URL must start with https:// — the token would be sent in cleartext" ;;
esac

# Trim surrounding whitespace; the server stores the title verbatim and would accept a blank one.
title="${1:-}"
title="${title#"${title%%[![:space:]]*}"}"
title="${title%"${title##*[![:space:]]}"}"
[ -n "$title" ] || fail "empty title — type something to add"

token="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -w 2>/dev/null)" \
  || fail "no token in Keychain item \"$KEYCHAIN_SERVICE\" — see tools/raycast/README.md"

body="$(jq -n --arg t "$title" \
  '{jsonrpc: "2.0", id: 1, method: "tools/call", params: {name: "create_task", arguments: {title: $t}}}')"
out="$(mktemp)"
err="$(mktemp)"
trap 'rm -f "$out" "$err"' EXIT

# The token goes in via a process-substituted header file so it never appears in the process list.
rc=0
status="$(curl -sS --max-time 10 -o "$out" -w '%{http_code}' -X POST "$APERTURE_URL/mcp" \
  -H 'content-type: application/json' \
  -H @<(printf 'x-aperture-agent-token: %s\n' "$token") \
  --data-binary "$body" 2>"$err")" || rc=$?
curl_msg="$(sed 's/^curl: ([0-9]*) //' "$err")"

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

added="$(jq -r '.result.content[0].text | fromjson | .title' "$out" 2>/dev/null)" \
  || fail "unexpected response — $(head -c 200 "$out")"
echo "Added: $added"
