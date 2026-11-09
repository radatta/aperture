#!/bin/bash
# A stand-in for tools/mailroom/runner.sh in the bench's orchestration fixtures (run-fixtures.sh): drains the inbox and
# writes results/<id>/{plan.json, progress.json, result.json} in the runner's shapes (runner.sh result + sim.sh's
# run_sim extra), answering from $SIM_BENCH_FAKE_TAPE: {"<job>@r<run>" | "<job>": {status, reason, detail, ms, steps}}.
# Steps default to every plan op passing in `ms` (default 1000) each; `steps` entries override by index.
# SIM_BENCH_FAKE_HANG=1 hangs (a child sleep) so the bench's kill path runs.
set -uo pipefail
HJ="$1"
TAPE="${SIM_BENCH_FAKE_TAPE:-/dev/null}"
if [ "${SIM_BENCH_FAKE_HANG:-}" = 1 ]; then
  command sleep 30 &
  echo $! >"$HJ/../../hang.pid" # the results dir's parent: case 9 checks the stop took this child too
  wait
  exit 0
fi
for f in "$HJ"/inbox/*.json; do
  [ -e "$f" ] || continue
  id="$(basename "$f" .json)"
  rest="${id#*-r}"
  run="${rest%%-*}"
  job="${rest#*-}"
  mkdir "$HJ/results/$id"
  mv -- "$f" "$HJ/results/$id/plan.json"
  jq -cn --slurpfile p "$HJ/results/$id/plan.json" '{at: (now | todate), i: 0, of: ($p[0].params.steps | length), op: $p[0].params.steps[0].op}' \
    >"$HJ/results/$id/progress.json"
  t="$(jq -c --arg k "$job@r$run" --arg j "$job" '.[$k] // .[$j] // {}' "$TAPE" 2>/dev/null)"
  [ -n "$t" ] || t='{}'
  if [ "${SIM_BENCH_FAKE_GARBLE:-}" = "$job" ]; then printf 'not json' >"$HJ/results/$id/result.json"; continue; fi
  jq -cn --arg id "$id" --argjson t "$t" --slurpfile p "$HJ/results/$id/plan.json" '
    ($p[0].params.steps) as $plan
    | [range(0; $plan | length) as $i
        | ({i: $i, op: $plan[$i].op, status: "pass", ms: ($t.ms // 1000)} + (($t.steps // {})["\($i)"] // {}))] as $steps
    | {v: 1, id: $id, job: "sim", status: ($t.status // "pass"), reason: ($t.reason // null),
       startedAt: (now | floor | todate), finishedAt: (now | floor | todate),
       durationMs: ([$steps[].ms] | add), runnerVersion: "fake",
       detail: ($t.detail // null), device: {name: "aperture-devcheck", udid: null, runtime: null, axe: "1.8.0", xcode: null},
       booted: ($t.booted // "warm"), signedIn: "true", buildsSeen: ($t.buildsSeen // []), steps: $steps, reads: {}, shots: []}' \
    >"$HJ/results/$id/result.json"
done
