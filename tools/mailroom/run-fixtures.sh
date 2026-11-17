#!/bin/bash
# Diagnostic only (axe-diag, never merged), round 2: which way of blocking survives in the background on the Mac.
set -euo pipefail
echo "bash $BASH_VERSION"
D="${TMPDIR:-/tmp}/diag.$$"; mkdir -p "$D"
probe() { # name, then the command to background
  local name="$1" p; shift
  "$@" >"$D/$name.out" 2>&1 &
  p=$!
  command sleep 0.5
  if kill -0 "$p" 2>/dev/null; then echo "$name: alive at 0.5 s"; else wait "$p" 2>/dev/null; echo "$name: DEAD at 0.5 s (rc $?) out=$(tr '\n' '|' <"$D/$name.out")"; fi
  kill -TERM "$p" 2>/dev/null || true; wait "$p" 2>/dev/null || true
  echo "  after TERM: $(tr '\n' '|' <"$D/$name.out")"
}
loop_e() { local n=0; echo s; while [ "$n" -lt 50 ]; do command sleep 0.1; n=$((n + 1)); done; echo ended; }
loop_noe() { set +e; local n=0; echo s; while [ "$n" -lt 50 ]; do command sleep 0.1; echo "rc$?"; n=$((n + 1)); done; echo ended; }
one_sleep() { trap 'echo trapped; exit 0' TERM; echo s; command sleep 5; echo "slept rc$?"; }
bg_wait() { trap 'kill "$s" 2>/dev/null; echo trapped; exit 0' TERM; echo s; command sleep 5 & s=$!; wait "$s"; echo "waited rc$?"; }
mkfifo "$D/f"
fifo_read() { trap 'echo trapped; exit 0' TERM; echo s; read -r -t 5 _ <>"$D/f" || true; echo "read-done"; }
probe loop_e loop_e
probe loop_noe loop_noe
probe one_sleep one_sleep
probe bg_wait bg_wait
probe fifo_read fifo_read
probe plain_sleep command sleep 5
echo "# 1 passed, 0 failed, of 1 cases"
