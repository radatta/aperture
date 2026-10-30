#!/bin/bash
# Leases (docs/ops/SESSION-BOARD.md → Leases). Sourced by board.sh and heavy.sh after lib.sh; decisions
# come from scripts/src/board/lease.ts via cli.ts (tested), state changes happen here under the board lock.
#   board.sh lease acquire dev [--wait SEC] [--force] [--note "…"] [--ttl SEC]
#   board.sh lease renew dev | release dev [--force] | status

BOARD_CLI=(node "$SB_REPO/scripts/src/board/cli.ts")
DEV="$BOARD_DIR/leases/dev.json"

lease_me() {  # pid → "start␟name␟branch" (\x1f-separated, so an empty field survives `read`)
  local ps start name branch f="$BOARD_DIR/sessions/$1.json"
  read -r ps start < <(sb_stat "$1")
  name=$(jq -r '.name // empty' "$f" 2>/dev/null); branch=$(jq -r '.branch // empty' "$f" 2>/dev/null)
  [ -n "$branch" ] || branch=$(git branch --show-current 2>/dev/null)
  printf '%s\x1f%s\x1f%s\n' "$start" "${name:-${branch:-pid$1}}" "$branch"
}

lease_event() { sb_append events "$(jq -nc --arg t "$(sb_now)" --argjson e "$1" '{v: 1, t: $t, kind: "lease"} + $e')"; }

# One attempt, under the lock. Exit 0 granted/renewed/taken over, 3 held by someone else.
# $5 = renew: only renew your own lease or resume your branch's gone one — never grant or take over.
_dev_try() {
  local pid="$1" ttl="$2" force="$3" note="$4" mode="${5:-}" start name branch cur req dec kind
  IFS=$'\x1f' read -r start name branch < <(lease_me "$pid")
  [ -n "$branch" ] || { echo "board: dev lease needs a branch (detached HEAD?)" >&2; return 2; }
  cur=$(cat "$DEV" 2>/dev/null); [ -n "$cur" ] || cur=null
  req=$(jq -nc --argjson pid "$pid" --arg start "$start" --arg name "$name" --arg branch "$branch" \
    --argjson ttl "$ttl" --argjson force "$force" '{pid: $pid, start: $start, name: $name, branch: $branch, ttlSec: $ttl, force: $force}')
  dec=$(jq -nc --argjson c "$cur" --argjson r "$req" --arg note "$note" '{current: $c, req: $r, note: $note}' | "${BOARD_CLI[@]}" decide-dev) || return 2
  kind=$(jq -r .kind <<<"$dec")
  if [ "$mode" = renew ] && { [ "$kind" = grant ] || { [ "$kind" = takeover ] && [ "$(jq -r .reason <<<"$dec")" != resumed ]; }; }; then
    echo "board: you don't hold dev — lease acquire dev" >&2; return 3
  fi
  case "$kind" in
    wait)
      jq -r '.holder | "dev held by \(.holderName) (\(.branch)) since \(.acquiredAt), expires \(.expiresAt)\(if .holderGone then " — holder gone; its branch takes it back on restart" else "" end) — --wait <sec> polls, --force takes it (logged)"' <<<"$dec" >&2
      return 3 ;;
    renew)
      jq -c --arg now "$(sb_now)" --argjson ttl "$ttl" --arg note "$note" '
        .expiresAt = (now + $ttl | todate) | .ttlSec = $ttl | del(.holderGone) | if $note != "" then .note = $note else . end' "$DEV" | sb_write "$DEV"
      echo "dev lease renewed ($branch) until $(jq -r .expiresAt "$DEV")" ;;
    grant|takeover)
      sb_init_dirs
      jq -c '.lease // empty' <<<"$dec" | sb_write "$DEV" || { echo "board: couldn't write the dev lease" >&2; return 2; }
      lease_event "$(jq -c --arg k "$kind" '{lease: "dev", action: $k, reason: .reason, previous: (.previous | if . then {holderName, branch, holderPid} else null end)}' <<<"$dec")"
      echo "dev lease: $branch ($name) until $(jq -r .expiresAt "$DEV")"
      if [ "$kind" = takeover ] && [ "$(jq -r .reason <<<"$dec")" != resumed ]; then
        jq -r '"took over from \(.previous.holderName) (\(.previous.branch)) — \(.reason). SendMessage `\(.previous.holderName)`: \"Took the dev lease from you (\(.reason)); tell me if you still need dev.\""' <<<"$dec"
      fi ;;
    *) echo "board: unexpected decision $dec" >&2; return 2 ;;
  esac
}

lease_dev_acquire() {  # pid wait ttl force note
  local pid="$1" wait="$2" ttl="$3" force="$4" note="$5" t0 rc
  t0=$(sb_epoch)
  while :; do
    sb_locked _dev_try "$pid" "$ttl" "$force" "$note"; rc=$?
    [ "$rc" = 3 ] || return "$rc"
    [ $(( $(sb_epoch) - t0 )) -lt "$wait" ] || return 3
    sleep 5
  done
}

