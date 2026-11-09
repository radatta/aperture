#!/bin/bash
# SessionStart (all sources, incl. compact) — registers this session on the shared-container board, starts
# the usage sampler if none is running, and injects a short board view: headroom, the real dev lock, the hub
# (or, in the hub itself, its roadmap reminder), and files this branch shares with other worktrees.
# docs/ops/SESSION-BOARD.md, docs/ops/HUB.md. Fail-open: any error → silent exit 0.
INPUT=$(cat)
B="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts/board" 2>/dev/null && pwd)" || exit 0
[ -f "$B/lib.sh" ] || exit 0
. "$B/lib.sh"
[ -d "${BOARD_DIR%/*}" ] && [ -r "$CG/memory.stat" ] || exit 0  # container-only: no cgroup (Mac, CI) → nothing to do

# \x1f, not a tab: whitespace IFS would drop an empty leading field and shift CWD into SID.
IFS=$'\x1f' read -r SID CWD < <(printf '%s' "$INPUT" | jq -r '[.session_id // "", .cwd // ""] | join("\u001f")' 2>/dev/null)
PID=$(sb_claude_pid "$PPID") || exit 0
bash "$B/board.sh" register --pid "$PID" --sid "$SID" --cwd "${CWD:-$(pwd)}" >/dev/null 2>&1 || exit 0
flock -n "$SAMPLER_LOCK" true 2>/dev/null && bash "$B/board.sh" sampler start >/dev/null 2>&1

branch=$(jq -r '.branch // empty' "$BOARD_DIR/sessions/$PID.json" 2>/dev/null)
{
  echo "Session board (\`scripts/board/board.sh status\` for the full view):"
  cat "$BOARD_DIR/status.line" 2>/dev/null
  # At most three read-only calls of 2 s each (one ls-remote for both dev slots, a tag read per held slot), skipped
  # when the caches are under a minute old: the hook's timeout is 10 s, and an overrun loses every line below.
  bash "$B/devlock.sh" refresh --max-age 60 --timeout 2 >/dev/null 2>&1
  bash "$B/devlock.sh" line 2>/dev/null
  name=$(jq -r '.name // empty' "$BOARD_DIR/sessions/$PID.json" 2>/dev/null)
  if [ -n "$name" ] && [ "$name" = "$(jq -r '.name // empty' "$B/hub.json" 2>/dev/null)" ]; then
    echo "You are the hub — read /workspace/localNotes/roadmap.md before anything else (docs/ops/HUB.md)."
  else
    bash "$B/board.sh" hub 2>/dev/null
  fi
  [ -n "$branch" ] && jq -r --arg b "$branch" '.messages[$b][]? ' "$BOARD_DIR/overlap.json" 2>/dev/null
  echo "Heavy commands (pnpm test / typecheck / lint / dev, Chromium) run best as \`scripts/board/heavy.sh -- <cmd>\`: it logs their peaks and only ever waits at the measured edge."
} | jq -Rs '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: .}}'
exit 0
