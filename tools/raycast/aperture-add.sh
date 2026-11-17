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

# Quick-add: one line → POST /api/capture with a capture token (docs/areas/tasks/capture.md). The server
# parses it (Claude Haiku, the same parse as the app's quick add — docs/areas/tasks/quick-add.md), creates
# the task and answers a receipt. A failed parse still saves the line, with a loud toast. The token can
# only capture — nothing else in Aperture. Needs only curl, jq and security (macOS 15+). Setup:
# tools/raycast/README.md.
set -uo pipefail

APERTURE_URL="${APERTURE_URL:-https://aperture.rahuldatta.dev}"
KEYCHAIN_SERVICE="${APERTURE_KEYCHAIN_SERVICE:-aperture-capture-token}"
MAYBE_ADDED="it may have been added — check the app before retrying"

# Raycast's compact toast shows only the last stdout line, so the reason is flattened onto one.
fail() { echo "Failed: $(printf '%s' "$1" | tr '\r\n' '  ')"; exit 1; }

# https only — the request carries a secret. Loopback http is allowed for a local test.
case "$APERTURE_URL" in
  *@*) fail "$APERTURE_URL has a user@ part — refusing to send a secret to it" ;;
  https://* | http://127.0.0.1:* | http://localhost:*) ;;
  *) fail "$APERTURE_URL must start with https:// — a secret would be sent in cleartext" ;;
esac
command -v jq >/dev/null || fail "jq not found — needs macOS 15+ or brew install jq"

# Trim surrounding whitespace; the server refuses a blank line, but saying so here saves a round trip.
line="${1:-}"
line="${line#"${line%%[![:space:]]*}"}"
line="${line%"${line##*[![:space:]]}"}"
[ -n "$line" ] || fail "empty title — type something to add"

token="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -w 2>/dev/null)" \
  || fail "no token in Keychain item \"$KEYCHAIN_SERVICE\" — see tools/raycast/README.md"

out="$(mktemp)"
err="$(mktemp)"
trap 'rm -f "$out" "$err"' EXIT

# One POST. The token goes in via a process-substituted header file, built right on the curl line, so it
# never appears in the process list. No voice flag: a typed line keeps the typed time rules. The server's
# parse budget is ≤ 5 s inside a 15 s Lambda, so 20 s covers it with a create and a calendar sync.
rc=0
status="$(curl -sS --max-time 20 -o "$out" -w '%{http_code}' -X POST "$APERTURE_URL/api/capture" \
  -H 'content-type: application/json' \
  -H @<(printf 'x-aperture-authorization: Bearer %s\n' "$token") \
  --data-binary "$(jq -cn --arg t "$line" '{text: $t}')" \
  2>"$err")" || rc=$?
curl_msg="$(sed 's/^curl: ([0-9]*) //' "$err")"

# Only a failure before the request went out (URL, DNS, connect, TLS) is a sure "nothing was added".
# A timeout or dropped reply can land after the task saved, and a blind retry would duplicate it (a
# retry of the same line within a minute is answered "Already added", not saved twice).
case "$rc" in
  0) ;;
  3 | 6 | 7 | 35 | 60) fail "can't reach $APERTURE_URL — $curl_msg" ;;
  *) fail "no response ($curl_msg) — $MAYBE_ADDED" ;;
esac

# Every answer from the route carries `say`; a 200 also carries `detail` (the receipt) and `raw`.
say="$(jq -r '.say // empty' "$out" 2>/dev/null)"
case "$status" in
  200) ;;
  401) fail "token rejected (HTTP 401) — revoked, or not a capture token? Make one in Settings › Capture" ;;
  429) fail "${say:-daily capture limit reached} (HTTP 429)" ;;
  5*) fail "HTTP $status — ${say:-no details}; $MAYBE_ADDED" ;;
  *) fail "HTTP $status — ${say:-$(head -c 200 "$out")}" ;;
esac

detail="$(jq -er '.detail | strings | select(length > 0)' "$out" 2>/dev/null)" \
  || detail="$(jq -er '.say' "$out" 2>/dev/null)" \
  || fail "unexpected response — $(head -c 200 "$out")"
echo "$detail"
# Saved, but not as parsed: exit 1 so Raycast shows it red.
[ "$(jq -r '.raw' "$out" 2>/dev/null)" != "true" ] || exit 1
