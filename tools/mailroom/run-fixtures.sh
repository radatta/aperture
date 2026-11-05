#!/bin/bash
# Fixture suite for runner.sh + jobs/: each testdata/jobs.jsonl case runs the real runner against a fresh temp
# .hostjobs, with `curl` and `security` replaced by exported shell functions (no stub files — a process command
# line holding a path ending in the curl name trips COI's Sigma rule; docs/ops/COI-INCIDENTS.md → Incident H).
# `sim` cases stub axe, xcrun, open, pgrep, caffeinate and xcodebuild the same way, answering from a per-case tape
# of {m: argv substring, rc, n: uses (0 = any), out} rules, first match wins; short sleeps return at once.
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
export MAILROOM_FIXTURE_PW="FIXTUREPW-9d41"
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
  case "$*" in
    "find-generic-password -s aperture-mailroom-gh -w")
      [ -z "${MAILROOM_FIXTURE_NO_TOKEN:-}" ] || return 44
      printf '%s\n' "$MAILROOM_FIXTURE_TOKEN" ;;
    "find-generic-password -s aperture-devcheck-dev -a rahul3datta+devcheck@gmail.com")
      [ -z "${MAILROOM_FIXTURE_NO_SIMPW:-}" ] || return 44
      printf 'keychain: item attributes\n' ;;
    "find-generic-password -s aperture-devcheck-dev -a rahul3datta+devcheck@gmail.com -w")
      [ -z "${MAILROOM_FIXTURE_NO_SIMPW:-}" ] || return 44
      [ -z "${MAILROOM_FIXTURE_NO_SIMPW_READ:-}" ] || return 44
      printf 'read\n' >>"$MAILROOM_FIXTURE_SIMCALLS.pw"
      printf '%s\n' "$MAILROOM_FIXTURE_PW" ;;
    *) echo "security stub: unexpected $*" >&2; return 2 ;;
  esac
}
# One tape answer: record the call (stdin too, for `type --stdin`), make a screenshot's file, then the first rule
# whose substring is in the argv and still has uses left; an unmatched point read is an empty group.
sim_stub() {
  local argv="$*" idx=0 m rc n out cnt o=""
  if [ "$1 ${2:-} ${3:-}" = "axe type --stdin" ]; then
    printf '%s <<<%s\n' "$argv" "$(cat)" >>"$MAILROOM_FIXTURE_SIMCALLS"
  else
    printf '%s\n' "$argv" >>"$MAILROOM_FIXTURE_SIMCALLS"
  fi
  if [ "$1 ${2:-}" = "axe screenshot" ]; then
    while [ $# -gt 0 ]; do [ "$1" != --output ] || o="${2:-}"; shift; done
    [ -z "$o" ] || printf 'PNG' >"$o"
  fi
  while IFS=$'\t' read -r m rc n out; do
    idx=$((idx + 1))
    case "$argv" in *"$m"*) ;; *) continue ;; esac
    if [ "$n" != 0 ]; then
      cnt="$(cat "$MAILROOM_FIXTURE_TAPE.c$idx" 2>/dev/null || echo 0)"
      [ "$cnt" -lt "$n" ] || continue
      echo $((cnt + 1)) >"$MAILROOM_FIXTURE_TAPE.c$idx"
    fi
    [ -z "$out" ] || printf '%s\n' "$out"
    return "$rc"
  done <"$MAILROOM_FIXTURE_TAPE"
  case "$argv" in *"describe-ui --point"*) printf '%s\n' '{"role":"AXGroup","AXLabel":"","AXValue":"","frame":{"x":0,"y":0,"width":402,"height":874}}' ;; esac
  return 0
}
axe() { sim_stub axe "$@"; }
xcrun() { sim_stub xcrun "$@"; }
open() { sim_stub open "$@"; }
pgrep() { sim_stub pgrep "$@"; }
caffeinate() { sim_stub caffeinate "$@"; }
xcodebuild() { sim_stub xcodebuild "$@"; }
sleep() { if [ "${1%%.*}" -ge 20 ] 2>/dev/null; then command sleep "$1"; fi; }
export -f curl security sim_stub axe xcrun open pgrep caffeinate xcodebuild sleep

ok() { pass=$((pass + 1)); echo "ok - $1"; }
bad() { failed=$((failed + 1)); echo "not ok - $1: $2"; [ -z "${3:-}" ] || sed 's/^/    /' "$3"; }

base="$(head -1 "$CASES" | jq -c .base)"
simbase="$(head -1 "$CASES" | jq -c .simBase)"
defapi="$(sed -n 2p "$CASES" | jq -c .defaultApi)"
deftape="$(sed -n 2p "$CASES" | jq -c .defaultTape)"

