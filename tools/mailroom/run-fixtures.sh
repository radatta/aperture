#!/bin/bash
# Fixture suite for runner.sh + jobs/: each testdata/jobs.jsonl case runs the real runner against a fresh temp
# .hostjobs, with `curl` and `security` replaced by exported shell functions (no stub files — a process command
# line holding a path ending in the curl name trips COI's Sigma rule; docs/ops/COI-INCIDENTS.md → Incident H).
# `sim` cases stub axe, xcrun, open, pgrep, caffeinate and xcodebuild the same way, answering from a per-case tape
# of {m: argv substring, rc, n: uses (0 = any), out} rules, first match wins; short sleeps return at once. `clip`
# cases stub osascript from the same tape: a JXA read (`-l JavaScript`) that answers 0 writes a PNG to its path argv.
# Bash 3.2 + jq, so it runs in the container (vitest: scripts/src/mailroom/runner-fixtures.test.ts) and on the Mac.
set -uo pipefail
# On the Mac, run as launchd will: Apple's /bin/bash 3.2 and the system tools, not Homebrew's.
if [ "$(uname)" = Darwin ]; then
  export PATH=/usr/bin:/bin:/usr/sbin:/sbin
  [ "${BASH_VERSINFO[0]}" -le 3 ] || exec /bin/bash "$0" "$@"
fi
HERE="$(cd "$(dirname "$0")" && pwd -P)"
# The cases say @DEV_ACCOUNT@ where the dev Cognito host carries the account id (it stays out of tracked files,
# docs/ops/IDENTIFIERS.md): filled here from sim.sh's own pin, so a case's host always matches the runner it tests.
DEV_ACCOUNT="$(sed -n "s/^SIM_COGNITO_RE='^aperture-dev-\([0-9]*\).*/\1/p" "$HERE/jobs/sim.sh")"
[ -n "$DEV_ACCOUNT" ] || { echo "run-fixtures: no SIM_COGNITO_RE pin in jobs/sim.sh" >&2; exit 2; }
# A template under $TMPDIR, as everywhere here: the mktemp wrapper below isn't defined yet (it explains why).
CASES="$(mktemp "${TMPDIR:-/tmp}/rf-cases.XXXXXXXX")" && [ -n "$CASES" ] || { echo "run-fixtures: no temp file for the cases" >&2; exit 2; }
trap 'rm -f -- "$CASES"' EXIT
sed "s/@DEV_ACCOUNT@/$DEV_ACCOUNT/g" "$HERE/testdata/jobs.jsonl" >"$CASES"
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
      -w | --max-time | --max-filesize | --proto-redir) shift 2 ;;
      -L) shift ;;
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
    "find-generic-password -s aperture-devcheck-dev -a devcheck@dev.aperture.rahuldatta.dev")
      [ -z "${MAILROOM_FIXTURE_NO_SIMPW:-}" ] || return 44
      printf 'keychain: item attributes\n' ;;
    "find-generic-password -s aperture-devcheck-dev -a devcheck@dev.aperture.rahuldatta.dev -w")
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
# The JXA read gets its script on stdin (what it may ask is pinned statically); answer from the tape, and on 0 write
# the image to argv's OUT ($4):
# a PNG, or what the answer's "write" names (gif: wrong magic; big: one byte over the 16 MiB cap).
osascript() {
  local out rc=0
  out="$(sim_stub osascript "$@" </dev/null)" || rc=$?
  [ -z "$out" ] || printf '%s\n' "$out"
  if [ "$rc" = 0 ] && [ "${1:-}" = -l ]; then
    case "$out" in
      *'"write":"gif"'*) printf 'GIF89a-fixture' >"$4" ;;
      *'"write":"big"'*) head -c 16777217 /dev/zero >"$4" ;;
      *) printf '\211PNG\r\n\032\nfixture-image' >"$4" ;;
    esac
  fi
  return "$rc"
}
sleep() { if [ "${1%%.*}" -ge 20 ] 2>/dev/null; then command sleep "$1"; fi; }
# macOS mktemp ignores TMPDIR without a template (it asks confstr for the user's temp dir), and under the fixtures
# job's sandbox only $TMPDIR is writable: every temp path here, and in the jobs the cases run, goes under $TMPDIR.
mktemp() {
  local a
  for a in "$@"; do case "$a" in -*) ;; *) command mktemp "$@"; return ;; esac; done
  command mktemp "$@" "${TMPDIR:-/tmp}/rf.XXXXXXXX"
}
export -f curl security sim_stub axe xcrun open pgrep caffeinate xcodebuild osascript sleep mktemp
# A fresh temp dir by its real path, or the suite stops: an unchecked empty one is the cwd (bash 3.2's `cd ""` is a
# no-op), which the caller's cleanup then deletes.
tmpdir_real() { local d; d="$(mktemp -d)" && [ -n "$d" ] && (cd "$d" && pwd -P); }
bail() { echo "Bail out! $1"; exit 1; }

