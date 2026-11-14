#!/bin/bash
# The sim bench: replays the devcheck's iOS jobs (plans.json, exported from ios-standalone by `pnpm sim-bench:plans`)
# N times on this Mac through the REAL tools/mailroom/runner.sh + jobs/sim.sh, a black box, with a private .hostjobs and
# state dir (as run-fixtures.sh drives it; no launchd). Timings are sim.sh's own per-op `ms` from each result.json, never
# re-timed; sampler.sh records memory, swap, load and the sim's processes every 2 s alongside; summarize.sh writes
# summary.json + summary.md. Runbook: docs/ops/SIM-BENCH.md.
#
#   /bin/bash tools/mailroom/bench/sim-bench.sh [--runs 5] [--tag m1] [--out ~/aperture-sim-bench] [--sha auto|<40 hex>]
#     [--jobs launch,capture,…] [--timeout 480] [--interval 2] [--no-prelude] [--no-sampler] [--allow-mailroom]
#     [--against <summary.json>] [--runner <runner.sh>] [--plans <plans.json>]
#
# Exit: 0 the bench ran (job failures are findings, not errors) · 1 aborted (the sim can't run: no device, AXe,
# Device Hub, password; or the sign-in prelude failed) · 75 refused before any job (preflight).
# Bash 3.2 (macOS /bin/bash) + jq; every data shape goes through jq.
set -uo pipefail
umask 077
export LC_ALL=C
# On the Mac: Apple's /bin/bash 3.2, and the mailroom plist's PATH exactly — native Homebrew's axe/jq, never an Intel
# /usr/local one (the M1 has both, with `brew` aliased to the Intel one).
if [ "$(uname)" = Darwin ]; then
  export PATH=/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin
  [ "${BASH_VERSINFO[0]}" -le 3 ] || exec /bin/bash "$0" "$@"
fi
HERE="$(cd "$(dirname "$0")" && pwd -P)"
MR="$(cd "$HERE/.." && pwd -P)"

RUNS=5
TAG=""
OUT="$HOME/aperture-sim-bench"
SHA=auto
JOBS=""
TIMEOUT=""
INTERVAL=2
PRELUDE=1
SAMPLER=1
ALLOW_MAILROOM=0
AGAINST=""
RUNNER="$MR/runner.sh"
PLANS="$HERE/plans.json"
ORIGIN="https://dev.aperture.rahuldatta.dev" # slot A: the sim's Home Screen app is dev's (IOS-CHECK.md)
LABEL="dev.rahuldatta.aperture.mailroom"
MAILROOM_STATE="${SIM_BENCH_MAILROOM_STATE:-$HOME/Library/Application Support/aperture-mailroom/state}"
POLL="${SIM_BENCH_POLL:-5}"
EMAIL="devcheck@dev.aperture.rahuldatta.dev"
KEYCHAIN="aperture-devcheck-dev"

say() { printf '%s\n' "$*"; }
die() { say "sim-bench: $*" >&2; exit "${2:-75}"; }
need() { [ $# -ge 2 ] || die "$1 needs a value"; }
# Inside a checkout the mailroom watches (a .hostjobs beside it): the container can write there (MAILROOM.md → trust).
in_share() {
  local d="$1"
  while [ -n "$d" ] && [ "$d" != / ] && [ "$d" != . ]; do
    [ ! -d "$d/.hostjobs" ] || return 0
    d="$(dirname "$d")"
  done
  return 1
}
# The real path of P's nearest existing dir, creating nothing: a refused --out leaves no dir in the shared checkout.
near() {
  local d="$1"
  while [ ! -d "$d" ]; do d="$(dirname "$d")"; done
  cd "$d" && pwd -P
}
sha256() { if command -v shasum >/dev/null; then shasum -a 256; else sha256sum; fi | cut -d' ' -f1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --runs) need "$@"; RUNS="$2"; shift 2 ;;
    --tag) need "$@"; TAG="$2"; shift 2 ;;
    --out) need "$@"; OUT="$2"; shift 2 ;;
    --sha) need "$@"; SHA="$2"; shift 2 ;;
    --jobs) need "$@"; JOBS="$2"; shift 2 ;;
    --timeout) need "$@"; TIMEOUT="$2"; shift 2 ;;
    --interval) need "$@"; INTERVAL="$2"; shift 2 ;;
    --no-prelude) PRELUDE=0; shift ;;
    --no-sampler) SAMPLER=0; shift ;;
    --allow-mailroom) ALLOW_MAILROOM=1; shift ;;
    --against) need "$@"; AGAINST="$2"; shift 2 ;;
    --runner) need "$@"; RUNNER="$2"; shift 2 ;;
    --plans) need "$@"; PLANS="$2"; shift 2 ;;
    -h | --help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument $1 (--help)" ;;
  esac
