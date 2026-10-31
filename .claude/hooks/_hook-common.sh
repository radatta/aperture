#!/bin/bash
# Sourced (never executed) by every git/path-aware hook. `.cwd` in the hook's stdin JSON is the session's
# real working directory (the WORKTREE root in a worktree session); CLAUDE_PROJECT_DIR is the project root
# (main checkout) and does NOT track the worktree — so hooks must cd via `.cwd`, not CLAUDE_PROJECT_DIR.
# See README.md. No `set` flags here — this is sourced into hooks with differing flags.
hook_cd() {  # $1 = the hook's stdin JSON (INPUT)
  local d
  d=$(printf '%s' "$1" | jq -r '.cwd // empty' 2>/dev/null)
  [ -n "$d" ] || d="${CLAUDE_PROJECT_DIR:-$(pwd)}"
  cd "$d" 2>/dev/null || return 1
}

# Session ids reach filenames, grep patterns and (in precompact-handoff.sh) a process argv — only a UUID passes.
SID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

# The branch as it appears in a handoff filename: `detached` when HEAD is, `/` flattened to `-` (else the
# name is a subdirectory). The handoff skill applies the same rule by hand.
handoff_branch() {
  local b
  b=$(git branch --show-current 2>/dev/null)
  b=${b:-detached}
  printf '%s' "${b//\//-}"
}
