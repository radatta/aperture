#!/bin/bash
# The Mac stats agent (docs/ops/TOWER.md → Mac stats): every 15 s, launchd runs this once. It reads the Mac's own
# memory, load and VM size and writes one JSON file into the main checkout's localNotes/board/, where the web tower
# reads it. Trust boundary: it takes NO input from the container. Its only argv are the two absolute paths the
# installer rendered into the plist. It reads nothing from the shared folder, executes nothing from it, makes no
# network call, and its one write there is a rename of a file it just made (a planted symlink is replaced, never
# followed). bash 3.2 + what macOS ships, plus jq (the mailroom needs it too).
#   macstats.sh <out-dir> <state-dir>     one tick (launchd)
#   macstats.sh --render <fixture-dir>    print the JSON from vm_stat.txt, sysctl.txt, ps.txt (the test seam)
set -euo pipefail
umask 022
export LC_ALL=C PATH=/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin # jq: macOS 15 ships it; else Homebrew
AGENT_VERSION="${MACSTATS_VERSION:-dev}"
case "$(uname -s)" in Darwin) MV_NOFOLLOW=-h ;; *) MV_NOFOLLOW=-T ;; esac # the tests run on Linux (GNU mv)

# collect VM SYSCTL PS: the three raw texts, one per variable
collect() {
  VM=$(vm_stat)
  # one OID per call, one line each: a missing OID leaves its own line empty instead of shifting the rest
  local o
  SYSCTL=$(for o in hw.memsize hw.ncpu vm.loadavg vm.swapusage kern.memorystatus_vm_pressure_level; do
    printf '%s\n' "$(sysctl -n "$o" 2>/dev/null | head -n 1)"
  done)
  PS=$(ps -axo pid=,rss=,comm=)
}

