#!/usr/bin/env bash
# Load-test matrix (docs/ops/SESSION-BOARD.md → Measurement protocol). Every job runs through heavy.sh
# with HEAVY_GUARD=1, so the stop conditions hold and every rep lands in events-*.jsonl.
#   matrix.sh setup              scratch trees B and C (detached at this HEAD) + install, for pair cells
#   matrix.sh list
#   matrix.sh <cell> [reps]      default 3; extends to 5 when Δanon or Δpids spread > 10 % of the median
# Singles can run any time; pairs, *-sessions and edge.sh belong in the quiet window (other sessions exited).
# Env: MATRIX_TREES="A B C" (default: this tree + .claude/worktrees/board-matrix-{b,c}), PW_DIR (ui cells).
set -u
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

read -r -a TREES <<<"$(sb_matrix_trees)"
GAP="${MATRIX_GAP:-20}"

# cell → "class|command" for one job; pairs and sessions compose these.
job() {
  case "$1" in
    typecheck) echo "typecheck|pnpm exec tsc -b --force" ;;  # cold: the incremental gate is cheaper
    lint) echo "lint|pnpm exec eslint ." ;;  # cold: no --cache
    test) echo "test|pnpm test" ;;
    test-wc1) echo "test|pnpm -r --workspace-concurrency=1 test" ;;
    test-wc2) echo "test|pnpm -r --workspace-concurrency=2 test" ;;
    test-w3) echo "test|env VITEST_MAX_WORKERS=3 pnpm test" ;;
    test-w4) echo "test|env VITEST_MAX_WORKERS=4 pnpm test" ;;
    dev) echo "dev|pnpm dev" ;;
    ui) echo "ui|scripts/board/measure/ui-cell.sh" ;;
    ui-rpl1) echo "ui|env UI_RENDERER_LIMIT=1 scripts/board/measure/ui-cell.sh" ;;
    *) return 1 ;;
  esac
}
CELLS="typecheck lint test test-wc1 test-wc2 test-w3 test-w4 dev ui ui-rpl1 pair:test+test pair:test+ui pair:test+typecheck pair:dev+ui two-sessions three-sessions"

# One job in tree $1: cell $2, label $3.
run_job() {
  local spec class cmd
  spec=$(job "$2") || { echo "matrix: unknown job $2" >&2; return 2; }
  class=${spec%%|*}; cmd=${spec#*|}
  ( cd "$1" || exit 2
    export HEAVY_GUARD=1 HEAVY_LABEL="$3" HEAVY_CLASS="$class"
    [ "$class" = dev ] && export HEAVY_DURATION="${MATRIX_DEV_SEC:-90}"
    # shellcheck disable=SC2086 — cmd is a fixed string from job()
    bash scripts/board/heavy.sh -- $cmd >"${TMPDIR:-/tmp}/aperture-matrix.${3//[^A-Za-z0-9]/_}.log" 2>&1 )  # A/B kept apart
}

# A session's round in tree $1: test → typecheck → ui — all three whatever each exits (each is its own event).
run_session() { run_job "$1" test "$2:test"; run_job "$1" typecheck "$2:typecheck"; run_job "$1" ui "$2:ui"; }

run_cell() {  # $1 cell, $2 rep label prefix
  local cell="$1" pre="$2" a b i pids=() need=1
  case "$cell" in pair:*|two-sessions) need=2 ;; three-sessions) need=3 ;; esac
  for ((i = 0; i < need; i++)); do  # a missing scratch tree would exit at `cd` and leave no event
    [ -d "${TREES[$i]:-/nonexistent}/node_modules" ] || { echo "matrix: $cell needs ${TREES[$i]:-tree $((i + 1))} installed — matrix.sh setup" >&2; return 2; }
  done
  case "$cell" in
    pair:*)
      a=${cell#pair:}; b=${a#*+}; a=${a%%+*}
      run_job "${TREES[0]}" "$a" "$pre:A:$a" & pids+=($!)
      run_job "${TREES[1]}" "$b" "$pre:B:$b" & pids+=($!) ;;
    two-sessions|three-sessions)
      local n=2; [ "$cell" = three-sessions ] && n=3
      for ((i = 0; i < n; i++)); do run_session "${TREES[$i]}" "$pre:S$i" & pids+=($!); done ;;
    *) run_job "${TREES[0]}" "$cell" "$pre" & pids+=($!) ;;
  esac
  wait "${pids[@]}"
}

