#!/usr/bin/env bash
# Session board CLI — who's doing what in this shared container (docs/ops/SESSION-BOARD.md).
#   board.sh status | json   (status shows the real dev lock — devlock.sh — and ends with the test cap's barriers)
#   board.sh hub              the hub session (hub.json, docs/ops/HUB.md) and whether the board has it live
#   board.sh register | heartbeat working|idle | end | note "<text>"   (hooks; --pid/--sid/--cwd override)
#   board.sh sampler start|restart|stop|status
#   board.sh tower start|restart|stop|status|version   (the web tower on :6183, docs/ops/TOWER.md; version: the commit
#     it serves, which pnpm board sync-main compares)
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
# Two lines (not a TAB pair: `read` drops an empty leading field): branch, then name, for session $2 in cwd $1.
# The name is its tmux window — the session name the status line sets, and the SendMessage address — but only
# when $2 is that pane's own claude (the pane process or its child, as sample.awk attributes it): a claude
# started from inside another session's pane inherits TMUX_PANE. Else the branch, then the cwd's basename.
me_ident() {
  local branch win= pp ps
  branch=$(git -C "$1" branch --show-current 2>/dev/null)
  if [ -n "${TMUX_PANE:-}" ] && [ -n "${2:-}" ]; then
    read -r pp win < <(tmux display-message -p -t "$TMUX_PANE" '#{pane_pid} #W' 2>/dev/null)  # pid has no spaces; the name may
    read -r ps _ < <(sb_stat "$2")
    [ "${pp:-x}" = "$2" ] || [ "${pp:-x}" = "${ps:-y}" ] || win=
  fi
  printf '%s\n%s\n' "$branch" "${win:-${branch:-${1##*/}}}"
}

# --- session registry ---

