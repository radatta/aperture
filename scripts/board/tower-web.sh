#!/usr/bin/env bash
# The web tower's server (docs/ops/TOWER.md): normally `board.sh tower start`, which runs this detached.
#   scripts/board/tower-web.sh [--port 6183] [--bind 0.0.0.0] [--fixtures <dir> --now <iso>] [--no-gh] [--once]
# One server per container: the port is the lock (a second one exits on EADDRINUSE). Once bound, the server writes
# its pid to $TOWER_PID (live mode only), which is how `board.sh tower` tells it's running.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
command -v node >/dev/null || { echo "tower-web: needs node" >&2; exit 1; }
export APERTURE_BOARD_DIR="$BOARD_DIR" APERTURE_TOWER_PID="$TOWER_PID"
exec node "$SB_REPO/scripts/src/board/tower/web/main.ts" "$@"