_dev_release() {
  local pid="$1" force="$2" holder
  [ -f "$DEV" ] || { echo "dev lease: already free"; return 0; }
  holder=$(jq -r .holderPid "$DEV")
  if [ "$holder" != "$pid" ] && [ "$force" != true ]; then
    echo "board: dev is held by $(jq -r .holderName "$DEV") — only the holder releases it (--force overrides, logged)" >&2; return 3
  fi
  lease_event "$(jq -c --arg f "$force" '{lease: "dev", action: "release", forced: ($f == "true"), holderName, branch}' "$DEV")"
  rm -f "$DEV"; echo "dev lease released"
}

# Hot path (UserPromptSubmit): jq only (node only on a resume), no lock wait beyond a flock. Renews the holder's lease;
# a restarted session on a gone holder's branch takes it back (logged `resumed`) through the tested path.
lease_renew_dev() {
  [ -f "$DEV" ] || return 0
  local pid="$1" branch holder gone
  read -r holder gone < <(jq -r '"\(.holderPid) \(.holderGone // false)"' "$DEV" 2>/dev/null)
  branch=$(jq -r '.branch // empty' "$BOARD_DIR/sessions/$pid.json" 2>/dev/null)
  if [ "$holder" != "$pid" ]; then
    [ "$gone" = true ] && [ -n "$branch" ] && [ "$branch" = "$(jq -r .branch "$DEV")" ] &&
      sb_locked _dev_try "$pid" "$(jq -r .ttlSec "$DEV")" false "" renew >/dev/null 2>&1
    return 0
  fi
  [ -z "$branch" ] || [ "$branch" = "$(jq -r .branch "$DEV")" ] || return 0
  sb_locked sh -c 'jq -c ".expiresAt = (now + .ttlSec | todate) | del(.holderGone)" "$1" >"$1.tmp.$$" && mv -f "$1.tmp.$$" "$1"' _ "$DEV"
}

# SessionEnd: the holder is gone, the lease stays until TTL (answer 4 — dev testing outlives a restart).
lease_end_dev() {
  [ -f "$DEV" ] || return 0
  [ "$(jq -r .holderPid "$DEV" 2>/dev/null)" = "$1" ] || return 0
  sb_locked sh -c 'jq -c ".holderGone = true" "$1" >"$1.tmp.$$" && mv -f "$1.tmp.$$" "$1"' _ "$DEV"
}

# --- heavy slots ---

