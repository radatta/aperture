#!/usr/bin/env bash
# The iOS CI probe: can a GitHub-hosted macOS runner do what the Mac's `sim` job does up to sign-in
# (tools/mailroom/jobs/sim.sh, docs/ops/IOS-CHECK.md)? Boots an iPhone sim, installs AXe at the Mac's pin, opens
# Safari at the dev slot B origin, adds it to the Home Screen through AXe, launches that app and stops at the Sign in
# card. No secrets, no sign-in. Run by .github/workflows/ios-probe.yml (the ios-ci-probe branch only); every knob is
# here, so the probe iterates by pushing this file. Writes ios-probe-out/: steps.tsv (step, pass|fail|skip, ms, note),
# shots/, trees/ (AXe's accessibility trees), log.txt, summary.md. bash 3.2-safe (macOS /bin/bash).
set -uo pipefail

RUNS=3      # shards above this exit at once: the workflow's matrix is fixed at 3, this is the knob
CACHE=off   # off | save (tar the device after Add to Home Screen) | use (restore it, skip Add to Home Screen)
ORIGIN=https://devb.aperture.rahuldatta.dev
FALLBACK=https://aperture.rahuldatta.dev # read only, the sign-in card; used only when devb doesn't answer
DEVICE_TYPE=com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro-Max
RUNTIMES="26.5 26.4 26.2" # newest first; the first that boots wins
AXE_VER=1.8.0             # the Mac's pin (IOS-CHECK.md → Setup)
AXE_SHA=7b76340b72e90d0f211bc7c4636f15009076eff07acef2f2b632b175debd8834
AXE_URL="https://github.com/cameroncooke/AXe/releases/download/v$AXE_VER/AXe-macOS-v$AXE_VER-universal.tar.gz"
APP_NAME=Aperture # apple-mobile-web-app-title (app/index.html)
SIM_NAME=ios-probe
X_MID=220 # 440 pt wide, as the 18 Pro Max the Mac profiles
W=440
H=956
BUDGET=1000 # seconds of probe before every loop gives up, inside the job's 20 min (setup takes ~2)

# The workflow asks which cache mode is set before it restores anything.
if [ "${1:-}" = cache-mode ]; then echo "$CACHE"; exit 0; fi

SHARD="${IOS_PROBE_SHARD:-1}"
OUT="${IOS_PROBE_OUT:-$PWD/ios-probe-out}"
CACHE_DIR="${IOS_PROBE_CACHE_DIR:-$PWD/.ios-probe-cache}"
WORK="${RUNNER_TEMP:-/tmp}/ios-probe"
mkdir -p "$OUT/shots" "$OUT/trees" "$WORK"
: >"$OUT/steps.tsv"
N=0
U=""
DEADLINE=$((SECONDS + BUDGET))
late() { [ "$SECONDS" -ge "$DEADLINE" ]; }
AXE=""
RUNTIME=""

if [ "$SHARD" -gt "$RUNS" ]; then echo "shard $SHARD > RUNS=$RUNS: nothing to do" | tee "$OUT/summary.md"; exit 0; fi

log() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$OUT/log.txt" >&2; }
now_ms() { python3 -c 'import time; print(int(time.time()*1000))'; }
# cap <sec> <cmd…>: a portable timeout (macOS has none); 124 when it fired
cap() {
  local c="$1" pid wd rc
  shift
  "$@" &
  pid=$!
  (sleep "$c" && kill -TERM "$pid" 2>/dev/null) >/dev/null 2>&1 &
  wd=$!
  wait "$pid"
  rc=$?
  pkill -P "$wd" 2>/dev/null || true
  kill "$wd" 2>/dev/null || true
  wait "$wd" 2>/dev/null || true
  if [ "$rc" = 143 ]; then return 124; fi
  return "$rc"
}
ax() { cap "${AX_CAP:-30}" "$AXE" "$@" --udid "$U"; }
NOTE=""
note() { local m; m="$(printf '%s' "$*" | tr '\n|' ' /')"; NOTE="${NOTE:+$NOTE; }$m"; log "  note: $m"; }