# render HOST T → the JSON on stdout, from $VM, $SYSCTL, $PS
render() {
  local page free active inactive spec wired comp mem ncpu load swap_total swap_used level vm
  page=$(printf '%s\n' "$VM" | awk 'NR == 1 { for (i = 1; i <= NF; i++) if ($i == "of") { print $(i + 1); exit } }')
  [ -n "$page" ] || { echo "macstats: no page size in vm_stat" >&2; return 1; }
  pages() { printf '%s\n' "$VM" | awk -F: -v k="$1" '$1 == k { gsub(/[ .]/, "", $2); print $2; exit }'; }
  free=$(pages 'Pages free'); active=$(pages 'Pages active'); inactive=$(pages 'Pages inactive')
  spec=$(pages 'Pages speculative'); wired=$(pages 'Pages wired down'); comp=$(pages 'Pages occupied by compressor')
  for v in "$free" "$active" "$inactive" "$wired" "$comp"; do
    case "$v" in '' | *[!0-9]*) echo "macstats: unreadable vm_stat" >&2; return 1 ;; esac
  done
  mem=$(printf '%s\n' "$SYSCTL" | sed -n 1p)
  ncpu=$(printf '%s\n' "$SYSCTL" | sed -n 2p)
  load=$(printf '%s\n' "$SYSCTL" | sed -n 3p | tr -d '{}')
  # "total = 2048.00M  used = 1024.50M …": MiB with an M suffix, or G; anything else is unknown (null), not 0
  swapv() { printf '%s\n' "$SYSCTL" | sed -n 4p | awk -v k="$1" '{ for (i = 1; i <= NF; i++) if ($i == k) { v = $(i + 2)
      if (v ~ /^[0-9.]+M$/) { sub(/M$/, "", v); print v } else if (v ~ /^[0-9.]+G$/) { sub(/G$/, "", v); print v * 1024 }
      exit } }'; }
  swap_total=$(swapv total)
  swap_used=$(swapv used)
  level=$(printf '%s\n' "$SYSCTL" | sed -n 5p)
  case "$mem" in '' | *[!0-9]*) echo "macstats: unreadable hw.memsize" >&2; return 1 ;; esac
  # The VM: the largest resident process whose name is a hypervisor's (COI's VM on this Mac).
  vm=$(printf '%s\n' "$PS" | awk '{ pid = $1; rss = $2; $1 = ""; $2 = ""; sub(/^ +/, ""); n = $0; sub(/.*\//, "", n)
      if (n ~ /Virtualization|limactl|qemu|vfkit|krunkit/ && rss + 0 > best) { best = rss + 0; bp = pid; bn = n } }
      END { if (bp != "") printf "%s\t%s\t%s\n", bp, best, bn }')
  jq -n --arg t "$2" --arg host "$1" --arg ver "$AGENT_VERSION" \
    --argjson page "$page" --argjson free "$free" --argjson active "$active" --argjson inactive "$inactive" \
    --argjson spec "${spec:-0}" --argjson wired "$wired" --argjson comp "$comp" --argjson mem "$mem" \
    --arg ncpu "$ncpu" --arg load "$load" --arg st "$swap_total" --arg su "$swap_used" --arg level "$level" \
    --arg vm "$vm" '
    def mib(p): (p * $page / 1048576 | floor);
    def n(s): (s | tonumber? // null);
    ($mem / 1048576 | floor) as $total |
    { v: 1, t: $t, host: $host, agentVersion: $ver, memTotalMiB: $total,
      mem: { freeMiB: mib($free + $spec), activeMiB: mib($active), inactiveMiB: mib($inactive),
             wiredMiB: mib($wired), compressedMiB: mib($comp), usedMiB: mib($active + $wired + $comp),
             freePct: (if $total > 0 then (mib($free + $spec) * 100 / $total | floor) else null end),
             pressure: ({"1": "normal", "2": "warn", "4": "critical"}[$level] // "unknown") },
      swap: (if n($st) == null or n($su) == null then null
             else { totalMiB: (n($st) | floor), usedMiB: (n($su) | floor) } end),
      load: ($load | split(" ") | map(select(. != "") | tonumber? // empty) | if length == 3 then . else null end),
      cpus: n($ncpu),
      vm: (if $vm == "" then null else ($vm | split("\t")) as $v
           | { pid: ($v[0] | tonumber), rssMiB: ($v[1] | tonumber / 1024 | floor), comm: $v[2] } end) }'
}

tmp=''
main() {
  if [ "${1:-}" = --render ]; then
    VM=$(cat "$2/vm_stat.txt"); SYSCTL=$(cat "$2/sysctl.txt"); PS=$(cat "$2/ps.txt")
    render fixture-host 2026-11-13T12:00:00Z
    return
  fi
  [ $# -eq 2 ] || { echo "usage: macstats.sh <out-dir> <state-dir> | --render <fixture-dir>" >&2; return 2; }
  local out="$1" state="$2" real json was now
  mkdir -p "$state"
  was=$(cat "$state/last" 2>/dev/null || true)
  # Pin the out dir: a real directory, not a symlink, at exactly the path the installer rendered. Absent (the
  # checkout moved, a volume unmounted) is one log line on the change, not one per tick.
  real=$(cd "$out" 2>/dev/null && pwd -P || true)
  if [ ! -d "$out" ] || [ -L "$out" ] || [ "$real" != "$out" ]; then
    [ "$was" = missing ] || echo "$(date -u +%FT%TZ) out dir missing or not a plain directory: $out"
    echo missing >"$state/last"
    return 0
  fi
  # A directory (or a link to one) at the target would make `mv` move into it: refuse it. A link to a file is just
  # removed (rm on a link removes the link) so the rename below replaces it.
  if [ -d "$out/mac-stats.json" ]; then
    [ "$was" = target ] || echo "$(date -u +%FT%TZ) refusing: $out/mac-stats.json is a directory or a link to one"
    echo target >"$state/last"
    return 0
  fi
  [ ! -L "$out/mac-stats.json" ] || rm -f "$out/mac-stats.json"
  collect
  now=$(date -u +%FT%TZ)
  json=$(render "$(hostname -s)" "$now")
  tmp=$(mktemp "$out/.mac-stats.XXXXXX")
  trap 'rm -f "${tmp:-}"' EXIT # a failure before the rename leaves no stray temp file (tmp is global: the trap
  # runs after main returns)
  printf '%s\n' "$json" >"$tmp"
  chmod 644 "$tmp" # mktemp makes it 0600; the container reads it
  # never into a directory: BSD mv -h / GNU mv -T rename onto the target name itself, even if a link to a directory
  # was planted there after the check above
  mv -f "$MV_NOFOLLOW" "$tmp" "$out/mac-stats.json"
  trap - EXIT
  [ "$was" = ok ] || echo "$now writing $out/mac-stats.json"
  echo ok >"$state/last"
}

main "$@"