# Per-rep summary from the events this rep wrote: container peaks across its jobs.
summarize() {  # $1 label prefix
  cat "$BOARD_DIR"/history/events-*.jsonl 2>/dev/null | jq -sc --arg p "$1" '
    map(select(.kind == "job" and ((.label // "") | startswith($p)))) | select(length > 0) |
    {rep: $p, jobs: length, exits: map(.exit), wallSec: (map(.wallSec) | max),
     dPids: (map(.peak.dPids) | max), dAnonMiB: (map(.peak.dAnonMiB) | max),
     pids: (map(.peak.pids) | max), anonMiB: (map(.peak.anonMiB) | max),
     subtreeThr: (map(.peak.subtreeThr) | add), subtreeRssMiB: (map(.peak.subtreeRssMiB) | add),
     oomKillDelta: (map(.oomKillDelta) | add), highDelta: (map(.highDelta) | add),
     psiFullMax: (map(.psiFullMax) | max), cores: (map(.peak.cores) | max),
     verdicts: (map(.verdict) | unique)}'
}

spread_ok() {  # reads rep summaries on stdin; true when max−min ≤ 10 % of the median for dAnon and dPids
  jq -se 'def med: sort | .[length / 2 | floor];
    def ok(f): (map(f) | (max - min) <= (med * 0.1 | if . < 1 then 1 else . end));
    ok(.dAnonMiB) and ok(.dPids)' >/dev/null
}

case "${1:-}" in
  list) echo "$CELLS" | tr ' ' '\n' ;;
  setup)
    for t in "${TREES[@]:1}"; do
      [ -d "$t" ] && { echo "matrix: $t exists"; continue; }
      git -C "$SB_REPO" worktree add --detach "$t" HEAD && ( cd "$t" && CI=true pnpm install --frozen-lockfile )
    done ;;
  "") sed -n '2,9p' "${BASH_SOURCE[0]}"; exit 2 ;;
  *)
    cell="$1"; reps="${2:-3}"
    case " $CELLS " in *" $cell "*) ;; *) echo "matrix: unknown cell $cell (matrix.sh list)" >&2; exit 2 ;; esac
    run="matrix:$cell:$(date -u +%m%d%H%M)"
    summaries=()
    r=0
    while :; do
      r=$((r + 1))
      if [ "$r" -gt "$reps" ]; then  # past the asked reps: continue to 5 only while the spread is wide
        [ "$r" -le 5 ] && [ "${#summaries[@]}" -ge 3 ] && ! printf '%s\n' "${summaries[@]}" | spread_ok || break
      fi
      [ "$r" -gt 1 ] && sleep "$GAP"
      run_cell "$cell" "$run#$r"
      s=$(summarize "$run#$r")
      summaries+=("$s")
      printf '%s\n' "$s" | jq -r '"rep \(.rep | split("#")[1]): exits \(.exits) · \(.wallSec)s · Δpids +\(.dPids) (peak \(.pids)) · Δanon +\(.dAnonMiB) MiB (peak \(.anonMiB)) · subtree \(.subtreeThr) thr / \(.subtreeRssMiB) MiB · oom_kill +\(.oomKillDelta) · high +\(.highDelta) · psi \(.psiFullMax) · \(.cores) cores · \(.verdicts | join(","))"'
      printf '%s\n' "$s" | jq -e '.verdicts | index("guard-stop")' >/dev/null && { echo "matrix: guard stop — not repeating"; break; }
    done
    printf '%s\n' "${summaries[@]}" | jq -sc --arg cell "$cell" --arg run "$run" --arg t "$(sb_now)" '
      {v: 1, t: $t, kind: "matrix", cell: $cell, run: $run, reps: length,
       max: {dPids: (map(.dPids) | max), dAnonMiB: (map(.dAnonMiB) | max), wallSec: (map(.wallSec) | max)},
       median: {dPids: (map(.dPids) | sort | .[length / 2 | floor]), dAnonMiB: (map(.dAnonMiB) | sort | .[length / 2 | floor]),
                wallSec: (map(.wallSec) | sort | .[length / 2 | floor])}, summaries: .}' |
      tee -a "$BOARD_DIR/history/matrix-$(sb_today).jsonl" | jq -r '"\(.cell): \(.reps) reps · max Δpids +\(.max.dPids) · max Δanon +\(.max.dAnonMiB) MiB · median wall \(.median.wallSec)s"' ;;
esac
