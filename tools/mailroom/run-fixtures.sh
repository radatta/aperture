#!/bin/bash
# Fixture suite for runner.sh + jobs/: each testdata/jobs.jsonl case runs the real runner against a fresh temp
# .hostjobs, with `curl` and `security` replaced by exported shell functions (no stub files — a process command
# line holding a path ending in the curl name trips COI's Sigma rule; docs/ops/COI-INCIDENTS.md → Incident H).
# Bash 3.2 + jq, so it runs in the container (vitest: scripts/src/mailroom/runner-fixtures.test.ts) and on the Mac.
set -uo pipefail
# On the Mac, run as launchd will: Apple's /bin/bash 3.2 and the system tools, not Homebrew's.
if [ "$(uname)" = Darwin ]; then
  export PATH=/usr/bin:/bin:/usr/sbin:/sbin
  [ "${BASH_VERSINFO[0]}" -le 3 ] || exec /bin/bash "$0" "$@"
fi
HERE="$(cd "$(dirname "$0")" && pwd -P)"
CASES="$HERE/testdata/jobs.jsonl"
export MAILROOM_FIXTURE_TOKEN="fixture-token-5f3a9c"
pass=0
failed=0

sha256() { if command -v shasum >/dev/null; then shasum -a 256; else sha256sum; fi | cut -d' ' -f1; }

# --- stubs: answer from $MAILROOM_FIXTURE_API, record every call in $MAILROOM_FIXTURE_CALLS -----------------
curl() {
  local hdr="" out="" method=GET url="" data="" auth=missing leak=0 argv="$*" n route rc
  while [ $# -gt 0 ]; do
    case "$1" in
      -D) hdr="$2"; shift 2 ;;
      -o) out="$2"; shift 2 ;;
      -w | --max-time) shift 2 ;;
      -X) method="$2"; shift 2 ;;
      --data-binary) data="${2#@}"; shift 2 ;;
      -H)
        if [ "${2#@}" != "$2" ]; then
          if [ "$(cat "${2#@}")" = "Authorization: Bearer $MAILROOM_FIXTURE_TOKEN" ]; then auth=ok; else auth=bad; fi
        fi
        shift 2 ;;
      -sS) shift ;;
      https://*) url="$1"; shift ;;
      *) echo "curl stub: unexpected argument $1" >&2; return 2 ;;
    esac
  done
  case "$argv" in *"$MAILROOM_FIXTURE_TOKEN"*) leak=1 ;; esac
  n="$(wc -l <"$MAILROOM_FIXTURE_CALLS" | tr -d ' ')"
  printf '%s %s auth=%s leak=%s\n' "$method" "${url#https://api.github.com}" "$auth" "$leak" >>"$MAILROOM_FIXTURE_CALLS"
  [ -z "$data" ] || cp "$data" "$MAILROOM_FIXTURE_CALLS.$n.data"
  route="$(jq -c --arg k "$method ${url#https://api.github.com}" '.[$k] // empty' "$MAILROOM_FIXTURE_API")"
  if [ -z "$route" ]; then echo "curl: (7) no route" >&2; return 7; fi
  rc="$(jq -r '.exit // 0' <<<"$route")"
  [ "$rc" = 0 ] || return "$rc"
  jq -r '"HTTP/2 \(.status)\r", ((.headers // {}) | to_entries[] | "\(.key): \(.value)\r")' <<<"$route" >"$hdr"
  jq -r 'if (.body | type) == "string" then .body else (.body // {} | tojson) end' <<<"$route" >"$out"
  printf '%s' "$(jq -r .status <<<"$route")"
}
security() {
  [ "$*" = "find-generic-password -s aperture-mailroom-gh -w" ] || { echo "security stub: unexpected $*" >&2; return 2; }
  [ -z "${MAILROOM_FIXTURE_NO_TOKEN:-}" ] || return 44
  printf '%s\n' "$MAILROOM_FIXTURE_TOKEN"
}
export -f curl security

ok() { pass=$((pass + 1)); echo "ok - $1"; }
bad() { failed=$((failed + 1)); echo "not ok - $1: $2"; [ -z "${3:-}" ] || sed 's/^/    /' "$3"; }