while IFS= read -r c; do
  name="$(jq -r .name <<<"$c")"
  T="$(cd "$(mktemp -d)" && pwd -P)" # the real path: the runner refuses a .hostjobs that resolves elsewhere
  hj="$T/hj"
  st="$T/state"
  mkdir -p "$hj/inbox" "$hj/results" "$hj/staging" "$st"
  : >"$T/calls"
  : >"$T/simcalls"
  now="$(date +%s)"
  kind="$(jq -r '.kind // "open-pr"' <<<"$c")"
  cbase="$base"
  [ "$kind" != sim ] || cbase="$simbase"

  # The job: base ⊕ patch, minus unset paths, submittedAt relative to now, bodySha256 computed when "auto".
  job="$(jq -c --argjson base "$cbase" --argjson now "$now" '. as $c | ($base * ($c.patch // {}))
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

  # The tape: the case's rules first, then the defaults; one TAB-separated line per rule.
  jq -r --argjson d "$deftape" '((.tape // []) + $d)[] | [.m, (.rc // 0 | tostring), (.n // 0 | tostring),
    (.out // "" | if type == "string" then . else tojson end)] | join("\t")' <<<"$c" >"$T/tape"

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
    parent-symlink)
      mkdir "$T/realparent"; mv "$hj" "$T/realparent/hj"; ln -s "$T/realparent" "$T/lnk"; hj="$T/lnk/hj"
      mv "$hj/staging/x" "$hj/inbox/$file" ;;
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
    [ "$(jq -r '.noSimPassword // false' <<<"$c")" = true ] && export MAILROOM_FIXTURE_NO_SIMPW=1
    [ "$(jq -r '.noSimPasswordRead // false' <<<"$c")" = true ] && export MAILROOM_FIXTURE_NO_SIMPW_READ=1
    MAILROOM_FIXTURE_API="$T/api.json" MAILROOM_FIXTURE_CALLS="$T/calls" MAILROOM_FIXTURE_TAPE="$T/tape" \
      MAILROOM_FIXTURE_SIMCALLS="$T/simcalls" bash "$HERE/runner.sh" "$hj" "$st"
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
  if [ -z "$why" ] && grep -rq -e "$MAILROOM_FIXTURE_TOKEN" -e BODYMARK -e "$MAILROOM_FIXTURE_PW" "$T/out" "$hj/results/" 2>/dev/null; then
    why="the token, the test user's password or body text reached the log or a result"
  fi
  # sim cases: tool calls in order (substrings), calls that must not happen, password reads/typings, artifacts.
  if [ -z "$why" ] && [ "$kind" = sim ]; then
    last=0
    while IFS= read -r want; do
      [ -n "$want" ] || continue
      ln="$(tail -n +$((last + 1)) "$T/simcalls" | grep -n -F -- "$want" | head -1 | cut -d: -f1)"
      if [ -z "$ln" ]; then why="no call matching \"$want\" (in order)"; break; fi
      last=$((last + ln))
    done < <(jq -r '.simIncludes // [] | .[]' <<<"$c")
    while IFS= read -r nope; do
      [ -z "$why" ] && [ -n "$nope" ] || continue
      if grep -q -F -- "$nope" "$T/simcalls"; then why="an unwanted call: \"$nope\""; fi
    done < <(jq -r '.simExcludes // [] | .[]' <<<"$c")
    while IFS=$'\t' read -r want cnt; do
      [ -z "$why" ] && [ -n "$want" ] || continue
      [ "$(grep -c -F -- "$want" "$T/simcalls" || true)" = "$cnt" ] || why="\"$want\" not called $cnt times"
    done < <(jq -r '.simCount // {} | to_entries[] | [.key, (.value | tostring)] | @tsv' <<<"$c")
    typed="$(grep -c -F -- "<<<$MAILROOM_FIXTURE_PW" "$T/simcalls" || true)"
    reads=0
    [ ! -f "$T/simcalls.pw" ] || reads="$(wc -l <"$T/simcalls.pw" | tr -d ' ')"
    want_pw="$(jq -r '.pwTyped // 0' <<<"$c")"
    [ -n "$why" ] || [ "$typed" = "$want_pw" ] || why="the password was typed $typed times, want $want_pw"
    [ -n "$why" ] || [ "${reads:-0}" = "$want_pw" ] || why="the password was read ${reads:-0} times, want $want_pw"
    if [ -z "$why" ] && [ "$(grep -v -F -- "<<<$MAILROOM_FIXTURE_PW" "$T/simcalls" | grep -c -F -- "$MAILROOM_FIXTURE_PW")" != 0 ]; then
      why="the password reached a tool's argv"
    fi
    while IFS= read -r f; do
      [ -z "$why" ] && [ -n "$f" ] || continue
      [ -f "$hj/results/$rid/$f" ] || why="no results/$rid/$f"
    done < <(jq -r '.files // [] | .[]' <<<"$c")
  fi
  if [ -z "$why" ] && [ "$setup" = symlink ] && [ "$(cat "$T/outside.txt")" != secret ]; then
    why="the symlink target was touched"
  fi
  if [ -z "$why" ]; then ok "$name"; else bad "$name" "$why" "$T/out"; fi
  rm -r -f -- "$T"
done < <(tail -n +3 "$CASES")

# sim_cap kills a command that outlives its cap (the sim job's only guard against a hung axe/simctl/security).
(
  . "$HERE/jobs/sim.sh"
  started=$(date +%s)
  sim_cap 1 command sleep 30
  rc=$?
  [ "$rc" = 124 ] && [ $(($(date +%s) - started)) -lt 10 ]
) && ok "sim_cap kills a command at its cap" || bad "sim_cap kills a command at its cap" "it did not return 124 promptly"

cases="$(($(wc -l <"$CASES" | tr -d ' ') - 2 + 1))"
echo "# $pass passed, $failed failed, of $cases cases"
[ "$failed" = 0 ] && [ "$pass" = "$cases" ] # a harness that ran nothing must not pass
