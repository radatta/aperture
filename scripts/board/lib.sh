#!/bin/bash
# Sourced by every board script (docs/ops/SESSION-BOARD.md). No `set` flags here — callers choose.
#
# Shape rules for everything under scripts/board/ (the COI monitor reads argv, not files — see
# docs/ops/SESSION-BOARD.md → Script-shape rules): never read /proc/*/environ, never xargs over /proc,
# no interpreter one-liners (awk -f / heredocs only), no ps-pipe-grep sweeps, kill by PID, labels via
# env (never argv — `pkill -f <label>` once killed the wrong process).

# A caller with no HOME (the COI tmux server's status-bar jobs) would run git without ~/.gitconfig — no https
# rewrite, no gh credential helper — and gh without its config: bash's `~` falls back to the passwd entry.
[ -n "${HOME:-}" ] || export HOME=~
SB_SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SB_REPO="$(cd "$SB_SCRIPTS/../.." && pwd)"
# The board lives in the MAIN checkout's localNotes/ (shared by every worktree): /workspace in the container;
# on the Mac, wherever git says the main checkout is (read-only view — see board.sh status).
# SB_HOME_BOARD is that default whatever the override: only the real board starts the main sync (board.sh sync ensure).
if [ -d /workspace/localNotes ]; then SB_HOME_BOARD=/workspace/localNotes/board
else SB_HOME_BOARD="$(cd "$(git -C "$SB_REPO" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)/.." 2>/dev/null && pwd)/localNotes/board"; fi
BOARD_DIR="${APERTURE_BOARD_DIR:-$SB_HOME_BOARD}"
BOARD_LOCK="${APERTURE_BOARD_LOCK:-/tmp/aperture-board.lock}"
CG="${APERTURE_CGROUP_DIR:-/sys/fs/cgroup}"
LIMITS_JSON="${APERTURE_LIMITS_JSON:-$SB_SCRIPTS/limits.json}"
# The sampler singleton (one per container) and where it records its pid; tests point both elsewhere.
SAMPLER_LOCK="${APERTURE_SAMPLER_LOCK:-/tmp/aperture-sampler.lock}"
SAMPLER_PID="${APERTURE_SAMPLER_PID:-/tmp/aperture-sampler.pid}"
TOWER_PID="${APERTURE_TOWER_PID:-/tmp/aperture-tower.pid}" # the web tower server, written once bound (docs/ops/TOWER.md)
TOWER_PORT="${APERTURE_TOWER_PORT:-6183}" # its port: the one-server lock, and how `board.sh tower` finds it without the pidfile
# The main-sync loop singleton (sync.sh, docs/ops/TOWER.md → Main sync); tests point both elsewhere.
SYNC_LOCK="${APERTURE_SYNC_LOCK:-/tmp/aperture-main-sync.lock}"
SYNC_PID="${APERTURE_SYNC_PID:-/tmp/aperture-main-sync.pid}"

sb_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
sb_today() { date -u +%Y-%m-%d; }
sb_epoch() { printf '%(%s)T' -1; }

sb_init_dirs() { mkdir -p "$BOARD_DIR/sessions" "$BOARD_DIR/leases/heavy" "$BOARD_DIR/history"; }

# stdin → $1, via tmp + rename in the same directory (atomic for readers, the Mac included).
# An empty result (a failed jq upstream) never replaces the file.
sb_write() { local tmp="$1.tmp.$$"; cat >"$tmp" && [ -s "$tmp" ] && mv -f "$tmp" "$1" || { rm -f "$tmp"; return 1; }; }

# Append one JSON line to today's history file of kind $1 (samples | events).
sb_append() { mkdir -p "$BOARD_DIR/history" && printf '%s\n' "$2" >>"$BOARD_DIR/history/$1-$(sb_today).jsonl"; }

