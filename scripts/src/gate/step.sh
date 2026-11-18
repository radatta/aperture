# gate:fast's step wrapper (cli.ts spawnExec runs `heavy.sh -- sh <this file> <step…>`): runs the step and
# writes its exit code to $GATE_STEP_RESULT, so a heavy.sh that loses the code can't turn a red step green. A file
# that never gets written reads as a failure. POSIX sh, run by path (no exec bit needed).
"$@"
c=$?
printf '%s' "$c" >"$GATE_STEP_RESULT" || exit 2
exit "$c"