_heavy_gc() {
  local f wp ws
  for f in "$BOARD_DIR"/leases/heavy/*.json; do
    [ -e "$f" ] || continue
    read -r wp ws < <(jq -r '"\(.wrapperPid) \(.wrapperStart)"' "$f" 2>/dev/null)
    sb_alive "$wp" "$ws" || rm -f "$f"
  done
}

# Who holds the heavy slots (of class $1, if given), for messages: "label (session), …".
_heavy_holders() {
  local f pid cls label name out=
  for f in "$BOARD_DIR"/leases/heavy/*.json; do
    [ -e "$f" ] || continue
    read -r pid cls label < <(jq -r '"\(.pid) \(.class) \(.label // .class)"' "$f" 2>/dev/null)
    [ -z "${1:-}" ] || [ "$cls" = "$1" ] || continue
    name=$(jq -r '.name // empty' "$BOARD_DIR/sessions/$pid.json" 2>/dev/null)
    out="${out:+$out, }$label (${name:-pid $pid})"
  done
  printf '%s' "${out:-nothing on the board}"
}

# The same as JSON, for barrier events: [{pid, name, class, label, startedAt}].
_heavy_holders_json() {
  local f pid
  for f in "$BOARD_DIR"/leases/heavy/*.json; do
    [ -e "$f" ] || continue
    pid=$(jq -r '.pid' "$f" 2>/dev/null)
    jq -c --arg name "$(jq -r '.name // empty' "$BOARD_DIR/sessions/$pid.json" 2>/dev/null)" \
      '{pid, name: (if $name == "" then null else $name end), class, label, startedAt}' "$f" 2>/dev/null
  done | jq -sc '.'
}

# matrix.sh (HEAVY_GUARD) and edge.sh (HEAVY_LOADTEST) probe the edge on purpose: the cap never holds them.
_heavy_is_load() { [ "${HEAVY_GUARD:-0}" = 1 ] || [ "${HEAVY_LOADTEST:-0}" = 1 ]; }

# Under the lock: gc, decide, and on a go write the slot. Prints the decision JSON; exit 0 go, 3 wait.
_heavy_try() {
  local slot="$1" owner="$2" class="$3" label="$4" wp="$5" ws="$6" slots live dec lt=false
  sb_init_dirs; _heavy_gc
  _heavy_is_load && lt=true
  slots=$(cat "$BOARD_DIR"/leases/heavy/*.json 2>/dev/null | jq -sc 'map({pid, class, label, startedAt, wrapperPid})')
  live=$(jq -nc --argjson p "$(cg_pids)" --argjson a "$(cg_anon)" '{pids: $p, anonBytes: $a}')
  dec=$(jq -nc --slurpfile l "$LIMITS_JSON" --argjson pm "$PIDS_MAX" --argjson hi "$MEM_HIGH" --argjson live "$live" \
    --argjson slots "${slots:-[]}" --arg class "$class" --argjson lt "$lt" \
    '{limits: $l[0], liveLimits: {pidsMax: $pm, highBytes: $hi}, live: $live, slots: $slots, req: {class: $class, loadTest: $lt}}' |
    "${BOARD_CLI[@]}" decide-heavy) || { echo '{"verdict":"grant","wait":false,"error":true}'; return 0; }  # fail open
  printf '%s\n' "$dec"
  [ "$(jq -r .wait <<<"$dec")" = true ] && return 3
  [ -n "$slot" ] || return 0  # decide only (the PreToolUse guard)
  jq -nc --argjson pid "$owner" --arg class "$class" --arg label "$label" --argjson wp "$wp" --arg ws "$ws" \
    --argjson cost "$(jq -c --arg c "$class" '.classes[$c] // {pids: 0, anonMiB: 0} | {pids, anonMiB}' "$LIMITS_JSON")" \
    '{v: 1, pid: $pid, class: $class, label: $label, cost: $cost, wrapperPid: $wp, wrapperStart: $ws, startedAt: (now | todate)}' | sb_write "$slot"
}

# A blocking decision plus who holds the slots (outside the lock: 2 jq per slot is too slow to hold it for).
_heavy_with_holders() {
  case "$(jq -r .verdict <<<"$1" 2>/dev/null)" in
    over-hard|cap-full) jq -c --argjson h "$(_heavy_holders_json)" '. + {holders: $h}' <<<"$1" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

# One barrier event (docs/ops/SESSION-BOARD.md → History): action waited | gaveUp | denied | wouldWait, from the
# decision that blocked (its cap, holders and prediction are the cause). args: action decision owner class label
# cmd [waitedSec].
_heavy_event() {
  local action="$1" dec="$2" owner="$3" class="$4" label="$5" cmd="$6" waited="${7:-}" start name branch mix lt=false
  IFS=$'\x1f' read -r start name branch < <(lease_me "$owner")
  mix=$(tail -n 1 "$BOARD_DIR/history/samples-$(sb_today).jsonl" 2>/dev/null | jq -c '.mix' 2>/dev/null)
  _heavy_is_load && lt=true
  lease_event "$(jq -c --arg a "$action" --argjson pid "${owner:-0}" --arg name "$name" --arg branch "$branch" \
    --arg c "$class" --arg l "$label" --arg cmd "${cmd:0:160}" --arg w "$waited" --argjson mix "${mix:-null}" --argjson lt "$lt" '
    {lease: "heavy", action: $a, pid: $pid, name: (if $name == "" then null else $name end),
     branch: (if $branch == "" then null else $branch end), class: $c, label: $l, cmd: $cmd,
     reason: (if .verdict == "cap-full" then "cap" elif .verdict == "lock-busy" then "lock" else "hard" end),
     cap, holders: (.holders // []),
     predicted, thresholds, mix: $mix, loadTest: $lt} + (if $w == "" then {} else {waitedSec: ($w | tonumber)} end)' <<<"$dec")"
}

# heavy.sh's entry: slot owner class label cmd wrapperPid wrapperStart [waitSec]. Waits only with enforce:true,
# while the budget is past hard or the class's concurrency cap is full; exit 75 past the wait — 90 s by default,
# inside the Bash tool's 120 s timeout, so the message reaches Claude (--wait N for longer). Every hold is a
# barrier event (waited / gaveUp; wouldWait when enforce is off).
lease_heavy_acquire() {
  local slot="$1" owner="$2" class="$3" label="$4" cmd="$5" wp="$6" ws="$7" wait="${8:-90}" t0 dec rc v first=
  t0=$(sb_epoch)
  while :; do
    dec=$(sb_locked _heavy_try "$slot" "$owner" "$class" "$label" "$wp" "$ws"); rc=$?
    # The board lock was busy for 5 s — likeliest at a full cap, with every waiter polling. Retry until our own
    # deadline rather than run unslotted (invisible to everyone else's count); fail open only then, logged.
    if [ "$rc" = 75 ]; then
      if [ $(( $(sb_epoch) - t0 )) -lt "$wait" ]; then sleep 2; continue; fi
      _heavy_event lockBusy '{"verdict":"lock-busy"}' "$owner" "$class" "$label" "$cmd" "$(( $(sb_epoch) - t0 ))"
      echo "heavy: the board lock stayed busy for ${wait}s — running without a slot (logged)" >&2
      return 0
    fi
    dec=$(_heavy_with_holders "$dec")
    v=$(jq -r .verdict <<<"$dec" 2>/dev/null)
    if [ "$rc" = 0 ]; then
      case "$v" in
        nudge) jq -r '"heavy: over the soft line (predicted \(.predicted.pids) pids / \(.predicted.anonMiB) MiB vs soft \(.thresholds.pidsSoft) / \(.thresholds.anonSoftMiB)) — running"' <<<"$dec" >&2 ;;
        over-hard) jq -r '"heavy: past the measured edge (predicted \(.predicted.pids) pids / \(.predicted.anonMiB) MiB vs hard \(.thresholds.pidsHard) / \(.thresholds.anonHardMiB)) — running (enforce off; logged as wouldWait)"' <<<"$dec" >&2 ;;
        cap-full) jq -r --arg c "$class" '"heavy: \($c) cap full (\(.cap.running)/\(.cap.max)) — running (enforce off; logged as wouldWait)"' <<<"$dec" >&2 ;;
      esac
      case "$v" in over-hard|cap-full) [ -n "$first" ] || _heavy_event wouldWait "$dec" "$owner" "$class" "$label" "$cmd" ;; esac
      [ -n "$first" ] && _heavy_event waited "$first" "$owner" "$class" "$label" "$cmd" "$(( $(sb_epoch) - t0 ))"
      return 0
    fi
    [ "$rc" = 3 ] || return 0  # lock trouble: fail open, never block work on board plumbing
    if [ -z "$first" ]; then
      first=$dec
      if [ "$v" = cap-full ]; then
        echo "heavy: $class cap full ($(jq -r '"\(.cap.running)/\(.cap.max)"' <<<"$dec"): $(_heavy_holders "$class")) — waiting up to ${wait}s" \
          "for a slot (board.sh status shows who; a slot freed late still runs inside this call — give a full suite a 600 s" \
          "timeout or run it in the background)" >&2
      else
        jq -r '"heavy: past the measured edge (predicted \(.predicted.pids) pids / \(.predicted.anonMiB) MiB vs hard \(.thresholds.pidsHard) / \(.thresholds.anonHardMiB)) — waiting for room (board.sh status shows who)"' <<<"$dec" >&2
      fi
    fi
    if [ $(( $(sb_epoch) - t0 )) -ge "$wait" ]; then
      _heavy_event gaveUp "$first" "$owner" "$class" "$label" "$cmd" "$wait"
      if [ "$(jq -r .verdict <<<"$first")" = cap-full ]; then
        echo "heavy: $class cap still full after ${wait}s — running: $(_heavy_holders "$class") — tell the user (board.sh status)" \
          "rather than retrying; a longer wait is heavy.sh --wait <sec> with the Bash call run in the background." >&2
      else
        echo "heavy: still past the measured edge after ${wait}s — running: $(_heavy_holders) — tell the user (board.sh status)" \
          "rather than retrying; a longer wait is heavy.sh --wait <sec> with the Bash call run in the background." >&2
      fi
      return 75
    fi
    sleep 2
  done
}

cmd_lease() {
  local sub="${1:-status}" kind="${2:-dev}" wait=0 force=false note= ttl= pid
  shift 2 2>/dev/null || shift $#
  while [ $# -gt 0 ]; do
    case "$1" in
      --wait) wait="$2"; shift 2 ;;
      --force) force=true; shift ;;
      --note) note="$2"; shift 2 ;;
      --ttl) ttl="$2"; shift 2 ;;
      *) echo "board: unknown lease option $1" >&2; return 2 ;;
    esac
  done
  [ "$sub" = status ] && { [ -f "$DEV" ] && jq . "$DEV" || echo "dev lease: free"; return 0; }
  [ "$kind" = dev ] || { echo "board: only the dev lease is taken by hand (heavy slots come from heavy.sh)" >&2; return 2; }
  pid=$(me_pid) || { echo "board: no claude ancestor" >&2; return 1; }
  case "$sub" in
    acquire) lease_dev_acquire "$pid" "$wait" "${ttl:-2700}" "$force" "$note" ;;
    renew) sb_locked _dev_try "$pid" "${ttl:-$(jq -r '.ttlSec // 2700' "$DEV" 2>/dev/null || echo 2700)}" false "$note" renew ;;  # keeps its TTL  # renews yours, resumes your branch's gone lease, else 3
    release) sb_locked _dev_release "$pid" "$force" ;;
    *) echo "usage: board.sh lease acquire|renew|release|status dev" >&2; return 2 ;;
  esac
}
