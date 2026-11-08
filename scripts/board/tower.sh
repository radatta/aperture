#!/usr/bin/env bash
# The control tower: a full-screen board for its own tmux window (docs/ops/SESSION-BOARD.md → Control tower).
#   scripts/board/tower.sh            live; q quits · 1/6/2 range · ←/→ readout · esc live · r refresh
#   scripts/board/tower.sh --measure  live, with each tick's cost on stderr
set -euo pipefail
. "$(dirname "$0")/lib.sh"
command -v node >/dev/null || { echo "tower: needs node" >&2; exit 1; }
APERTURE_BOARD_DIR="$BOARD_DIR" exec node "$SB_REPO/scripts/src/board/tower/main.ts" "$@"
