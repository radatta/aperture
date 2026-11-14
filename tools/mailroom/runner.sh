#!/bin/bash
# The Mac mailroom's clerk: drains <hostjobs>/inbox, runs each allowlisted job, writes <hostjobs>/results/<id>/.
# launchd runs the INSTALLED copy (~/Library/Application Support/aperture-mailroom/bin/) — never this file in the
# repo, which the container can write. Jobs are data: validated with jq, run with argv arrays, no eval/sh -c.
# Bash 3.2 (macOS /bin/bash) + jq + curl + security, all builtin on macOS 15+; the sim job adds AXe (Homebrew) and
# Xcode's simctl. Design: docs/ops/MAILROOM.md, docs/ops/IOS-CHECK.md.
#
#   runner.sh <hostjobs-dir> <state-dir> [slow|fast]   paths absolute; the plists pass them (install.sh renders two)
# Two launchd agents drain the one inbox: the slow lane runs SLOW_JOBS (the Simulator), the fast lane everything else,
# so a clip or an open-pr never waits behind a sim run. No lane = both locks, today's single drain (bench, hand runs).
set -euo pipefail
umask 077
export LC_ALL=C # deterministic globs and regexes, as under launchd

HJ="${1:?usage: runner.sh <hostjobs-dir> <state-dir>}"
STATE="${2:?usage: runner.sh <hostjobs-dir> <state-dir>}"
LANE="${3:-all}"
case "$LANE" in slow | fast | all) ;; *) echo "usage: runner.sh <hostjobs-dir> <state-dir> [slow|fast]" >&2; exit 1 ;; esac
HERE="$(cd "$(dirname "$0")" && pwd -P)"
JOBS="open-pr sim clip" # the allowlist; each has jobs/<name>.sh defining validate_<name> and run_<name> (- → _)
SLOW_JOBS="sim"         # the slow lane's; every other job, and anything unparseable, is the fast lane's
MAX_FILE=73728 # 72 KiB per job file
MAX_PER_DRAIN=5 # per lane, counting only the entries this lane takes
ID_RE='^[0-9]{8}T[0-9]{6}Z-[a-z0-9-]{1,48}$'
RUNNER_VERSION="$(cat "$HERE/VERSION" 2>/dev/null || echo dev)"

now_iso() { jq -nr 'now | todate'; }
now_ms() { jq -nr 'now * 1000 | floor'; }
log() { if [ "$LANE" = all ]; then printf '%s %s\n' "$(now_iso)" "$*"; else printf '%s %s %s\n' "$(now_iso)" "$LANE" "$*"; fi; }
sha256() { if command -v shasum >/dev/null; then shasum -a 256; else sha256sum; fi | cut -d' ' -f1; }

# --- pin the shared directories: refuse symlinks, then work relative to a pinned cwd ------------------------
for d in "$HJ" "$HJ/inbox" "$HJ/results"; do
  if [ -L "$d" ] || [ ! -d "$d" ]; then
    log "refusing: $d is missing or a symlink"
    exit 1
  fi
done
HJ_REAL="$(cd "$HJ" && pwd -P)"
# The plist passes the real path (install.sh resolves it), so any difference means .hostjobs was swapped meanwhile.
if [ "$HJ_REAL" != "$HJ" ]; then
  log "refusing: $HJ resolves elsewhere ($HJ_REAL)"
  exit 1
fi
# A work dir per lane: the two lanes' drains run at once, and each clears and deletes $WORK/<stem>.* freely.
WD=work
[ "$LANE" = all ] || WD="work-$LANE"
mkdir -p "$STATE/$WD" "$STATE/rejected"
WORK="$(cd "$STATE/$WD" && pwd -P)"
REJECTED="$(cd "$STATE/rejected" && pwd -P)"

