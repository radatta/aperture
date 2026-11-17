#!/bin/bash
# The sim bench's summary (docs/ops/SIM-BENCH.md): reads a bench results dir — runs.jsonl, every
# hostjobs/results/<id>/{result.json,plan.json}, samples.jsonl, machine.json, plans.json — and writes summary.json and
# summary.md beside them. Per job: wall time, run 1 apart from runs 2..N (each run starts from a shut-down sim: relaunch,
# the last job, ends with shutdown, as consecutive devchecks do). Per op: p50/p95/max of sim.sh's own
# `ms` (passing steps only). The signals sim.sh writes in step notes (re-taps, retypes, extra deletes, drops), fails by
# reason, and the sampler's memory, swap, load and per-process peaks, overall and per job. --against another bench's
# summary.json adds ratio columns (this / that). Bash 3.2 + jq; runs on either Mac and in the container.
#
#   summarize.sh <results-dir> [--against <summary.json>]
set -uo pipefail
export LC_ALL=C
RD="${1:?usage: summarize.sh <results-dir> [--against <summary.json>]}"
shift
AGAINST=""
while [ $# -gt 0 ]; do
  case "$1" in
    --against) [ $# -ge 2 ] || { echo "summarize: --against needs a summary.json" >&2; exit 2; }; AGAINST="$2"; shift 2 ;;
    *) echo "summarize: unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -f "$RD/runs.jsonl" ] && [ -f "$RD/machine.json" ] || { echo "summarize: $RD has no runs.jsonl/machine.json" >&2; exit 2; }
[ -z "$AGAINST" ] || [ -f "$AGAINST" ] || { echo "summarize: no $AGAINST" >&2; exit 2; }

# One line per job run: its steps (result.json) beside the plan it ran (plan.json, the job as the runner saw it).
J="$RD/.steps.jsonl"
: >"$J"
while IFS= read -r id; do
  d="$RD/hostjobs/results/$id"
  [ -f "$d/result.json" ] || continue
  if [ -f "$d/plan.json" ]; then
    jq -cn --arg id "$id" --slurpfile r "$d/result.json" --slurpfile p "$d/plan.json" \
      '{id: $id, steps: ($r[0].steps // []), plan: ($p[0].params.steps // [])}' >>"$J"
  else
    jq -cn --arg id "$id" --slurpfile r "$d/result.json" '{id: $id, steps: ($r[0].steps // []), plan: []}' >>"$J"
  fi
done < <(jq -r '.id' "$RD/runs.jsonl")
PLANS_F="$RD/plans.json"
[ -f "$PLANS_F" ] || PLANS_F=/dev/null
SAMPLES_F="$RD/samples.jsonl"
[ -f "$SAMPLES_F" ] || SAMPLES_F=/dev/null
AG_F="${AGAINST:-/dev/null}"

jq -n --slurpfile runs "$RD/runs.jsonl" --slurpfile steps "$J" --slurpfile samples "$SAMPLES_F" \
  --slurpfile machine "$RD/machine.json" --slurpfile plans "$PLANS_F" --slurpfile against "$AG_F" \
  --arg aborted "$(jq -r '.aborted // ""' "$RD/aborted.json" 2>/dev/null || true)" '
# nearest-rank percentile over numbers
def pct($p): if length == 0 then null else sort | .[(((($p / 100) * length) | ceil) - 1) as $i | if $i < 0 then 0 else $i end] end;
def stats: {n: length, p50: pct(50), p95: pct(95), max: (if length == 0 then null else max end), min: (if length == 0 then null else min end)};
def opkey: .op + (if .tab then " " + .tab elif .label then " " + .label elif .text then " \"" + .text + "\""
  elif .method then " " + .method elif .name then " " + .name elif .as then " " + .as
  elif .s then " \(.s)s" elif .n then " \(.n)" elif .signedIn != null then " signedIn" else "" end);
