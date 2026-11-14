#!/bin/bash
# SessionStart hook — fires once per session (new or resumed). Injects the doc
# index so Claude opens with the map, plus a short git-state briefing so a
# resumed session starts oriented instead of re-deriving where it stands.
#
# set -u only; fail-open everywhere — a session must always be able to start.

set -u

INPUT=$(cat)
source "${BASH_SOURCE[0]%/*}/_hook-common.sh"; hook_cd "$INPUT" || exit 0
INDEX="$PWD/docs/index.md"

CONTENT=""
if [ -f "$INDEX" ]; then
  CONTENT=$(cat "$INDEX")
else
  CONTENT="(docs/index.md not found — see docs/ for specs.)"
fi

# --- git briefing: computed in a subshell with errexit off so one failing
# check can't abort the hook. ---
BRIEF=$(
  set +e
  command -v git >/dev/null 2>&1 || exit 0
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0
  B=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
  printf '\n\n---\n\nGit state at session start:\nbranch: %s\n' "${B:-unknown}"
  case "$B" in
    main|master|dev)
      printf 'On a protected/deploy branch — branch before editing; commits/pushes here are blocked (they would deploy).\n' ;;
    HEAD|"") : ;;
    *)
      U=$(git rev-list --count '@{u}..HEAD' 2>/dev/null)
      [ -n "$U" ] && [ "$U" != "0" ] && printf 'unpushed commits: %s (push to back up)\n' "$U"
      ;;
  esac
  S=$(git status --short 2>/dev/null)
  if [ -z "$S" ]; then printf 'working tree: clean\n'; else printf 'uncommitted changes:\n%s\n' "$S"; fi
)

# --- the Mac repo path: never in a tracked file (docs/ops/IDENTIFIERS.md), so it comes from the main checkout's
# gitignored .local/mac-root — the path every handed-over `cd …` line starts with. ---
MAC=$(
  set +e
  common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
  f="${common%/.git}/.local/mac-root"
  # The same rule as scripts/src/mac-root.ts: one absolute line of [A-Za-z0-9_./-], no `..`, trailing / dropped.
  v=''
  [ "$(grep -c '' "$f" 2>/dev/null)" = 1 ] && v=$(tr -d '\r\n' <"$f" 2>/dev/null) && v=${v%/}
  if printf '%s' "$v" | grep -Eq '^/[A-Za-z0-9_./-]+$' && ! printf '%s' "$v" | grep -Eq '(^|/)\.\.(/|$)'; then
    printf '\nMac repo path (<mac-repo>, from .local/mac-root): %s — /workspace is this path on the Mac.\n' "$v"
  else
    printf '\nMac repo path: unknown (no valid .local/mac-root in the main checkout) — hand the user <mac-repo> lines and ask them to run: cd <the repo> && mkdir -p .local && pwd -P > .local/mac-root\n'
  fi
)

COMBINED="$CONTENT$BRIEF$MAC"

jq -n --arg content "$COMBINED" '{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": $content
  }
}'
