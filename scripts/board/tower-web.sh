#!/usr/bin/env bash
# The web tower's server (docs/ops/TOWER.md): normally `board.sh tower start`, which runs this detached.
#   scripts/board/tower-web.sh [--port 6183] [--bind 0.0.0.0] [--fixtures <dir> --now <iso>] [--no-gh] [--once]
# One server per container: the port is the lock (a second one exits on EADDRINUSE). Only the server `board.sh tower
# start` launches writes the pidfile (it alone sets APERTURE_TOWER_PID), so a proof run on another port never
# takes the tower's place in `board.sh tower status`.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
command -v node >/dev/null || { echo "tower-web: needs node" >&2; exit 1; }
export APERTURE_BOARD_DIR="$BOARD_DIR"
exec node "$SB_REPO/scripts/src/board/tower/web/main.ts" "$@"