def epoch: if . == null then null else (try fromdateiso8601 catch null) end;
# What sim.sh says in a step note when an input needed a second go (tools/mailroom/jobs/sim.sh; docs/ops/SIM-BENCH.md).
def signal_counts($note):
  {retap: ([$note | match("(^|; )tapped again \\("; "g")] | length),
   iconRetap: ([$note | match("icon tapped ([0-9]+) times"; "g") | .captures[0].string | tonumber - 1] | add // 0),
   homeRepress: ([$note | match("home pressed ([0-9]+) times"; "g") | .captures[0].string | tonumber - 1] | add // 0),
   keyboardSecondTap: ([$note | match("keyboard dismissed on the second tap"; "g")] | length),
   settingsAgain: ([$note | match("went to Settings again"; "g")] | length),
   retype: ([$note | match("retyped (once|twice)"; "g") | if .captures[0].string == "twice" then 2 else 1 end] | add // 0),
   extraDelete: ([$note | match("deleted [0-9]+ more|deleted more (twice)"; "g") | if .captures[0].string == "twice" then 2 else 1 end] | add // 0),
   switcherRetry: ([$note | match("; (the switcher didn.t open|no Aperture card at |still running after the swipe)"; "g")] | length),
   keyboardLate: ([$note | match("the keyboard came up late"; "g")] | length),
   inputDrops: ([$note | match("drops ([0-9]+)"; "g") | .captures[0].string | tonumber] | add // 0),
   leftoverDraft: ([$note | match("deleted a leftover draft"; "g")] | length),
   resumedMidTyping: ([$note | match("resumed mid-typing"; "g")] | length),
   expectBuildRelaunch: ([$note | match("first launch ran "; "g")] | length)};
def addobj: reduce .[] as $o ({}; reduce ($o | to_entries[]) as $e (.; .[$e.key] = ((.[$e.key] // 0) + $e.value)));
# A job that failed because iOS dropped an input. SWITCHER_FAILED counts only for its "the app switcher did not kill
# the app … iOS dropped the input" case, not "no Aperture card … was the app running?" (sim.sh, op_kill): told apart by
# the start of the note, which survives the 240-character cut in sim.sh. (No apostrophes in this program: it is single-quoted.)
def dropfail: (.detail // "") as $d | ($d | IN("ICON_TAP_DROPPED", "ICON_SCROLL_DROPPED", "HOME_PRESS_DROPPED", "TAP_DROPPED", "NAV_UNCONFIRMED", "TYPED", "ERASED"))
  or ($d == "SWITCHER_FAILED" and .status == "fail"
    and ([.steps[]? | select(.status == "fail") | .note // "" | startswith("the app switcher didn\u0027t kill")] | any));

$machine[0] as $m
| ($plans[0] // {}) as $pl
| ($steps | map({key: .id, value: .}) | from_entries) as $byid
| [$runs[] | . + {steps: ($byid[.id].steps // []), plan: ($byid[.id].plan // []),
    s0: (.startedAt | epoch), s1: (.finishedAt | epoch)}] as $R
| [$R[] | select(.run >= 1)] as $timed
| ($samples | map(select(.t != null)) | sort_by(.t)) as $S
| def window($r): [$S[] | select($r.s0 != null and $r.s1 != null and .t >= $r.s0 and .t <= $r.s1)];
  def delta($xs; $k): ([$xs[] | .[$k] | select(. != null)]) as $v | if ($v | length) >= 2 then ($v[-1] - $v[0]) else null end;
  (["prelude"] + ($m.args.jobs // [])) as $order
| [$order[] as $name | [$R[] | select(.job == $name)] | select(length > 0) | . as $rs
    | ([$rs[] | select(.run >= 1)]) as $t
    | ([$t[] | window(.)] ) as $w
    | {name: $name, runs: ($rs | length),
       pass: ([$rs[] | select(.status == "pass")] | length),
       fail: ([$rs[] | select(.status == "fail")] | length),
       error: ([$rs[] | select(.status != "pass" and .status != "fail")] | length),
       run1Ms: ([$rs[] | select(.run == 1 or .run == 0) | .durationMs] | first),
       runs2toN: ([$t[] | select(.run >= 2) | .durationMs] | stats),
       all: ([$t[] | .durationMs] | if length == 0 then [$rs[] | .durationMs] else . end | stats),
       failsBy: ([$rs[] | select(.status != "pass") | "\(.reason // "-")/\(.detail // "-")"] | group_by(.) | map({key: .[0], value: length}) | from_entries),
       booted: ([$rs[] | .booted // "?"] | group_by(.) | map({key: .[0], value: length}) | from_entries),
       minFreePct: ([$w[][] | .freePct | select(. != null)] | min),
       peakLoad1: ([$w[][] | .load[0]? | select(. != null)] | max),
       swapoutsDelta: ([$t[] | window(.) | delta(.; "swapouts")] | map(select(. != null)) | add),
       skippedSetup: ([$pl.jobs[]? | select(.name == $name) | .skippedSetup // empty] | first)}] as $jobs
| [$timed[] as $r | $r.steps[] | select(.status == "pass") | . + {job: $r.job, run: $r.run, key: ($r.plan[.i] // {op: .op} | opkey)}] as $passed
| [$passed | group_by([.job, .i])[] | . as $g
    | {job: $g[0].job, i: $g[0].i, key: $g[0].key, run1Ms: ([$g[] | select(.run == 1) | .ms] | first)} + ([$g[].ms] | stats)]
  | sort_by(.job as $j | (($order | index($j)) // 99), .i) as $ops
| [$passed | group_by(.op)[] | {op: .[0].op} + ([.[].ms] | stats)] | sort_by(-.p50) as $kinds
| [$R[] | select(.status != "pass") | . as $r
    | ([$r.steps[] | select(.status != "pass" and .status != "skipped")] | first) as $s
    | {run: $r.run, job: $r.job, id: $r.id, status: $r.status, reason: $r.reason, detail: $r.detail,
       i: ($s.i // null), op: (if $s then ($r.plan[$s.i] // {op: $s.op} | opkey) else null end), ms: ($s.ms // null),
       note: ($s.note // null),
       seedMissing: (if $s == null then false else ($r.detail == "MISS") and (($r.plan[$s.i] // {}) | .op == "tap" and .label == "Done") end)}] as $failures
| ([$R[] | .steps[] | signal_counts(.note // "")] | addobj) as $signals
| {dropFails: ([$R[] | select(dropfail)] | length),
   axTimeout: ([$R[] | select(.detail == "AX_TIMEOUT")] | length),
   timeout: ([$R[] | select(.reason == "TIMEOUT")] | length),
   staleBuild: ([$R[] | select(.detail == "STALE_BUILD")] | length),
   seedMissing: ([$failures[] | select(.seedMissing)] | length),
   byReason: ([$R[] | select(.status != "pass") | "\(.reason // "-")/\(.detail // "-")"] | group_by(.) | map({key: .[0], value: length}) | from_entries)} as $fails
| ([$S[] | .procs // {} | keys[]] | unique) as $pnames
| {samples: ($S | length),
   minFreePct: ([$S[] | .freePct | select(. != null)] | min),
   meanFreePct: ([$S[] | .freePct | select(. != null)] | if length == 0 then null else (add / length | . * 10 | round / 10) end),
   swapinsDelta: delta($S; "swapins"), swapoutsDelta: delta($S; "swapouts"),
   peakCompressorMB: ([$S[] | select(.compressorPages != null and .pageSize != null) | .compressorPages * .pageSize / 1048576 | floor] | max),
   peakLoad1: ([$S[] | .load[0]? | select(. != null)] | max),
   meanLoad1: ([$S[] | .load[0]? | select(. != null)] | if length == 0 then null else (add / length | . * 100 | round / 100) end),
   therm: ([$S[] | .therm // empty] | unique),
   procs: ([$pnames[] as $p | [$S[] | .procs[$p]? | select(. != null)] as $v
     | {key: $p, value: {peakRssMB: ([$v[].rssKb] | max / 1024 | floor), peakCpu: ([$v[].cpu] | max),
        meanCpu: ([$v[].cpu] | add / length | . * 10 | round / 10), maxCount: ([$v[].count] | max), samples: ($v | length)}}] | from_entries)}
  as $load
| ([$R[] | .sha // empty] | unique) as $shas
| {v: 1, tag: $m.tag, startedAt: $m.startedAt,
   machine: ($m | {host, model, memGB, cpu, ncpu, macos, macosBuild, xcode, axe, runtimes, device}),
   simShSha256: $m.simShSha256, runnerSha256: $m.runnerSha256, repoSha: $m.repoSha, repoDirty: $m.repoDirty,
   plansSha256: $m.plansSha256, args: $m.args,
   devBuilds: $shas, devBuildChanged: (($shas | length) > 1),
   buildsSeen: ([$R[] | .buildsSeen[]?] | unique),
   aborted: (if $aborted == "" then null else $aborted end),
   jobs: $jobs, ops: $ops, opKinds: $kinds, signals: $signals, fails: $fails, failures: $failures, load: $load,
   gaps: ($m.gaps // [])}
| if ($against | length) > 0 then
    ($against[0]) as $o
    | ($o.jobs // [] | map({key: .name, value: .}) | from_entries) as $oj
    | ($o.ops // [] | map({key: "\(.job)|\(.i)|\(.key)", value: .}) | from_entries) as $oo
    | .against = {tag: $o.tag, model: $o.machine.model, simShSha256: $o.simShSha256}
    | .jobs |= map(. + {against: ($oj[.name] // null | if . then {p50: .runs2toN.p50, allP50: .all.p50, run1Ms: .run1Ms} else null end)})
    | .ops |= map(. + {againstP50: ($oo["\(.job)|\(.i)|\(.key)"].p50 // null)})
  else . end' >"$RD/summary.json" || { echo "summarize: the jq summary failed" >&2; exit 1; }
rm -f -- "$J"

# summary.md: the tables a person reads first. Seconds with one decimal; "—" where there is nothing to show.
jq -r '
def s: if . == null then "—" else (. / 100 | round / 10 | tostring) end;
def n: if . == null then "—" else tostring end;
def ratio($a; $b): if $a == null or $b == null or $b == 0 then "—" else "×" + (($a / $b) * 100 | round / 100 | tostring) end;
(.against != null) as $vs
| "# Sim bench — \(.tag) · \(.machine.model // "?") · \(.machine.memGB // "?") GB · macOS \(.machine.macos // "?")",
  "",
  "\(.startedAt) · \(.args.runs) runs of \(.args.jobs | join(", ")) · timeout \(.args.timeoutSec) s",
  "",
  "- sim.sh `\(.simShSha256[0:12])` · runner `\(.runnerSha256[0:12])` · repo `\(.repoSha[0:12])`\(if .repoDirty then " (dirty)" else "" end) · plans `\(.plansSha256[0:12])`",
  "- \(.machine.xcode // "Xcode ?") · AXe \(.machine.axe // "?") · \(.machine.cpu // "?") (\(.machine.ncpu // "?") cores)",
  "- runtimes: \([.machine.runtimes[]? | "\(.name) \(.buildversion)"] | join(", ") | if . == "" then "—" else . end) · sim: \(.machine.device.runtime // "?") \(.machine.device.deviceTypeIdentifier // "" | sub(".*\\."; ""))",
  "- dev build\(if .devBuildChanged then "s CHANGED mid-bench" else "" end): \([.devBuilds[] | .[0:7]] | join(" → ")) · builds the app showed: \(.buildsSeen | join(", ") | if . == "" then "—" else . end)",
  (if .aborted then "- **Aborted:** \(.aborted)" else empty end),
  (if $vs then "- compared with: \(.against.tag) (\(.against.model // "?")), sim.sh `\(.against.simShSha256[0:12])`" else empty end),
  "",
  "## Jobs (wall, s)",
  "",
  (if $vs then "| Job | Runs | Run 1 | p50 runs 2–N | p95 | max | min–max (all) | vs p50 | ratio | pass/fail/error | min free % | peak load | fails |"
   else "| Job | Runs | Run 1 | p50 runs 2–N | p95 | max | min–max (all) | pass/fail/error | min free % | peak load | fails |" end),
  (if $vs then "|---|---|---|---|---|---|---|---|---|---|---|---|---|" else "|---|---|---|---|---|---|---|---|---|---|---|" end),
  (.jobs[] | "| \(.name)\(if .skippedSetup then " (no \(.skippedSetup | join(", ")))" else "" end) | \(.runs) | \(.run1Ms | s) | \(.runs2toN.p50 | s) | \(.runs2toN.p95 | s) | \(.runs2toN.max | s) | \(.all.min | s)–\(.all.max | s) | "
     + (if $vs then "\(.against.p50 // null | s) | \(ratio(.runs2toN.p50; .against.p50)) | " else "" end)
     + "\(.pass)/\(.fail)/\(.error) | \(.minFreePct | n) | \(.peakLoad1 | n) | \(.failsBy | to_entries | map("\(.key) ×\(.value)") | join(", ") | if . == "" then "—" else . end) |"),
  "",
  "## Inputs that needed a second go, and failures",
  "",
  "| Signal | Count |",
  "|---|---|",
  (.signals | to_entries[] | select(.value > 0) | "| \(.key) | \(.value) |"),
  (.fails | "| dropped-input fails (ICON_TAP_DROPPED, HOME_PRESS_DROPPED, TAP_DROPPED, TYPED, ERASED, SWITCHER_FAILED) | \(.dropFails) |",
     "| AX_TIMEOUT | \(.axTimeout) |", "| TIMEOUT (job budget or PROBES) | \(.timeout) |", "| STALE_BUILD | \(.staleBuild) |"),
  (if .fails.seedMissing > 0 then "| **Done form task missing?** (no row Done to tap — `pnpm sim-bench:seed`) | \(.fails.seedMissing) |" else empty end),
  "",
  (if (.failures | length) > 0 then
    "Failures: \(.failures | map("r\(.run) \(.job) op \(.i // "?") `\(.op // "?")` \(.status) \(.reason // "-")/\(.detail // "-")\(if .note then ": \(.note[0:160])" else "" end)") | join("; "))", ""
   else empty end),
  "## Machine",
  "",
  (.load | "- free memory: min \(.minFreePct | n) %, mean \(.meanFreePct | n) % · swap-ins +\(.swapinsDelta | n), swap-outs +\(.swapoutsDelta | n) pages · compressor peak \(.peakCompressorMB | n) MB · load 1m: peak \(.peakLoad1 | n), mean \(.meanLoad1 | n) · \(.samples) samples"),
  (if (.load.therm | length) > 0 then "- pmset -g therm: \(.load.therm | join(" | "))" else empty end),
  "",
  "| Process | peak RSS MB | peak CPU % | mean CPU % | max count |",
  "|---|---|---|---|---|",
  (.load.procs | to_entries[] | "| \(.key) | \(.value.peakRssMB) | \(.value.peakCpu) | \(.value.meanCpu) | \(.value.maxCount) |"),
  "",
  "## Slowest ops (passing steps, runs 1–N, s)",
  "",
  (if $vs then "| Job | # | Op | n | Run 1 | p50 | p95 | max | vs p50 | ratio |" else "| Job | # | Op | n | Run 1 | p50 | p95 | max |" end),
  (if $vs then "|---|---|---|---|---|---|---|---|---|---|" else "|---|---|---|---|---|---|---|---|" end),
  (.ops | sort_by(-.p50) | .[0:20][] | "| \(.job) | \(.i) | \(.key | gsub("\\|"; "/")) | \(.n) | \(.run1Ms | s) | \(.p50 | s) | \(.p95 | s) | \(.max | s) |"
     + (if $vs then " \(.againstP50 | s) | \(ratio(.p50; .againstP50)) |" else "" end)),
  "",
  "## By op kind (s)",
  "",
  "| Op | n | p50 | p95 | max |",
  "|---|---|---|---|---|",
  (.opKinds[] | "| \(.op) | \(.n) | \(.p50 | s) | \(.p95 | s) | \(.max | s) |"),
  "",
  "Run 1 is the first timed run after the sign-in prelude; every run starts from a shut-down sim (relaunch ends with shutdown). Every op of every job is in summary.json (`ops`). Signals `inputDrops`, `leftoverDraft` and `resumedMidTyping` read notes from sim.sh changes not yet on main (axe-input-gap, sim-speedups-be): 0 until a benched sim.sh writes them. Not measured: \(.gaps | join("; "))."
' "$RD/summary.json" >"$RD/summary.md" || { echo "summarize: the md render failed" >&2; exit 1; }
echo "summarize: $RD/summary.md"