done

# --- arguments ----------------------------------------------------------------------------------------------------
[[ "$RUNS" =~ ^[1-9][0-9]*$ ]] && [ "$RUNS" -ge 1 ] && [ "$RUNS" -le 50 ] || die "--runs takes 1–50"
[[ "$INTERVAL" =~ ^[0-9]+(\.[0-9]+)?$ ]] || die "--interval takes seconds"
[ -z "$TIMEOUT" ] || { [[ "$TIMEOUT" =~ ^[1-9][0-9]*$ ]] && [ "$TIMEOUT" -ge 60 ] && [ "$TIMEOUT" -le 600 ]; } || die "--timeout takes 60–600 (sim.sh's own range)"
[ "$SHA" = auto ] || [[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || die "--sha takes auto or a 40-hex commit"
[[ "$TAG" =~ ^[a-z0-9-]{0,20}$ ]] || die "--tag takes up to 20 of a-z 0-9 -"
[ -f "$PLANS" ] && jq -e '.jobs | length > 0' "$PLANS" >/dev/null 2>&1 || die "no plans at $PLANS (pnpm sim-bench:plans)"
[ -f "$RUNNER" ] || die "no runner at $RUNNER"
[ -f "$(dirname "$RUNNER")/jobs/sim.sh" ] || die "no jobs/sim.sh beside $RUNNER (the runner sources it from there)"
[ -z "$AGAINST" ] || [ -f "$AGAINST" ] || die "no summary at $AGAINST"
[ -n "$TIMEOUT" ] || TIMEOUT="$(jq -r '.timeoutSec' "$PLANS")"
ALL_JOBS="$(jq -r '[.jobs[].name] | join(",")' "$PLANS")"
[ -n "$JOBS" ] || JOBS="$ALL_JOBS"
for j in $(printf '%s' "$JOBS" | tr ',' ' '); do
  case ",$ALL_JOBS," in *",$j,"*) ;; *) die "--jobs: no job $j in $PLANS (have $ALL_JOBS)" ;; esac
done
[ -n "$TAG" ] || TAG="$(hostname -s 2>/dev/null | tr 'A-Z' 'a-z' | tr -cd 'a-z0-9-' | cut -c1-20)"
[ -n "$TAG" ] || TAG=mac

# --- preflight: refuse (75) before anything runs ------------------------------------------------------------------
if [ "$(uname)" != Darwin ] && [ "${SIM_BENCH_FIXTURE:-}" != 1 ]; then
  die "the bench drives the iOS Simulator: run it on a Mac (SIM_BENCH_FIXTURE=1 is the container's fixture mode)"
fi
# Never run code, or keep the job inbox, where the container can write: on the main Mac that's the shared checkout.
# The bench runs from a tarball at a reviewed commit in a Mac-only dir, and writes results there (SIM-BENCH.md → Setup).
if [ "${SIM_BENCH_FX_ALLOW_SHARE:-}" != 1 ] || [ "${SIM_BENCH_FIXTURE:-}" != 1 ] || [ "$(uname)" = Darwin ]; then
  for p in "$MR" "$(cd "$(dirname "$RUNNER")" && pwd -P)" "$(cd "$(dirname "$PLANS")" && pwd -P)"; do
    ! in_share "$p" || die "$p is inside a checkout the mailroom shares with the container — run the bench from a tarball in a Mac-only dir (docs/ops/SIM-BENCH.md → Setup)"
  done
  ! in_share "$(near "$OUT")" \
    || die "--out $OUT is inside the shared checkout — write results to a Mac-only dir, then move them (docs/ops/SIM-BENCH.md → Results)"
