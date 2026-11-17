#!/bin/bash
# Diagnostic only (axe-diag branch, never merged): how bash 3.2 on the Mac, inside the fixtures sandbox, treats a
# backgrounded exported function with redirections — $!, kill -0, wait — as sim.sh's log capture uses it.
set -euo pipefail
echo "bash $BASH_VERSION"
D="${TMPDIR:-/tmp}/diag.$$"; mkdir -p "$D"
st() { trap 'echo "trap-term"; exit 0' TERM; local n=0; echo "started"; while [ "$n" -lt 50 ]; do command sleep 0.1; n=$((n + 1)); done; echo "loop-ended"; }
export -f st
x() { st "$@"; }
export -f x
x >"$D/out" 2>"$D/err" &
p=$!
echo "bang=[$p]"
command sleep 0.3
if kill -0 "$p" 2>"$D/kerr"; then echo "alive-after-0.3"; else echo "dead-after-0.3 rc=$? kerr=$(cat "$D/kerr")"; fi
ps -o pid,ppid,stat,command -p "$p" 2>&1 | tail -1 || true
kill -TERM "$p" 2>/dev/null && echo "term-sent" || echo "term-failed"
wait "$p" 2>/dev/null; echo "wait-rc=$?"
echo "out: $(tr '\n' '|' <"$D/out") err: $(tr '\n' '|' <"$D/err")"
# the same, with set +e inside a subshell, and no redirection
( set +e; x & q=$!; command sleep 0.3; kill -0 "$q" && echo "noredir-alive" || echo "noredir-dead"; kill "$q" 2>/dev/null; wait "$q" 2>/dev/null )
echo "# 1 passed, 0 failed, of 1 cases"