ok() { pass=$((pass + 1)); echo "ok - $1"; }
bad() { failed=$((failed + 1)); echo "not ok - $1: $2"; [ -z "${3:-}" ] || sed 's/^/    /' "$3"; }

base="$(head -1 "$CASES" | jq -c .base)"
simbase="$(head -1 "$CASES" | jq -c .simBase)"
clipbase="$(head -1 "$CASES" | jq -c .clipBase)"
editbase="$(head -1 "$CASES" | jq -c .editBase)"
fxbase="$(head -1 "$CASES" | jq -c .fixturesBase)"
defapi="$(sed -n 2p "$CASES" | jq -c .defaultApi)"
deftape="$(sed -n 2p "$CASES" | jq -c .defaultTape)"

run_shard() { # $1: this shard's index; a case runs here when its index mod MAILROOM_FIXTURE_JOBS is $1
  local ci=0
  while IFS= read -r c; do
  ci=$((ci + 1))
  [ $((ci % MAILROOM_FIXTURE_JOBS)) = "$1" ] || continue
  # Every scalar the harness reads from the case, in one jq: one value per line (the JSON ones are compact, so
  # single-line), read back in order.
  {
    IFS= read -r name; read -r kind; read -r setup; read -r raw; read -r no_token; read -r no_simpw; read -r no_simpw_read
    read -r want_rc; read -r want_left; read -r no_result; read -r calls_type; read -r has_post; read -r has_md; read -r want_pw
    read -r expect_j; read -r want_calls; read -r post_j; read -r md_j; read -r notes_j; read -r lane; read -r locks_j
    read -r has_pb; read -r pb_j; read -r fx_script; read -r sb_fail
  } <<<"$(jq -r '[.name, (.kind // "open-pr"), (.setup // ""), (if has("raw") then "1" else "" end),
    (.noToken // false), (.noSimPassword // false), (.noSimPasswordRead // false), (.exit // 0), (.inboxLeft // 0),
    (.noResult // false), ((.calls // []) | type), has("post"), has("md"), (.pwTyped // 0),
    (.expect | tojson), ((.calls // []) | tojson), (.post | tojson), (.md | tojson), ((.notes // {}) | tojson),
    (.lane // ""), (.locks | tojson), has("patchBody"), (.patchBody | tojson), (.fxScript // "" | @json), (if .sandboxFails then "1" else "" end)] | .[]' <<<"$c")"
  T="$(tmpdir_real)" || bail "no temp dir for $name" # the real path: the runner refuses a .hostjobs that resolves elsewhere
  hj="$T/hj"
  st="$T/state dir" # the Mac's is under Application Support: a space in every state path
  mkdir -p "$hj/inbox" "$hj/results" "$hj/staging" "$st"
  : >"$T/calls"
  : >"$T/simcalls"
  now="$(date +%s)"
  cbase="$base"
  [ "$kind" != sim ] || cbase="$simbase"
  [ "$kind" != clip ] || cbase="$clipbase"
  [ "$kind" != edit-pr ] || cbase="$editbase"
  [ "$kind" != fixtures ] || cbase="$fxbase"
  # The fixtures job runs sandbox-exec and tar by name, through env -i: stub files on PATH, not functions. sandbox-exec
  # records its profile and runs the rest; tar unpacks the case's fxScript as the archive's run-fixtures.sh.
  mkdir "$T/bin"
  printf '%s\n' '#!/bin/bash' 'printf "sandbox-exec %s\n" "$*" >>"$MAILROOM_FIXTURE_SIMCALLS"' \
    'cat "$2" >>"$MAILROOM_FIXTURE_SIMCALLS.sb"' 'shift 2' \
    '[ -z "$MAILROOM_FIXTURE_SB_FAIL" ] || [ "$1" != /usr/bin/true ] || exit 65' 'exec "$@"' >"$T/bin/sandbox-exec"
  printf '%s\n' '#!/bin/bash' 'printf "tar %s\n" "$*" >>"$MAILROOM_FIXTURE_SIMCALLS"' 'd=""' \
    'while [ $# -gt 0 ]; do [ "$1" != -C ] || d="$2"; shift; done' \
    '[ -n "$MAILROOM_FIXTURE_FX" ] || exit 1' 'mkdir -p "$d/tools/mailroom"' \
    'printf "%s" "$MAILROOM_FIXTURE_FX" >"$d/tools/mailroom/run-fixtures.sh"' >"$T/bin/tar"
  chmod +x "$T/bin/sandbox-exec" "$T/bin/tar"

  # The job: base ⊕ patch, minus unset paths, submittedAt relative to now, bodySha256 computed when "auto".
  { IFS= read -r job; read -r id; read -r file; read -r sha_auto; } <<<"$(jq -r --argjson base "$cbase" --argjson now "$now" '. as $c | ($base * ($c.patch // {}))
    | reduce ($c.unset // [])[] as $p (.; delpaths([$p]))
    | if $c.bodyRepeat then .params.body = ($c.bodyRepeat.s * $c.bodyRepeat.n) else . end
    | if .submittedAt == "now" then .submittedAt = (($now - 60 * ($c.submittedAgoMin // 0)) | todate) else . end
    | . as $j | ($j | tojson),
      ((if ($j.id | type) == "string" then $j.id else "20261101T204512Z-mac-mailroom-3kx9" end) as $id | $id, ($c.file // "\($id).json")),
      ($j.params.bodySha256? // "")' <<<"$c")"
  if [ "$sha_auto" = auto ]; then
    job="$(jq -c --arg s "$(jq -j .params.body <<<"$job" | sha256)" '.params.bodySha256 = $s' <<<"$job")"
  fi
  rid="${file%.json}" # results land under the file's stem

  # The API: default routes ⊕ the case's (a null route removes it); an optional near expiry on GET /user.
  jq -c --argjson d "$defapi" --argjson now "$now" '. as $c | ($d * ($c.api // {}))
    | with_entries(select(.value != null))
    | if $c.expiresInDays then .["GET /user"].headers["github-authentication-token-expiration"] =
        (($now + $c.expiresInDays * 86400) | strftime("%Y-%m-%d %H:%M:%S UTC")) else . end' <<<"$c" >"$T/api.json"

  # The tape: the case's rules first, then the defaults; one TAB-separated line per rule.
  jq -r --argjson d "$deftape" '((.tape // []) + $d)[] | [.m, (.rc // 0 | tostring), (.n // 0 | tostring),
    (.out // "" | if type == "string" then . else tojson end)] | join("\t")' <<<"$c" >"$T/tape"

  if [ -n "$raw" ]; then jq -j .raw <<<"$c" >"$hj/staging/x"; else printf '%s' "$job" >"$hj/staging/x"; fi
  case "$setup" in
    symlink) printf 'secret\n' >"$T/outside.txt"; ln -s "$T/outside.txt" "$hj/inbox/$file" ;;
    fifo) mkfifo "$hj/inbox/$file" ;;
    dir) mkdir "$hj/inbox/$file" ;;
    oversize) head -c 80000 /dev/zero | tr '\0' 'a' >"$hj/inbox/$file" ;;
    duplicate) mkdir "$hj/results/$rid"; mv "$hj/staging/x" "$hj/inbox/$file" ;;
    lock) mkdir "$st/lock"; mv "$hj/staging/x" "$hj/inbox/$file" ;;
    stale-lock) mkdir "$st/lock"; touch -t 202001010000 "$st/lock"; mv "$hj/staging/x" "$hj/inbox/$file" ;;
    lock-fast) mkdir "$st/lock-fast"; mv "$hj/staging/x" "$hj/inbox/$file" ;;
    stale-lock-fast) mkdir "$st/lock-fast"; touch -t 202001010000 "$st/lock-fast"; mv "$hj/staging/x" "$hj/inbox/$file" ;;
    aged-lock | aged-lock-fast) # 6 minutes old: past the fast lane's 5-minute rule, inside the slow lane's 15
      l="lock${setup#aged-lock}"
      mkdir "$st/$l"; touch -t "$(jq -nr --argjson t $((now - 360)) '$t | strflocaltime("%Y%m%d%H%M.%S")')" "$st/$l"
      mv "$hj/staging/x" "$hj/inbox/$file" ;;
    mixed) # 6 copies of the case's job, then 2 sims: a lane's cap counts only the entries it takes
      for i in 1 2 3 4 5 6; do jq -c --arg id "${id}-$i" '.id = $id' <<<"$job" >"$hj/inbox/${id}-$i.json"; done
      for i in 1 2; do
        sid="$(jq -r .id <<<"$simbase")-s$i"
        jq -c --arg id "$sid" --argjson now "$now" '.id = $id | .submittedAt = ($now | todate)' <<<"$simbase" >"$hj/inbox/$sid.json"
      done ;;
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
    clip-state=*) # {ago: [seconds before now, one per serve], cc, n} → the clip job's private state; |junk adds junk
      cs="${setup#clip-state=}"
      jq -c --argjson now "$now" --arg junk "${cs##*|}" '{serves: ([.ago[] | $now - .] + if $junk == "junk" then ["9999999999", null, {}] else [] end),
        cc: (if $junk == "junk" then "41" else .cc end), n}' <<<"${cs%%|*}" >"$st/clip.json"
      mv "$hj/staging/x" "$hj/inbox/$file" ;;
    build-y=*) printf '%s\n' "${setup#build-y=}" >"$st/sim-build-y"; mv "$hj/staging/x" "$hj/inbox/$file" ;; # readBuild's last y
    no-tmp) mv "$hj/staging/x" "$hj/inbox/$file" ;; # the runner's TMPDIR is missing (below): mktemp fails
    "") mv "$hj/staging/x" "$hj/inbox/$file" ;;
    *) bad "$name" "unknown setup $setup"; continue ;;
  esac

  (
    [ "$no_token" = true ] && export MAILROOM_FIXTURE_NO_TOKEN=1
    [ "$no_simpw" = true ] && export MAILROOM_FIXTURE_NO_SIMPW=1
    [ "$no_simpw_read" = true ] && export MAILROOM_FIXTURE_NO_SIMPW_READ=1
    [ "$setup" = no-tmp ] && export TMPDIR="$T/no-such-dir"
    PATH="$T/bin:$PATH" MAILROOM_FIXTURE_FX="$(jq -r . <<<"$fx_script")" MAILROOM_FIXTURE_SB_FAIL="$sb_fail" \
      MAILROOM_FIXTURE_API="$T/api.json" MAILROOM_FIXTURE_CALLS="$T/calls" MAILROOM_FIXTURE_TAPE="$T/tape" \
      MAILROOM_FIXTURE_SIMCALLS="$T/simcalls" bash "$HERE/runner.sh" "$hj" "$st" ${lane:+"$lane"}
  ) >"$T/out" 2>&1
  rc=$?

  why=""
  [ "$rc" = "$want_rc" ] || why="runner exited $rc, want $want_rc"
  left="$(find "$hj/inbox/" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')"
  [ -n "$why" ] || [ "$left" = "$want_left" ] || why="$left entries left in the inbox"

  if [ -z "$why" ]; then
    if [ "$no_result" = true ]; then
      found="$(find "$hj/results/" "$T/elsewhere" -name result.json 2>/dev/null | wc -l | tr -d ' ')"
      [ "$found" = 0 ] || why="wrote $found result(s), want none"
    elif [ "$setup" = many ] || [ "$setup" = mixed ]; then
      found="$(find "$hj/results/" -name result.json | wc -l | tr -d ' ')"
      [ "$found" = 5 ] || why="wrote $found results, want 5"
    elif [ ! -f "$hj/results/$rid/result.json" ]; then
      why="no results/$rid/result.json"
    elif ! jq -e --argjson e "$expect_j" '. as $r | $e | to_entries | all(.value == $r[.key])' \
      "$hj/results/$rid/result.json" >/dev/null; then
      why="result $(cat "$hj/results/$rid/result.json") does not match $expect_j"
    fi
  fi

  # Every call: exactly the expected METHOD path list, the token only in the header file, never on argv.
  if [ -z "$why" ] && [ "$calls_type" = array ]; then
    got="$(cut -d' ' -f1,2 "$T/calls" | jq -Rsc 'split("\n") | map(select(. != ""))')"
    want="$want_calls"
    [ "$got" = "$want" ] || why="calls $got, want $want"
    if grep -qv ' auth=ok leak=0$' "$T/calls"; then why="a call without the header-file token, or with it on argv"; fi
  fi
  # The exact request body of a call: "post" for POST …/pulls, "md" for POST /markdown, "patchBody" for edit-pr's PATCH.
  for k in post md pb; do
    case "$k" in
      post) has="$has_post"; body_j="$post_j"; route='^POST /repos/radatta/aperture/pulls ' ;;
      md) has="$has_md"; body_j="$md_j"; route='^POST /markdown ' ;;
      pb) has="$has_pb"; body_j="$pb_j"; route='^PATCH /repos/radatta/aperture/pulls/' ;;
    esac
    [ -z "$why" ] && [ "$has" = true ] || continue
    idx="$(grep -n "$route" "$T/calls" | head -1 | cut -d: -f1)"
    sent="$( [ -z "$idx" ] || cat "$T/calls.$((idx - 1)).data" 2>/dev/null || true)"
    jq -e --argjson p "$body_j" '. == $p' <<<"$sent" >/dev/null 2>&1 || why="$k body ${sent:-not sent}"
  done
  # The lock dirs the run left: a lane releases only its own.
  if [ -z "$why" ] && [ "$locks_j" != null ]; then
    got="$(cd "$st" && find . -mindepth 1 -maxdepth 1 -name 'lock*' -type d | sed 's|^\./||' | sort | jq -Rsc 'split("\n") | map(select(. != ""))')"
    [ "$got" = "$(jq -c 'sort' <<<"$locks_j")" ] || why="locks left $got, want $locks_j"
  fi
  # A failed mktemp must never leave the job working in (and then deleting) the runner's cwd, the inbox.
  if [ -z "$why" ] && [ "$setup" = no-tmp ] && [ ! -d "$hj/inbox" ]; then why="the inbox was deleted"; fi
  if [ -z "$why" ] && [ "$setup" = hardlink ] && [ ! -f "$hj/staging/mine" ]; then why="the hard-linked original went missing"; fi
  if [ -z "$why" ] && grep -rq -e "$MAILROOM_FIXTURE_TOKEN" -e BODYMARK -e "$MAILROOM_FIXTURE_PW" "$T/out" "$hj/results/" 2>/dev/null; then
    why="the token, the test user's password or body text reached the log or a result"
  fi
  # A step's note, by step index: what the job says to whoever reads its result.
  if [ -z "$why" ] && [ "$notes_j" != "{}" ]; then
    jq -e --argjson n "$notes_j" '.steps as $s | $n | to_entries | all(.value as $v | ($s[.key | tonumber].note // "") | contains($v))' \
      "$hj/results/$rid/result.json" >/dev/null 2>&1 || why="a step note isn't $notes_j"
  fi
  # sim cases: tool calls in order (substrings), calls that must not happen, password reads/typings, artifacts.
  if [ -z "$why" ] && { [ "$kind" = sim ] || [ "$kind" = clip ] || [ "$kind" = fixtures ]; }; then
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
  # fixtures cases: lines the sandbox profile must hold, and the log tail the job kept.
  if [ -z "$why" ] && [ "$kind" = fixtures ]; then
    while IFS= read -r want; do
      [ -z "$why" ] && [ -n "$want" ] || continue
      grep -q -F -x -- "$want" "$T/simcalls.sb" 2>/dev/null || why="the profile has no line \"$want\""
    done < <(jq -r '.sbIncludes // [] | .[]' <<<"$c")
    while IFS= read -r want; do
      [ -z "$why" ] && [ -n "$want" ] || continue
      grep -q -F -- "$want" "$hj/results/$rid/fixtures.log" 2>/dev/null || why="fixtures.log lacks \"$want\""
    done < <(jq -r '.logIncludes // [] | .[]' <<<"$c")
    while IFS= read -r nope; do
      [ -z "$why" ] && [ -n "$nope" ] || continue
      if grep -q -F -- "$nope" "$hj/results/$rid/fixtures.log" 2>/dev/null; then why="fixtures.log holds \"$nope\""; fi
    done < <(jq -r '.logExcludes // [] | .[]' <<<"$c")
  fi
  # clip cases: the private state after the run ({cc, n, serves: how many}). What the JXA may ask the pasteboard is
  # pinned statically (runner-fixtures.test.ts).
  if [ -z "$why" ] && [ "$kind" = clip ]; then
    cs="$(jq -c '.clipState // empty' <<<"$c")"
    if [ -n "$cs" ] && ! jq -e --argjson e "$cs" '{cc, n, serves: (.serves | length)} == $e' "$st/clip.json" >/dev/null 2>&1; then
      why="clip state $(cat "$st/clip.json" 2>/dev/null || echo missing), want $cs"
    fi
  fi
  if [ -z "$why" ] && [ "$setup" = symlink ] && [ "$(cat "$T/outside.txt")" != secret ]; then
    why="the symlink target was touched"
  fi
  if [ -z "$why" ]; then ok "$name"; else bad "$name" "$why" "$T/out"; fi
  rm -r -f -- "$T"
  done < <(tail -n +3 "$CASES")
}
# Up to 4 shards, never more than the machine has cores: no gain past that, and CI's other tests share its two.
if [ -z "${MAILROOM_FIXTURE_JOBS:-}" ]; then
  MAILROOM_FIXTURE_JOBS="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1)"
  [ "$MAILROOM_FIXTURE_JOBS" -le 4 ] 2>/dev/null || MAILROOM_FIXTURE_JOBS=4