base="$(head -1 "$CASES" | jq -c .base)"
defapi="$(sed -n 2p "$CASES" | jq -c .defaultApi)"

while IFS= read -r c; do
  name="$(jq -r .name <<<"$c")"
  T="$(cd "$(mktemp -d)" && pwd -P)" # the real path: the runner refuses a .hostjobs that resolves elsewhere
  hj="$T/hj"
  st="$T/state"
  mkdir -p "$hj/inbox" "$hj/results" "$hj/staging" "$st"
  : >"$T/calls"
  now="$(date +%s)"

  # The job: base ⊕ patch, minus unset paths, submittedAt relative to now, bodySha256 computed when "auto".
  job="$(jq -c --argjson base "$base" --argjson now "$now" '. as $c | ($base * ($c.patch // {}))
    | reduce ($c.unset // [])[] as $p (.; delpaths([$p]))
    | if $c.bodyRepeat then .params.body = ($c.bodyRepeat.s * $c.bodyRepeat.n) else . end
    | if .submittedAt == "now" then .submittedAt = (($now - 60 * ($c.submittedAgoMin // 0)) | todate) else . end' <<<"$c")"
  if [ "$(jq -r '.params.bodySha256? // ""' <<<"$job")" = auto ]; then
    job="$(jq -c --arg s "$(jq -j .params.body <<<"$job" | sha256)" '.params.bodySha256 = $s' <<<"$job")"
  fi
  id="$(jq -r 'if (.id | type) == "string" then .id else "20261101T204512Z-mac-mailroom-3kx9" end' <<<"$job")"
  file="$(jq -r --arg d "$id.json" '.file // $d' <<<"$c")"
  rid="${file%.json}" # results land under the file's stem

  # The API: default routes ⊕ the case's (a null route removes it); an optional near expiry on GET /user.
  jq -c --argjson d "$defapi" --argjson now "$now" '. as $c | ($d * ($c.api // {}))
    | with_entries(select(.value != null))
    | if $c.expiresInDays then .["GET /user"].headers["github-authentication-token-expiration"] =
        (($now + $c.expiresInDays * 86400) | strftime("%Y-%m-%d %H:%M:%S UTC")) else . end' <<<"$c" >"$T/api.json"

  setup="$(jq -r '.setup // ""' <<<"$c")"
  raw="$(jq -r 'if has("raw") then "1" else "" end' <<<"$c")"
  if [ -n "$raw" ]; then jq -j .raw <<<"$c" >"$hj/staging/x"; else printf '%s' "$job" >"$hj/staging/x"; fi
  case "$setup" in
    symlink) printf 'secret\n' >"$T/outside.txt"; ln -s "$T/outside.txt" "$hj/inbox/$file" ;;
    fifo) mkfifo "$hj/inbox/$file" ;;
    dir) mkdir "$hj/inbox/$file" ;;
    oversize) head -c 80000 /dev/zero | tr '\0' 'a' >"$hj/inbox/$file" ;;
    duplicate) mkdir "$hj/results/$rid"; mv "$hj/staging/x" "$hj/inbox/$file" ;;
    lock) mkdir "$st/lock"; mv "$hj/staging/x" "$hj/inbox/$file" ;;
    stale-lock) mkdir "$st/lock"; touch -t 202001010000 "$st/lock"; mv "$hj/staging/x" "$hj/inbox/$file" ;;
    many)
      for i in 1 2 3 4 5 6; do
        jq -c --arg id "${id}-$i" '.id = $id' <<<"$job" >"$hj/inbox/${id}-$i.json"
      done ;;
    inbox-symlink)
      mkdir "$T/elsewhere"; mv "$hj/staging/x" "$T/elsewhere/$file"
      rmdir "$hj/inbox"; ln -s "$T/elsewhere" "$hj/inbox" ;;
    hj-symlink)
      mv "$hj" "$T/real-hj"; ln -s "$T/real-hj" "$hj"; mv "$hj/staging/x" "$hj/inbox/$file" ;;
    hardlink)
      mv "$hj/staging/x" "$hj/staging/mine"; ln "$hj/staging/mine" "$hj/inbox/$file" ;;
    results-symlink)
      mkdir "$T/elsewhere"; rmdir "$hj/results"; ln -s "$T/elsewhere" "$hj/results"
      mv "$hj/staging/x" "$hj/inbox/$file" ;;
    "") mv "$hj/staging/x" "$hj/inbox/$file" ;;
    *) bad "$name" "unknown setup $setup"; continue ;;
  esac

  (
    [ "$(jq -r '.noToken // false' <<<"$c")" = true ] && export MAILROOM_FIXTURE_NO_TOKEN=1
    MAILROOM_FIXTURE_API="$T/api.json" MAILROOM_FIXTURE_CALLS="$T/calls" bash "$HERE/runner.sh" "$hj" "$st"
  ) >"$T/out" 2>&1
  rc=$?

  why=""
  want_rc="$(jq -r '.exit // 0' <<<"$c")"
  [ "$rc" = "$want_rc" ] || why="runner exited $rc, want $want_rc"
  left="$(find "$hj/inbox/" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')"
  [ -n "$why" ] || [ "$left" = "$(jq -r '.inboxLeft // 0' <<<"$c")" ] || why="$left entries left in the inbox"

  if [ -z "$why" ]; then
    if [ "$(jq -r '.noResult // false' <<<"$c")" = true ]; then
      found="$(find "$hj/results/" "$T/elsewhere" -name result.json 2>/dev/null | wc -l | tr -d ' ')"
      [ "$found" = 0 ] || why="wrote $found result(s), want none"
    elif [ "$setup" = many ]; then
      found="$(find "$hj/results/" -name result.json | wc -l | tr -d ' ')"
      [ "$found" = 5 ] || why="wrote $found results, want 5"
    elif [ ! -f "$hj/results/$rid/result.json" ]; then
      why="no results/$rid/result.json"
    elif ! jq -e --argjson e "$(jq -c .expect <<<"$c")" '. as $r | $e | to_entries | all(.value == $r[.key])' \
      "$hj/results/$rid/result.json" >/dev/null; then
      why="result $(cat "$hj/results/$rid/result.json") does not match $(jq -c .expect <<<"$c")"
    fi
  fi

  # Every call: exactly the expected METHOD path list, the token only in the header file, never on argv.
  if [ -z "$why" ] && [ "$(jq -r '.calls // [] | type' <<<"$c")" = array ]; then
    got="$(cut -d' ' -f1,2 "$T/calls" | jq -R . | jq -sc .)"
    want="$(jq -c '.calls // []' <<<"$c")"
    [ "$got" = "$want" ] || why="calls $got, want $want"
    if grep -qv ' auth=ok leak=0$' "$T/calls"; then why="a call without the header-file token, or with it on argv"; fi
  fi
  # The exact request body of a call: "post" for POST …/pulls, "md" for POST /markdown.
  for k in post md; do
    [ -z "$why" ] && [ "$(jq -r --arg k "$k" 'has($k)' <<<"$c")" = true ] || continue
    case "$k" in post) route='^POST /repos/radatta/aperture/pulls ' ;; md) route='^POST /markdown ' ;; esac
    idx="$(grep -n "$route" "$T/calls" | head -1 | cut -d: -f1)"
    sent="$( [ -z "$idx" ] || cat "$T/calls.$((idx - 1)).data" 2>/dev/null || true)"
    jq -e --argjson p "$(jq -c --arg k "$k" '.[$k]' <<<"$c")" '. == $p' <<<"$sent" >/dev/null 2>&1 || why="$k body ${sent:-not sent}"
  done
  if [ -z "$why" ] && [ "$setup" = hardlink ] && [ ! -f "$hj/staging/mine" ]; then why="the hard-linked original went missing"; fi
  if [ -z "$why" ] && grep -rq -e "$MAILROOM_FIXTURE_TOKEN" -e BODYMARK "$T/out" "$hj/results/" 2>/dev/null; then
    why="the token or body text reached the log or a result"
  fi
  if [ -z "$why" ] && [ "$setup" = symlink ] && [ "$(cat "$T/outside.txt")" != secret ]; then
    why="the symlink target was touched"
  fi
  if [ -z "$why" ]; then ok "$name"; else bad "$name" "$why" "$T/out"; fi
  rm -r -f -- "$T"
done < <(tail -n +3 "$CASES")

echo "# $pass passed, $failed failed"
[ "$failed" = 0 ]