cmd_register() {
  local pid cwd sid start ps branch name f
  pid=$(me_pid) || { echo "board: no claude ancestor" >&2; return 1; }
  cwd="${OPT_CWD:-$(pwd)}"; sid="${OPT_SID:-${CLAUDE_CODE_SESSION_ID:-}}"
  read -r ps start < <(sb_stat "$pid")
  { read -r branch; read -r name; } < <(me_ident "$cwd" "$pid")
  sb_init_dirs; f=$(me_file "$pid")
  # SessionStart also fires on resume/compact: keep startedAt/note/lastPromptAt for the same process.
  # A missing, empty or corrupt file starts fresh rather than sticking (sb_write refuses empty output).
  { jq -ce . "$f" 2>/dev/null || echo '{}'; } | jq -c --argjson pid "$pid" --arg start "$start" --arg sid "$sid" \
    --arg name "$name" --arg branch "$branch" --arg cwd "$cwd" --arg now "$(sb_now)" '
    (if .pidStart == $start then . else {} end) as $old |
    {v: 1, pid: $pid, pidStart: $start, sid: $sid, name: $name, branch: $branch, cwd: $cwd,
     startedAt: ($old.startedAt // $now), lastPromptAt: $old.lastPromptAt, lastStopAt: $old.lastStopAt,
     state: ($old.state // "idle"), note: $old.note, updatedAt: $now}' | sb_write "$f"
}

cmd_heartbeat() {
  local state="$1" pid f branch name
  case "$state" in working|idle) ;; *) echo "usage: board.sh heartbeat working|idle" >&2; return 2 ;; esac
  pid=$(me_pid) || return 1
  f=$(me_file "$pid")
  [ -s "$f" ] || cmd_register || return 1
  # Branch and name can change mid-session (a session that starts in detached /workspace, a renamed window).
  { read -r branch; read -r name; } < <(me_ident "${OPT_CWD:-$(pwd)}" "$pid")
  jq -c --arg s "$state" --arg now "$(sb_now)" --arg branch "$branch" --arg name "$name" '
    .state = $s | .updatedAt = $now | .branch = $branch | .name = $name |
    if $s == "working" then .lastPromptAt = $now else .lastStopAt = $now end' "$f" | sb_write "$f"
  return 0
}

cmd_end() {
  local pid f s
  pid=$(me_pid) || return 1
  f=$(me_file "$pid")
  [ -f "$f" ] && jq -c --arg now "$(sb_now)" '.state = "gone" | .endedAt = $now | .updatedAt = $now' "$f" | sb_write "$f"
  for s in "$BOARD_DIR/leases/heavy/$pid"-*.json; do [ -e "$s" ] && rm -f "$s"; done
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
# The probe waits 200 ms for the lock rather than failing at once: every other probe (status, json, SessionStart,
# the restart poll) holds it only for the life of a `true` — microseconds idle, milliseconds under load — so a
# brief wait gets past them, and only the sampler keeps it the whole 200 ms.
sampler_running() {
  if [ -r "$CG/memory.stat" ]; then ! flock -w 0.2 "$SAMPLER_LOCK" true 2>/dev/null; return; fi
  local last; last=$(ls -t "$BOARD_DIR"/history/samples-*.jsonl 2>/dev/null | head -n 1)
  [ -n "$last" ] && [ -n "$(find "$last" -mtime -90s 2>/dev/null || find "$last" -mmin -2 2>/dev/null)" ]
}

board_json() {
  local sample leases overlap bar
  if [ -r "$CG/memory.stat" ]; then
    sample=$(bash "$SB_SCRIPTS/sampler.sh" --print)
  else  # not in the container (the Mac): the sampler's latest tick, read-only
    sample=$(tail -n 1 "$(ls -t "$BOARD_DIR"/history/samples-*.jsonl 2>/dev/null | head -n 1)" 2>/dev/null)
    [ -n "$sample" ] || { echo "board: no samples under $BOARD_DIR — is the container's sampler running?" >&2; return 1; }
    export SB_PIDS_MAX=$(jq -r '.cg.pidsMax' <<<"$sample") SB_MEM_HIGH=$(jq -r '.cg.highMiB * 1048576' <<<"$sample")
  fi
  local -a live=()
  mapfile -t live < <(sb_live_slots)  # a dead wrapper's slot is not a running job (lib.sh)
  leases='[]'
  [ "${#live[@]}" -eq 0 ] || leases=$(jq -s '.' "${live[@]}" 2>/dev/null) || leases='[]'
  bar=$(node "$SB_REPO/scripts/src/board/cli.ts" barriers "$BOARD_DIR/history" 7 2>/dev/null)  # none on a Mac without node
  jq -n --argjson s "${sample:-null}" --argjson heavy "$leases" --arg bar "$bar" --arg cap "$(sb_limit '.concurrency.test')" \
    --slurpfile dev <( [ -f "$BOARD_DIR/devlock.json" ] && cat "$BOARD_DIR/devlock.json" ) \
    --slurpfile ov <( [ -f "$BOARD_DIR/overlap.json" ] && cat "$BOARD_DIR/overlap.json" ) \
    --slurpfile reg <( cat "$BOARD_DIR"/sessions/*.json 2>/dev/null ) \
    --arg sampler "$(sampler_running && echo running || echo stopped)" \
    --arg thr "$(sb_thresholds 2>/dev/null)" '
    {sample: $s, sampler: $sampler, barriers: (if $bar == "" then null else $bar end),
     testCap: (if $cap == "" then null else ($cap | tonumber) end), thresholds: ($thr | split(" ") | map(select(. != "") | split("=") | {(.[0]): .[1]}) | add),
     devLock: ($dev[0] // null), heavy: $heavy, overlap: ($ov[0] // null),
     registered: ($reg | map({key: (.pid | tostring), value: .}) | from_entries)}'
}

cmd_status() {
  local dl
  APERTURE_DEVLOCK_CALLER=status bash "$SB_SCRIPTS/devlock.sh" refresh --max-age 30 >/dev/null 2>&1
  dl=$(bash "$SB_SCRIPTS/devlock.sh" line 2>/dev/null)
  board_json | jq -r --arg dl "${dl:-dev lock: unknown}" '
    def gib: . / 1024 | . * 10 | round / 10 | tostring;
    def hm: if . == null then "?" else (sub("\\.[0-9]+"; "") | fromdate | strflocaltime("%H:%M:%S")) end;
    .sample as $s | .thresholds as $t | .registered as $r |
    "board @ \($s.t | hm)  anon \($s.cg.anonMiB | gib)/\($s.cg.highMiB | gib) GiB (soft \(($t.ANON_SOFT | tonumber) / 1048576 | gib) · hard \(($t.ANON_HARD | tonumber) / 1048576 | gib))" +
      " · pids \($s.cg.pids)/\($s.cg.pidsMax) (soft \($t.PIDS_SOFT) · hard \($t.PIDS_HARD))" +
      " · cpu \($s.cg.cpuCores // "?") cores · psi full \($s.cg.psiMemFull10)" +
      (if $t.ENFORCE == "true" then " · enforcing" else " · nudge-only" end),
    "sessions (\($s.mix.working) working, \($s.mix.idle) idle):",
    ($s.sessions | sort_by(.state != "working", .name)[] |
      "  \(.name)  \(.state)\(if .stateSrc == "cpu" then "*" else "" end)  \($r[.pid | tostring].branch // .branch // "-")" +
      "  thr \(.thr) · \(.rssMiB) MiB\(if .heavy then "  heavy: " + .heavy else "" end)" +
      (($r[.pid | tostring].note // "") as $n | if $n != "" then "  — " + $n else "" end)),
    $dl,
    "heavy: \(.heavy | length) slot(s)\(if .testCap then " · test \([.heavy[] | select(.class == "test")] | length)/\(.testCap)" else "" end)\(if (.heavy | length) > 0 then " — " + (.heavy | map("\(.name // .pid): \(.label // .class)") | join(", ")) else "" end)",
    (.barriers // empty),
    (if .overlap and ((.overlap.pairs // []) | length) > 0
     then "overlaps:", (.overlap.pairs[] | "  \(.a) ↔ \(.b): \(.files | join(", "))") else empty end),
    "sampler: \(.sampler)\(if .sampler != "running" then " — board.sh sampler start" else "" end)",
    "(* = state inferred from CPU; no hook registration)"'
}

# The hub (docs/ops/HUB.md): its name from hub.json, and whether a live session by that name is on the board.
cmd_hub() {
  local name pid start st branch
  name=$(jq -r '.name // empty' "$SB_SCRIPTS/hub.json" 2>/dev/null)
  [ -n "$name" ] || { echo "hub: none named in scripts/board/hub.json — docs/ops/HUB.md → Missing hub"; return 0; }
  while read -r pid start st branch; do
    sb_alive "$pid" "$start" || continue
    echo "hub: $name — on the board ($st, $branch)"; return 0
  done < <(jq -r --arg n "$name" 'select(.name == $n and .state != "gone") | "\(.pid) \(.pidStart) \(.state // "idle") \(if (.branch // "") == "" then "detached" else .branch end)"' \
    "$BOARD_DIR"/sessions/*.json 2>/dev/null)
  echo "hub: $name — not on the board; ListAgents decides (docs/ops/HUB.md → Missing hub)"
}

# --- sampler lifecycle ---

cmd_sampler() {
  case "${1:-status}" in
    start)
      sampler_running && { echo "sampler: already running (pid $(cat "$SAMPLER_PID" 2>/dev/null))"; return 0; }
      sb_init_dirs
      # Detached background process, no tmux window (it has nothing to show); errors → sampler.log.
      setsid nohup bash "$SB_SCRIPTS/sampler.sh" </dev/null >>"$BOARD_DIR/sampler.log" 2>&1 &
      # It holds its lock within a second (`flock -w 5` rides out the probes); not seen holding it = not running.
      local i
      for ((i = 0; i < 10; i++)); do
        sampler_running && { echo "sampler: started (pid in $SAMPLER_PID, log $BOARD_DIR/sampler.log)"; return 0; }
        sleep 0.1
      done
      echo "sampler: did not start — see $BOARD_DIR/sampler.log" >&2
      return 1 ;;
    stop|restart)
      local p i
      p=$(cat "$SAMPLER_PID" 2>/dev/null)
      # Kill by the PID the holder recorded, never by name; only if it still holds the lock.
      if [ -n "$p" ] && sampler_running && [ "$(sb_comm "$p")" = bash ]; then kill "$p" && echo "sampler: stopped $p"; fi
      # Up to ~5 s (each probe of a live sampler costs 200 ms): one mid-tick finishes the tick before its TERM trap runs.
      for ((i = 0; i < 12; i++)); do sampler_running || break; sleep 0.2; done
      [ "$1" = restart ] && cmd_sampler start ;;
    status)
      local last
      last=$(tail -n 1 "$BOARD_DIR/history/samples-$(sb_today).jsonl" 2>/dev/null | jq -r '.t' 2>/dev/null)
      if sampler_running; then echo "sampler: running (pid $(cat "$SAMPLER_PID" 2>/dev/null)), last tick ${last:-none today}"
      else echo "sampler: stopped — board.sh sampler start"; return 1; fi ;;
    *) echo "usage: board.sh sampler start|restart|stop|status" >&2; return 2 ;;
  esac
}

# --- web tower lifecycle (docs/ops/TOWER.md) ---

# Running = the tower's node, found by its pidfile (written once the server has bound the port) or, when that's
# gone (/tmp cleaned), by the port's listener — and then the pidfile is written back. Either way the pid must be a
# live node running tower/web/main.ts. Never by name, never by a lock an inherited fd could keep held (kill-by-PID).
_is_tower() {
  [[ "$1" =~ ^[0-9]+$ ]] && sb_alive "$1" && [ "$(sb_comm "$1")" = node ] \
    && tr '\0' ' ' <"/proc/$1/cmdline" 2>/dev/null | grep -q 'tower/web/main.ts'
}
# A proof server (`--fixtures`, `--once`) is a tower too, but never the board's: the fallback doesn't claim one.
_is_board_tower() { _is_tower "$1" && ! tr '\0' ' ' <"/proc/$1/cmdline" 2>/dev/null | grep -qE -- ' --(fixtures|once)( |$)'; }
# The pid listening on the tower's port, if any (whatever it is).
_port_pid() { ss -ltnpH "sport = :$TOWER_PORT" 2>/dev/null | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -n 1; }
tower_pid() {
  local p; p=$(cat "$TOWER_PID" 2>/dev/null)
  _is_tower "$p" && { printf '%s' "$p"; return 0; }
  p=$(_port_pid)
  _is_board_tower "$p" || return 1
  { printf '%s\n' "$p" >"$TOWER_PID"; } 2>/dev/null
  printf '%s' "$p"
}

cmd_tower() {
  local p i
  case "${1:-status}" in
    start)
      p=$(tower_pid) && { echo "tower: already running (pid $p) — http://localhost:$TOWER_PORT"; return 0; }
      sb_init_dirs
      APERTURE_TOWER_PID="$TOWER_PID" setsid nohup bash "$SB_SCRIPTS/tower-web.sh" --port "$TOWER_PORT" </dev/null >>"$BOARD_DIR/tower.log" 2>&1 &
      # "started" only once the server has bound the port and written its pid (≤ 3 s; node starts in ~0.3 s)
      for ((i = 0; i < 30; i++)); do
        p=$(tower_pid) && { echo "tower: started (pid $p) — http://localhost:$TOWER_PORT, log $BOARD_DIR/tower.log"; return 0; }
        sleep 0.1
      done
      p=$(_port_pid)
      [ -n "$p" ] && { echo "tower: did not start — port $TOWER_PORT is held by pid $p ($(sb_comm "$p")), not the tower" >&2; return 1; }
      echo "tower: did not start — see $BOARD_DIR/tower.log" >&2
      return 1 ;;
    stop|restart)
      if p=$(tower_pid); then
        kill "$p" && echo "tower: stopped $p"
        for ((i = 0; i < 25; i++)); do sb_alive "$p" || break; sleep 0.2; done
        sb_alive "$p" && { echo "tower: $p still running" >&2; return 1; }
      fi
      rm -f "$TOWER_PID.sha"
      [ "$1" = restart ] && { cmd_tower start; return; } # start's status: sync-main reads a failed restart from it
      return 0 ;;
    status)
      if p=$(tower_pid); then echo "tower: running (pid $p) — http://localhost:$TOWER_PORT"
      else echo "tower: stopped — board.sh tower start"; return 1; fi ;;
    version)
      # The commit the running server started from: "<pid> <sha>" beside its pidfile. Empty when it wrote none or the
      # file is another server's (a stale one, or an older server that writes none): unknown, so sync-main restarts.
      local pid sha
      p=$(tower_pid) || { echo "tower: stopped" >&2; return 1; }
      read -r pid sha <"$TOWER_PID.sha" 2>/dev/null || true
      [ "$pid" = "$p" ] && printf '%s\n' "$sha"
      return 0 ;;
    *) echo "usage: board.sh tower start|restart|stop|status|version" >&2; return 2 ;;
  esac
}

# --- housekeeping ---

cmd_gc() {
  local f pid start n=0
  # Sessions whose process is gone (or pid reused), kept 24 h after their last update.
  for f in "$BOARD_DIR"/sessions/*.json; do
    [ -e "$f" ] || continue
    read -r pid start < <(jq -r '"\(.pid) \(.pidStart)"' "$f")
    if ! sb_alive "$pid" "$start"; then
      find "$f" -mmin +1440 -delete 2>/dev/null && [ ! -e "$f" ] && { rm -f "${f%.json}.tool" "${f%.json}.nudged"; n=$((n + 1)); }
    fi
  done
  # Heavy slots whose wrapper died (or is a zombie) — the same rule every reader counts by (lib.sh sb_slot_live).
  for f in "$BOARD_DIR"/leases/heavy/*.json; do
    [ -e "$f" ] || continue
    sb_slot_live "$f" || { rm -f "$f"; n=$((n + 1)); }
  done
  # The retired board dev lease (refs/locks/dev is the only dev lock since session-comms).
  rm -f "$BOARD_DIR/leases/dev.json"
  # History older than 90 days.
  find "$BOARD_DIR/history" -name '*.jsonl' -mtime +90 -delete 2>/dev/null
  echo "gc: removed $n stale entr$( [ $n = 1 ] && echo y || echo ies)"
}

case "${1:-status}" in
  status) cmd_status ;;
  json) board_json ;;
  register) cmd_register ;;
  heartbeat) shift; cmd_heartbeat "${1:-}" ;;
  end) cmd_end ;;
  note) shift; cmd_note "$@" ;;
  sampler) shift; cmd_sampler "$@" ;;
  tower) shift; cmd_tower "$@" ;;
  hub) cmd_hub ;;
  gc) cmd_gc ;;
  *) sed -n '2,8p' "${BASH_SOURCE[0]}"; exit 2 ;;
esac
