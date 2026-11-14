#!/usr/bin/env bash
# The web tower's server (docs/ops/TOWER.md): normally `board.sh tower start`, which runs this detached.
#   scripts/board/tower-web.sh [--port 6183] [--bind 0.0.0.0] [--fixtures <dir> --now <iso>] [--no-gh] [--once]
# Live mode holds $TOWER_LOCK for its whole life (node inherits fd 9), so one server per container; --once and
# --fixtures runs take no lock (a proof run beside the live server).
set -euo pipefail
. "$(dirname "$0")/lib.sh"
command -v node >/dev/null || { echo "tower-web: needs node" >&2; exit 1; }
export APERTURE_BOARD_DIR="$BOARD_DIR"
case " $* " in
  *' --once '* | *' --fixtures '*) ;;
  *)
    exec 9>"$TOWER_LOCK"
    flock -n 9 || { echo "tower-web: already running (pid $(cat "$TOWER_PID" 2>/dev/null))" >&2; exit 75; }
    echo $$ >"$TOWER_PID" ;;
esac
exec node "$SB_REPO/scripts/src/board/tower/web/main.ts" "$@"
