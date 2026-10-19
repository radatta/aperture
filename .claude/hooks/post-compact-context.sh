#!/bin/bash
# SessionStart hook, matcher "compact" — runs AFTER compaction and injects live repo state into the
# freshly-compacted context. Anthropic's documented pattern for re-establishing context post-compact.
#
# Pairs with the `handoff` skill: a handoff file is a dated SNAPSHOT, so it carries only what is safe
# to freeze, and this hook re-derives the rest at the moment it's needed:
#
#   handoff file  ->  decisions, dead ends, open questions   (durable — safe to freeze)
#   this hook     ->  branch, commits, PRs, deploys          (volatile — always re-derived)
#
# Motivation: on 2026-09-07 deployment history and branch state were asserted from stale `origin/*`
# refs, confidently and wrongly, three separate times — see docs/ops/COI-SANDBOX.md → GitHub access
# inside the container. Compaction makes it worse: the summary carries forward whatever was believed,
# detached from how it was learned.
#
# Everything here is READ-ONLY and best-effort. Any command may fail (no network, no `gh` auth, not a
# repo); each is guarded so the hook always exits 0. A hook that errors on a plane is worse than one
# that says less.
#
# Wired in .claude/settings.json (SessionStart, matcher "compact"). The handoff itself is written before
# compaction by precompact-handoff.sh — see docs/ops/COMPACTION-HANDOFF.md.

set -uo pipefail  # deliberately NOT -e: a failing probe must not kill the hook

INPUT=$(cat)
source "${BASH_SOURCE[0]%/*}/_hook-common.sh"; hook_cd "$INPUT" || exit 0
git rev-parse --git-dir >/dev/null 2>&1 || exit 0
cd "$(git rev-parse --show-toplevel)" || exit 0  # handoffs live at the repo root even if the session cd'd into app/

BRANCH=$(git branch --show-current 2>/dev/null || echo "")

echo "=== Live repo state (re-derived post-compact — trust this over anything in the summary) ==="
echo

echo "## Branch and working tree"
git status -sb 2>/dev/null | head -5 || echo "(unavailable)"
echo

echo "## Recent commits"
git log --oneline -5 2>/dev/null || echo "(unavailable)"
echo

# Remote refs are only as fresh as the last fetch. Inside the COI container there may be no network
# and no credentials, so this is strictly best-effort — but when it works it's the difference between
# reading live state and reading whatever the Mac last pulled.
if timeout 15 git fetch --quiet origin 2>/dev/null; then
  echo "## vs origin (fetched just now)"
  if [ -n "$BRANCH" ] && git rev-parse --verify --quiet "origin/$BRANCH" >/dev/null 2>&1; then
    echo "ahead $(git rev-list --count "origin/$BRANCH..HEAD" 2>/dev/null), behind $(git rev-list --count "HEAD..origin/$BRANCH" 2>/dev/null)"
  else
    echo "no upstream for '$BRANCH' (unpushed branch)"
  fi
  echo "origin/main: $(git log --oneline -1 origin/main 2>/dev/null || echo '?')"
  echo "origin/dev:  $(git log --oneline -1 origin/dev 2>/dev/null || echo '?')"
else
  echo "## vs origin"
  echo "FETCH FAILED — every origin/* ref below is as stale as the last successful fetch."
  echo "Do not state remote or deployment facts from them. Say you cannot see it."
fi
echo

if command -v gh >/dev/null 2>&1; then
  PRS=$(timeout 20 gh pr list --state open --limit 5 \
    --json number,headRefName,mergeStateStatus \
    --template '{{range .}}#{{.number}} {{.headRefName}} — {{.mergeStateStatus}}{{"\n"}}{{end}}' 2>/dev/null)
  echo "## Open PRs"
  echo "${PRS:-(none, or unavailable)}"
  echo

  RUNS=$(timeout 20 gh run list --limit 3 \
    --json headBranch,headSha,conclusion,createdAt \
    --template '{{range .}}{{.createdAt | printf "%.16s"}} {{.headBranch}} {{.headSha | printf "%.8s"}} {{.conclusion}}{{"\n"}}{{end}}' 2>/dev/null)
  echo "## Recent CI runs"
  echo "${RUNS:-(none, or unavailable)}"
  echo
fi

# The handoff precompact-handoff.sh wrote for THIS compaction — its log's last line for this session names
# the file and was written in the last 10 min — is injected: it was written for exactly this moment.
# Otherwise the newest handoff for this branch is surfaced by path only; reading it is a decision for the
# session, and dumping a stale file into a just-compacted context defeats compaction.
H=localNotes/handoffs
SID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
OWN=""
if [[ "$SID" =~ $SID_RE ]]; then
  SID8=${SID:0:8}
  LAST=$(grep -F -- " sid=$SID8" "$H/precompact.log" 2>/dev/null | tail -1)
  OWN=$(sed -n 's/.* file=\(handoff-[^ ]*\.md\)$/\1/p' <<<"$LAST")
  LOGGED=$(date -d "${LAST%% *}" +%s 2>/dev/null || echo 0)
  [ -n "$OWN" ] && [ -f "$H/$OWN" ] && [ $(($(date +%s) - LOGGED)) -lt 600 ] || OWN=""
fi
if [ -n "$OWN" ]; then
  echo "## Handoff written just before this compaction — $H/$OWN"
  echo "Written by a fork of this session moments ago. Its decisions, dead ends and open questions are"
  echo "what the summary may have dropped; its 'State as of' block is superseded by the live state above."
  echo
  head -150 "$H/$OWN"
  LINES=$(wc -l < "$H/$OWN")
  [ "$LINES" -gt 150 ] && echo "… (first 150 of $LINES lines — read the file for the rest)"
  echo
else
  # Fixed-string match on the dated name (`handoff-<YYYY-MM-DD-HHMM>-<branch>[-<sid8>].md`), so a branch
  # like `c++` can't break a regex and `main` can't match `…-other-main.md`.
  B=$(handoff_branch)
  D='[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]-[0-9][0-9][0-9][0-9]'
  X='[0-9a-f]'
  LATEST=$(cd "$H" 2>/dev/null && ls -1d handoff-$D-"$B".md handoff-$D-"$B"-$X$X$X$X$X$X$X$X.md 2>/dev/null | sort | tail -1)
  if [ -n "$LATEST" ]; then
    echo "## Handoff available"
    echo "$H/$LATEST"
    echo "Durable context (decisions, dead ends, open questions). Its 'State as of' block is a frozen"
    echo "snapshot — the live state above supersedes it. Read the file if picking up unfamiliar work."
    echo
  fi
fi

exit 0