fi
for t in jq axe xcrun security curl; do
  p="$(command -v "$t" 2>/dev/null)" || die "no $t on PATH ($PATH) — docs/ops/SIM-BENCH.md → Setup"
  case "$p" in /usr/local/*) die "$t resolves to $p (Intel Homebrew); the bench needs the native one in /opt/homebrew/bin" ;; esac
done
security find-generic-password -s "$KEYCHAIN" -a "$EMAIL" >/dev/null 2>&1 \
  || die "no Keychain item $KEYCHAIN for $EMAIL — docs/ops/IOS-CHECK.md → Setup (the sign-in prelude types it)"
# The installed mailroom drives the same sim by name: a container devcheck arriving mid-bench would interleave jobs.
if [ "$ALLOW_MAILROOM" != 1 ] && launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  die "the mailroom agent is loaded here and drives the same sim — in a quiet window dispatch names: launchctl bootout gui/\$(id -u)/$LABEL (bootstrap it again after), or --allow-mailroom"
fi
if [ -d "$MAILROOM_STATE/lock" ] && [ -z "$(find "$MAILROOM_STATE/lock" -maxdepth 0 -mmin +15 2>/dev/null)" ]; then
  die "the mailroom is running a job right now ($MAILROOM_STATE/lock is fresh) — wait for it"
fi

# dev's served build: the shell's <meta name="aperture-build">, re-read before every job (another lane may deploy).
served_sha() {
  curl -sS --max-time 15 -H 'cache-control: no-cache' "$ORIGIN/" 2>/dev/null \
    | grep -o '<meta name="aperture-build" content="[0-9a-f]\{40\}"' | head -1 | sed 's/.*content="\([0-9a-f]*\)"/\1/'
}
CUR_SHA="$SHA"
if [ "$SHA" = auto ]; then
  CUR_SHA="$(served_sha)"
  [[ "$CUR_SHA" =~ ^[0-9a-f]{40}$ ]] || die "no build marker at $ORIGIN/ — is dev up? (or pass --sha <40 hex>)"
fi

# --- the results dir ----------------------------------------------------------------------------------------------
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT" || die "can't make $OUT"
RD="$(cd "$OUT" && pwd -P)/$STAMP-$TAG"
mkdir "$RD" || die "$RD exists"
mkdir -p "$RD/hostjobs/inbox" "$RD/hostjobs/results" "$RD/state" "$RD/staging"
HJ="$(cd "$RD/hostjobs" && pwd -P)" # the real path: runner.sh refuses one that resolves elsewhere
ST="$RD/state"
LOG="$RD/bench.log"
: >"$RD/runs.jsonl"
: >"$RD/samples.jsonl"
cp -- "$PLANS" "$RD/plans.json" # what was replayed, beside what it measured

# machine.json: what ran where. A command this Mac lacks reads null, never an abort.
q() { "$@" 2>/dev/null | head -c 2000 || true; }
# simctl's JSON runs to many KB: filtered whole through jq, never truncated
runtimes_j() {
  local o
  o="$(xcrun simctl list runtimes -j 2>/dev/null | jq -c '[.runtimes[]? | select((.name // "") | startswith("iOS")) | {name, version, buildversion, isAvailable}]' 2>/dev/null)"
  [ -n "$o" ] && echo "$o" || echo '[]'
}
device_j() {
  local o
  o="$(xcrun simctl list devices -j 2>/dev/null | jq -c --arg n aperture-devcheck '[(.devices // {}) | to_entries[] | .key as $rt | .value[]
    | select(.name == $n) | {udid, state, deviceTypeIdentifier, runtime: ($rt | sub(".*SimRuntime\\."; ""))}] | first' 2>/dev/null)"
  [ -n "$o" ] && echo "$o" || echo null
}
# The sim.sh that runs is the one beside the runner (runner.sh sources $(dirname runner)/jobs/*.sh).
SIM_SH_SHA="$(sha256 <"$(dirname "$RUNNER")/jobs/sim.sh")"
RUNNER_SHA="$(sha256 <"$RUNNER")"
# A tarball has no .git: never let git walk up into an unrelated repo above it (a git-tracked home).
CEIL="$(dirname "$(dirname "$(dirname "$MR")")")" # above the repo root, so its own .git is still found
REPO_SHA="$(GIT_CEILING_DIRECTORIES="$CEIL" git -C "$MR" rev-parse HEAD 2>/dev/null || echo unknown)"
REPO_DIRTY="$(GIT_CEILING_DIRECTORIES="$CEIL" git -C "$MR" status --porcelain -- . 2>/dev/null | head -1)"
jq -n --arg tag "$TAG" --arg stamp "$STAMP" --arg host "$(q hostname -s)" \
  --arg macos "$(q sw_vers -productVersion)" --arg macbuild "$(q sw_vers -buildVersion)" \
  --arg model "$(q sysctl -n hw.model)" --arg mem "$(q sysctl -n hw.memsize)" --arg cpu "$(q sysctl -n machdep.cpu.brand_string)" \
  --arg ncpu "$(q sysctl -n hw.ncpu)" --arg xcode "$(q xcodebuild -version | tr '\n' ' ')" --arg axe "$(q axe --version)" \
  --argjson runtimes "$(runtimes_j)" --argjson device "$(device_j)" \
  --arg simsh "$SIM_SH_SHA" --arg runner "$RUNNER_SHA" --arg repo "$REPO_SHA" --arg dirty "$REPO_DIRTY" \
  --arg plans "$(sha256 <"$PLANS")" --arg origin "$ORIGIN" --arg sha "$SHA" \
  --argjson runs "$RUNS" --arg jobs "$JOBS" --argjson timeout "$TIMEOUT" --arg interval "$INTERVAL" \
  --argjson prelude "$PRELUDE" --argjson sampler "$SAMPLER" '
  def nz: if . == "" then null else . end;
  {tag: $tag, startedAt: ($stamp | strptime("%Y%m%dT%H%M%SZ") | todate), host: ($host | nz),
   macos: ($macos | nz), macosBuild: ($macbuild | nz), model: ($model | nz),
   memGB: (if $mem == "" then null else (($mem | tonumber) / 1073741824 | . * 10 | round / 10) end),
   cpu: ($cpu | nz), ncpu: (if $ncpu == "" then null else ($ncpu | tonumber) end),
   xcode: ($xcode | sub(" +$"; "") | nz), axe: ($axe | sub("\n$"; "") | nz),
   runtimes: $runtimes, device: $device,
   simShSha256: $simsh, runnerSha256: $runner, plansSha256: $plans, repoSha: $repo, repoDirty: ($dirty != ""),
   origin: $origin,
   args: {runs: $runs, jobs: ($jobs | split(",")), timeoutSec: $timeout, interval: ($interval | tonumber),
     prelude: ($prelude == 1), sampler: ($sampler == 1), sha: $sha},
   gaps: ["powermetrics: needs sudo, not sampled", "temperature: no sudo-free reading on Apple Silicon; pmset -g therm (warning levels only) is sampled instead"]}' \
  >"$RD/machine.json"

SPID=""
RPID=""
# The runner runs in its own process group (set -m below), so a stop takes its axe/simctl grandchildren too.
# CONT after TERM: a member stopped on the terminal would otherwise hold the signal pending and `wait` forever.
stop_runner() {
  kill -TERM -- "-$1" 2>/dev/null || kill -TERM "$1" 2>/dev/null || true
  kill -CONT -- "-$1" 2>/dev/null || true
}
cleanup() {
  [ -z "$RPID" ] || stop_runner "$RPID"
  [ -z "$SPID" ] || kill "$SPID" 2>/dev/null || true
  rm -f -- "$RD/sampler.pid"
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM HUP
# Awake for the whole bench, not only inside each job (sim.sh's own caffeinate ends with the job's runner).
if [ "$(uname)" = Darwin ]; then caffeinate -is -w $$ >/dev/null 2>&1 & fi
if [ "$SAMPLER" = 1 ]; then
  /bin/bash "$HERE/sampler.sh" "$RD/samples.jsonl" "$INTERVAL" >>"$LOG" 2>&1 &
  SPID=$!
  echo "$SPID" >"$RD/sampler.pid"
fi

say "sim-bench: $TAG · $RUNS runs of $JOBS · dev build ${CUR_SHA:0:7} · sim.sh ${SIM_SH_SHA:0:12} · repo ${REPO_SHA:0:12}"
say "results: $RD"

# --- one job: an envelope into the private inbox, the real runner drains it, one line into runs.jsonl ---------------
SEQ=0
ABORT=""
run_job() { # NAME RUN STEPS_JSON TIMEOUT
  local name="$1" run="$2" steps="$3" tmo="$4" id f t0 now last="" line res st rs dt ms kill_after
  SEQ=$((SEQ + 1))
  if [ "$SHA" = auto ]; then
    local s
    s="$(served_sha)"
    if [[ "$s" =~ ^[0-9a-f]{40}$ ]]; then
      [ "$s" = "$CUR_SHA" ] || say "  dev's build changed: ${CUR_SHA:0:7} → ${s:0:7}"
      CUR_SHA="$s"
    else
      say "  couldn't read dev's build marker; keeping ${CUR_SHA:0:7}"
    fi
  fi
  id="$(date -u +%Y%m%dT%H%M%SZ)-ios-bench-$(printf '%03d' "$SEQ")-r$run-$name" # …Z-ios-…: the slow lane takes only those
  f="$RD/staging/$id.json"
  jq -n --arg id "$id" --arg sha "$CUR_SHA" --argjson t "$tmo" --argjson steps "$steps" \
    '{v: 1, id: $id, job: "sim", submittedAt: (now | floor | todate), expiresInMin: 60,
      params: {sha: $sha, timeoutSec: $t, shutdown: false, steps: $steps}}' >"$f"
  mv -- "$f" "$HJ/inbox/$id.json"
  t0="$(date +%s)"
  kill_after="${SIM_BENCH_KILL_AFTER:-$((tmo + 120))}" # sim.sh stops itself at the budget; this is the backstop
  # A process group of its own, led by the runner's PID. stdin from /dev/null as under launchd: with -m, bash no longer
  # does that for `&`, and sim.sh hands its stdin to every axe/simctl call (sim_cap), so a tty there could stop the group.
  set -m
  bash "$RUNNER" "$HJ" "$ST" slow </dev/null >>"$LOG" 2>&1 & # the slow lane: it drives the Simulator, and takes only state/lock
  RPID=$!
  set +m
  while kill -0 "$RPID" 2>/dev/null; do
    now="$(date +%s)"
    if [ $((now - t0)) -gt "$kill_after" ]; then
      say "  $name: no result $kill_after s in — stopping the runner (process group $RPID)"
      stop_runner "$RPID"
      break
    fi
    line="$(jq -r '"op \(.i + 1)/\(.of) \(.op)"' "$HJ/results/$id/progress.json" 2>/dev/null || true)"
    if [ -n "$line" ] && [ "$line" != "$last" ]; then
      printf '  r%s %-13s %s\n' "$run" "$name" "$line"
      last="$line"
    fi
    command sleep "$POLL"
  done
  wait "$RPID" 2>/dev/null
  RPID=""
  # Both dirs are the bench's own: a job the runner never drained must not run inside the next job's budget, and a
  # stopped runner's lock must not turn the next 15 minutes of runners away.
  rm -f -- "$HJ"/inbox/*.json
  rmdir "$ST/lock" 2>/dev/null || true
  res="$HJ/results/$id/result.json"
  line=""
  [ ! -f "$res" ] || line="$(jq -ce --argjson run "$run" --arg job "$name" --arg sha "$CUR_SHA" \
    'select(type == "object" and (.status | type) == "string")
     | {run: $run, job: $job, id, sha: $sha, status, reason, detail: (.detail // null), durationMs, booted: (.booted // null),
        signedIn: (.signedIn // null), buildsSeen: (.buildsSeen // []), startedAt, finishedAt}' "$res" 2>/dev/null)" || line=""
  if [ -z "$line" ]; then # none, or one that isn't the runner's: recorded, never skipped
    line="$(jq -cn --argjson run "$run" --arg job "$name" --arg id "$id" --arg sha "$CUR_SHA" --argjson ms "$((($(date +%s) - t0) * 1000))" \
      --arg why "$([ -f "$res" ] && echo BAD_RESULT || echo NO_RESULT)" \
      '{run: $run, job: $job, id: $id, sha: $sha, status: "error", reason: $why, detail: null, durationMs: $ms}')"
  fi
  printf '%s\n' "$line" >>"$RD/runs.jsonl"
  { IFS= read -r st; read -r rs; read -r dt; read -r ms; } <<<"$(tail -1 "$RD/runs.jsonl" | jq -r '.status, (.reason // "-"), (.detail // "-"), .durationMs')"
  printf 'r%s %-13s %-6s %7.1f s  %s\n' "$run" "$name" "$st" "$(jq -nr --argjson ms "$ms" '$ms / 1000')" \
    "$([ "$st" = pass ] || printf '%s/%s' "$rs" "$dt")"
  # The sim can't run at all: every later job would say the same, so stop and say why.
  case "$rs/$dt" in
    PASSWORD_MISSING/* | */SIM_MISSING | */SIM_AMBIGUOUS | */PROFILE_MISMATCH | */DEVICE_HUB | */AXE_MISSING | */WEBCLIP_MISSING | */AXE_VERSION*)
      ABORT="$name: $rs/$dt — the sim can't run (docs/ops/IOS-CHECK.md → Setup)" ;;
  esac
  if [ "$run" = 0 ] && [ "$st" != pass ] && [ -z "$ABORT" ]; then ABORT="the sign-in prelude ended $st $rs/$dt — read $HJ/results/$id/"; fi
}

