#!/bin/bash
# The Mac mailroom's clerk: drains <hostjobs>/inbox, runs each allowlisted job, writes <hostjobs>/results/<id>/.
# launchd runs the INSTALLED copy (~/Library/Application Support/aperture-mailroom/bin/) — never this file in the
# repo, which the container can write. Jobs are data: validated with jq, run with argv arrays, no eval/sh -c.
# Bash 3.2 (macOS /bin/bash) + jq + curl + security, all builtin on macOS 15+; the sim job adds AXe (Homebrew) and
# Xcode's simctl. Design: docs/ops/MAILROOM.md, docs/ops/IOS-CHECK.md.
#
#   runner.sh <hostjobs-dir> <state-dir> [slow|fast]   paths absolute; the plists pass them (install.sh renders two)
# Two launchd agents drain the one inbox: the slow lane takes the sim jobs (named …Z-ios-…), the fast lane everything
# else, so a clip or an open-pr never waits behind a sim run. No lane = both locks, one drain of everything (a hand run).
set -euo pipefail
umask 077
export LC_ALL=C # deterministic globs and regexes, as under launchd

HJ="${1:?usage: runner.sh <hostjobs-dir> <state-dir> [slow|fast]}"
STATE="${2:?usage: runner.sh <hostjobs-dir> <state-dir> [slow|fast]}"
LANE="${3:-all}"
case "$LANE" in slow | fast | all) ;; *) echo "usage: runner.sh <hostjobs-dir> <state-dir> [slow|fast]" >&2; exit 1 ;; esac
HERE="$(cd "$(dirname "$0")" && pwd -P)"
JOBS="open-pr sim clip" # the allowlist; each has jobs/<name>.sh defining validate_<name> and run_<name> (- → _)
SLOW_JOBS="sim"         # run only holding lock (slow lane): they drive the Simulator
FAST_JOBS="clip"        # run only holding lock-fast (fast lane): they keep state (clip.json's caps)
SLOW_RE='^[0-9]{8}T[0-9]{6}Z-ios-' # the slow lane takes entries named so (sim.ts's ids); open-pr may run in either
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
# lock is the slow lane's, lock-fast the fast lane's. Each held lock is touched before every job (and the sim job touches
# lock per op), so only a crashed drain's lock goes stale: 15 min, and 5 for the fast lane, whose longest job is an
# open-pr's 5 calls × 30 s. A held lock exits 0: launchd re-fires while the inbox is non-empty.
HELD="" # lock names under $STATE, which has a space in it on the Mac (Application Support): always quote the path
trap 'for l in $HELD; do rmdir "$STATE/$l" 2>/dev/null || true; done' EXIT
take_lock() { # NAME STALE_MIN → 0 held, 1 another drain of this lane is running
  if ! mkdir "$STATE/$1" 2>/dev/null; then
    if [ -n "$(find "$STATE/$1" -maxdepth 0 -mmin +"$2" 2>/dev/null)" ] && rmdir "$STATE/$1" && mkdir "$STATE/$1"; then
      log "took a stale $1"
    else
      return 1
    fi
  fi
  HELD="$HELD $1"
}
case "$LANE" in
  slow) take_lock lock 15 || exit 0 ;;
  fast) take_lock lock-fast 5 || exit 0 ;;
  all) { take_lock lock 15 && take_lock lock-fast 5; } || exit 0 ;;
esac

# --- lanes ----------------------------------------------------------------------------------------------------
# The lane of an entry comes from its name alone: nothing in the shared folder is opened before the move. The name is the
# container's word, like the content, so it only routes; the snapshot's job field decides (job_lane_ok).
slow_name() { [[ "$1" == *.json && "${1%.json}" =~ $SLOW_RE ]]; } # no subshell: it runs once per inbox entry
job_lane_ok() { # JOB → 0 when this drain holds the lock the job needs
  case " $SLOW_JOBS " in *" $1 "*) [ "$LANE" != fast ] || return 1 ;; esac
  case " $FAST_JOBS " in *" $1 "*) [ "$LANE" != slow ] || return 1 ;; esac
  return 0
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
# slow lane, and such a drain should cost a directory listing, not a parse of every job file.
SOURCED=""

# --- drain --------------------------------------------------------------------------------------------------
cd "$HJ_REAL/inbox" && [ "$(pwd -P)" = "$HJ_REAL/inbox" ] || {
  log "inbox moved"
  exit 1
}
shopt -s nullglob dotglob
n=0
for entry in ./*; do
  [ "$n" -lt "$MAX_PER_DRAIN" ] || break
  if [ "$LANE" = slow ]; then slow_name "${entry#./}" || continue; fi # the other lane's: left, uncounted
  if [ "$LANE" = fast ]; then ! slow_name "${entry#./}" || continue; fi
  for l in $HELD; do touch "$STATE/$l" 2>/dev/null || true; done
  if [ -z "$SOURCED" ]; then
    for f in "$HERE"/jobs/[!.]*.sh; do . "$f"; done # dotglob is on here: never a stray ._clip.sh
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
  if ! job_lane_ok "$job"; then # a sim not named …Z-ios-…, or a clip that is: never from the container's own code
    rm -f -- "$w"
    log "$stem $job job in the $LANE lane"
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
