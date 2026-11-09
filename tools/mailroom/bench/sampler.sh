#!/bin/bash
# The sim bench's sampler (docs/ops/SIM-BENCH.md): one JSON line per tick into <samples.jsonl> until killed — free
# memory % (memory_pressure), vm_stat's cumulative swap-ins/outs and compressor pages (summarize.sh takes the
# deltas), the load average, and RSS + CPU of the sim's processes, summed by name. Every 15th tick also `pmset -g therm`
# (thermal and performance warning levels — the only sudo-free thermal signal; powermetrics needs sudo).
#
#   sampler.sh <samples.jsonl> [interval-seconds]
set -uo pipefail
export LC_ALL=C
OUT="${1:?usage: sampler.sh <samples.jsonl> [interval]}"
INTERVAL="${2:-2}"
# The sim's processes, by executable name (basename of ps's comm); com.apple.WebKit.* are summed as one.
PROCS="SpringBoard SimMetalHost SimRenderServer DeviceHub launchd_sim Web com.apple.WebKit*"

tick=0
while :; do
  t="$(date +%s)"
  free="$(memory_pressure 2>/dev/null | sed -n 's/.*System-wide memory free percentage: *\([0-9][0-9]*\)%.*/\1/p' | head -1)"
  vm="$(vm_stat 2>/dev/null)"
  vmv() { printf '%s\n' "$vm" | sed -n "s/^$1: *\\([0-9][0-9]*\\)\\.*\$/\\1/p" | head -1; }
  swapins="$(vmv Swapins)"
  swapouts="$(vmv Swapouts)"
  comp="$(vmv 'Pages occupied by compressor')"
  page="$(printf '%s\n' "$vm" | sed -n 's/.*page size of \([0-9][0-9]*\) bytes.*/\1/p' | head -1)"
  load="$(sysctl -n vm.loadavg 2>/dev/null | tr -d '{}')"
  # rss (KB), %cpu, then the command path (may hold spaces): summed per wanted basename.
  procs="$(ps -axo rss=,pcpu=,comm= 2>/dev/null | awk -v want="$PROCS" '
    BEGIN { n = split(want, w, " ") }
    { rss = $1; cpu = $2; sub(/^ *[0-9]+ +[0-9.]+ +/, ""); c = $0; sub(/.*\//, "", c)
      for (i = 1; i <= n; i++) {
        p = w[i]; hit = 0
        if (substr(p, length(p)) == "*") { if (index(c, substr(p, 1, length(p) - 1)) == 1) hit = 1 } else if (c == p) hit = 1
        if (hit) { R[p] += rss; C[p] += cpu; K[p]++; break }
      }
    }
    END { for (p in K) printf "%s\t%d\t%.1f\t%d\n", p, R[p], C[p], K[p] }')"
  therm=""
  if [ $((tick % 15)) = 0 ]; then
    therm="$(pmset -g therm 2>/dev/null | grep -v '^ *$' | tr '\n' ';' | tr -s ' ' | cut -c1-200)"
  fi
  jq -cn --argjson t "$t" --arg free "$free" --arg si "$swapins" --arg so "$swapouts" --arg comp "$comp" --arg page "$page" \
    --arg load "$load" --arg procs "$procs" --arg therm "$therm" '
    def num: if . == "" or . == null then null else tonumber end;
    {t: $t, freePct: ($free | num), swapins: ($si | num), swapouts: ($so | num), compressorPages: ($comp | num),
     pageSize: ($page | num),
     load: ($load | [splits(" +") | select(. != "") | tonumber] | if length == 3 then . else null end),
     procs: ($procs | split("\n") | map(select(. != "") | split("\t")
       | {key: .[0], value: {rssKb: (.[1] | tonumber), cpu: (.[2] | tonumber), count: (.[3] | tonumber)}}) | from_entries)}
    + (if $therm == "" then {} else {therm: $therm} end)' >>"$OUT" 2>/dev/null
  tick=$((tick + 1))
  sleep "$INTERVAL"
done