# Evidence for one moment: a simctl screenshot (no AXe needed) and AXe's full tree.
# Trees cost up to 30 s each on a busy runner (run 2), so only failures and the add flow keep one.
evidence() {
  local tag
  N=$((N + 1))
  tag="$(printf '%02d' "$N")-$1"
  [ -n "$U" ] || return 0
  cap 30 xcrun simctl io "$U" screenshot "$OUT/shots/$tag.png" >/dev/null 2>&1 || log "  screenshot failed ($tag)"
  if [ -n "$AXE" ] && [ -n "${2:-}" ]; then ax describe-ui >"$OUT/trees/$tag.json" 2>/dev/null || log "  tree failed ($tag)"; fi
}

# step <name> <fn>: time it, record it, keep evidence. A failed step stops the run; later ones read skip.
FAILED=""
step() {
  local name="$1" t0 t1 st rc=0
  shift
  if [ -n "$FAILED" ]; then printf '%s\tskip\t0\tafter %s failed\n' "$name" "$FAILED" >>"$OUT/steps.tsv"; return 1; fi
  if late; then FAILED="the ${BUDGET} s budget"; printf '%s\tskip\t0\tbudget spent\n' "$name" >>"$OUT/steps.tsv"; return 1; fi
  NOTE=""
  log "== $name"
  t0=$(now_ms)
  "$@" || rc=$?
  t1=$(now_ms)
  case "$rc" in 0) st=pass ;; 2) st=soft ;; *) st=fail; FAILED="$name" ;; esac # soft: went on, but short of its check
  printf '%s\t%s\t%s\t%s\n' "$name" "$st" "$((t1 - t0))" "$NOTE" >>"$OUT/steps.tsv"
  log "== $name: $st in $((t1 - t0)) ms"
  if [ "$st" = pass ]; then evidence "$name"; else evidence "$name" tree; fi
  [ "$st" != fail ]
}

