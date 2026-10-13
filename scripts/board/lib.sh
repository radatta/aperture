#!/bin/bash
# Sourced by every board script (docs/ops/SESSION-BOARD.md). No `set` flags here — callers choose.
#
# Shape rules for everything under scripts/board/ (the COI monitor reads argv, not files — see
# docs/ops/SESSION-BOARD.md → Script-shape rules): never read /proc/*/environ, never xargs over /proc,
# no interpreter one-liners (awk -f / heredocs only), no ps-pipe-grep sweeps, kill by PID, labels via
# env (never argv — `pkill -f <label>` once killed the wrong process).

SB_SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SB_REPO="$(cd "$SB_SCRIPTS/../.." && pwd)"
BOARD_DIR="${APERTURE_BOARD_DIR:-/workspace/localNotes/board}"
BOARD_LOCK="${APERTURE_BOARD_LOCK:-/tmp/aperture-board.lock}"
CG="${APERTURE_CGROUP_DIR:-/sys/fs/cgroup}"
LIMITS_JSON="${APERTURE_LIMITS_JSON:-$SB_SCRIPTS/limits.json}"

sb_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
sb_today() { date -u +%Y-%m-%d; }
sb_epoch() { printf '%(%s)T' -1; }

sb_init_dirs() { mkdir -p "$BOARD_DIR/sessions" "$BOARD_DIR/leases/heavy" "$BOARD_DIR/history"; }

# stdin → $1, via tmp + rename in the same directory (atomic for readers, the Mac included).
sb_write() { local tmp="$1.tmp.$$"; cat >"$tmp" && mv -f "$tmp" "$1"; }

# Append one JSON line to today's history file of kind $1 (samples | events).
sb_append() { mkdir -p "$BOARD_DIR/history" && printf '%s\n' "$2" >>"$BOARD_DIR/history/$1-$(sb_today).jsonl"; }

# --- cgroup reads (bytes / counts; `max` → empty) ---
sb_kv() { local k v; while read -r k v; do [ "$k" = "$2" ] && { printf '%s' "$v"; return; }; done <"$1"; }
sb_one() { local v; read -r v 2>/dev/null <"$1" || return; [ "$v" = max ] || printf '%s' "$v"; }
cg_anon() { sb_kv "$CG/memory.stat" anon; }
cg_file() { sb_kv "$CG/memory.stat" file; }
cg_current() { sb_one "$CG/memory.current"; }
cg_high() { sb_one "$CG/memory.high"; }
cg_pids() { sb_one "$CG/pids.current"; }
cg_pids_max() { sb_one "$CG/pids.max"; }
cg_usage_usec() { sb_kv "$CG/cpu.stat" usage_usec; }
cg_oom_kill() { sb_kv "$CG/memory.events" oom_kill; }
cg_high_events() { sb_kv "$CG/memory.events" high; }
# PSI `avg10` of line $2 (some|full) in pressure file $1 (memory|cpu).
cg_psi() {
  local kind a rest
  while read -r kind a rest; do [ "$kind" = "$2" ] && { printf '%s' "${a#avg10=}"; return; }; done <"$CG/$1.pressure"
  printf 0
}

# --- /proc helpers (parse after the last `)` — comm may hold spaces, e.g. `tmux: server`) ---
# Prints "ppid starttime" for $1.
sb_stat() {
  local s r
  read -r s 2>/dev/null <"/proc/$1/stat" || return 1
  r=${s##*) }
  set -- $r
  printf '%s %s' "$2" "${20}"
}
sb_comm() { local c; read -r c 2>/dev/null <"/proc/$1/comm" && printf '%s' "$c"; }
sb_alive() { local want="$2" ps st; read -r ps st < <(sb_stat "$1") || return 1; [ -z "$want" ] || [ "$st" = "$want" ]; }

# Nearest ancestor of $1 (inclusive) whose comm is `claude`. Hooks use it because CLAUDE_PID in a
# hook's env is not guaranteed; a Bash tool shell has it, and the walk agrees with it.
sb_claude_pid() {
  local p="$1" i ps st
  for ((i = 0; i < 32; i++)); do
    [ "$(sb_comm "$p")" = claude ] && { printf '%s' "$p"; return 0; }
    read -r ps st < <(sb_stat "$p") || return 1
    [ "$ps" -gt 1 ] 2>/dev/null || return 1
    p=$ps
  done
  return 1
}

sb_in_container() { case "$(hostname)" in coi-*) return 0 ;; esac; return 1; }

# limits.json value by jq path, e.g. sb_limit '.container.pidsSoftFrac'.
sb_limit() { jq -r "$1 // empty" "$LIMITS_JSON" 2>/dev/null; }

# Live absolute thresholds from limits.json fractions × live limits. Prints shell assignments.
sb_thresholds() {
  local pm hi
  pm=$(cg_pids_max); hi=$(cg_high)
  [ -n "$pm" ] || pm=4194304
  [ -n "$hi" ] || hi=$(awk '$1=="MemTotal:"{print $2*1024}' /proc/meminfo)
  jq -r --argjson pm "$pm" --argjson hi "$hi" '.container as $c |
    "PIDS_SOFT=\(($c.pidsSoftFrac*$pm)|floor) PIDS_HARD=\(($c.pidsHardFrac*$pm)|floor) " +
    "ANON_SOFT=\(($c.anonSoftFrac*$hi)|floor) ANON_HARD=\(($c.anonHardFrac*$hi)|floor) " +
    "PSI_KILL=\($c.psiFullKill) CURRENT_GUARD=\(($c.currentGuardMiB*1048576)|floor) " +
    "PIDS_MAX=\($pm) MEM_HIGH=\($hi) ENFORCE=\(.enforce)"' "$LIMITS_JSON"
}

sb_mib() { printf '%d' $(( ${1:-0} / 1048576 )); }
sb_gib() { awk -v b="${1:-0}" 'BEGIN{printf "%.1f", b/1073741824}'; }

# Run $@ under the board lock (rootfs flock; one container = the whole population).
sb_locked() { (flock -w 5 9 || { echo "board: lock busy ($BOARD_LOCK)" >&2; exit 75; }; "$@") 9>>"$BOARD_LOCK"; }
