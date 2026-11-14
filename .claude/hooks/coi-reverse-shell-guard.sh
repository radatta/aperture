#!/bin/bash
# PreToolUse hook on Bash — DENIES command text that COI's security monitor acts on: the CRITICAL
# "reverse shell" shapes, which KILL THE WHOLE CONTAINER, and the HIGH ones that PAUSE it (Sigma's
# `/curl`|`/wget` rule, the exec watcher's node pattern). The right move is to stop emitting the shape,
# not to disarm the detector.
#
# Rule reference (regenerated on every COI upgrade): localNotes/code-on-incus/APERTURE-ANALYSIS.md.
# Mechanism and observed kills/pauses: docs/ops/COI-INCIDENTS.md → Incidents F and H. The any-process
# rules live in _coi-patterns.sh, shared with coi-grep-guard.sh so the two can't drift. It also carries the
# search-load rule (_search-load.sh, Incident I) — not a COI rule: it protects the VM's memory.
#
# ---------------------------------------------------------------------------
# IMPLEMENTATION CONSTRAINT — READ BEFORE EDITING
#
# This script must never place a flagged pattern into a process's argv. An
# earlier version used `echo "$COMMAND" | grep -qE '...socat...tcp...'` and
# `jq -n --arg reason "<text mentioning python -c>"`. Both put the literals on a
# command line, so the guard itself could trip the detector it exists to avoid.
#
# Therefore: match with `case`/`[[ ]]`/`${//}` (shell builtins, no process), shared
# via _coi-patterns.sh, and pass the deny message to jq over STDIN via printf (also a
# builtin) rather than as --arg. jq's own argv holds only the filter, which contains no
# flagged substring. Do not reintroduce grep/sed/awk here.
# ---------------------------------------------------------------------------
#
# KNOWN FALSE POSITIVE: matching is text-based — a heredoc whose *content* carries a
# strong token is blocked though no such process would spawn. Use the Write/Edit tools
# for that. The arms are narrowed to what COI v0.15 really fires on: over-blocking
# makes Claude timid, so a shape COI lets through is let through here too.
#
# See docs/ops/COI-SANDBOX.md → "Container killed — the CRITICAL path is a different
# animal", and docs/ops/COI-INCIDENTS.md → Incidents F and H.

set -euo pipefail

# Only meaningful inside a COI container. No-op on the Mac or in the Lima VM.
case "$(hostname)" in
  coi-*) ;;
  *) exit 0 ;;
esac

INPUT=$(cat)
# jq's argv here is only the filter — no flagged substrings.
COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""')

# Lowercase, mirroring COI's own strings.ToLower before matching.
LC=${COMMAND,,}

source "${BASH_SOURCE[0]%/*}/_coi-patterns.sh"

HEREDOC_HINT='Use a heredoc instead — it runs as "python3 -", which is not on the list:

  python3 - <<'"'"'PY'"'"'
  import json, sys
  ...
  PY

For JSON, jq is installed and matches nothing. If you are writing file CONTENT that
merely mentions these strings, use the Write/Edit tools rather than Bash.'

if coi_kill_shape "$LC"; then
  if [[ $COI_CLASS == oneliner ]]; then
    coi_deny "Blocked: $COI_REASON is COI's one-liner reverse-shell class — CRITICAL, it KILLS the container (unless [monitoring] reverse_shell_one_liners = \"warn\" is live). A one-liner without a network token is fine.

$HEREDOC_HINT"
  fi
  coi_deny "Blocked: this command carries $COI_REASON — COI classifies it CRITICAL in any process and KILLS the container. Run the command directly; to search for it use a fragment or escape (socket\\.sock, bash\\s-i); to write file content that mentions it use Write/Edit."
fi