tree() {
  local t i
  for i in 1 2 3 4 5 6 7 8; do # the first reads after a boot can time out (sim.sh → sim_tree)
    late && return 1
    if t="$(AX_CAP=15 ax describe-ui 2>>"$OUT/axe.err")" && [ -n "$t" ]; then printf '%s' "$t"; return 0; fi
    sleep 2
  done
  return 1
}
# The Home Screen shows its page pill ("Page 1 of 2"), as sim.sh → sim_find_icon reads it.
on_home() { jq -e 'any(.. | objects | .AXValue? | select(type == "string"); test("^Page [0-9]+ of [0-9]+$"))' <<<"$1" >/dev/null 2>&1; }
# The front app's label: "Safari", "Web" (a Home Screen web app, sim.sh → sim_tree_web), "" for SpringBoard.
front_app() { jq -r '[.. | objects | select(.role? == "AXApplication")][0].AXLabel // ""' <<<"$1" 2>/dev/null; }
# find <tree> <label regex> [role]: "cx cy role label" of the first on-screen match
find_el() {
  jq -r --arg re "$2" --arg role "${3:-}" --argjson w "$W" --argjson h "$H" '[.. | objects
    | select(((.AXLabel? // "") | tostring | test($re; "i")) and ($role == "" or .role? == $role))
    | select((.frame.width // 0) > 0 and (.frame.height // 0) > 0 and (.frame.x // -1) >= 0 and (.frame.y // -1) >= 0
      and (.frame.x + .frame.width) <= $w and (.frame.y + .frame.height) <= $h)][0] // empty
    | "\((.frame.x + .frame.width / 2) | floor) \((.frame.y + .frame.height / 2) | floor) \(.role) \(.AXLabel)"' <<<"$1" 2>/dev/null
}
# Every labelled element, one line each: what the tree offered when a find missed.
labels() { jq -r '[.. | objects | select((.AXLabel? // "") != "") | "\(.role) \(.AXLabel)"] | unique | join(" · ")' <<<"$1" 2>/dev/null | cut -c1-600; }
tap_at() { ax tap -x "$1" -y "$2" >/dev/null 2>>"$OUT/axe.err"; }
# tap_label <regex> [role] [tries]: find in the full tree and tap its centre; retry while the screen settles
tap_label() {
  local re="$1" role="${2:-}" tries="${3:-6}" i t e x y r l
  for i in $(seq 1 "$tries"); do
    t="$(tree)" || { note "tree unreadable"; return 1; }
    e="$(find_el "$t" "$re" "$role")"
    if [ -n "$e" ]; then
      read -r x y r l <<<"$e"
      log "  tap '$re' → $r '$l' at $x,$y"
      tap_at "$x" "$y" || { note "axe tap failed at $x,$y"; return 1; }
      return 0
    fi
    late && break
    sleep 1
  done
  note "no '$re' in the tree; it had: $(labels "$t")"
  return 1
}
# scan_text <prefix> [from] [to] [x]: point reads down x (220) (web content is only in point reads, IOS-CHECK.md →
# Reading the page) until an element whose label or value starts with <prefix>; prints "y role label|value"
scan_text() {
  local want y raw
  want="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  for y in $(seq "${2:-250}" 30 "${3:-850}"); do
    raw="$(cap 8 "$AXE" describe-ui --point "${4:-$X_MID},$y" --udid "$U" 2>/dev/null)" || continue
    if jq -e --arg w "$want" '(if type == "array" then .[0] else . end) as $e
      | [($e.AXLabel // ""), ($e.AXValue // "")] | map(tostring | ascii_downcase | ltrimstr(" ")) | any(startswith($w))' \
      <<<"$raw" >/dev/null 2>&1; then
      printf '%s %s\n' "$y" "$(jq -r '(if type == "array" then .[0] else . end) | "\(.role) \(.AXLabel // "")|\(.AXValue // "")"' <<<"$raw")"
      return 0
    fi
  done
  return 1
}

# --- the steps -------------------------------------------------------------------------------------------------

s_env() {
  note "image ${ImageOS:-?} ${ImageVersion:-?}, macOS $(sw_vers -productVersion), $(xcodebuild -version | tr '\n' ' ')"
  {
    sw_vers
    xcodebuild -version
    xcrun simctl list runtimes
    xcrun simctl list devicetypes | grep -i iphone
    sysctl -n machdep.cpu.brand_string hw.ncpu hw.memsize
  } >"$OUT/env.txt" 2>&1
  return 0 # evidence only
}

s_axe_install() {
  local tgz="$WORK/axe.tar.gz" got v
  curl -fsSL --retry 3 -o "$tgz" "$AXE_URL" || { note "download failed"; return 1; }
  got="$(shasum -a 256 "$tgz" | cut -d' ' -f1)"
  [ "$got" = "$AXE_SHA" ] || { note "sha256 mismatch: $got"; return 1; }
  mkdir -p "$WORK/axe" && tar xzf "$tgz" -C "$WORK/axe" || { note "untar failed"; return 1; }
  AXE="$(find "$WORK/axe" -type f -name axe | head -1)"
  [ -n "$AXE" ] || { note "no axe binary in the tarball"; return 1; }
  v="$("$AXE" --version 2>&1)" || { note "axe won't run: $(head -1 <<<"$v")"; AXE=""; return 1; }
  note "axe --version: $(head -1 <<<"$v")"
}

# Newest listed runtime first; one that won't boot is deleted and the next tried.
s_boot() {
  local v rid list
  list="$(xcrun simctl list runtimes -j)"
  for v in $RUNTIMES; do
    rid="$(jq -r --arg v "$v" '[.runtimes[] | select(.platform == "iOS" and .isAvailable and (.version == $v or (.version | startswith($v + "."))))][0].identifier // empty' <<<"$list")"
    [ -n "$rid" ] || { note "iOS $v not on the image"; continue; }
    U="$(xcrun simctl create "$SIM_NAME" "$DEVICE_TYPE" "$rid" 2>>"$OUT/log.txt")" || { note "create on $v failed"; U=""; continue; }
    if cap 240 xcrun simctl bootstatus "$U" -b >>"$OUT/log.txt" 2>&1; then
      RUNTIME="$v"
      note "booted iOS $v ($rid), udid $U"
      return 0
    fi
    note "boot on iOS $v failed or took over 240 s"
    xcrun simctl shutdown "$U" >/dev/null 2>&1 || true
    xcrun simctl delete "$U" >/dev/null 2>&1 || true
    U=""
  done
  return 1
}

# AXe on a fresh boot: the full tree reads, a point read answers, AXe's own screenshot works.
s_axe_ready() {
  local t
  t="$(tree)" || { note "describe-ui never answered (8 tries)"; return 1; }
  note "front app: '$(front_app "$t")', $(jq '[.. | objects | select(.role? == "AXButton")] | length' <<<"$t") buttons"
  ax describe-ui --point "$X_MID,400" >/dev/null 2>&1 && note "point read ok" || note "point read failed"
  ax screenshot --output "$OUT/shots/axe-screenshot.png" >/dev/null 2>&1 && note "axe screenshot ok" || { note "axe screenshot failed"; return 1; }
}

s_origin() {
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$ORIGIN/")" || code=000
  if [ "${code:0:1}" = 2 ] || [ "${code:0:1}" = 3 ]; then note "devb answered $code"; return 0; fi
  note "devb answered $code; falling back to the prod origin (read only, the sign-in card)"
  ORIGIN="$FALLBACK"
}

s_safari() {
  local t i s err app=""
  for i in 1 2 3; do # run 2: one shard's first openurl failed 10 s after boot
    if err="$(cap 60 xcrun simctl openurl "$U" "$ORIGIN/" 2>&1)"; then break; fi
    note "openurl try $i failed: $(head -c 200 <<<"$err")"
    [ "$i" = 3 ] && return 1
    sleep 5
  done
  for i in $(seq 1 30); do
    late && break
    sleep 2
    t="$(tree)" || continue
    app="$(front_app "$t")"
    [ "$app" = Safari ] || continue
    # iOS 26's first-run tip ("View Bookmarks, Share Menu, and Open Tabs") lays a full-screen "dismiss popup" group
    # over the page, so every point read lands on it (run 1): close it first
    if [ -n "$(find_el "$t" '^dismiss popup$')" ]; then
      note "closed Safari's first-run tip after $((i * 2)) s"
      tap_label '^Close$' AXButton 1 || true
      continue
    fi
    [ -f "$OUT/point-530.json" ] || ax describe-ui --point "$X_MID,530" >"$OUT/point-530.json" 2>&1 || true
    if s="$(scan_text 'Sign in' 400 700)"; then note "Safari up, page shows Sign in at y ${s%% *} after $((i * 2)) s"; return 0; fi
  done
  note "front app '$app'; no Sign in text in 60 s"
  [ "$app" = Safari ] || return 1
  return 2 # soft: Safari is up without the text, so go on; the evidence shows why
}

# pixel <x pt> <y pt>: "r g b" there on a fresh simctl screenshot (3x). The share sheet runs in another process and
# is absent from AXe's tree (runs 2-3), so its arrival is read from pixels: light grey over the dark page.
pixel() {
  local png="$WORK/px.png"
  cap 30 xcrun simctl io "$U" screenshot "$png" >/dev/null 2>&1 || return 1
  python3 - "$png" "$(($1 * 3))" "$(($2 * 3))" <<'PNG'
import struct, sys, zlib
path, x, y = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
d = open(path, 'rb').read(); i = 8; idat = b''
while i < len(d):
    ln = struct.unpack('>I', d[i:i + 4])[0]; t = d[i + 4:i + 8]; c = d[i + 8:i + 8 + ln]
    if t == b'IHDR': w, h, bd, ct = struct.unpack('>IIBB', c[:10])
    if t == b'IDAT': idat += c
    i += 12 + ln
raw = zlib.decompress(idat); bpp = 4 if ct == 6 else 3; st = w * bpp; prev = bytearray(st); p = 0
for r in range(y + 1):
    f = raw[p]; line = bytearray(raw[p + 1:p + 1 + st]); p += 1 + st
    for k in range(st):
        a = line[k - bpp] if k >= bpp else 0; b = prev[k]; cc = prev[k - bpp] if k >= bpp else 0
        if f == 1: line[k] = (line[k] + a) & 255
        elif f == 2: line[k] = (line[k] + b) & 255
        elif f == 3: line[k] = (line[k] + (a + b) // 2) & 255
        elif f == 4:
            pa, pb, pc = abs(b - cc), abs(a - cc), abs(a + b - 2 * cc)
            line[k] = (line[k] + (a if pa <= pb and pa <= pc else (b if pb <= pc else cc))) & 255
    prev = line
print(*prev[x * bpp:x * bpp + 3])
PNG
}
# light: every channel over 150 (the sheet reads ~184,196,191; the page ~47,66,60)
light() {
  local r g b
  read -r r g b <<<"$(pixel "$1" "$2")" || return 1
  [ "${r:-0}" -gt 150 ] && [ "${g:-0}" -gt 150 ] && [ "${b:-0}" -gt 150 ]
}
# Raw point reads, kept for the report: does AXe's --point see the share sheet at all?
dump_points() {
  local tag="$1" pt
  shift
  for pt in "$@"; do ax describe-ui --point "$pt" >"$OUT/point-$tag-${pt/,/x}.json" 2>&1 || true; done
}

# Measured on runs 2-3 screenshots (pt): the collapsed sheet's View More, and Add to Home Screen once expanded.
PT_VIEW_MORE="366 855"
PT_A2HS="158 654"
# Share → View More → Add to Home Screen → Add. iOS 26 Safari puts Share in its … menu; every screen on the way is
# kept (a2hs-*), so a miss shows exactly what was offered.
s_a2hs() {
  local i hit y x
  # iOS 26 Safari: Share sits in the … menu (AXButton "More", right of the address bar); "Page Menu" is the left one
  tap_label '^More$' AXButton 3 || return 1
  sleep 1
  evidence a2hs-menu tree
  tap_label '^Share$' AXButton 4 || return 1
  for i in $(seq 1 30); do
    late && return 1
    if light 100 800; then break; fi
    [ "$i" = 30 ] && { note "no share sheet in the pixels after 30 looks"; return 1; }
    sleep 2
  done
  note "share sheet drawn by look $i"
  sleep 2
  evidence a2hs-sheet-collapsed
  dump_points sheet 366,855 52,855 220,630
  # View More expands the action list: by point read if that sees it, else at the measured point
  if hit="$(scan_text 'View More' 820 900 366)"; then
    note "View More by point read ($hit)"
    tap_at 366 "${hit%% *}" || return 1
  else
    note "View More not in point reads: tapped at the measured $PT_VIEW_MORE"
    read -r x y <<<"$PT_VIEW_MORE"
    tap_at "$x" "$y" || return 1
  fi
  sleep 3
  evidence a2hs-sheet-expanded
  dump_points expanded 158,654 220,654 158,610 158,700
  if hit="$(scan_text 'Add to Home Screen' 300 920 158)"; then
    note "Add to Home Screen by point read ($hit)"
    tap_at 158 "${hit%% *}" || return 1
  else
    note "Add to Home Screen not in point reads: tapped at the measured $PT_A2HS"
    read -r x y <<<"$PT_A2HS"
    tap_at "$x" "$y" || return 1
  fi
  sleep 4
  evidence a2hs-add-sheet tree
  dump_points addsheet 400,90 380,90 400,110 60,90
  # The Add sheet's confirm: in the tree if it's Safari's own, else by point reads along its top bar
  if tap_label '^Add$' AXButton 3; then sleep 3; return 0; fi
  for x in 400 390 380 410 370; do
    if hit="$(scan_text 'Add' 50 160 "$x")"; then
      note "Add by point read at $x,${hit%% *} ($hit)"
      tap_at "$x" "${hit%% *}" || return 1
      sleep 3
      return 0
    fi
  done
  note "no Add by tree or point reads; see the a2hs-add-sheet shot"
  return 1
}

# The icon on the Home Screen: press Home, look on each page (scroll-left between), as sim.sh → sim_find_icon.
find_icon() {
  local t="" i page e
  ax button home >/dev/null 2>&1 || true
  sleep 1
  for i in 1 2 3 4 5 6; do
    late && break
    t="$(tree)" || return 1
    if ! on_home "$t"; then # a dropped home press: Safari's own 'Aperture' title must not count
      note "no Home Screen after the press ($(front_app "$t") in front): pressed again"
      ax button home >/dev/null 2>&1 || true
      sleep 2
      continue
    fi
    page="$(jq -r 'first(.. | objects | .AXValue? | select(type == "string" and test("^Page [0-9]+ of [0-9]+$"))) // ""' <<<"$t")"
    e="$(find_el "$t" "^$APP_NAME\$" AXButton)"
    if [ -n "$e" ]; then ICON="$e"; note "icon on '${page:-no page pill}' at ${e%% A*}"; return 0; fi
    ax gesture scroll-left --screen-width 440 --screen-height 956 >/dev/null 2>&1 || true
    sleep 2
  done
  note "no $APP_NAME icon; last tree had: $(labels "$t" | cut -c1-300)"
  return 1
}
s_icon() { find_icon; }

s_launch() {
  local i t s x y r l app=""
  read -r x y r l <<<"$ICON"
  tap_at "$x" "$y" || { note "icon tap failed"; return 1; }
  for i in $(seq 1 20); do
    late && break
    sleep 2
    t="$(tree)" || continue
    app="$(front_app "$t")"
    if on_home "$t"; then
      if [ "$i" = 3 ]; then note "still the Home Screen at 6 s: icon tapped again"; tap_at "$x" "$y" || true; fi
      continue
    fi
    [ "$app" != Safari ] || continue
    if s="$(scan_text 'Sign in' 400 700)"; then note "front app '$app' (the Mac's iOS 27 reads 'Web'), Sign in at y ${s%% *} after $((i * 2)) s"; return 0; fi
  done
  note "front app '$app'; no Sign in card in 40 s"
  return 1
}

# Part 2: the booted device's data, after Add to Home Screen, as a tarball the workflow caches.
s_cache_save() {
  local d="$HOME/Library/Developer/CoreSimulator/Devices/$U"
  xcrun simctl shutdown "$U" >/dev/null 2>&1 || true
  mkdir -p "$CACHE_DIR"
  tar czf "$CACHE_DIR/device.tgz" -C "$HOME/Library/Developer/CoreSimulator/Devices" "$U" || return 1
  printf '%s %s\n' "$U" "$RUNTIME" >"$CACHE_DIR/meta"
  note "device dir $(du -sh "$d" | cut -f1), tarball $(du -sh "$CACHE_DIR/device.tgz" | cut -f1)"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "cache=save" >>"$GITHUB_OUTPUT"; fi
  return 0
}
# Restore a cached device in place of create + Add to Home Screen; CoreSimulator rescans its set on restart.
s_cache_use() {
  [ -f "$CACHE_DIR/device.tgz" ] || { note "no cached device restored"; return 1; }
  read -r U RUNTIME <"$CACHE_DIR/meta"
  tar xzf "$CACHE_DIR/device.tgz" -C "$HOME/Library/Developer/CoreSimulator/Devices" || return 1
  killall -9 com.apple.CoreSimulator.CoreSimulatorService 2>/dev/null || true
  sleep 2
  xcrun simctl list devices | grep -q "$U" || { note "CoreSimulator didn't list the restored device"; return 1; }
  cap 240 xcrun simctl bootstatus "$U" -b >>"$OUT/log.txt" 2>&1 || { note "restored device didn't boot"; return 1; }
  note "restored $U (iOS $RUNTIME) and booted it"
}

summary() {
  {
    echo "## iOS probe, shard $SHARD — iOS ${RUNTIME:-none}, cache $CACHE, origin $ORIGIN"
    echo
    echo "| step | result | s | note |"
    echo "| --- | --- | --- | --- |"
    awk -F'\t' '{ printf "| %s | %s | %.1f | %s |\n", $1, $2, $3 / 1000, $4 }' "$OUT/steps.tsv"
  } >"$OUT/summary.md"
  [ -z "${GITHUB_STEP_SUMMARY:-}" ] || cat "$OUT/summary.md" >>"$GITHUB_STEP_SUMMARY"
  cat "$OUT/summary.md"
}

# The summary is written however the script ends: a set -u exit, a cancel's TERM, or the last step.
finish() {
  local rc=$?
  trap - EXIT
  printf 'total\t%s\t%s\t\n' "$([ "$rc" = 0 ] && echo pass || echo fail)" "$(($(now_ms) - T0))" >>"$OUT/steps.tsv"
  [ -z "$U" ] || xcrun simctl shutdown "$U" >/dev/null 2>&1 || true
  summary
  exit "$rc"
}
T0=$(now_ms)
trap finish EXIT
trap 'exit 143' TERM
step env s_env
step axe-install s_axe_install
if [ "$CACHE" = use ]; then
  step cache-restore-boot s_cache_use
else
  step boot s_boot
fi
step axe-ready s_axe_ready
step origin s_origin
if [ "$CACHE" != use ]; then
  step safari s_safari
  step add-to-home-screen s_a2hs
fi
step home-screen-icon s_icon
step launch-to-sign-in s_launch
if [ "$CACHE" = save ] && [ "$SHARD" = 1 ]; then step cache-save s_cache_save; fi # one fixed cache entry
[ -z "$FAILED" ]
