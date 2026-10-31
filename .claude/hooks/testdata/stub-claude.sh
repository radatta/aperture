#!/bin/bash
# Stand-in for `claude` in the compaction suite (run-fixtures.py puts it first on PATH as `claude`).
# Records its argv — plus the /compact instructions file, if the hook wrote one — to $STUB_ARGV_FILE,
# writes the handoff the real fork would, and prints a canned `-p --output-format json` result.
# STUB_RC sets the exit code, STUB_SLEEP (seconds) makes it outlive the hook's timeout.
set -u
printf '%s\n' "$@" > "$STUB_ARGV_FILE"
[ -n "${STUB_SLEEP:-}" ] && exec sleep "$STUB_SLEEP"
prompt=${!#}
sid=${prompt#*session=}; sid=${sid%% *}; sid8=${sid:0:8}
instr="localNotes/handoffs/.instructions-$sid8.txt"
[ -f "$instr" ] && printf 'instructions: %s\n' "$(cat "$instr")" >> "$STUB_ARGV_FILE"
if [ "${STUB_RC:-0}" -ne 0 ]; then
  echo "stub failure" >&2
  exit "$STUB_RC"
fi
branch=$(git branch --show-current); branch=${branch:-detached}; branch=${branch//\//-}
echo "# Handoff — stub" > "localNotes/handoffs/handoff-$(date +%Y-%m-%d-%H%M)-$branch-$sid8.md"
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"num_turns":5,"session_id":"f0f0f0f0-0000-4000-8000-000000000000","usage":{"cache_read_input_tokens":500000,"cache_creation_input_tokens":2000,"output_tokens":1500},"permission_denials":[]}'