fi
OUTD="$(tmpdir_real)" || bail "no temp dir for the shards"
trap 'rm -r -f -- "$OUTD" "$CASES"' EXIT
s=0
while [ "$s" -lt "$MAILROOM_FIXTURE_JOBS" ]; do
  run_shard "$s" >"$OUTD/$s" 2>&1 &
  s=$((s + 1))
done
wait
s=0
while [ "$s" -lt "$MAILROOM_FIXTURE_JOBS" ]; do cat "$OUTD/$s"; s=$((s + 1)); done
pass="$(cat "$OUTD"/* | grep -c '^ok - ' || true)"
failed="$(cat "$OUTD"/* | grep -c '^not ok - ' || true)"

# sim_cap kills a command that outlives its cap (the sim job's only guard against a hung axe/simctl/security).
(
  . "$HERE/jobs/sim.sh"
  started=$(date +%s)
  sim_cap 1 command sleep 30
  rc=$?
  [ "$rc" = 124 ] && [ $(($(date +%s) - started)) -lt 10 ]
) && ok "sim_cap kills a command at its cap" || bad "sim_cap kills a command at its cap" "it did not return 124 promptly"

# fx_cap kills the fixtures suite's whole tree at its cap (the suite backgrounds its shards), not just its parent.
# Its tree ignores TERM (KILL can't be), and a child it leaves behind after a normal exit is killed with the group.
(
  unset -f pgrep sleep
  . "$HERE/jobs/fixtures.sh"
  STATE="$(tmpdir_real)" || exit 1 # the cap touches the drain's locks: never ./lock in the caller's directory
  trap 'rm -r -f -- "$STATE" ${f:+"$f"}' EXIT
  HELD=" lock"
  f="$(mktemp)" && [ -n "$f" ] || exit 1
  tree() { trap '' TERM; command sleep 30 & echo $! >"$f"; command sleep 30; }
  started=$(date +%s)
  fx_cap 1 tree
  rc=$?
  command sleep 0.2
  [ "$rc" = 124 ] && [ $(($(date +%s) - started)) -lt 10 ] && ! kill -0 "$(cat "$f")" 2>/dev/null || exit 1
  left() { command sleep 30 & echo $! >"$f"; }
  fx_cap 5 left
  rc=$?
  command sleep 0.2
  [ "$rc" = 0 ] && ! kill -0 "$(cat "$f")" 2>/dev/null && [ ! -e ./lock ] && [ -e "$STATE/lock" ] || exit 1
  # As the runner calls it: inside a command substitution (run_<job>'s), where bash 3.2 must still make the group.
  out="$(fx_cap 1 tree >/dev/null 2>&1; echo "$?")"
  command sleep 0.2
  [ "$out" = 124 ] && ! kill -0 "$(cat "$f")" 2>/dev/null
) && ok "fx_cap kills a command's whole tree at its cap, and its leftovers after a normal exit" || bad "fx_cap kills a command's whole tree at its cap, and its leftovers after a normal exit" "a wrong code, a slow return, or a child survived"

