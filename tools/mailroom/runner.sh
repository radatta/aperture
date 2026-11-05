#!/bin/bash
# The Mac mailroom's clerk: drains <hostjobs>/inbox, runs each allowlisted job, writes <hostjobs>/results/<id>/.
# launchd runs the INSTALLED copy (~/Library/Application Support/aperture-mailroom/bin/) — never this file in the
# repo, which the container can write. Jobs are data: validated with jq, run with argv arrays, no eval/sh -c.
# Bash 3.2 (macOS /bin/bash) + jq + curl + security, all builtin on macOS 15+; the sim job adds AXe (Homebrew) and
# Xcode's simctl. Design: docs/ops/MAILROOM.md, docs/ops/IOS-CHECK.md.
#
#   runner.sh <hostjobs-dir> <state-dir>     both absolute; the plist passes them (install.sh renders it)
set -euo pipefail
umask 077
export LC_ALL=C # deterministic globs and regexes, as under launchd

HJ="${1:?usage: runner.sh <hostjobs-dir> <state-dir>}"
STATE="${2:?usage: runner.sh <hostjobs-dir> <state-dir>}"
HERE="$(cd "$(dirname "$0")" && pwd -P)"
JOBS="open-pr sim" # the allowlist; each has jobs/<name>.sh defining validate_<name> and run_<name> (- → _)
MAX_FILE=73728 # 72 KiB per job file
MAX_PER_DRAIN=5
ID_RE='^[0-9]{8}T[0-9]{6}Z-[a-z0-9-]{1,48}$'
RUNNER_VERSION="$(cat "$HERE/VERSION" 2>/dev/null || echo dev)"

now_iso() { jq -nr 'now | todate'; }
now_ms() { jq -nr 'now * 1000 | floor'; }
log() { printf '%s %s\n' "$(now_iso)" "$*"; }
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
mkdir -p "$STATE/work" "$STATE/rejected"
WORK="$(cd "$STATE/work" && pwd -P)"
REJECTED="$(cd "$STATE/rejected" && pwd -P)"

# --- single instance ----------------------------------------------------------------------------------------
if ! mkdir "$STATE/lock" 2>/dev/null; then
  if [ -n "$(find "$STATE/lock" -maxdepth 0 -mmin +15 2>/dev/null)" ] && rmdir "$STATE/lock" && mkdir "$STATE/lock"; then
    log "took a stale lock"
  else
    exit 0 # another drain is running; launchd re-fires while the inbox is non-empty
  fi
fi
trap 'rmdir "$STATE/lock" 2>/dev/null || true' EXIT

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
    TOKEN_* | API_FAILED | RATE_LIMITED | TIMEOUT | WRONG_AUTHOR | SIM_UNAVAILABLE | PASSWORD_MISSING | SIGNIN_FAILED) echo error ;;
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

for f in "$HERE"/jobs/*.sh; do . "$f"; done

# --- drain --------------------------------------------------------------------------------------------------
cd "$HJ_REAL/inbox" && [ "$(pwd -P)" = "$HJ_REAL/inbox" ] || {
  log "inbox moved"
  exit 1
}
shopt -s nullglob dotglob
n=0
for entry in ./*; do
  [ "$n" -lt "$MAX_PER_DRAIN" ] || break
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