if [ "$PRELUDE" = 1 ]; then
  run_job prelude 0 "$(jq -c '.prelude.steps' "$PLANS")" "$(jq -r '.prelude.timeoutSec' "$PLANS")"
fi
r=1
while [ -z "$ABORT" ] && [ "$r" -le "$RUNS" ]; do
  for j in $(printf '%s' "$JOBS" | tr ',' ' '); do
    run_job "$j" "$r" "$(jq -c --arg j "$j" '.jobs[] | select(.name == $j) | .steps' "$PLANS")" "$TIMEOUT"
    [ -z "$ABORT" ] || break
  done
  r=$((r + 1))
done

cleanup
SPID=""
[ -z "$ABORT" ] || { say "sim-bench: aborted — $ABORT"; jq -n --arg a "$ABORT" '{aborted: $a}' >"$RD/aborted.json"; }
if [ -n "$AGAINST" ]; then
  /bin/bash "$HERE/summarize.sh" "$RD" --against "$AGAINST" || say "sim-bench: the summary failed — rerun: /bin/bash $HERE/summarize.sh $RD"
else
  /bin/bash "$HERE/summarize.sh" "$RD" || say "sim-bench: the summary failed — rerun: /bin/bash $HERE/summarize.sh $RD"
fi
say "summary: $RD/summary.md"
say "bring it back: AirDrop $RD to the main Mac, then move it into the checkout's localNotes/sim-bench/ (docs/ops/SIM-BENCH.md → Results)"
[ -z "$ABORT" ] || exit 1
exit 0