# Lanes, for real: a slow drain inside a 20 s sim op, a second slow drain, and a fast drain beside it — as launchd's
# two agents would run them.
lanes_check() {
  local L hj st now a b cl pa i rc
  L="$(tmpdir_real)" || bail "no temp dir for the lanes checks"
  hj="$L/hj"; st="$L/state dir"
  mkdir -p "$hj/inbox" "$hj/results" "$hj/staging" "$st"
  : >"$L/calls"; : >"$L/simcalls"
  printf '%s' "$defapi" >"$L/api.json"
  { printf '%s\t0\t0\t%s\n' '-l JavaScript - ' '{"cc":41,"front":"com.googlecode.iterm2","source":"png","bytes":21}'
    jq -r '.[] | [.m, (.rc // 0 | tostring), (.n // 0 | tostring), (.out // "" | if type == "string" then . else tojson end)] | join("\t")' <<<"$deftape"
  } >"$L/tape"
  lane_run() {
    MAILROOM_FIXTURE_API="$L/api.json" MAILROOM_FIXTURE_CALLS="$L/calls" MAILROOM_FIXTURE_TAPE="$L/tape" \
      MAILROOM_FIXTURE_SIMCALLS="$L/simcalls" bash "$HERE/runner.sh" "$hj" "$st" "$1" >>"$L/out" 2>&1
  }
  now="$(date +%s)"
  a="20261113T230000Z-ios-lane-aa01"; b="20261113T230001Z-ios-lane-bb02"; cl="20261113T230002Z-clip-cc03"
  jq -c --arg id "$a" --argjson now "$now" '.id = $id | .submittedAt = ($now | todate) | .params.steps = [{"op": "wait", "s": 20}]' <<<"$simbase" >"$hj/inbox/$a.json"
  lane_run slow &
  pa=$!
  for i in $(seq 1 150); do [ -d "$hj/results/$a" ] && break; command sleep 0.1; done
  [ -d "$hj/results/$a" ] || { bad "lanes: a slow drain takes the sim" "results/$a never appeared" "$L/out"; wait "$pa"; return; }
  jq -c --arg id "$b" --argjson now "$now" '.id = $id | .submittedAt = ($now | todate)' <<<"$simbase" >"$hj/inbox/$b.json"
  lane_run slow; rc=$?
  if [ "$rc" = 0 ] && [ -f "$hj/inbox/$b.json" ] && [ ! -e "$hj/results/$b" ]; then
    ok "lanes: a second slow drain leaves the next sim queued while one runs"
  else bad "lanes: a second slow drain leaves the next sim queued while one runs" "rc $rc, inbox: $(ls "$hj/inbox")" "$L/out"; fi
  # The container re-sends the running sim's id as a clip: its name is the slow lane's, so the fast lane leaves it (the
  # slow lane later finds results/<id> and runs nothing), and the slow lane's private snapshot is untouched.
  jq -c --arg id "$a" --argjson now "$now" '.id = $id | .submittedAt = ($now | todate)' <<<"$clipbase" >"$hj/inbox/$a.json"
  lane_run fast
  if [ -f "$st/work-slow/$a.json" ] && [ -f "$hj/inbox/$a.json" ] && [ ! -e "$hj/results/$a/result.json" ]; then
    ok "lanes: a fast drain leaves a sim-named entry alone and never touches the slow lane's private snapshot"
  else bad "lanes: a fast drain leaves a sim-named entry alone and never touches the slow lane's private snapshot" "work-slow: $(ls "$st/work-slow" 2>/dev/null | tr '\n' ' '), inbox: $(ls "$hj/inbox" | tr '\n' ' ')" "$L/out"; fi
  jq -c --arg id "$cl" --argjson now "$now" '.id = $id | .submittedAt = ($now | todate)' <<<"$clipbase" >"$hj/inbox/$cl.json"
  lane_run fast
  if [ "$(jq -r .status "$hj/results/$cl/result.json" 2>/dev/null)" = served ] && [ ! -e "$hj/results/$a/result.json" ] &&
    [ -d "$st/lock" ] && [ ! -e "$st/lock-fast" ] && [ -f "$hj/inbox/$b.json" ]; then
    ok "lanes: a clip is served while the sim runs, and the sim stays queued"
  else bad "lanes: a clip is served while the sim runs, and the sim stays queued" "clip $(cat "$hj/results/$cl/result.json" 2>/dev/null), sim result $([ -e "$hj/results/$a/result.json" ] && echo early || echo none)" "$L/out"; fi
  wait "$pa"
  lane_run slow
  if [ "$(jq -r .status "$hj/results/$a/result.json" 2>/dev/null)" = pass ] && [ -f "$hj/results/$b/result.json" ] &&
    [ -z "$(ls -A "$hj/inbox")" ] && grep -q "$a DUPLICATE" "$L/out" &&
    [ -z "$(find "$st" -mindepth 1 -maxdepth 1 -name 'lock*')" ]; then
    ok "lanes: once the sim ends, the next slow drain takes the queued one, refuses the re-sent id, and both locks are gone"
  else bad "lanes: once the sim ends, the next slow drain takes the queued one, refuses the re-sent id, and both locks are gone" "a $(jq -c '{status, reason, detail}' "$hj/results/$a/result.json" 2>/dev/null), b $([ -f "$hj/results/$b/result.json" ] && echo done || echo none)" "$L/out"; fi
  rm -r -f -- "$L"

  # Both agents fire on one drop: a slow and a fast drain start together on the same sim entry, 10 times. Exactly one
  # takes it (the slow), it passes, nothing is parked or refused, and the fast drain never touches it.
  local k fails=""
  for k in 1 2 3 4 5 6 7 8 9 10; do
    L="$(tmpdir_real)" || bail "no temp dir for the lanes race"
    hj="$L/hj"; st="$L/state dir"
    mkdir -p "$hj/inbox" "$hj/results" "$hj/staging" "$st"
    : >"$L/calls"; : >"$L/simcalls"
    printf '%s' "$defapi" >"$L/api.json"
    jq -r '.[] | [.m, (.rc // 0 | tostring), (.n // 0 | tostring), (.out // "" | if type == "string" then . else tojson end)] | join("\t")' <<<"$deftape" >"$L/tape"
    a="20261113T230010Z-ios-race-$k"
    jq -c --arg id "$a" --argjson now "$now" '.id = $id | .submittedAt = ($now | todate) | .params.steps = [{"op": "wait", "s": 1}]' <<<"$simbase" >"$hj/inbox/$a.json"
    lane_run slow &
    pa=$!
    lane_run fast
    wait "$pa"
    if [ "$(jq -r .status "$hj/results/$a/result.json" 2>/dev/null)" != pass ] || [ -n "$(ls -A "$st/rejected" 2>/dev/null)" ] ||
      [ -n "$(ls -A "$hj/inbox")" ] || [ "$(find "$hj/results" -name result.json | wc -l | tr -d ' ')" != 1 ] ||
      grep -q 'could not be moved out' "$L/out"; then # a vanished entry is skipped, never chased
      fails="$fails $k"
      sed 's/^/    /' "$L/out"
    fi
    rm -r -f -- "$L"
  done
  if [ -z "$fails" ]; then ok "lanes: slow and fast drains started together on one sim: only the slow takes it (10 runs)"
  else bad "lanes: slow and fast drains started together on one sim: only the slow takes it (10 runs)" "failed runs:$fails"; fi
}
lanes_check
LANES_CHECKS=6 # five lanes checks, plus fx_cap

cases="$(($(wc -l <"$CASES" | tr -d ' ') - 2 + 1 + LANES_CHECKS))"
echo "# $pass passed, $failed failed, of $cases cases"
[ "$failed" = 0 ] && [ "$pass" = "$cases" ] # a harness that ran nothing must not pass
