#!/bin/bash
# The `ui` matrix cell: `pnpm dev` (stub + auth bypass) + headless Chromium over 4 routes at phone width,
# then both stopped by PID. Run it under heavy.sh so the pair is measured as one job:
#   PW_DIR=<dir with node_modules/playwright> heavy.sh -- scripts/board/measure/ui-cell.sh
# Env: PW_DIR (required; install Playwright there BEFORE a quiet window — the install is a rootfs write
#      burst the COI monitor can flag), UI_CHROMIUM (executablePath; default Playwright's own),
#      UI_RENDERER_LIMIT=1 (adds --renderer-process-limit=1).
set -u
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
[ -d "${PW_DIR:-}/node_modules/playwright" ] || { echo "ui-cell: PW_DIR must hold node_modules/playwright" >&2; exit 2; }

work="${TMPDIR:-/tmp}/aperture-ui.$$"
mkdir -p "$work"
cd "$SB_REPO" || exit 2
pnpm dev >"$work/vite.log" 2>&1 &
dev=$!
stop_dev() {
  local p
  for p in $(sb_procs | awk -F'\t' -v root="$dev" '{ pp[$1] = $2 } END { for (p in pp) { q = p; for (n = 0; n < 64 && q > 1; n++) { if (q == root) { print p; break } q = pp[q] } } }'); do
    kill -TERM "$p" 2>/dev/null
  done
}
trap 'stop_dev; rm -rf "$work"' EXIT

# Vite prints its URL once ready; it walks upward from the base port, so read it rather than assume.
port=
for _ in $(seq 1 90); do
  port=$(sed -n 's/.*localhost:\([0-9][0-9]*\).*/\1/p' "$work/vite.log" | head -n 1)
  [ -n "$port" ] && break
  kill -0 "$dev" 2>/dev/null || { cat "$work/vite.log" >&2; exit 1; }
  sleep 1
done
[ -n "$port" ] || { echo "ui-cell: vite never reported a port" >&2; exit 1; }

cat >"$PW_DIR/board-ui.mjs" <<'JS'
import { chromium } from 'playwright';
const args = ['--no-sandbox'];
if (process.env.UI_RENDERER_LIMIT === '1') args.push('--renderer-process-limit=1');
const browser = await chromium.launch({ headless: true, args, executablePath: process.env.UI_CHROMIUM || undefined });
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
const base = `http://localhost:${process.env.PORT}`;
for (const route of ['/', '/tasks', '/log', '/settings']) {
  await page.goto(base + route, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 60000 });
  await page.screenshot({ path: `${process.env.OUT}/shot${route.replace(/\//g, '_') || '_'}.png`, fullPage: true });
}
await browser.close();
JS
( cd "$PW_DIR" && PORT="$port" OUT="$work" node board-ui.mjs )
