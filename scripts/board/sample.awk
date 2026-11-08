# One sampler tick → one JSON line on stdout (docs/ops/SESSION-BOARD.md → Sampler format).
# Inputs, in ARGV order (named F1–F4 via -v; no gawk ARGIND): 1 tmux panes  "window\tpane_pid"
#                                      2 sessions    "pid\tsid\tname\tbranch\tstate"   (hook-registered)
#                                      3 heavy slots "pid\tlabel"
#                                      4 prev tick   "T\tepoch\tusage_usec\tepochRealtime" | "S\tpid\tcpuTicks"
#                                      5 procs (-)   "pid\tppid\tcomm\tthreads\trssPages\tcpuTicks\targs"
# -v: t ep epr interval anon file current high pids pidsMax usage cpus psiMemSome psiMemFull psiCpuSome oomKill
#     highEvents dev page hz prevOut statusOut
BEGIN { FS = "\t"; MiB = 1048576 }
FILENAME == F1 { win[$2] = $1; next }
# A hook state counts only once a heartbeat has fired (sampler.sh blanks it otherwise).
FILENAME == F2 { reg[$1] = 1; sid[$1] = $2; rname[$1] = $3; branch[$1] = $4; hstate[$1] = $5; next }
FILENAME == F3 { if (!($1 in heavy)) heavy[$1] = $2; else heavy[$1] = heavy[$1] "+" $2; nslots++; next }
FILENAME == F4 {
  if ($1 == "T") { prevEp = $2; prevUsage = $3; prevEpr = $4 } else if ($1 == "S") prevCpu[$2] = $3
  next
}
{
  p = $1; ppid[p] = $2; comm[p] = $3; thr[p] = $4; rss[p] = $5 * page; cpu[p] = $6
  cat[p] = category($3, tolower($7))
  if ($3 == "claude") roots[p] = 1
}

function category(c, a) {
  if (c == "claude") return "claude"
  if (c ~ /^(chrom|headless_shell)/ || a ~ /chrom(e|ium)|headless_shell/) return "chromium"
  if (c == "tsgo" || c == "tsc" || a ~ /typescript\/bin\/tsc|tsgo|native-preview/) return "tsc"
  if (a ~ /vitest/) return "vitest"
  if (a ~ /eslint/) return "eslint"
  if (a ~ /\/vite(\/|\.js| )|vite\/bin|vite\.config|\.bin\/vite/) return "vite"
  if (c == "pnpm" || c == "corepack" || a ~ /pnpm|corepack/) return "pnpm"
  if (c ~ /^(snapfuse|snapd|dockerd|containerd|systemd|rsyslogd|udisksd|cron|agetty|dbus|polkitd|unattended|networkd|sd-pam|\(sd-pam\))/) return "system"
  return "other"
}

# Session root for pid p: nearest ancestor (inclusive) that is a claude process; "" if none.
function root(p,   q, n) {
  if (p in memo) return memo[p]
  q = p
  for (n = 0; n < 64 && q != "" && q > 1; n++) {
    if (q in roots) return memo[p] = q
    if (!(q in ppid)) break
    q = ppid[q]
  }
  return memo[p] = ""
}

function esc(s) { gsub(/\\/, "\\\\", s); gsub(/"/, "\\\"", s); return s }
function num(x) { return x == "" ? 0 : x }