# --- one drain per lane -------------------------------------------------------------------------------------
# lock is the slow lane's (the sim job touches it per op, so a long run never reads as stale); lock-fast the fast
# lane's, whose jobs are capped well under 5 min. A held lock exits 0: launchd re-fires while the inbox is non-empty.
HELD=""
trap 'for l in $HELD; do rmdir "$l" 2>/dev/null || true; done' EXIT
take_lock() { # NAME STALE_MIN → 0 held, 1 another drain of this lane is running
  if ! mkdir "$STATE/$1" 2>/dev/null; then
    if [ -n "$(find "$STATE/$1" -maxdepth 0 -mmin +"$2" 2>/dev/null)" ] && rmdir "$STATE/$1" && mkdir "$STATE/$1"; then
      log "took a stale $1"
    else
      return 1
    fi
  fi
  HELD="$HELD $STATE/$1"
}
case "$LANE" in
  slow) take_lock lock 15 || exit 0 ;;
  fast) take_lock lock-fast 5 || exit 0 ;;
  all) { take_lock lock 15 && take_lock lock-fast 5; } || exit 0 ;;
esac

# --- lanes ----------------------------------------------------------------------------------------------------
lane_of_job() { case " $SLOW_JOBS " in *" $1 "*) echo slow ;; *) echo fast ;; esac; }
# mr_cap SECS CMD… — run CMD, stopped after SECS (macOS has no timeout(1)); 124 when stopped. jobs/sim.sh's sim_cap
# shape: `command sleep` (the fixtures stub sleep), and the watchdog's output detached, so a $(…) never waits on it.
mr_cap() {
  local cap="$1" pid wd rc
  shift
  "$@" &
  pid=$!
  (command sleep "$cap" && kill -TERM "$pid" 2>/dev/null) >/dev/null 2>&1 &
  wd=$!
  rc=0
  wait "$pid" || rc=$?
  pkill -P "$wd" 2>/dev/null || true
  kill "$wd" 2>/dev/null || true
  wait "$wd" 2>/dev/null || true
  if [ "$rc" = 143 ]; then return 124; fi
  return "$rc"
}
# peek_lane ENTRY → slow|fast|gone: a routing hint read from the shared file. Capped, so a FIFO swapped in under the -f
# check costs one drain 3 s, never a hang; the snapshot's job field, checked after the move, is what decides. Gone: the
# other lane moved it out after this drain listed the inbox. A link, a non-file or one over MAX_FILE (judged without
# opening it) is the fast lane's, which refuses it.
peek_lane() {
  local j=""
  if [ ! -e "$1" ] && [ ! -L "$1" ]; then
    echo gone
    return 0
  fi
  if [ -L "$1" ] || [ ! -f "$1" ] || [ -z "$(find "$1" -maxdepth 0 -size -$((MAX_FILE + 1))c 2>/dev/null)" ]; then
    echo fast
    return 0
  fi
  j="$(mr_cap 3 jq -rs 'if length == 1 and (.[0] | type) == "object" then (.[0].job | strings) else empty end' "$1" 2>/dev/null)" || j=""
  lane_of_job "$j"
}

# Park anything we won't parse in rejected/ (Mac-side), under a name we choose.
park() { mv -- "$1" "$REJECTED/$(date -u +%Y%m%dT%H%M%SZ)-$$-$RANDOM" 2>/dev/null || rm -f -- "$1" 2>/dev/null || true; }

