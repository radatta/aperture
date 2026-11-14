#!/bin/bash
# Fixture suite for the sim bench (sim-bench.sh, sampler.sh, summarize.sh): each case runs the bench in fixture mode
# (SIM_BENCH_FIXTURE=1) against a temp dir, with the Mac's tools replaced by exported shell functions — no stub files,
# so no process argv ever carries a path ending in the curl name (docs/ops/COI-INCIDENTS.md → Incident H). Most cases use
# fixtures/fake-runner.sh; one drives the REAL tools/mailroom/runner.sh + jobs/sim.sh, answering axe/simctl from the
# mailroom's default tape (testdata/jobs.jsonl line 2, read only). Bash 3.2 + jq; vitest runs it
# (scripts/src/mailroom/sim-bench.test.ts). docs/ops/SIM-BENCH.md → Tests.
set -uo pipefail
if [ "$(uname)" = Darwin ]; then
  export PATH=/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin
  [ "${BASH_VERSINFO[0]}" -le 3 ] || exec /bin/bash "$0" "$@"
fi
HERE="$(cd "$(dirname "$0")" && pwd -P)"
MR="$(cd "$HERE/.." && pwd -P)"
FX="$HERE/fixtures"
BENCH="$HERE/sim-bench.sh"
# FX: the stubs read their answers from it. ALLOW_SHARE: this checkout sits in the container's share (case 11 drops it).
export SIM_BENCH_FIXTURE=1 SIM_BENCH_POLL=0.05 LC_ALL=C FX SIM_BENCH_FX_ALLOW_SHARE=1
pass=0
failed=0
cases=0
sha256() { if command -v shasum >/dev/null; then shasum -a 256; else sha256sum; fi | cut -d' ' -f1; }
ok() { pass=$((pass + 1)); echo "ok - $1"; }
bad() { failed=$((failed + 1)); echo "not ok - $1: $2"; [ -z "${3:-}" ] || sed 's/^/    /' "$3" | tail -40; }
check() { # NAME WHY-OR-EMPTY [LOG]
  cases=$((cases + 1))
  if [ -z "$2" ]; then ok "$1"; else bad "$1" "$2" "${3:-}"; fi
}

# --- stubs: the Mac's tools, answering from fixtures and SIM_BENCH_FX_* knobs ------------------------------------------
curl() { # dev's shell: shell.1 for the first $SIM_BENCH_FX_SWITCH calls, shell.2 after
  [ -z "${SIM_BENCH_FX_CURL_FAIL:-}" ] || return 7
  local n
  n=$(($(cat "$SIM_BENCH_FX_DIR/curl.n" 2>/dev/null || echo 0) + 1))
  echo "$n" >"$SIM_BENCH_FX_DIR/curl.n"
  if [ "$n" -le "${SIM_BENCH_FX_SWITCH:-1000}" ]; then cat "$FX/shell.1.txt"; else cat "$FX/shell.2.txt"; fi
}
security() {
  case "$*" in
    "find-generic-password -s aperture-devcheck-dev -a devcheck@dev.aperture.rahuldatta.dev") [ -z "${SIM_BENCH_FX_NO_PW:-}" ] || return 44 ;;
    *) echo "security stub: unexpected $*" >&2; return 2 ;;
  esac
}
launchctl() { [ "${SIM_BENCH_FX_LOADED:-}" = 1 ] && [ "$1" = print ] && return 0; return 113; }
memory_pressure() { printf 'The system has 8589934592 (524288 pages with a page size of 16384).\nSystem-wide memory free percentage: %s%%\n' "${SIM_BENCH_FX_FREE:-31}"; }
vm_stat() { cat "$FX/vm_stat.txt"; }
ps() { cat "$FX/ps.txt"; }
pmset() { printf 'Note: No thermal warning level has been recorded\nNote: No performance warning level has been recorded\n'; }
sysctl() {
  case "$*" in
    "-n vm.loadavg") echo "{ 2.10 1.50 1.20 }" ;;
    "-n hw.model") echo "MacBookAir10,1" ;;
    "-n hw.memsize") echo 8589934592 ;;
    "-n machdep.cpu.brand_string") echo "Apple M1" ;;
    "-n hw.ncpu") echo 8 ;;
    *) return 1 ;;
  esac
}
sw_vers() { case "$1" in -productVersion) echo 26.6 ;; -buildVersion) echo 25G5 ;; esac; }
xcodebuild() { printf 'Xcode 27.2\nBuild version 27C88\n'; }
axe() { [ "$1" = --version ] && echo 1.8.0; }
xcrun() {
  case "$*" in
    # real output runs to many KB (supportedDeviceTypes per runtime): padded past any truncation
    "simctl list runtimes -j") printf '{"runtimes":[{"name":"iOS 27.2","version":"27.2","buildversion":"24B8117","isAvailable":true,"supportedDeviceTypes":["%s"]},{"name":"watchOS 12","version":"12.0","buildversion":"x","isAvailable":true}]}\n' "$(printf 'x%.0s' $(seq 3000))" ;;
    "simctl list devices -j") echo '{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-27-2":[{"name":"aperture-devcheck","udid":"0D6D7F2A-1111-2222-3333-444455556666","state":"Booted","isAvailable":true,"deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro-Max"}]}}' ;;
  esac
}
export -f curl security launchctl memory_pressure vm_stat ps pmset sysctl sw_vers xcodebuild axe xcrun

