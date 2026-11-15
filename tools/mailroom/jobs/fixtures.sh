# shellcheck shell=bash
# The `fixtures` job: run a pushed commit's mailroom fixture suite (tools/mailroom/run-fixtures.sh) on the Mac, under
# its bash 3.2, before a tools/mailroom/ branch's trial, in place of the user pasting the line. Params: {sha}.
#   GET /user (mr_whoami) · GET …/compare/main...<sha> (refused if it touches install.sh or the plist template, or the
#   list is cut at 300 files) · GET …/tarball/<sha> (followed to GitHub's archive host) — no write.
# This is the one job that runs code that isn't merged main: bot-pushed, unreviewed bash. So it runs under
# sandbox-exec with no network, writes only to its own temp dir, no reads under /Users or the Keychain, and a clean
# environment; and it's capped (FX_TIMEOUT) with its whole process tree killed at the cap. The slow lane runs it
# (SLOW_JOBS): it takes minutes. Design: docs/ops/MAILROOM.md → The fixtures job.

FX_TIMEOUT=600 # seconds for the suite, after the fetch
FX_MAX_FAILING=20 # failing case names carried in the result
FX_LOG_LINES=400 # the log tail kept in the result dir
FX_INSTALL_RE='^tools/mailroom/(install\.sh|[^/]*\.plist\.tmpl)$' # what a fixtures run may never come from

validate_fixtures() {
  jq -r 'try (.params as $p
    | if ($p | type) != "object" or ($p | keys) != ["sha"] then "BAD_PARAM"
      elif ($p.sha | type) != "string" or ($p.sha | contains("\n")) or ($p.sha | test("^[0-9a-f]{40}$") | not) then "BAD_PARAM"
      else empty end) catch "BAD_PARAM"' "$1" 2>/dev/null || printf 'BAD_PARAM'
}

# fx_cap SECONDS CMD… — run CMD in its own process group, touching the drain's locks as it goes. Past the cap the whole
# group is stopped, then killed (a TERM can be ignored; KILL can't), and 124 is returned. After a normal exit the group
# is killed too, so nothing the suite backgrounded outlives it. The wait for the dead group is bounded.
fx_cap() {
  local cap="$1" pid end l rc=0 i
  shift
  set -m
  "$@" &
  pid=$!
  set +m
  end=$(($(date +%s) + cap))
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$(date +%s)" -ge "$end" ]; then
      kill -STOP -- "-$pid" 2>/dev/null || true
      kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
      for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
      wait "$pid" 2>/dev/null || true
      return 124
    fi
    for l in ${HELD:-lock}; do touch "${STATE:-.}/$l" 2>/dev/null || true; done
    sleep 1
  done
  wait "$pid" || rc=$?
  kill -KILL -- "-$pid" 2>/dev/null || true
  return "$rc"
}

# The profile: everything else stays allowed (Apple's tools run as usual), then network, writes, home-folder reads, the
# Keychain and the services that would run work outside the sandbox are taken away. Later rules win in SBPL. $1 is the
# run's real temp dir, checked to need no quoting. The suite stubs every tool it drives, so it needs none of these.
fx_profile() {
  printf '%s\n' '(version 1)' '(allow default)' '(deny network*)' '(deny file-write*)' \
    "(allow file-write* (subpath \"$1\") (literal \"/dev/null\") (literal \"/dev/zero\") (literal \"/dev/dtracehelper\") (regex #\"^/dev/fd/\"))" \
    '(deny file-read* (subpath "/Users") (subpath "/Volumes") (subpath "/System/Volumes/Data/Users"))' \
    '(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd") (global-name "com.apple.security.agent"))' \
    '(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd") (global-name "com.apple.lsd.mapdb") (global-name "com.apple.lsd.modifydb") (global-name "com.apple.coreservices.appleevents") (global-name "com.apple.pasteboard.1") (global-name "com.apple.CoreSimulator.CoreSimulatorService"))' \
    '(deny appleevent-send)' '(deny job-creation)' \
    '(deny process-exec (literal "/usr/bin/security") (literal "/usr/bin/open") (literal "/usr/bin/osascript") (literal "/bin/launchctl") (literal "/usr/bin/pbpaste") (literal "/usr/bin/pbcopy") (literal "/usr/bin/xcrun") (literal "/usr/bin/defaults"))'
}

# The two sandboxed steps, each in $t (the inbox is under /Users, which the profile can't read) with a file-size limit
# (ulimit -f, 512-byte blocks: 1 GiB), so a commit of compressible files can't fill the Mac's disk.
fx_unpack() { (cd "$1" && ulimit -f 2097152 && exec sandbox-exec -f "$MR_P.sb" tar -xzf "$1/src.tgz" -C "$1/src" --strip-components 1); }
fx_suite() {
  (cd "$1" && ulimit -f 2097152 && exec sandbox-exec -f "$MR_P.sb" /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin \
    HOME="$1/home" TMPDIR="$1/tmp" LC_ALL=C /bin/bash "$1/src/tools/mailroom/run-fixtures.sh")
}