# --- results: mkdir under a pinned cwd, re-verify, write with noclobber; the content never echoes job text ---
# The result dir is made once per job: before the run (make_rdir: a job's artifacts and heartbeat go there, and the
# container takes its existence as the pickup), or by write_result for a job refused before it ran.
RDIR_MADE=""
make_rdir() {
  local id="$1"
  (
    cd "$HJ_REAL/results" && [ "$(pwd -P)" = "$HJ_REAL/results" ] || exit 1
    mkdir "./$id" 2>/dev/null || exit 1
  ) || {
    log "$id DUPLICATE or results dir moved — not run"
    return 1
  }
  RDIR_MADE="$id"
}
write_result() {
  local id="$1" json="$2"
  (
    cd "$HJ_REAL/results" && [ "$(pwd -P)" = "$HJ_REAL/results" ] || {
      log "$id results dir moved — not written"
      exit 1
    }
    [ "$RDIR_MADE" = "$id" ] || mkdir "./$id" 2>/dev/null || {
      log "$id DUPLICATE — results/$id exists"
      exit 1
    }
    cd "./$id" && [ "$(pwd -P)" = "$HJ_REAL/results/$id" ] || {
      log "$id result dir swapped — not written"
      exit 1
    }
    if [ -e result.json ] || [ -L result.json ]; then
      log "$id result.json pre-exists — not written"
      exit 1
    fi
    set -C
    printf '%s\n' "$json" >result.json
  ) || true
}

# result ID STATUS REASON STARTED_MS [EXTRA_JSON] — EXTRA_JSON holds only fields a job built from anchored values.
# The job name is the validated one ($job), or null for a file refused before its envelope was read.
result() {
  local id="$1" status="$2" reason="$3" started="$4" extra="${5:-}" fin
  [ -n "$extra" ] || extra='{}'
  fin="$(now_ms)"
  write_result "$id" "$(jq -cn --arg id "$id" --arg status "$status" --arg reason "$reason" --arg job "${job:-}" \
    --argjson started "$started" --argjson fin "$fin" --arg rv "$RUNNER_VERSION" --argjson extra "$extra" \
    '{v: 1, id: $id, job: (if $job == "" then null else $job end), status: $status, reason: (if $reason == "" then null else $reason end),
      startedAt: ($started / 1000 | floor | todate), finishedAt: ($fin / 1000 | floor | todate),
      durationMs: ($fin - $started), runnerVersion: $rv} + $extra')"
  log "$id $status ${reason:-ok} $((fin - started))ms"
}

status_of() {
  case "$1" in
    EXPIRED) echo expired ;;
    TOKEN_* | API_FAILED | RATE_LIMITED | TIMEOUT | WRONG_AUTHOR) echo error ;;
    *) echo rejected ;;
  esac
}

# The envelope check every job shares: prints a reason code, or nothing when the envelope is good.
# Same order as scripts/src/mailroom/job.ts → validateJob (the fixtures run both).
ENVELOPE_JQ='try (
  if type != "object" then "BAD_JSON"
  elif (keys - ["v","id","job","submittedAt","expiresInMin","params"]) != [] or .v != 1 then "BAD_JSON"
  elif .id != $stem then "BAD_ID"
  elif .job as $j | ($j | type) != "string" or ($jobs | split(" ") | index($j)) == null then "UNKNOWN_JOB"
  elif (.submittedAt | type) != "string"
    or (.submittedAt | contains("\n")) or (.submittedAt | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$") | not)
    or (.expiresInMin | type) != "number" or .expiresInMin != (.expiresInMin | floor)
    or .expiresInMin < 1 or .expiresInMin > 60 then "BAD_PARAM"
  elif (.submittedAt | fromdateiso8601) > (now + 300) then "EXPIRED"
  elif (.submittedAt | fromdateiso8601) + .expiresInMin * 60 < now then "EXPIRED"
  else empty end
) catch "BAD_PARAM"'

# The jobs are sourced at the first entry this drain takes: the fast agent re-fires every 2 s while a sim waits for the
# slow lane, and such a drain should cost a few peeks, not a parse of every job file.
SOURCED=""
MAX_PEEKS=50 # entries a lane drain looks at, its own or not