# Shell-only: /dev/tcp|udp/<endpoint> fires only in a shell process — and the Bash wrapper is one — with a
# non-loopback endpoint (process.go:614-676). Loopback probes are stripped first, so they can't mask a remote one.
T=${LC//\/dev\/tcp\/localhost\//}; T=${T//\/dev\/tcp\/127.0.0.1\//}
T=${T//\/dev\/udp\/localhost\//}; T=${T//\/dev\/udp\/127.0.0.1\//}
RE_DEVNET='/dev/(tcp|udp)/[^[:space:]"'\'';|&<>()]'
if [[ $T =~ $RE_DEVNET ]]; then
  coi_deny "Blocked: /dev/tcp/ or /dev/udp/ followed by a non-loopback endpoint in a shell line KILLS the container. A bare mention (followed by a space or quote) or localhost/127.0.0.1 is fine; use curl -sI for reachability."
fi

# Exec watcher nc-exec/ncat-exec (procwatcher.go:41-76): a process whose argv0 starts with `nc` and whose
# text holds `-e` ANYWHERE → PAUSE — so `nc -z host.us-east-1… 443` trips it via `-east`. A spaced `-e`
# counts only in nc's own segment (up to ; | & or a newline; `\`-continuations joined first), so `set -e`
# and `grep -e` pass. A glued one (`us-east-1`) counts anywhere on an nc line: a variable, loop or xargs
# can carry it into nc's argv from another segment.
S=${LC//$'\\\n'/ }
RE_NC="${COI_TOK}nc[^[:space:]]*[[:space:]][^;|&"$'\n'"]*-e"
RE_NCTOK="${COI_TOK}nc[^[:space:]]*[[:space:]]"
if [[ $S =~ $RE_NC ]] || [[ $S =~ $RE_NCTOK && $S =~ [[:alnum:]]-e ]]; then
  coi_deny "Blocked: an nc/ncat command whose text contains \`-e\` anywhere (a flag, or a hostname like \`us-east-1\`) matches COI's netcat exec pattern and PAUSES the container. Use curl -sI for reachability instead."
fi

# Exec watcher node-reverse-shell (procwatcher.go:55-75): argv0 node + child_process + net → PAUSE.
RE_NODE="${COI_TOK}node (-e|-p|--eval|--print)"
if [[ $LC =~ $RE_NODE && $LC == *child_process* && $LC == *net* ]]; then
  coi_deny "Blocked: node -e/-p with child_process and net matches COI's node reverse-shell exec pattern and PAUSES the container. Put the script in a file, or pipe it: node - <<'JS' … JS."
fi

# Sigma "Suspicious Download and Execute via Curl/Wget" (HIGH → container PAUSED, still on v0.15.0):
# it needs `/curl` or `/wget` + `/tmp/` + `sh -c`, and the Bash tool's own wrapper supplies the last
# two on every call — so the five characters alone (a path segment, a URL, a grep pattern) pause it.
case "$LC" in
  *"/curl"*|*"/wget"*)
    coi_deny "Blocked: the text \`/curl\` or \`/wget\` (with the slash) anywhere on a Bash line PAUSES the COI container — Sigma's download-and-execute rule, completed by the Bash wrapper's own \`/tmp/\` + \`bash -c\`. Bare \`curl\`/\`wget\` is fine. To read a file under a curl/ or wget/ path use the Read tool; to search for those words use a fragment (e.g. \`url\`) or the Read tool." ;;
esac

# Search-load rule (Incident I; not a COI rule): a padded pattern over files, or an ignore-blind recursive search
# on a root. After the COI arms, so a kill or pause shape is always the reason given.
case "$LC" in *grep*|*rg*)
  source "${BASH_SOURCE[0]%/*}/_search-load.sh"
  CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // ""')
  MAIN=${BASH_SOURCE[0]%/*}; MAIN=${MAIN%/.claude/hooks}; MAIN=${MAIN%/.claude/worktrees/*}
  if search_load_shape "$COMMAND" "$CWD" "$MAIN"; then
    SAFE='Safe form: timeout 60 nice -n 10 rg -n <pattern> <dirs> | head -500, scoped to tracked source dirs (app/src lambdas/src packages scripts docs …); -C N for context lines. Mechanism: docs/ops/COI-INCIDENTS.md → Incident I.'
    if [[ $SEARCH_REASON == pad ]]; then
      coi_deny "Blocked: a wide padding quantifier (.{0,N} with N >= 20) in a grep / git grep / rg pattern over files. On 2026-11-14 one such search took 12 GB and froze the VM for every session. Use -C for context instead of padding, or rg (its engine is linear-time; rg is exempt); for one very long line, the Read tool with an offset. Padding on a pipe of command output is not blocked.
$SAFE"
    fi
    coi_deny "Blocked: an ignore-blind recursive search (grep -r, rg -u/--no-ignore, git grep --no-index/--untracked) on a checkout root, home, / or the worktrees dir walks node_modules and every checkout under .claude/worktrees. Name the dirs, or use git grep -n <pattern> -- <dirs> (tracked files only).
$SAFE"
  fi ;;
esac

# Everything else passes through silently.
exit 0