END {
  for (p in cat) {
    c = cat[p]; cn[c]++; ct[c] += thr[p]; cr[c] += rss[p]
    r = root(p)
    if (r != "") { st[r] += thr[p]; sr[r] += rss[p]; sc[r] += cpu[p] }
    else if (c ~ /^(vitest|vite|chromium|tsc|eslint)$/) unattr += thr[p]
  }

  # Over the real elapsed time (µs clock): whole epoch seconds could halve it for a `--print` just after a
  # tick; a prev file from before the 4th field falls back to the seconds. null when the counters can't be
  # this cgroup's last tick's: a delta below zero, or above the CPUs it has (with room for rounding).
  dt = (prevEpr != "" && epr != "") ? epr - prevEpr : ep - prevEp
  cores = (prevEp != "" && prevUsage != "" && dt > 0) ? (usage - prevUsage) / (dt * 1e6) : 0
  coresOut = (cores < 0 || (cpus > 0 && cores > cpus * 1.5)) ? "null" : sprintf("%.2f", cores)
  el = (prevEp != "" && ep > prevEp) ? ep - prevEp : interval
  gap = (prevEp != "" && ep - prevEp > interval + 60) ? ep - prevEp - interval : ""

  printf "T\t%s\t%s\t%s\n", ep, usage, epr > prevOut
  sess = ""; working = 0; idle = 0
  for (r in roots) {
    printf "S\t%s\t%s\n", r, sc[r] > prevOut
    d = (r in prevCpu) ? sc[r] - prevCpu[r] : 0
    if (r in reg && (hstate[r] == "working" || hstate[r] == "idle")) { state = hstate[r]; src = "hook" }
    else { state = (d >= 0.05 * hz * el) ? "working" : "idle"; src = "cpu" }  # ≥ 5 % of a core
    if (state == "working") working++; else idle++
    nm = (ppid[r] in win) ? win[ppid[r]] : ((r in reg && rname[r] != "") ? rname[r] : "pid" r)
    sess = sess (sess == "" ? "" : ",") sprintf("{\"pid\":%s,\"name\":\"%s\",\"sid\":%s,\"branch\":%s,\"state\":\"%s\",\"stateSrc\":\"%s\",\"thr\":%d,\"rssMiB\":%d,\"cpuSec\":%.1f,\"heavy\":%s}", \
      r, esc(nm), (r in reg && sid[r] != "") ? "\"" esc(sid[r]) "\"" : "null", \
      (r in reg && branch[r] != "") ? "\"" esc(branch[r]) "\"" : "null", state, src, st[r], sr[r] / MiB, d / hz, \
      (r in heavy) ? "\"" esc(heavy[r]) "\"" : "null")
  }
  close(prevOut)

  cats = ""
  split("claude vitest vite chromium tsc eslint pnpm system other", order, " ")
  for (i = 1; i <= 9; i++) {
    c = order[i]
    cats = cats (i > 1 ? "," : "") sprintf("\"%s\":{\"n\":%d,\"thr\":%d,\"rssMiB\":%d}", c, cn[c], ct[c], cr[c] / MiB)
  }
  cats = cats sprintf(",\"unattributed\":{\"thr\":%d}", unattr)

  printf "{\"t\":\"%s\",\"v\":1,\"cg\":{\"anonMiB\":%d,\"fileMiB\":%d,\"currentMiB\":%d,\"highMiB\":%s,\"pids\":%d,\"pidsMax\":%s,\"cpuCores\":%s,\"psiMemSome10\":%s,\"psiMemFull10\":%s,\"psiCpuSome10\":%s,\"oomKill\":%d,\"highEvents\":%d},\"cats\":{%s},\"sessions\":[%s],\"mix\":{\"working\":%d,\"idle\":%d,\"heavy\":%d},\"gapSec\":%s}\n", \
    t, anon / MiB, file / MiB, current / MiB, high == "" ? "null" : int(high / MiB), pids, pidsMax == "" ? "null" : pidsMax, \
    coresOut, num(psiMemSome), num(psiMemFull), num(psiCpuSome), oomKill, highEvents, cats, sess, working, idle, nslots, \
    gap == "" ? "null" : gap

  printf "board: %d working · %d idle · heavy %d · anon %.1f/%sG · pids %d/%s%s\n", working, idle, nslots, \
    anon / 1073741824, high == "" ? "-" : sprintf("%d", high / 1073741824), pids, pidsMax == "" ? "-" : pidsMax, \
    dev == "" ? "" : " · dev: " dev > statusOut
  close(statusOut)
}