# --- cgroup reads (bytes / counts; `max` → empty) ---
sb_kv() { local k v; while read -r k v || [ -n "$k" ]; do [ "$k" = "$2" ] && { printf '%s' "$v"; return; }; done <"$1"; }
sb_one() { local v; read -r v 2>/dev/null <"$1" || return; [ "$v" = max ] || printf '%s' "$v"; }
cg_anon() { sb_kv "$CG/memory.stat" anon; }
cg_file() { sb_kv "$CG/memory.stat" file; }
cg_current() { sb_one "$CG/memory.current"; }
cg_high() { sb_one "$CG/memory.high"; }
cg_pids() { sb_one "$CG/pids.current"; }
cg_pids_max() { sb_one "$CG/pids.max"; }
cg_usage_usec() { sb_kv "$CG/cpu.stat" usage_usec; }
# CPUs the container may use: cpu.max's quota/period, else every online CPU.
cg_cpus() { local q= p=; read -r q p 2>/dev/null <"$CG/cpu.max"; if [ -n "$q" ] && [ "$q" != max ] && [ -n "$p" ]; then awk -v q="$q" -v p="$p" 'BEGIN{printf "%.2f", q / p}'; else getconf _NPROCESSORS_ONLN; fi; }  # not nproc: it honours OMP_NUM_THREADS
cg_oom_kill() { sb_kv "$CG/memory.events" oom_kill; }
cg_high_events() { sb_kv "$CG/memory.events" high; }
# PSI `avg10` of line $2 (some|full) in pressure file $1 (memory|cpu).
cg_psi() {
  local kind a rest
  while read -r kind a rest || [ -n "$kind" ]; do [ "$kind" = "$2" ] && { printf '%s' "${a#avg10=}"; return; }; done <"$CG/$1.pressure"
  printf 0
}