# --- drain --------------------------------------------------------------------------------------------------
cd "$HJ_REAL/inbox" && [ "$(pwd -P)" = "$HJ_REAL/inbox" ] || {
  log "inbox moved"
  exit 1
}
shopt -s nullglob dotglob
n=0
peeks=0
for entry in ./*; do
  [ "$n" -lt "$MAX_PER_DRAIN" ] || break
  if [ "$LANE" != all ]; then
    [ "$peeks" -lt "$MAX_PEEKS" ] || break
    peeks=$((peeks + 1))
    [ "$(peek_lane "$entry")" = "$LANE" ] || continue # the other lane's, or gone: left in the inbox
  fi
  if [ -z "$SOURCED" ]; then
    for f in "$HERE"/jobs/*.sh; do . "$f"; done
    SOURCED=1
  fi
  n=$((n + 1))
  name="${entry#./}"
  stem="${name%.json}"
  started="$(now_ms)"
  job=""
  if ! [[ "$name" == *.json && "$stem" =~ $ID_RE ]]; then
    park "$entry"
    log "rejected an entry with a bad name"
    continue
  fi
  # Out of the shared folder, then a private copy. The moved file can still be the container's inode (a hard link,
  # or a handle opened before the move), so everything below reads only the snapshot: a file the runner created.
  moved="$WORK/$stem.moved"
  w="$WORK/$stem.json"
  for f in "$moved" "$w"; do if [ -e "$f" ] || [ -L "$f" ]; then park "$f"; fi; done
  mv -- "$entry" "$moved" || {
    log "$stem could not be moved out — skipped"
    continue
  }
  # A re-sent id runs nothing: its result dir exists (the original's, or one the container made to block it).
  if [ -e "$HJ_REAL/results/$stem" ] || [ -L "$HJ_REAL/results/$stem" ]; then
    park "$moved"
    log "$stem DUPLICATE — results/$stem exists, not run"
    continue
  fi
  if [ -L "$moved" ] || [ ! -f "$moved" ] || [ -z "$(find "$moved" -maxdepth 0 -links 1)" ]; then
    park "$moved"
    result "$stem" rejected BAD_FILE "$started"
    continue
  fi
  if ! (set -C && head -c $((MAX_FILE + 1)) <"$moved" >"$w"); then
    park "$moved"
    log "$stem could not be snapshotted — skipped"
    continue
  fi
  rm -f -- "$moved"
  if [ "$(wc -c <"$w" | tr -d ' ')" -gt "$MAX_FILE" ]; then
    rm -f -- "$w"
    result "$stem" rejected TOO_LARGE "$started"
    continue
  fi
  if ! jq -se 'length == 1' "$w" >/dev/null 2>&1; then # exactly one JSON value
    rm -f -- "$w"
    result "$stem" rejected BAD_JSON "$started"
    continue
  fi
  reason="$(jq -r --arg stem "$stem" --arg jobs "$JOBS" "$ENVELOPE_JQ" "$w")"
  if [ -n "$reason" ]; then
    rm -f -- "$w"
    result "$stem" "$(status_of "$reason")" "$reason" "$started"
    continue
  fi
  job="$(jq -r .job "$w")"
  if [ "$LANE" != all ] && [ "$(lane_of_job "$job")" != "$LANE" ]; then
    rm -f -- "$w"
    log "$stem lane changed under the peek"
    result "$stem" rejected BAD_FILE "$started"
    continue
  fi
  fn="${job//-/_}"
  reason="$("validate_$fn" "$w")"
  if [ -n "$reason" ]; then
    rm -f -- "$w"
    result "$stem" "$(status_of "$reason")" "$reason" "$started"
    continue
  fi
  if ! make_rdir "$stem"; then
    rm -f -- "$w"
    continue
  fi
  # run_<job> W PRIVATE_PREFIX RESULT_DIR prints "STATUS REASON EXTRA_JSON" on one line (REASON "-" for none).
  out="$("run_$fn" "$w" "$WORK/$stem" "$HJ_REAL/results/$stem")" || out="error API_FAILED {}"
  rm -f -- "$w" "$WORK/$stem".*
  st="${out%% *}"
  rest="${out#* }"
  rs="${rest%% *}"
  extra="${rest#* }"
  [ "$rs" != "-" ] || rs=""
  result "$stem" "$st" "$rs" "$started" "$extra"
done
