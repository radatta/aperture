#!/bin/bash
# PreToolUse hook on Grep — DENIES search patterns COI's monitor KILLS the container on. The Grep tool runs
# rg with the pattern on its argv, and COI matches every process's command line, so a pattern that names a
# reverse-shell shape IS that shape. Rules: _coi-patterns.sh (shared with coi-reverse-shell-guard.sh). Only
# any-process rules apply: rg is not a shell (no /dev/tcp/ match) and carries no `sh -c` (no Sigma /curl
# pause). Same constraint as the Bash guard: builtins only, deny text over stdin.
set -euo pipefail
case "$(hostname)" in coi-*) ;; *) exit 0 ;; esac
INPUT=$(cat)
# Everything that reaches rg's argv, joined; jq's argv is only this filter. The path rg gets is absolute:
# none → the cwd; relative → resolved against the cwd (inference from Claude Code's Grep tool).
TEXT=$(printf '%s' "$INPUT" | jq -r '(.tool_input.path // "") as $p
  | [.tool_input.pattern, .tool_input.glob,
     (if ($p | startswith("/")) or ($p | startswith("~")) then $p elif $p == "" then .cwd else ((.cwd // "") + "/" + $p) end),
     .tool_input.type]
  | map(select(type == "string")) | join(" ")')
LC=${TEXT,,}
source "${BASH_SOURCE[0]%/*}/_coi-patterns.sh"
if coi_kill_shape "$LC"; then
  coi_deny "Blocked: this Grep carries $COI_REASON. Grep runs rg with the pattern on its command line, and COI KILLS the container on that text. Search an escaped form or fragment instead (socket\\.sock, fsock[o]pen, bash\\s-i, nc\\s-e), or Read the file."
fi
exit 0