# --- /proc helpers (parse after the last `)` — comm may hold spaces, e.g. `tmux: server`) ---
# Prints "ppid starttime" for $1.
sb_stat() {
  local s r
  read -r s 2>/dev/null <"/proc/$1/stat" || return 1
  r=${s##*) }
  set -- $r
  printf '%s %s\n' "$2" "${20}"
}
sb_comm() { local c; read -r c 2>/dev/null <"/proc/$1/comm" && printf '%s' "$c"; }
# $1 is alive — and, given $2, started at that tick (else the pid was reused). A zombie (`Z`, exited but never
# reaped — a wrapper's `cmd & exec …` leaves one) or a dead process (`X`) still has a readable stat: not alive.
sb_alive() {
  local want="${2:-}" s r
  read -r s 2>/dev/null <"/proc/${1:-0}/stat" || return 1
  r=${s##*) }
  set -- $r
  case "$1" in Z|X) return 1 ;; esac
  [ -z "$want" ] || [ "${20}" = "$want" ]
}

# --- heavy slots: one liveness rule, read-only ---
# A slot file whose wrapper (heavy.sh's pid + start tick) is alive. Every count goes through this — board_json,
# the sampler's tick, the guard, gc — so a dead job's slot is never a running job, whoever reads first. Nothing
# here deletes: only gc and the acquire do.
sb_slot_live() {
  local wp ws
  read -r wp ws < <(jq -r '"\(.wrapperPid) \(.wrapperStart)"' "$1" 2>/dev/null)
  sb_alive "$wp" "$ws"
}
# The live slot files, one path per line.
sb_live_slots() {
  local f
  for f in "$BOARD_DIR"/leases/heavy/*.json; do [ -e "$f" ] && sb_slot_live "$f" && printf '%s\n' "$f"; done
  return 0
}

# One TSV line per process: pid ppid comm threads rssPages cpuTicks [args]. Builtins only — no fork per
# process. `$1 = args` adds the first 3 cmdline args (≤200 chars); without it the column is empty.
sb_procs() {
  local d pid s r comm a0 a1 a2 args= mode="${1:-}"
  for d in /proc/[0-9]*; do
    pid=${d#/proc/}
    read -r s 2>/dev/null <"$d/stat" || continue
    comm=${s#*(}; comm=${comm%)*}
    r=${s##*) }
    if [ "$mode" = args ]; then  # not $1: `set -- $r` below replaces it
      a0= a1= a2=
      { IFS= read -r -d '' a0; IFS= read -r -d '' a1; IFS= read -r -d '' a2; } 2>/dev/null <"$d/cmdline"
      args="$a0 $a1 $a2"; args=${args//$'\t'/ }; args=${args//$'\n'/ }
    fi
    set -- $r
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$pid" "$2" "${comm//$'\t'/ }" "${18}" "${22}" \
      "$(( ${12} + ${13} + ${14} + ${15} ))" "${args:0:200}"
  done
}

# Heavy class of a command line: test | test-file | typecheck | lint | build | dev | ui | other.
# `case` only (no grep), so the PreToolUse hook can use it on the raw command for free.
sb_classify() {
  local c=" ${1,,} "
  c=${c//$'\n'/ }
  case "$c" in
    *playwright*|*chromium*|*headless_shell*) echo ui ;;
    *vitest*|*"pnpm test"*|*"pnpm "*" test "*)
      case "$c" in *.test.*|*.spec.*|*" src/"*|*"/src/"*) echo test-file ;; *) echo test ;; esac ;;
    *"pnpm typecheck"*|*" tsc "*|*"tsc -b"*|*tsgo*) echo typecheck ;;
    *"pnpm lint"*|*eslint*) echo lint ;;
    *"pnpm build"*|*"vite build"*|*"-r build"*) echo build ;;
    *"pnpm dev"*|*" vite "*|*"vite dev"*|*"vite preview"*) echo dev ;;
    *) echo other ;;
  esac
}

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
  pm=${SB_PIDS_MAX:-$(cg_pids_max)}; hi=${SB_MEM_HIGH:-$(cg_high)}
  [ -n "$pm" ] || pm=4194304
  [ -n "$hi" ] || hi=$(awk '$1=="MemTotal:"{print $2*1024}' /proc/meminfo 2>/dev/null)
  [ -n "$hi" ] || hi=0
  # A missing or mid-edit limits.json falls back to the shipped fractions, nudge-only — callers run under
  # `set -u`, and a board problem must never cost a command its exit code.
  jq -r --argjson pm "$pm" --argjson hi "$hi" '(.container // {}) as $c |
    "PIDS_SOFT=\((($c.pidsSoftFrac // 0.8)*$pm)|floor) PIDS_HARD=\((($c.pidsHardFrac // 0.92)*$pm)|floor) " +
    "ANON_SOFT=\((($c.anonSoftFrac // 0.6)*$hi)|floor) ANON_HARD=\((($c.anonHardFrac // 0.8)*$hi)|floor) " +
    "PSI_KILL=\($c.psiFullKill // 15) CURRENT_GUARD=\((($c.currentGuardMiB // 1536)*1048576)|floor) " +
    "PIDS_MAX=\($pm) MEM_HIGH=\($hi) ENFORCE=\(.enforce == true)"' "$LIMITS_JSON" 2>/dev/null ||
    echo "PIDS_SOFT=$((pm * 8 / 10)) PIDS_HARD=$((pm * 92 / 100)) ANON_SOFT=$((hi * 6 / 10)) ANON_HARD=$((hi * 8 / 10))" \
      "PSI_KILL=15 CURRENT_GUARD=$((1536 * 1048576)) PIDS_MAX=$pm MEM_HIGH=$hi ENFORCE=false"
}

# The measurement trees: this checkout + scratch worktrees board-matrix-{b,c} under the main checkout's
# .claude/worktrees/ (resolved via git, so it holds from the main checkout too). MATRIX_TREES overrides.
sb_matrix_trees() {
  local wt
  wt="$(cd "$(git -C "$SB_REPO" rev-parse --path-format=absolute --git-common-dir)/.." && pwd)/.claude/worktrees"
  printf '%s\n' "${MATRIX_TREES:-$SB_REPO $wt/board-matrix-b $wt/board-matrix-c}"
}

sb_mib() { printf '%d' $(( ${1:-0} / 1048576 )); }
sb_gib() { awk -v b="${1:-0}" 'BEGIN{printf "%.1f", b/1073741824}'; }

# Run $@ under the board lock (rootfs flock; one container = the whole population).
sb_locked() { (flock -w 5 9 || { echo "board: lock busy ($BOARD_LOCK)" >&2; exit 75; }; "$@") 9>>"$BOARD_LOCK"; }
