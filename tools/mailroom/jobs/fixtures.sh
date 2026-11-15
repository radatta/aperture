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

# fx_kill_tree PID — TERM a process and everything under it (the suite backgrounds its shards).
fx_kill_tree() {
  local c
  for c in $(pgrep -P "$1" 2>/dev/null); do fx_kill_tree "$c"; done
  kill -TERM "$1" 2>/dev/null || true
}

# fx_cap SECONDS CMD… — run CMD, touching the drain's locks as it goes; past the cap, kill its tree and return 124.
fx_cap() {
  local cap="$1" pid end l
  shift
  "$@" &
  pid=$!
  end=$(($(date +%s) + cap))
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$(date +%s)" -ge "$end" ]; then
      fx_kill_tree "$pid"
      wait "$pid" 2>/dev/null || true
      return 124
    fi
    for l in ${HELD:-lock}; do touch "${STATE:-.}/$l" 2>/dev/null || true; done
    sleep 1
  done
  wait "$pid"
}

# The profile: everything else stays allowed (Apple's tools run as usual), then network, writes, the home folders and
# the Keychain are taken away. Later rules win in SBPL. $1 is the run's real temp dir, checked to need no quoting.
fx_profile() {
  printf '%s\n' '(version 1)' '(allow default)' '(deny network*)' '(deny file-write*)' \
    "(allow file-write* (subpath \"$1\") (literal \"/dev/null\") (literal \"/dev/zero\") (literal \"/dev/dtracehelper\") (regex #\"^/dev/fd/\"))" \
    '(deny file-read* (subpath "/Users") (subpath "/Volumes"))' \
    '(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd") (global-name "com.apple.security.agent"))' \
    '(deny process-exec (literal "/usr/bin/security"))'
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
  # Unpacked inside the sandbox too: the archive's own entries can write only under $t. The state dir is under /Users,
  # which the sandbox can't read, so the archive moves into $t first.
  mv -- "$MR_P.resp" "$t/src.tgz"
  if ! sandbox-exec -f "$MR_P.sb" tar -xzf "$t/src.tgz" -C "$t/src" --strip-components 1 >/dev/null 2>&1 ||
    [ ! -f "$t/src/tools/mailroom/run-fixtures.sh" ]; then
    rm -r -f -- "$t"
    mr_emit error API_FAILED
    return 0
  fi

  rc=0
  fx_cap "$FX_TIMEOUT" sandbox-exec -f "$MR_P.sb" /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME="$t/home" \
    TMPDIR="$t/tmp" LC_ALL=C /bin/bash "$t/src/tools/mailroom/run-fixtures.sh" >"$t/out" 2>&1 </dev/null || rc=$?
  # The log tail, printable ASCII only, written as results are: a pinned cwd, noclobber, never through a planted link.
  tail -n "$FX_LOG_LINES" "$t/out" | LC_ALL=C tr -cd '\11\12\40-\176' >"$MR_P.log" 2>/dev/null || true
  (
    cd "$rd" && [ "$(pwd -P)" = "$rd" ] || exit 1
    set -C
    cat -- "$MR_P.log" >./fixtures.log
  ) 2>/dev/null || true
  out="$(jq -Rsc --argjson max "$FX_MAX_FAILING" 'split("\n") as $l
    | ([$l[] | capture("^# (?<p>[0-9]+) passed, (?<f>[0-9]+) failed, of (?<c>[0-9]+) cases$")] | last) as $sum
    | {passed: ($sum.p // null | if . then tonumber else null end), failed: ($sum.f // null | if . then tonumber else null end),
       cases: ($sum.c // null | if . then tonumber else null end),
       failing: [$l[] | select(startswith("not ok - ")) | .[9:] | gsub("[^A-Za-z0-9 ._:,()/+-]"; "?") | .[0:120]][0:$max]}' "$t/out" 2>/dev/null || echo '{}')"
  rm -r -f -- "$t"
  if [ "$rc" = 124 ]; then printf 'error TIMEOUT %s\n' "$(jq -c '{fixtures: .}' <<<"$out")"; return 0; fi
  if [ "$rc" = 0 ] && jq -e '.failed == 0 and .passed != null and .passed == .cases and .passed > 0' <<<"$out" >/dev/null 2>&1; then
    printf 'pass - %s\n' "$(jq -c '{fixtures: .}' <<<"$out")"
  else
    printf 'fail FIXTURES_FAILED %s\n' "$(jq -c --argjson rc "$rc" '{fixtures: (. + {exit: $rc})}' <<<"$out")"
  fi
}