run_fixtures() {
  local w="$1" rd="$3" sha fail n bad t rc out
  MR_P="$2"
  MR_EXPIRY_JSON='{}'
  MR_BODY_SHA=""
  sha="$(jq -r .params.sha "$w")"
  if ! command -v sandbox-exec >/dev/null 2>&1; then printf 'error SANDBOX_MISSING {}\n'; return 0; fi

  mr_whoami || return 0

  mr_call GET "/repos/$MR_REPO/compare/main...$sha"
  if [ "$MR_RC" = 0 ] && [ "$MR_HTTP" = 404 ]; then mr_emit rejected HEAD_MISSING; return 0; fi
  fail="$(mr_failure 200)"
  if [ -n "$fail" ]; then mr_emit "$(status_of "$fail")" "$fail"; return 0; fi
  n="$(jq -r 'if (.files | type) == "array" then (.files | length) else "x" end' "$MR_P.resp" 2>/dev/null || echo x)"
  if [ "$n" = x ]; then mr_emit error API_FAILED; return 0; fi
  if [ "$n" -ge 300 ]; then mr_emit rejected DIFF_TOO_LARGE; return 0; fi # GitHub cuts the list at 300
  bad="$(jq -r --arg re "$FX_INSTALL_RE" '[.files[] | .filename, (.previous_filename // empty)] | map(select(test($re))) | length' "$MR_P.resp" 2>/dev/null || echo x)"
  if [ "$bad" != 0 ]; then mr_emit rejected TOUCHES_INSTALL; return 0; fi

  MR_FOLLOW=1 MR_MAX_TIME=120 mr_call GET "/repos/$MR_REPO/tarball/$sha"
  fail="$(mr_failure 200)"
  if [ -n "$fail" ]; then mr_emit "$(status_of "$fail")" "$fail"; return 0; fi

  # A fresh dir outside the shared folder, by its real path (the profile matches resolved paths: /private/var/…).
  t="$(cd "$(mktemp -d)" && pwd -P)" || { mr_emit error API_FAILED; return 0; }
  if ! [[ "$t" =~ ^/[A-Za-z0-9/._-]+$ ]]; then rm -r -f -- "$t"; mr_emit error API_FAILED; return 0; fi
  mkdir -p "$t/src" "$t/home" "$t/tmp"
  fx_profile "$t" >"$MR_P.sb"
  # A profile this macOS won't compile (or no working sandbox) is its own code, so a first trial can tell it apart.
  if ! (cd "$t" && sandbox-exec -f "$MR_P.sb" /usr/bin/true) >/dev/null 2>&1; then
    rm -r -f -- "$t"
    mr_emit error SANDBOX_FAILED
    return 0
  fi
  # The state dir is under /Users, which the sandbox can't read, so the archive moves into $t first.
  mv -- "$MR_P.resp" "$t/src.tgz"
  if ! fx_cap 120 fx_unpack "$t" >/dev/null 2>&1 || [ ! -f "$t/src/tools/mailroom/run-fixtures.sh" ]; then
    rm -r -f -- "$t"
    mr_emit error API_FAILED
    return 0
  fi

  # The output goes to a file the runner made outside $t (its work dir, under /Users: the sandbox can neither open nor
  # replace it), and nothing below reads a path inside $t, which the suite controls.
  rc=0
  fx_cap "$FX_TIMEOUT" fx_suite "$t" >"$MR_P.out" 2>&1 </dev/null || rc=$?
  rm -r -f -- "$t"
  # The log tail, printable ASCII only, written as results are: a pinned cwd, noclobber, never through a planted link.
  tail -n "$FX_LOG_LINES" "$MR_P.out" | LC_ALL=C tr -cd '\11\12\40-\176' >"$MR_P.log" 2>/dev/null || true
  (
    cd "$rd" && [ "$(pwd -P)" = "$rd" ] || exit 1
    set -C
    cat -- "$MR_P.log" >./fixtures.log
  ) 2>/dev/null || true
  out="$(jq -Rsc --argjson max "$FX_MAX_FAILING" 'split("\n") as $l
    | ([$l[] | capture("^# (?<p>[0-9]+) passed, (?<f>[0-9]+) failed, of (?<c>[0-9]+) cases$")] | last) as $sum
    | {passed: ($sum.p // null | if . then tonumber else null end), failed: ($sum.f // null | if . then tonumber else null end),
       cases: ($sum.c // null | if . then tonumber else null end),
       failing: [$l[] | select(startswith("not ok - ")) | .[9:] | gsub("[^A-Za-z0-9 ._:,()/+-]"; "?") | .[0:120]][0:$max]}' "$MR_P.out" 2>/dev/null || echo '{}')"
  if [ "$rc" = 124 ]; then printf 'error TIMEOUT %s\n' "$(jq -c '{fixtures: .}' <<<"$out")"; return 0; fi
  if [ "$rc" = 0 ] && jq -e '.failed == 0 and .passed != null and .passed == .cases and .passed > 0' <<<"$out" >/dev/null 2>&1; then
    printf 'pass - %s\n' "$(jq -c '{fixtures: .}' <<<"$out")"
  else
    printf 'fail FIXTURES_FAILED %s\n' "$(jq -c --argjson rc "$rc" '{fixtures: (. + {exit: $rc})}' <<<"$out")"
  fi
}
