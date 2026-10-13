#!/usr/bin/env bash
# Session board CLI — who's doing what in this shared container (docs/ops/SESSION-BOARD.md).
#   board.sh status | json
#   board.sh register | heartbeat working|idle | end | note "<text>"   (hooks; --pid/--sid/--cwd override)
#   board.sh sampler start|restart|stop|status
#   board.sh gc
set -u
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

OPT_PID= OPT_SID= OPT_CWD=
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --pid) OPT_PID="$2"; shift 2 ;;
    --sid) OPT_SID="$2"; shift 2 ;;
    --cwd) OPT_CWD="$2"; shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done
set -- "${args[@]+"${args[@]}"}"

me_pid() { [ -n "$OPT_PID" ] && { printf '%s' "$OPT_PID"; return; }; [ -n "${CLAUDE_PID:-}" ] && { printf '%s' "$CLAUDE_PID"; return; }; sb_claude_pid "$PPID"; }
me_file() { printf '%s/sessions/%s.json' "$BOARD_DIR" "$1"; }

# --- session registry ---

cmd_register() {
  local pid cwd sid start ps branch name f
  pid=$(me_pid) || { echo "board: no claude ancestor" >&2; return 1; }
  cwd="${OPT_CWD:-$(pwd)}"; sid="${OPT_SID:-${CLAUDE_CODE_SESSION_ID:-}}"
  read -r ps start < <(sb_stat "$pid")
  branch=$(git -C "$cwd" branch --show-current 2>/dev/null)
  name="${branch:-${cwd##*/}}"
  sb_init_dirs; f=$(me_file "$pid")
  # SessionStart also fires on resume/compact: keep startedAt/note/lastPromptAt for the same process.
  { [ -f "$f" ] && cat "$f" || echo '{}'; } | jq -c --argjson pid "$pid" --arg start "$start" --arg sid "$sid" \
    --arg name "$name" --arg branch "$branch" --arg cwd "$cwd" --arg now "$(sb_now)" '
    (if .pidStart == $start then . else {} end) as $old |
    {v: 1, pid: $pid, pidStart: $start, sid: $sid, name: $name, branch: $branch, cwd: $cwd,
     startedAt: ($old.startedAt // $now), lastPromptAt: $old.lastPromptAt, lastStopAt: $old.lastStopAt,
     state: ($old.state // "idle"), note: $old.note, updatedAt: $now}' | sb_write "$f"
}

cmd_heartbeat() {
  local state="$1" pid f
  case "$state" in working|idle) ;; *) echo "usage: board.sh heartbeat working|idle" >&2; return 2 ;; esac
  pid=$(me_pid) || return 1
  f=$(me_file "$pid")
  [ -f "$f" ] || cmd_register || return 1
  jq -c --arg s "$state" --arg now "$(sb_now)" \
    '.state = $s | .updatedAt = $now | if $s == "working" then .lastPromptAt = $now else .lastStopAt = $now end' "$f" | sb_write "$f"
  [ "$state" = working ] && lease_renew_dev "$pid"
  return 0
}

cmd_end() {
  local pid f s
  pid=$(me_pid) || return 1
  f=$(me_file "$pid")
  [ -f "$f" ] && jq -c --arg now "$(sb_now)" '.state = "gone" | .endedAt = $now | .updatedAt = $now' "$f" | sb_write "$f"
  for s in "$BOARD_DIR/leases/heavy/$pid"-*.json; do [ -e "$s" ] && rm -f "$s"; done
  lease_end_dev "$pid"
  return 0
}

cmd_note() {
  local pid f
  pid=$(me_pid) || return 1
  f=$(me_file "$pid")
  [ -f "$f" ] || cmd_register || return 1
  jq -c --arg n "$*" --arg now "$(sb_now)" '.note = $n | .updatedAt = $now' "$f" | sb_write "$f"
}

# --- views ---

# In the container: is the sampler holding its lock? Elsewhere (the Mac): did it write in the last 90 s?
sampler_running() {
  if [ -r "$CG/memory.stat" ]; then ! flock -n /tmp/aperture-sampler.lock true 2>/dev/null; return; fi
  local last; last=$(ls -t "$BOARD_DIR"/history/samples-*.jsonl 2>/dev/null | head -n 1)
  [ -n "$last" ] && [ -n "$(find "$last" -mtime -90s 2>/dev/null || find "$last" -mmin -2 2>/dev/null)" ]
}

board_json() {
  local sample leases overlap
  if [ -r "$CG/memory.stat" ]; then
    sample=$(bash "$SB_SCRIPTS/sampler.sh" --print)
  else  # not in the container (the Mac): the sampler's latest tick, read-only
    sample=$(tail -n 1 "$(ls -t "$BOARD_DIR"/history/samples-*.jsonl 2>/dev/null | head -n 1)" 2>/dev/null)
    [ -n "$sample" ] || { echo "board: no samples under $BOARD_DIR — is the container's sampler running?" >&2; return 1; }
    export SB_PIDS_MAX=$(jq -r '.cg.pidsMax' <<<"$sample") SB_MEM_HIGH=$(jq -r '.cg.highMiB * 1048576' <<<"$sample")
  fi
  leases=$(jq -s '.' "$BOARD_DIR"/leases/heavy/*.json 2>/dev/null) || leases='[]'
  [ -n "$leases" ] || leases='[]'
  jq -n --argjson s "${sample:-null}" --argjson heavy "$leases" \
    --slurpfile dev <( [ -f "$BOARD_DIR/leases/dev.json" ] && cat "$BOARD_DIR/leases/dev.json" ) \
    --slurpfile ov <( [ -f "$BOARD_DIR/overlap.json" ] && cat "$BOARD_DIR/overlap.json" ) \
    --slurpfile reg <( cat "$BOARD_DIR"/sessions/*.json 2>/dev/null ) \
    --arg sampler "$(sampler_running && echo running || echo stopped)" \
    --arg thr "$(sb_thresholds 2>/dev/null)" '
    {sample: $s, sampler: $sampler, thresholds: ($thr | split(" ") | map(select(. != "") | split("=") | {(.[0]): .[1]}) | add),
     dev: ($dev[0] // null), heavy: $heavy, overlap: ($ov[0] // null),
     registered: ($reg | map({key: (.pid | tostring), value: .}) | from_entries)}'
}

cmd_status() {
  board_json | jq -r '
    def gib: . / 1024 | . * 10 | round / 10 | tostring;
    def hm: if . == null then "?" else (sub("\\.[0-9]+"; "") | fromdate | strflocaltime("%H:%M:%S")) end;
    .sample as $s | .thresholds as $t | .registered as $r |
    "board @ \($s.t | hm)  anon \($s.cg.anonMiB | gib)/\($s.cg.highMiB | gib) GiB (soft \(($t.ANON_SOFT | tonumber) / 1048576 | gib) · hard \(($t.ANON_HARD | tonumber) / 1048576 | gib))" +
      " · pids \($s.cg.pids)/\($s.cg.pidsMax) (soft \($t.PIDS_SOFT) · hard \($t.PIDS_HARD))" +
      " · cpu \($s.cg.cpuCores) cores · psi full \($s.cg.psiMemFull10)" +
      (if $t.ENFORCE == "true" then " · enforcing" else " · nudge-only" end),
    "sessions (\($s.mix.working) working, \($s.mix.idle) idle):",
    ($s.sessions | sort_by(.state != "working", .name)[] |
      "  \(.name)  \(.state)\(if .stateSrc == "cpu" then "*" else "" end)  \($r[.pid | tostring].branch // .branch // "-")" +
      "  thr \(.thr) · \(.rssMiB) MiB\(if .heavy then "  heavy: " + .heavy else "" end)" +
      (($r[.pid | tostring].note // "") as $n | if $n != "" then "  — " + $n else "" end)),
    (if .dev == null then "dev lease: free"
     else "dev lease: \(.dev.holderName) (\(.dev.branch)) since \(.dev.acquiredAt | hm), expires \(.dev.expiresAt | hm)\(if .dev.holderGone then " — holder gone" else "" end)" end),
    "heavy: \(.heavy | length) slot(s)\(if (.heavy | length) > 0 then " — " + (.heavy | map("\(.name // .pid): \(.label // .class)") | join(", ")) else "" end)",
    (if .overlap and ((.overlap.pairs // []) | length) > 0
     then "overlaps:", (.overlap.pairs[] | "  \(.a) ↔ \(.b): \(.files | join(", "))") else empty end),
    "sampler: \(.sampler)\(if .sampler != "running" then " — board.sh sampler start" else "" end)",
    "(* = state inferred from CPU; no hook registration)"'
}

# --- sampler lifecycle ---

cmd_sampler() {
  case "${1:-status}" in
    start)
      sampler_running && { echo "sampler: already running (pid $(cat /tmp/aperture-sampler.pid 2>/dev/null))"; return 0; }
      sb_init_dirs
      if [ -n "${TMUX:-}" ] && tmux new-window -d -n board-sampler "bash '$SB_SCRIPTS/sampler.sh' 2>>'$BOARD_DIR/sampler.log'" 2>/dev/null; then
        echo "sampler: started in tmux window board-sampler"
      else
        setsid nohup bash "$SB_SCRIPTS/sampler.sh" </dev/null >>"$BOARD_DIR/sampler.log" 2>&1 &
        echo "sampler: started (setsid)"
      fi ;;
    stop|restart)
      local p
      p=$(cat /tmp/aperture-sampler.pid 2>/dev/null)
      # Kill by the PID the holder recorded, never by name; only if it still holds the lock.
      if [ -n "$p" ] && sampler_running && [ "$(sb_comm "$p")" = bash ]; then kill "$p" && echo "sampler: stopped $p"; fi
      for _ in 1 2 3 4 5 6 7 8 9 10; do sampler_running || break; sleep 0.2; done
      [ "$1" = restart ] && cmd_sampler start ;;
    status)
      local last
      last=$(tail -n 1 "$BOARD_DIR/history/samples-$(sb_today).jsonl" 2>/dev/null | jq -r '.t' 2>/dev/null)
      if sampler_running; then echo "sampler: running (pid $(cat /tmp/aperture-sampler.pid 2>/dev/null)), last tick ${last:-none today}"
      else echo "sampler: stopped — board.sh sampler start"; return 1; fi ;;
    *) echo "usage: board.sh sampler start|restart|stop|status" >&2; return 2 ;;
  esac
}

# --- housekeeping ---

cmd_gc() {
  local f pid start ps st wp n=0
  # Sessions whose process is gone (or pid reused), kept 24 h after their last update.
  for f in "$BOARD_DIR"/sessions/*.json; do
    [ -e "$f" ] || continue
    read -r pid start < <(jq -r '"\(.pid) \(.pidStart)"' "$f")
    if ! sb_alive "$pid" "$start"; then
      find "$f" -mmin +1440 -delete 2>/dev/null && [ ! -e "$f" ] && { rm -f "${f%.json}.tool"; n=$((n + 1)); }
    fi
  done
  # Heavy slots whose wrapper died.
  for f in "$BOARD_DIR"/leases/heavy/*.json; do
    [ -e "$f" ] || continue
    read -r wp st < <(jq -r '"\(.wrapperPid) \(.wrapperStart)"' "$f")
    sb_alive "$wp" "$st" || { rm -f "$f"; n=$((n + 1)); }
  done
  # History older than 90 days.
  find "$BOARD_DIR/history" -name '*.jsonl' -mtime +90 -delete 2>/dev/null
  echo "gc: removed $n stale entr$( [ $n = 1 ] && echo y || echo ies)"
}

. "$SB_SCRIPTS/lease.sh"

case "${1:-status}" in
  status) cmd_status ;;
  json) board_json ;;
  register) cmd_register ;;
  heartbeat) shift; cmd_heartbeat "${1:-}" ;;
  end) cmd_end ;;
  note) shift; cmd_note "$@" ;;
  sampler) shift; cmd_sampler "$@" ;;
  gc) cmd_gc ;;
  lease) shift; cmd_lease "$@" ;;
  *) sed -n '2,6p' "${BASH_SOURCE[0]}"; exit 2 ;;
esac
