#!/bin/bash
# Heavy slots (docs/ops/SESSION-BOARD.md → Leases). Sourced by heavy.sh and the heavy guard after lib.sh; decisions
# come from scripts/src/board/lease.ts via cli.ts (tested), state changes happen here under the board lock.

BOARD_CLI=(node "$SB_REPO/scripts/src/board/cli.ts")

lease_me() {  # pid → "start␟name␟branch" (\x1f-separated, so an empty field survives `read`)
  local ps start name branch f="$BOARD_DIR/sessions/$1.json"
  read -r ps start < <(sb_stat "$1")
  name=$(jq -r '.name // empty' "$f" 2>/dev/null); branch=$(jq -r '.branch // empty' "$f" 2>/dev/null)
  [ -n "$branch" ] || branch=$(git branch --show-current 2>/dev/null)
  printf '%s\x1f%s\x1f%s\n' "$start" "${name:-${branch:-pid$1}}" "$branch"
}

lease_event() { sb_append events "$(jq -nc --arg t "$(sb_now)" --argjson e "$1" '{v: 1, t: $t, kind: "lease"} + $e')"; }

# --- heavy slots ---

_heavy_gc() {  # the same liveness rule every reader counts by (lib.sh sb_slot_live)
  local f
  for f in "$BOARD_DIR"/leases/heavy/*.json; do
    [ -e "$f" ] || continue
    sb_slot_live "$f" || rm -f "$f"
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
# args: slot owner class label wrapperPid wrapperStart [cmd] [blog]. blog=1 (heavy.sh's first decision only) also
# asks decide-heavy to log the log-only budget beside it (SESSION-BOARD.md → Budget); the guard passes neither.
_heavy_try() {
  local slot="$1" owner="$2" class="$3" label="$4" wp="$5" ws="$6" cmd="${7:-}" blog="${8:-0}" slots live dec lt=false
  sb_init_dirs; _heavy_gc
  _heavy_is_load && lt=true
  slots=$(cat "$BOARD_DIR"/leases/heavy/*.json 2>/dev/null | jq -sc 'map({pid, class, label, startedAt, wrapperPid, cmd})')
  live=$(jq -nc --argjson p "$(cg_pids)" --argjson a "$(cg_anon)" '{pids: $p, anonBytes: $a}')
  dec=$(jq -nc --slurpfile l "$LIMITS_JSON" --argjson pm "$PIDS_MAX" --argjson hi "$MEM_HIGH" --argjson live "$live" \
    --argjson slots "${slots:-[]}" --arg class "$class" --argjson lt "$lt" \
    --arg blog "$blog" --arg board "$BOARD_DIR" --arg owner "$owner" --arg label "$label" --arg cmd "${cmd:0:160}" \
    '{limits: $l[0], liveLimits: {pidsMax: $pm, highBytes: $hi}, live: $live, slots: $slots, req: {class: $class, loadTest: $lt}}
     + (if $blog == "1" then {budget: {board: $board, owner: ($owner | tonumber? // 0), label: $label, cmd: $cmd}} else {} end)' |
    "${BOARD_CLI[@]}" decide-heavy) || { echo '{"verdict":"grant","wait":false,"error":true}'; return 0; }  # fail open
  printf '%s\n' "$dec"
  [ "$(jq -r .wait <<<"$dec")" = true ] && return 3
  [ -n "$slot" ] || return 0  # decide only (the PreToolUse guard)
  jq -nc --argjson pid "$owner" --arg class "$class" --arg label "$label" --argjson wp "$wp" --arg ws "$ws" \
    --argjson cost "$(jq -c --arg c "$class" '.classes[$c] // {pids: 0, anonMiB: 0} | {pids, anonMiB}' "$LIMITS_JSON")" \
    --arg cmd "${cmd:0:160}" \
    '{v: 1, pid: $pid, class: $class, label: $label, cost: $cost, wrapperPid: $wp, wrapperStart: $ws, startedAt: (now | todate), cmd: $cmd}' | sb_write "$slot"
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
     predicted, thresholds, mix: $mix, loadTest: $lt} + (if $w == "" then {} else {waitedSec: ($w | tonumber)} end)
     + (if .interrupted then {interrupted: true} else {} end)' <<<"$dec")"
}

# heavy.sh's entry: slot owner class label cmd wrapperPid wrapperStart [waitSec]. Waits only with enforce:true,
# while the budget is past hard or the class's concurrency cap is full; exit 75 past the wait — 90 s by default,
# inside the Bash tool's 120 s timeout, so the message reaches Claude (--wait N for longer). Every hold is a
# barrier event (waited / gaveUp; wouldWait when enforce is off).
lease_heavy_acquire() {
  local rc
  _heavy_acquire "$@"; rc=$?
  trap - INT TERM HUP
  return "$rc"
}

# A held wait killed before it ends (Ctrl-C, a Bash-tool timeout) is still a block: gaveUp, interrupted, the real wait.
_heavy_interrupted() {
  trap '' INT TERM HUP  # ignore, not reset: a second delivery (the gate forwards what the group also got) must not cut the event
  _heavy_event gaveUp "$(jq -c '. + {interrupted: true}' <<<"$1")" "$2" "$3" "$4" "$5" "$(( $(sb_epoch) - $6 ))"
  exit "$7"
}

_heavy_acquire() {
  local slot="$1" owner="$2" class="$3" label="$4" cmd="$5" wp="$6" ws="$7" wait="${8:-90}" t0 dec rc v first= blog=1
  t0=$(sb_epoch)
  while :; do
    dec=$(sb_locked _heavy_try "$slot" "$owner" "$class" "$label" "$wp" "$ws" "$cmd" "$blog" 2>/dev/null); rc=$?
    case "$rc" in 0|3) blog=0 ;; esac  # the budget logs the first real decision of an admission, not every poll
    # The wait is over unless still held (3) or retrying a busy lock: disarm now, so a late signal can't add a
    # second event for this hold (or a gaveUp for a granted run). A signal from here dies as it did before.
    case "$rc" in 3) ;; 75) [ $(( $(sb_epoch) - t0 )) -lt "$wait" ] || trap - INT TERM HUP ;; *) trap - INT TERM HUP ;; esac
    if [ "$rc" = 75 ]; then
      # The board lock was busy for 5 s — likeliest at a full cap, with every waiter polling. Nudge-only
      # (enforce off): never wait on board plumbing. Enforcing: retry until our deadline rather than run unslotted
      # (invisible to everyone else's count). A run that was already held gives up as usual; one that never got
      # a decision fails open, logged as lockBusy.
      [ "${ENFORCE:-false}" = true ] || return 0
      if [ $(( $(sb_epoch) - t0 )) -lt "$wait" ]; then sleep 2 & wait $!; continue; fi
      [ -n "$first" ] && { _heavy_give_up "$first" "$owner" "$class" "$label" "$cmd" "$wait"; return 75; }
      _heavy_event lockBusy '{"verdict":"lock-busy"}' "$owner" "$class" "$label" "$cmd" "$(( $(sb_epoch) - t0 ))"
      echo "heavy: the board lock stayed busy for ${wait}s — running without a slot (logged)" >&2
      return 0
    fi
    # Holders only for a decision we report: the first block, or a run that goes ahead (wouldWait).
    { [ -z "$first" ] || [ "$rc" = 0 ]; } && dec=$(_heavy_with_holders "$dec")
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
    [ "$rc" = 3 ] || return 0  # other lock trouble: fail open, never block work on board plumbing
    if [ -z "$first" ]; then
      first=$dec
      trap '_heavy_interrupted "$first" "$owner" "$class" "$label" "$cmd" "$t0" 130' INT
      trap '_heavy_interrupted "$first" "$owner" "$class" "$label" "$cmd" "$t0" 143' TERM
      trap '_heavy_interrupted "$first" "$owner" "$class" "$label" "$cmd" "$t0" 129' HUP
      if [ "$v" = cap-full ]; then
        echo "heavy: $class cap full ($(jq -r '"\(.cap.running)/\(.cap.max)"' <<<"$dec"): $(_heavy_holders "$class")) — waiting up to ${wait}s" \
          "for a slot (board.sh status shows who; a slot freed late still runs inside this call — give a full suite a 600 s" \
          "timeout or run it in the background)" >&2
      else
        jq -r '"heavy: past the measured edge (predicted \(.predicted.pids) pids / \(.predicted.anonMiB) MiB vs hard \(.thresholds.pidsHard) / \(.thresholds.anonHardMiB)) — waiting for room (board.sh status shows who)"' <<<"$dec" >&2
      fi
    fi
    if [ $(( $(sb_epoch) - t0 )) -ge "$wait" ]; then
      trap - INT TERM HUP
      _heavy_give_up "$first" "$owner" "$class" "$label" "$cmd" "$wait"
      return 75
    fi
    sleep 2 & wait $!  # interruptible: a signal runs the trap at once, not after the sleep
  done
}

# Past the wait: record the hold (from the first blocking decision) and tell Claude to tell the user.
_heavy_give_up() {
  local first="$1" owner="$2" class="$3" label="$4" cmd="$5" wait="$6"
  _heavy_event gaveUp "$first" "$owner" "$class" "$label" "$cmd" "$wait"
  if [ "$(jq -r .verdict <<<"$first")" = cap-full ]; then
    echo "heavy: $class cap still full after ${wait}s — running: $(_heavy_holders "$class") — tell the user (board.sh status)" \
      "rather than retrying; a longer wait is heavy.sh --wait <sec> with the Bash call run in the background." >&2
  else
    echo "heavy: still past the measured edge after ${wait}s — running: $(_heavy_holders) — tell the user (board.sh status)" \
      "rather than retrying; a longer wait is heavy.sh --wait <sec> with the Bash call run in the background." >&2
  fi
}
