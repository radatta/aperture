#!/usr/bin/env bash
# Proof frames of the control tower (docs/ops/SESSION-BOARD.md → Control tower): runs it in a private tmux
# server at two sizes, presses the range and readout keys, and saves each frame as ANSI text (cat it in a
# truecolor terminal), SVG, and PNG: headless Chromium from the shared ~/pw Playwright install (the dev
# check's), else ImageMagick (whose SVG renderer drops braille: a PNG from it under-draws the charts).
#   scripts/board/tower-capture.sh <out-dir>          the fixtures at a fixed clock (deterministic)
#   scripts/board/tower-capture.sh <out-dir> --live   the real board, one pass
set -euo pipefail
out=${1:?usage: tower-capture.sh <out-dir> [--live]}
here="$(cd "$(dirname "$0")" && pwd)"
fixtures="$here/../src/board/tower/fixtures"
args=(--fixtures "$fixtures" --now 2026-11-08T06:10:00Z)
tag=fixtures
if [ "${2:-}" = --live ]; then args=(); tag=live; fi
mkdir -p "$out"
out="$(cd "$out" && pwd)" # absolute: the PNG step opens each frame as a file:// URL
sock="tower-proof-$$"
tm() { tmux -L "$sock" -f /dev/null "$@"; }
trap 'tm kill-server 2>/dev/null || true' EXIT

shot() { # name
  local f="$out/$tag-$1"
  tm capture-pane -e -p -t proof >"$f.txt"
  node "$here/../src/board/tower/main.ts" --svg "$f.txt" "$f.svg"
  svgs+=("$f.svg")
}
svgs=()

# One browser for every frame; prints the PNGs it wrote.
pngs() {
  if [ -d "$HOME/pw/node_modules/playwright" ]; then
    PW="$HOME/pw" node - "${svgs[@]}" <<'JS'
const { createRequire } = require('node:module');
const { chromium } = createRequire(process.env.PW + '/')('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
  const p = await b.newPage({ deviceScaleFactor: 1 });
  for (const svg of process.argv.slice(2)) {
    await p.goto('file://' + svg);
    await p.setViewportSize({ width: 2000, height: 1200 });
    await p.locator('svg').screenshot({ path: svg.replace(/\.svg$/, '.png') });
    console.log(svg.replace(/\.svg$/, '.png'));
  }
  await b.close();
})();
JS
  elif command -v convert >/dev/null; then
    for f in "${svgs[@]}"; do convert "$f" "${f%.svg}.png" && echo "${f%.svg}.png"; done
  else printf '%s\n' "${svgs[@]}"; fi
}

for size in 210x55 100x50; do
  w=${size%x*} h=${size#*x}
  # the terminal type before the session exists, so the tower's pane gets it; argv quoted for the pane's shell
  tm start-server \; set -g default-terminal tmux-256color \; set -g exit-empty off >/dev/null
  tm new-session -d -s proof -x "$w" -y "$h" "$(printf '%q ' bash "$here/tower.sh" "${args[@]}")"
  drawn=
  for _ in $(seq 50); do tm capture-pane -p -t proof | grep -q TOWER && { drawn=1; break; }; sleep 0.2; done
  [ -n "$drawn" ] || { echo "tower-capture: no frame at $size after 10 s" >&2; tm capture-pane -p -t proof >&2; exit 1; }
  sleep 0.3
  shot "$size-1h"
  tm send-keys -t proof 6; sleep 0.5; shot "$size-6h"
  tm send-keys -t proof Left Left Left Left Left Left Left Left Left Left Left Left; sleep 0.5; shot "$size-6h-readout"
  tm send-keys -t proof 2 Escape; sleep 0.5; shot "$size-24h"
  tm send-keys -t proof q; sleep 0.5
  tm kill-server 2>/dev/null || true
done
pngs