# A failed mktemp must stop the suite: `cd ""` would leave T on the cwd, and a case's rm would delete it.
tmpdir_real() { local d; d="$(mktemp -d)" && [ -n "$d" ] && (cd "$d" && pwd -P); }
bail() { echo "Bail out! $1"; exit 1; }
new_dir() { T="$(tmpdir_real)" || bail "no temp dir for a case"; export SIM_BENCH_FX_DIR="$T" SIM_BENCH_MAILROOM_STATE="$T/mailroom-state"; }
bench() { /bin/bash "$BENCH" --out "$T/out" --tag fx --runner "$FX/fake-runner.sh" "$@" >"$T/log" 2>&1; }
rdir() { find "$T/out" -mindepth 1 -maxdepth 1 -type d | head -1; }
jqe() { jq -e "$@" >/dev/null 2>&1; } # jq -e, quiet

# The fake tape for the orchestration case: capture slower in run 1 than 2 than 3; a dropped tap's retap and a retype
# in run 2's notes; run 1's Done form misses its row's Done (a missing seed); run 3's launch an AX_TIMEOUT.
PLANS="$HERE/plans.json"
DONE_I="$(jq '[.jobs[] | select(.name == "done-form") | .steps | to_entries[] | select(.value.op == "tap" and .value.label == "Done") | .key][0]' "$PLANS")"
TAPE="$(mktemp)" && [ -n "$TAPE" ] || bail "no temp file for the tape"
trap 'rm -f -- "$TAPE"' EXIT
jq -n --argjson d "$DONE_I" '{
  "capture@r1": {ms: 3000}, "capture@r2": {ms: 2000, steps: {"3": {note: "focused; tapped again (still there after the first)"}, "5": {note: "typed; retyped once (first read zq)"}}},
  "capture@r3": {ms: 1000, steps: {"4": {note: "erased; deleted more twice, 2 (first read zz)"}}},
  "relaunch@r2": {steps: {"3": {note: "; the switcher didn'"'"'t open (SpringBoard, Page 1 of 2); web: gone"}}},
  "relaunch@r3": {status: "fail", reason: "ASSERT", detail: "SWITCHER_FAILED", steps: {"3": {status: "fail", note: "no Aperture card in the app switcher in two tries; no Aperture card at 220,500 (AXGroup): was the app running? Rerun from a launch"}}},
  "done-form@r1": {status: "fail", reason: "ASSERT", detail: "MISS", steps: {"\($d)": {status: "fail", note: "no Done near 395"}}},
  "launch@r3": {status: "error", reason: "SIM_UNAVAILABLE", detail: "AX_TIMEOUT", steps: {"0": {status: "error", note: "describe-ui timed out eight times; icon tapped 3 times"}}}
}' >"$TAPE"
export SIM_BENCH_FAKE_TAPE="$TAPE"

# --- 1. orchestration: the prelude, then 3 × 5 jobs in order, every envelope the runner's, dev's build per job ---------
new_dir
SIM_BENCH_FX_SWITCH=7 bench --runs 3 --interval 0.2
rc=$?
R="$(rdir)"
why=""
[ "$rc" = 0 ] || why="exit $rc"
[ -n "$why" ] || [ "$(wc -l <"$R/runs.jsonl" | tr -d ' ')" = 16 ] || why="$(wc -l <"$R/runs.jsonl") runs, want 16"
want_order="prelude $(jq -r '[.jobs[].name] as $j | [$j, $j, $j] | flatten | join(" ")' "$PLANS")"
[ -n "$why" ] || [ "$(jq -r .job "$R/runs.jsonl" | tr '\n' ' ' | sed 's/ $//')" = "$want_order" ] || why="order $(jq -r .job "$R/runs.jsonl" | tr '\n' ' ')"
if [ -z "$why" ]; then
  for p in "$R"/hostjobs/results/*/plan.json; do
    id="$(basename "$(dirname "$p")")"
    jqe --arg id "$id" '.v == 1 and .id == $id and .job == "sim" and (.id | test("^[0-9]{8}T[0-9]{6}Z-[a-z0-9-]{1,48}$"))
      and (.submittedAt | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and .expiresInMin == 60
      and (.params | keys == ["sha", "shutdown", "steps", "timeoutSec"]) and (.params.sha | test("^[0-9a-f]{40}$"))
      and .params.shutdown == false and (.params.timeoutSec == (if (.id | endswith("-prelude")) then 600 else 480 end))' "$p" \
      || { why="envelope $id"; break; }
  done
fi
[ -n "$why" ] || jqe --slurpfile p "$PLANS" '.params.steps == $p[0].prelude.steps' "$(ls "$R"/hostjobs/results/*-r0-prelude/plan.json)" || why="the prelude isn't plans.json's"
[ -n "$why" ] || jqe --slurpfile p "$PLANS" '.params.steps == ($p[0].jobs[] | select(.name == "done-form") | .steps)' "$(ls "$R"/hostjobs/results/*-r2-done-form/plan.json)" || why="done-form isn't plans.json's"
# the first 7 shell reads (preflight, prelude, run 1's five) see build 1, later jobs build 2
[ -n "$why" ] || [ "$(jq -r '.sha[0:1]' "$R/runs.jsonl" | tr -d '\n')" = "1111112222222222" ] || why="shas $(jq -r '.sha[0:1]' "$R/runs.jsonl" | tr -d '\n')"
[ -n "$why" ] || jqe --arg s "$(sha256 <"$MR/jobs/sim.sh")" '.simShSha256 == $s and .memGB == 8 and .model == "MacBookAir10,1" and .axe == "1.8.0"
  and .runtimes == [{name: "iOS 27.2", version: "27.2", buildversion: "24B8117", isAvailable: true}]
  and .device.deviceTypeIdentifier == "com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro-Max" and .args.runs == 3' "$R/machine.json" || why="machine.json $(cat "$R/machine.json")"
[ -n "$why" ] || [ ! -e "$R/sampler.pid" ] || why="sampler.pid left"
[ -n "$why" ] || jqe -s 'length >= 1 and (.[0].freePct == 31)' "$R/samples.jsonl" || why="no samples"
n1="$(wc -l <"$R/samples.jsonl")"
command sleep 0.5
[ -n "$why" ] || [ "$(wc -l <"$R/samples.jsonl")" = "$n1" ] || why="the sampler outlived the bench"
[ -n "$why" ] || cmp -s "$PLANS" "$R/plans.json" || why="plans.json not kept beside the results"
check "orchestration: prelude + 3 × 5 jobs, runner envelopes, dev's build per job, machine.json, sampler stopped" "$why" "$T/log"
ORCH="$R"
ORCH_T="$T"

# --- 2. summary math from case 1's results -------------------------------------------------------------------------
S="$ORCH/summary.json"
why=""
[ -f "$ORCH/summary.md" ] || why="no summary.md"
[ -n "$why" ] || jqe '[.jobs[].name] == ["prelude", "launch", "capture", "done-form", "capture-long", "relaunch"]' "$S" || why="jobs $(jq -c '[.jobs[].name]' "$S")"
# capture: 18 ops × 3000 / 2000 / 1000 ms → run 1 54 s; runs 2..3 [36, 18] → p50 18, p95 36
[ -n "$why" ] || jqe '.jobs[] | select(.name == "capture") | .run1Ms == 54000 and .runs2toN.p50 == 18000 and .runs2toN.p95 == 36000 and .runs2toN.max == 36000
  and .all.min == 18000 and .all.max == 54000 and .runs == 3 and .pass == 3' "$S" || why="capture $(jq -c '.jobs[] | select(.name == "capture")' "$S")"
# an op over runs 1..3 [3000, 2000, 1000]: nearest-rank p50 2000, p95 3000
[ -n "$why" ] || jqe '.ops[] | select(.job == "capture" and .i == 0) | .n == 3 and .p50 == 2000 and .p95 == 3000 and .max == 3000 and .min == 1000 and .run1Ms == 3000' "$S" || why="capture op 0"
[ -n "$why" ] || jqe '.signals.retap == 1 and .signals.retype == 1 and .signals.iconRetap == 2 and .signals.extraDelete == 2
  and .signals.switcherRetry == 2' "$S" || why="signals $(jq -c .signals "$S")"
# relaunch r3's SWITCHER_FAILED is "no Aperture card … was the app running?": a fail, not a dropped input
[ -n "$why" ] || jqe '.fails.axTimeout == 1 and .fails.seedMissing == 1 and .fails.dropFails == 0
  and .fails.byReason == {"ASSERT/MISS": 1, "ASSERT/SWITCHER_FAILED": 1, "SIM_UNAVAILABLE/AX_TIMEOUT": 1}' "$S" || why="fails $(jq -c .fails "$S")"
[ -n "$why" ] || jqe '.jobs[] | select(.name == "done-form") | .fail == 1 and .failsBy == {"ASSERT/MISS": 1}' "$S" || why="done-form fails"
[ -n "$why" ] || jqe '.jobs[] | select(.name == "capture-long") | .skippedSetup == ["16 createTask", "16 upsertPlan"]' "$S" || why="capture-long's skipped setup"
[ -n "$why" ] || jqe '.devBuildChanged == true and (.devBuilds | length) == 2' "$S" || why="dev builds"
[ -n "$why" ] || grep -q 'Done form task missing' "$ORCH/summary.md" || why="summary.md doesn't name the missing seed"
[ -n "$why" ] || grep -q '^| capture | 3 | 54 | 18 | 36 | 36 | 18–54 | 3/0/0 |' "$ORCH/summary.md" || why="summary.md's capture row: $(grep '^| capture |' "$ORCH/summary.md")"
check "summary: per-job run 1 vs runs 2–N wall, per-op percentiles, signals, fails by reason, a missing seed named" "$why" "$ORCH/summary.md"

# --- 3. machine load from planted samples: overall and inside one job's window -----------------------------------------
why=""
t2="$(jq -r 'select(.job == "capture" and .run == 2) | .startedAt | fromdateiso8601' "$ORCH/runs.jsonl")"
jq -cn --argjson t "$t2" '
  {t: 1, freePct: 40, swapins: 100, swapouts: 50, compressorPages: 64000, pageSize: 16384, load: [1, 1, 1],
   procs: {SimMetalHost: {rssKb: 512000, cpu: 10, count: 1}}},
  {t: 2, freePct: 22, swapins: 130, swapouts: 90, compressorPages: 128000, pageSize: 16384, load: [5.5, 3, 2],
   procs: {SimMetalHost: {rssKb: 768000, cpu: 30, count: 2}}, therm: "Note: No thermal warning level has been recorded;"},
  {t: $t, freePct: 11, swapins: 131, swapouts: 95, load: [2, 2, 2], procs: {}}' >"$ORCH/samples.jsonl"
/bin/bash "$HERE/summarize.sh" "$ORCH" >"$ORCH_T/sum.log" 2>&1 || why="summarize exited $?"
[ -n "$why" ] || jqe '.load | .minFreePct == 11 and .swapinsDelta == 31 and .swapoutsDelta == 45 and .peakLoad1 == 5.5 and .peakCompressorMB == 2000
  and .procs.SimMetalHost == {peakRssMB: 750, peakCpu: 30, meanCpu: 20, maxCount: 2, samples: 2} and (.therm | length) == 1' "$S" || why="load $(jq -c .load "$S")"
[ -n "$why" ] || jqe '.jobs[] | select(.name == "capture") | .minFreePct == 11 and .peakLoad1 == 2' "$S" || why="capture's window $(jq -c '.jobs[] | select(.name == "capture") | {minFreePct, peakLoad1}' "$S")"
check "summary: memory, swap deltas, compressor, load and per-process peaks; a job's window" "$why" "$ORCH_T/sum.log"

# --- 4. --against: ratio columns ------------------------------------------------------------------------------------
why=""
jq '.tag = "m3" | .jobs |= map(.runs2toN.p50 = (if .runs2toN.p50 then .runs2toN.p50 / 2 else null end)) | .ops |= map(.p50 = .p50 / 2)' "$S" >"$ORCH_T/m3.json"
/bin/bash "$HERE/summarize.sh" "$ORCH" --against "$ORCH_T/m3.json" >"$ORCH_T/sum.log" 2>&1 || why="summarize exited $?"
[ -n "$why" ] || jqe '.against.tag == "m3" and (.jobs[] | select(.name == "capture") | .against.p50 == 9000)' "$S" || why="against $(jq -c .against "$S")"
[ -n "$why" ] || grep -q '^| capture | 3 | 54 | 18 | 36 | 36 | 18–54 | 9 | ×2 |' "$ORCH/summary.md" || why="md: $(grep '^| capture |' "$ORCH/summary.md")"
[ -n "$why" ] || grep -q '| ×2 |$' "$ORCH/summary.md" || why="no op ratio"
check "summary --against: this / that per job and per op" "$why" "$ORCH/summary.md"
rm -r -f -- "$ORCH_T"

# --- 5. the sampler: one tick parsed from memory_pressure, vm_stat, sysctl, ps, pmset ---------------------------------
new_dir
/bin/bash "$HERE/sampler.sh" "$T/s.jsonl" 30 >"$T/log" 2>&1 &
spid=$!
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do [ -s "$T/s.jsonl" ] && break; command sleep 0.1; done
kill "$spid" 2>/dev/null
wait "$spid" 2>/dev/null
why=""
jqe -s '.[0] | .freePct == 31 and .swapins == 100 and .swapouts == 50 and .compressorPages == 120000 and .pageSize == 16384
  and .load == [2.1, 1.5, 1.2]
  and .procs.SimMetalHost == {rssKb: 768000, cpu: 35, count: 2}
  and .procs["com.apple.WebKit*"] == {rssKb: 358400, cpu: 42.5, count: 2}
  and .procs.SpringBoard.rssKb == 204800 and .procs.Web.rssKb == 153600 and .procs.DeviceHub.count == 1
  and .procs.launchd_sim.rssKb == 102400 and .procs.SimRenderServer.cpu == 3 and (.procs | has("notifyd") | not)
  and (.therm | startswith("Note: No thermal warning level"))' "$T/s.jsonl" || why="sample $(head -1 "$T/s.jsonl")"
check "sampler: one tick's memory, swap, load, per-process sums (paths with spaces), thermal note" "$why" "$T/log"
rm -r -f -- "$T"

# --- 6. the REAL runner.sh + sim.sh accept the bench's job outside launchd -------------------------------------------
new_dir
(
  # axe/simctl/… from the mailroom's default tape (testdata/jobs.jsonl line 2), as run-fixtures.sh answers them
  export MAILROOM_FIXTURE_TAPE="$T/tape" MAILROOM_FIXTURE_SIMCALLS="$T/simcalls"
  sed -n 2p "$MR/testdata/jobs.jsonl" | jq -r '.defaultTape[] | [.m, (.rc // 0 | tostring), (.n // 0 | tostring),
    (.out // "" | if type == "string" then . else tojson end)] | join("\t")' >"$T/tape"
  : >"$T/simcalls"
  sim_stub() {
    local argv="$*" idx=0 m rc n out cnt
    printf '%s\n' "$argv" >>"$MAILROOM_FIXTURE_SIMCALLS"
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
    return 0
  }
  axe() { sim_stub axe "$@"; }
  xcrun() { sim_stub xcrun "$@"; }
  open() { sim_stub open "$@"; }
  pgrep() { sim_stub pgrep "$@"; }
  caffeinate() { sim_stub caffeinate "$@"; }
  xcodebuild() { sim_stub xcodebuild "$@"; }
  sleep() { if [ "${1%%.*}" -ge 20 ] 2>/dev/null; then command sleep "$1"; fi; }
  export -f sim_stub axe xcrun open pgrep caffeinate xcodebuild sleep
  /bin/bash "$BENCH" --out "$T/out" --tag fx --runner "$MR/runner.sh" --plans "$FX/plans-smoke.json" \
    --sha "$(printf 'a%.0s' $(seq 40))" --no-sampler --runs 1
) >"$T/log" 2>&1
rc=$?
R="$(rdir)"
why=""
[ "$rc" = 0 ] || why="exit $rc"
res="$(ls "$R"/hostjobs/results/*-r1-wait-only/result.json 2>/dev/null | head -1)"
[ -n "$why" ] || [ -n "$res" ] || why="no result.json from the real runner"
[ -n "$why" ] || jqe '.job == "sim" and .status == "pass" and .steps[0].op == "wait" and .steps[0].status == "pass" and (.durationMs | type) == "number"' "$res" || why="result $(cat "$res")"
[ -n "$why" ] || [ -f "$(dirname "$res")/plan.json" ] || why="no plan.json beside it"
[ -n "$why" ] || jqe -s 'length == 2 and all(.status == "pass")' "$R/runs.jsonl" || why="runs $(cat "$R/runs.jsonl")"
[ -n "$why" ] || [ ! -d "$R/state/lock" ] || why="the runner's lock was left"
[ -n "$why" ] || jqe '[.jobs[].name] == ["prelude", "wait-only"]' "$R/summary.json" || why="summary $(jq -c '[.jobs[].name]' "$R/summary.json")"
check "real runner.sh + sim.sh run the bench's job from a private .hostjobs (no launchd)" "$why" "$T/log"
rm -r -f -- "$T"

# --- 7. preflight refusals (75) and what passes them -------------------------------------------------------------------
quick() { bench --runs 1 --jobs launch --no-prelude --no-sampler "$@"; }
guard() { # NAME WANT-RC GREP [env…] -- [args…]
  local name="$1" want="$2" pat="$3" rc why=""
  shift 3
  new_dir
  local envs=()
  while [ $# -gt 0 ] && [ "$1" != -- ]; do envs+=("$1"); shift; done
  [ $# -eq 0 ] || shift
  if [ "${#envs[@]}" -gt 0 ]; then env "${envs[@]}" /bin/bash "$BENCH" --out "$T/out" --tag fx --runner "$FX/fake-runner.sh" --runs 1 --jobs launch --no-prelude --no-sampler "$@" >"$T/log" 2>&1
  else quick "$@"; fi
  rc=$?
  [ "$rc" = "$want" ] || why="exit $rc, want $want"
  [ -n "$why" ] || [ -z "$pat" ] || grep -q -- "$pat" "$T/log" || why="no \"$pat\" in the output"
  if [ "$want" = 75 ] && [ -z "$why" ] && [ -d "$T/out" ] && [ -n "$(find "$T/out" -name 'result.json' 2>/dev/null)" ]; then why="a job ran"; fi
  check "$name" "$why" "$T/log"
  rm -r -f -- "$T"
}
guard "refuses while the mailroom agent is loaded (it drives the same sim)" 75 "launchctl bootout" SIM_BENCH_FX_LOADED=1 --
guard "--allow-mailroom runs with the agent loaded" 0 "" SIM_BENCH_FX_LOADED=1 -- --allow-mailroom
guard "refuses without the test user's Keychain item" 75 "IOS-CHECK.md → Setup" SIM_BENCH_FX_NO_PW=1 --
guard "refuses when dev's build marker can't be read" 75 "no build marker" SIM_BENCH_FX_CURL_FAIL=1 --
guard "--sha skips the marker read" 0 "" SIM_BENCH_FX_CURL_FAIL=1 -- --sha 3333333333333333333333333333333333333333
guard "refuses a bad --sha" 75 "--sha takes" -- --sha abc
guard "refuses an unknown --jobs name" 75 "no job nope" -- --jobs nope
guard "refuses --runs 0" 75 "--runs takes" -- --runs 0
guard "refuses off a Mac outside fixture mode" 75 "run it on a Mac" SIM_BENCH_FIXTURE=0 --
# a fresh mailroom lock is a job running now; a 16-minute-old one is stale (runner.sh's own rule)
new_dir
mkdir -p "$SIM_BENCH_MAILROOM_STATE/lock"
quick
rc=$?
check "refuses while the mailroom holds a fresh lock" "$([ "$rc" = 75 ] && grep -q 'running a job right now' "$T/log" || echo "exit $rc")" "$T/log"
rm -r -f -- "$T"
new_dir
mkdir -p "$SIM_BENCH_MAILROOM_STATE/lock"
touch -t 202001010000 "$SIM_BENCH_MAILROOM_STATE/lock"
quick
rc=$?
check "runs past a stale mailroom lock" "$([ "$rc" = 0 ] || echo "exit $rc")" "$T/log"
rm -r -f -- "$T"

# --- 8. aborts: the sim can't run, or the sign-in prelude fails → stop, still summarize ------------------------------
abort_case() { # NAME TAPE-JSON
  new_dir
  jq -n "$2" >"$T/tape.json"
  SIM_BENCH_FAKE_TAPE="$T/tape.json" bench --runs 2 --no-sampler
  local rc=$? R why=""
  R="$(rdir)"
  [ "$rc" = 1 ] || why="exit $rc, want 1"
  [ -n "$why" ] || [ "$(wc -l <"$R/runs.jsonl" | tr -d ' ')" = 1 ] || why="$(wc -l <"$R/runs.jsonl") runs, want 1"
  [ -n "$why" ] || [ -f "$R/aborted.json" ] || why="no aborted.json"
  [ -n "$why" ] || grep -q '\*\*Aborted:\*\*' "$R/summary.md" || why="summary.md doesn't say aborted"
  check "$1" "$why" "$T/log"
  rm -r -f -- "$T"
}
abort_case "aborts when the prelude finds no password" '{prelude: {status: "error", reason: "PASSWORD_MISSING", steps: {"1": {status: "error"}}}}'
abort_case "aborts when the sim's device is missing" '{prelude: {status: "error", reason: "SIM_UNAVAILABLE", detail: "SIM_MISSING", steps: {"0": {status: "error"}}}}'
abort_case "aborts when the sign-in prelude fails" '{prelude: {status: "error", reason: "SIGNIN_FAILED", detail: "FORM_CHANGED", steps: {"1": {status: "error"}}}}'

# --- 9. a runner that never answers is stopped, recorded, and the bench goes on --------------------------------------
new_dir
SIM_BENCH_FAKE_HANG=1 SIM_BENCH_KILL_AFTER=1 bench --runs 1 --jobs launch,capture --no-prelude --no-sampler
rc=$?
R="$(rdir)"
why=""
[ "$rc" = 0 ] || why="exit $rc"
[ -n "$why" ] || jqe -s 'length == 2 and all(.reason == "NO_RESULT" and .status == "error")' "$R/runs.jsonl" || why="runs $(cat "$R/runs.jsonl")"
[ -n "$why" ] || grep -q 'stopping the runner' "$T/log" || why="no stop line"
[ -n "$why" ] || [ -s "$T/out/hang.pid" ] || why="the fake runner never started its child"
[ -n "$why" ] || ! kill -0 "$(cat "$T/out/hang.pid")" 2>/dev/null || why="the runner's child outlived the stop"
check "a hung runner is stopped with its process group, recorded NO_RESULT, and the next job runs" "$why" "$T/log"
rm -r -f -- "$T"

# --- 10. a result.json that isn't JSON is recorded BAD_RESULT, never dropped ------------------------------------------
new_dir
SIM_BENCH_FAKE_GARBLE=launch bench --runs 1 --jobs launch,capture --no-prelude --no-sampler
rc=$?
R="$(rdir)"
why=""
[ "$rc" = 0 ] || why="exit $rc"
[ -n "$why" ] || jqe -s 'length == 2 and .[0].reason == "BAD_RESULT" and .[1].status == "pass"' "$R/runs.jsonl" || why="runs $(cat "$R/runs.jsonl")"
check "an unreadable result.json is recorded BAD_RESULT and the bench goes on" "$why" "$T/log"
rm -r -f -- "$T"

# --- 10b. a runner that dies mid-drain leaves its envelope and lock: cleared, so the next job runs alone ----------------
new_dir
SIM_BENCH_FAKE_STRAND=launch bench --runs 1 --jobs launch,capture --no-prelude --no-sampler
rc=$?
R="$(rdir)"
why=""
[ "$rc" = 0 ] || why="exit $rc"
[ -n "$why" ] || jqe -s 'length == 2 and .[0].reason == "NO_RESULT" and .[1].job == "capture" and .[1].status == "pass"' "$R/runs.jsonl" || why="runs $(cat "$R/runs.jsonl")"
[ -n "$why" ] || [ -z "$(find "$R/hostjobs/results" -mindepth 1 -maxdepth 1 -name '*-launch')" ] || why="the stranded launch ran inside capture's turn"
[ -n "$why" ] || [ -z "$(ls -A "$R/hostjobs/inbox")" ] || why="inbox not empty: $(ls -A "$R/hostjobs/inbox")"
[ -n "$why" ] || [ ! -d "$R/state/lock" ] || why="the runner lock was left"
check "a runner that dies mid-drain: its envelope and lock are cleared and the next job runs alone" "$why" "$T/log"
rm -r -f -- "$T"

# --- 11. never from, or into, a checkout the mailroom shares with the container -----------------------------------------
share_case() { # NAME GREP BENCH-ROOT OUT
  local rc why=""
  (unset SIM_BENCH_FX_ALLOW_SHARE; /bin/bash "$3/tools/mailroom/bench/sim-bench.sh" --out "$4" --tag fx --runner "$3/tools/mailroom/bench/fixtures/fake-runner.sh" \
    --runs 1 --jobs launch --no-prelude --no-sampler) >"$T/log" 2>&1
  rc=$?
  [ "$rc" = 75 ] || why="exit $rc, want 75"
  [ -n "$why" ] || grep -q -- "$2" "$T/log" || why="no \"$2\" in the output"
  [ -n "$why" ] || [ -z "$(find "$4" -name result.json 2>/dev/null)" ] || why="a job ran"
  [ -n "$why" ] || [ ! -e "$4" ] || why="the refused run made $4"
  check "$1" "$why" "$T/log"
}
new_dir
mkdir -p "$T/share/.hostjobs" "$T/share/tools" "$T/own/tools"
cp -R "$MR" "$T/share/tools/mailroom"
cp -R "$MR" "$T/own/tools/mailroom"
share_case "refuses to run from a checkout with a .hostjobs (the container can write it)" "shares with the container" "$T/share" "$T/out"
share_case "refuses to write results inside the shared checkout" "inside the shared checkout" "$T/own" "$T/share/localNotes/sim-bench"
(unset SIM_BENCH_FX_ALLOW_SHARE; /bin/bash "$T/own/tools/mailroom/bench/sim-bench.sh" --out "$T/out2" --tag fx --runner "$T/share/tools/mailroom/bench/fixtures/fake-runner.sh" \
  --runs 1 --jobs launch --no-prelude --no-sampler) >"$T/log" 2>&1
rc=$?
check "refuses a --runner inside the shared checkout" "$([ "$rc" = 75 ] && grep -q 'shares with the container' "$T/log" || echo "exit $rc")" "$T/log"
rm -r -f -- "$T"

# --- 12. temp dirs: a failed mktemp yields no dir, never the cwd --------------------------------------------------------
why=""
out="$(cd "$HERE" && mktemp() { return 1; } && tmpdir_real)" && why="succeeded with mktemp failing"
[ -z "$out" ] || why="printed '$out' with mktemp failing"
out="$(cd "$HERE" && mktemp() { :; } && tmpdir_real)" && why="${why:-succeeded with mktemp printing nothing}"
[ -z "$out" ] || why="${why:-printed '$out' with mktemp printing nothing}"
d="$(tmpdir_real)" && [ -d "$d" ] && [ "$d" != "$PWD" ] && rmdir "$d" || why="${why:-no real temp dir}"
check "a failed mktemp yields no temp dir, never the cwd" "$why"

echo "# $pass passed, $failed failed, of $cases cases"
[ "$failed" = 0 ] && [ "$pass" = "$cases" ] && [ "$cases" -gt 0 ]
