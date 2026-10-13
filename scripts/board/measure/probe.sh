#!/bin/bash
# M0 environment probe (~10 s, safe): limits, versions, capability checks → board/history/probe-<date>.json
# and a readable summary on stdout. docs/ops/SESSION-BOARD.md → Measurement protocol.
set -u
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
sb_init_dirs

cat_or() { local v; read -r v 2>/dev/null <"$1" && printf '%s' "$v" || printf '%s' "${2:-}"; }
memtotal=$(awk '$1=="MemTotal:"{print $2*1024}' /proc/meminfo)
swaptotal=$(awk '$1=="SwapTotal:"{print $2*1024}' /proc/meminfo)

# vitest's default worker count = availableParallelism() − 1 (heredoc, never a one-liner — lib.sh).
workers=$(node - <<'JS' 2>/dev/null
process.stdout.write(String(Math.max(1, require('node:os').availableParallelism() - 1)));
JS
)

# Capability (a): a setsid child outlives the shell that started it.
marker="${TMPDIR:-/tmp}/aperture-probe.$$"
setsid bash -c 'sleep 2; echo ok >"$1"' _ "$marker" </dev/null >/dev/null 2>&1 &
# Capability (b): tmux can open a detached window from this environment.
tmux_ok=false
if [ -n "${TMUX:-}" ] && tmux new-window -d -n board-probe "sleep 1" 2>/dev/null; then tmux_ok=true; fi
sleep 3
setsid_ok=false; [ "$(cat_or "$marker")" = ok ] && setsid_ok=true; rm -f "$marker"

out="$BOARD_DIR/history/probe-$(sb_today).json"
jq -n \
  --arg t "$(sb_now)" --arg host "$(hostname)" --argjson nproc "$(nproc)" \
  --arg memTotal "$memtotal" --arg swapTotal "$swaptotal" \
  --arg high "$(cg_high)" --arg max "$(cat_or "$CG/memory.max")" --arg swapMax "$(cat_or "$CG/memory.swap.max")" \
  --arg anon "$(cg_anon)" --arg file "$(cg_file)" --arg current "$(cg_current)" --arg peak "$(cat_or "$CG/memory.peak")" \
  --arg pids "$(cg_pids)" --arg pidsMax "$(cg_pids_max)" --arg pidsPeak "$(cat_or "$CG/pids.peak")" \
  --arg cpuMax "$(cat_or "$CG/cpu.max")" --arg oomKill "$(cg_oom_kill)" --arg highEvents "$(cg_high_events)" \
  --arg psiFull "$(cg_psi memory full)" --arg pidMax "$(cat_or /proc/sys/kernel/pid_max)" \
  --arg node "$(node --version 2>/dev/null)" --arg pnpm "$(pnpm --version 2>/dev/null)" \
  --arg vitest "$(jq -r .version "$SB_REPO/node_modules/.pnpm/node_modules/vitest/package.json" 2>/dev/null)" \
  --arg wsConc "$(cd "$SB_REPO" && pnpm config get workspace-concurrency 2>/dev/null)" \
  --arg workers "$workers" --argjson setsid "$setsid_ok" --argjson tmux "$tmux_ok" \
  --arg panes "$(tmux list-panes -a -F '#{window_name}=#{pane_pid}' 2>/dev/null | paste -sd, -)" \
  --arg socks "$(ls /tmp/cc-socks 2>/dev/null | paste -sd, -)" '
  def n: if . == "" then null else tonumber end;
  {v: 1, t: $t, host: $host, nproc: $nproc, memTotal: ($memTotal | n), swapTotal: ($swapTotal | n),
   cg: {memoryHigh: ($high | n), memoryMax: $max, swapMax: $swapMax, anon: ($anon | n), file: ($file | n),
        current: ($current | n), peak: ($peak | n), pids: ($pids | n), pidsMax: ($pidsMax | n),
        pidsPeak: ($pidsPeak | n), cpuMax: $cpuMax, oomKill: ($oomKill | n), highEvents: ($highEvents | n),
        psiMemFull10: ($psiFull | n)},
   pidMax: ($pidMax | n),
   versions: {node: $node, pnpm: $pnpm, vitest: $vitest},
   pnpmWorkspaceConcurrency: $wsConc, vitestDefaultWorkers: ($workers | n),
   capabilities: {setsidSurvives: $setsid, tmuxNewWindow: $tmux},
   tmuxPanes: $panes, ccSockets: $socks}' | sb_write "$out"

jq -r '"probe \(.t) on \(.host): \(.nproc) CPUs, VM RAM \(.memTotal / 1073741824 * 10 | round / 10) GiB, swap \(.swapTotal)",
  "memory.high \(if .cg.memoryHigh then (.cg.memoryHigh / 1073741824 | tostring) + " GiB" else "max" end) · memory.max \(.cg.memoryMax) · anon \(.cg.anon / 1048576 | floor) MiB · file \(.cg.file / 1048576 | floor) MiB · peak \(.cg.peak / 1048576 | floor) MiB",
  "pids \(.cg.pids)/\(.cg.pidsMax) (peak \(.cg.pidsPeak)) · cpu.max \(.cg.cpuMax) · oom_kill \(.cg.oomKill) · high \(.cg.highEvents) · psi full \(.cg.psiMemFull10)",
  "node \(.versions.node) · pnpm \(.versions.pnpm) · vitest \(.versions.vitest) (default workers \(.vitestDefaultWorkers)) · workspace-concurrency \(.pnpmWorkspaceConcurrency)",
  "setsid survives: \(.capabilities.setsidSurvives) · tmux new-window: \(.capabilities.tmuxNewWindow)"' "$out"
echo "→ $out"
