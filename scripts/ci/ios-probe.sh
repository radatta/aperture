#!/usr/bin/env bash
# The iOS CI probe: how fast can a GitHub-hosted macOS runner go from cold to a real iOS devcheck row, proving the
# same things the Mac's `sim` job does (tools/mailroom/jobs/sim.sh, docs/ops/IOS-CHECK.md)? It gets an iPhone sim
# with dev on its Home Screen (cold: Safari → Add to Home Screen through AXe; restore: the device a `save` run cached,
# signed out; seed: a fresh device given the webclip files Safari wrote), launches the Home Screen app to its Sign in
# card, and with the dev test user's password (the ios-probe environment) runs ios-standalone's own plans through
# sim.sh's run_sim. Run by .github/workflows/ios-probe.yml (the ios-ci-probe branch only); every knob is here, so the
# probe iterates by pushing this file. Writes ios-probe-out/: steps.tsv (step, pass|fail|soft|skip, ms, note), shots/,
# trees/, log.txt, summary.md; after sign-in only rows.tsv (op, status, ms: no shots, reads or notes leave the runner).
# bash 3.2-safe (macOS /bin/bash).
set -uo pipefail

RUNS=3 # shards above this exit at once: the workflow's matrix is fixed at 3, this is the knob
# Each shard's variant, "<source> <after>": source cold | restore | seed; after card (stop at the Sign in card) |
# save (cache the signed-out device) | rows (sign in, run the plans). One run tries three variants side by side.
variant() {
  case "$SHARD" in
    1) echo "seed save" ;;
    2) echo "cold card" ;;
    *) echo "seed card" ;;
  esac
}
KEY="ios-probe-dev-27.2-v1" # the cached device; bump to re-save (cache keys are immutable)
ORIGIN=https://dev.aperture.rahuldatta.dev # slot A: sim.sh's Cognito host and test user are slot A's
FALLBACK=https://aperture.rahuldatta.dev # read only, the sign-in card; used only when dev doesn't answer
DEVICE_TYPE=com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro-Max # sim.sh's SIM_DEVICE_TYPE: the Mac's profile
RUNTIME_ID=com.apple.CoreSimulator.SimRuntime.iOS-27-2           # the xcode-27 image (phase 1 ran iOS 26.5)
AXE_VER=1.8.0                                           # the Mac's pin (IOS-CHECK.md → Setup)
AXE_SHA=7b76340b72e90d0f211bc7c4636f15009076eff07acef2f2b632b175debd8834
AXE_URL="https://github.com/cameroncooke/AXe/releases/download/v$AXE_VER/AXe-macOS-v$AXE_VER-universal.tar.gz"
APP_NAME=Aperture        # apple-mobile-web-app-title (app/index.html)
SIM_NAME=aperture-devcheck # the name sim.sh resolves the device by
ROW_JOBS="launch capture relaunch" # ios-standalone's jobs (plans.json) that need no seeded tasks
X_MID=220                # 440 pt wide, as the 18 Pro Max the Mac profiles
W=440
H=956
BUDGET=2400 # seconds of probe before every loop gives up, inside the job's 45 min

SHARD="${IOS_PROBE_SHARD:-1}"
read -r SRC AFTER <<<"$(variant)"
# Only a rows shard holds the password, and only as an unexported shell variable: no child process inherits it.
PW=""
[ "$AFTER" != rows ] || PW="${DEVCHECK_PASSWORD:-}"
# recon reads only the secret's shape (yes/no), at once, and keeps nothing
SHAPE=""
if [ "$AFTER" = recon ]; then
  SHAPE="$([ -n "${DEVCHECK_PASSWORD:-}" ] && echo set || echo unset), $([[ "${DEVCHECK_PASSWORD:-}" =~ ^[[:space:]] || "${DEVCHECK_PASSWORD:-}" =~ [[:space:]]$ ]] && echo edge-space || echo no-edge-space), $([[ "${DEVCHECK_PASSWORD:-}" == *$'\r'* ]] && echo cr || echo no-cr), $([[ "${DEVCHECK_PASSWORD:-}" =~ ^[\"\'] || "${DEVCHECK_PASSWORD:-}" =~ [\"\']$ ]] && echo quoted || echo unquoted)"
fi
unset DEVCHECK_PASSWORD
# The workflow asks for this shard's cache keys before it restores anything.
if [ "${1:-}" = cache-keys ]; then
  if [ "$SRC" = restore ]; then echo "restore=$KEY"; else echo "restore="; fi
  if [ "$AFTER" = save ]; then echo "save=$KEY"; else echo "save="; fi
  exit 0
fi
if [ "${1:-}" = cache-mode ]; then echo off; exit 0; fi # the phase-1 workflow's question
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
  [ -z "${SIGNIN_RAN:-}" ] || return 0 # nothing from a signed-in screen leaves the runner
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
    xcrun simctl runtime list
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

DEVICES="$HOME/Library/Developer/CoreSimulator/Devices"
BOOT_PID=""
# The boot starts here, before env and AXe, and runs beside them (option 2); s_boot_wait collects it.
boot_start() {
  (cap 400 xcrun simctl bootstatus "$U" -b >"$WORK/boot.log" 2>&1; echo "$?" >"$WORK/boot.rc") &
  BOOT_PID=$!
}
# runner-images 15334: select Xcode 27.2 before any simctl call (the image's default is 27.1)
select_xcode() {
  [ -d /Applications/Xcode_27.2.app ] || return 0
  sudo xcode-select -s /Applications/Xcode_27.2.app && note "Xcode 27.2 selected"
}
s_create() {
  select_xcode
  U="$(xcrun simctl create "$SIM_NAME" "$DEVICE_TYPE" "$RUNTIME_ID" 2>>"$OUT/log.txt")" || { note "create failed"; U=""; return 1; }
  RUNTIME=27.2
  note "created $U"
  [ "$SRC" != seed ] || seed_webclip || return 1
  boot_start
}
# The cached device (a `save` run's, signed out, shut down): moved into CoreSimulator's set, which reads it after a
# service restart. If the set won't list it, its data goes into a fresh device of the same type instead.
s_restore() {
  local d u
  select_xcode
  d="$(find "$CACHE_DIR/device" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | head -1)"
  [ -n "$d" ] || { note "no cached device ($KEY) restored"; return 1; }
  u="$(basename "$d")"
  note "cache holds $u ($(du -sh "$d" | cut -f1))"
  du -sk "$d"/data/* "$d"/data/Library/* "$d"/data/Containers/*/* 2>/dev/null | sort -rn | head -25 >"$OUT/device-du.txt" || true
  mkdir -p "$DEVICES"
  mv "$d" "$DEVICES/$u" || { note "move into the set failed"; return 1; }
  # On a fresh runner nothing has started CoreSimulator yet, so its first start reads the set with the device in
  # it; only a service already up is restarted (run 8: the forced restart took 17–70 s).
  if pgrep -f CoreSimulatorService >/dev/null 2>&1; then
    note "CoreSimulator was already up: restarted"
    killall -9 com.apple.CoreSimulator.CoreSimulatorService 2>/dev/null || true
    sleep 1
  fi
  if xcrun simctl list devices -j | jq -e --arg u "$u" '[.devices[][] | select(.udid == $u)] | length == 1' >/dev/null; then
    U="$u"
    note "registered by a service restart"
  else
    note "not listed after a service restart: its data into a fresh device"
    U="$(xcrun simctl create "$SIM_NAME" "$DEVICE_TYPE" "$RUNTIME_ID" 2>>"$OUT/log.txt")" || return 1
    mv "$DEVICES/$U/data" "$WORK/fresh-data" && mv "$DEVICES/$u/data" "$DEVICES/$U/data" || return 1
    mv "$DEVICES/$u" "$WORK/restored-shell" # its device.plist names aperture-devcheck too: out of the set
  fi
  RUNTIME=27.2
  boot_start
}
# Device Hub (Xcode 27's Simulator app): sim.sh starts it on the Mac. Whether it starts on a runner (a GUI session?)
# is run-only (no source either way); simctl boots without it.
HUB=down
s_hub() {
  local i
  [ "$(xcodebuild -version | sed -n 's/^Xcode \([0-9]*\).*/\1/p')" -ge 27 ] || { note "Xcode < 27: no Device Hub"; return 0; }
  cap 30 open -g -b com.apple.dt.Devices >/dev/null 2>&1 || note "open -g -b com.apple.dt.Devices failed"
  for i in $(seq 1 15); do
    if pgrep -x DeviceHub >/dev/null 2>&1; then HUB=up; note "Device Hub up after ${i} s"; return 0; fi
    sleep 1
  done
  note "Device Hub didn't start in 15 s: sim.sh gets the shim"
}
s_boot_wait() {
  wait "$BOOT_PID" 2>/dev/null || true
  local rc
  rc="$(cat "$WORK/boot.rc" 2>/dev/null || echo 1)"
  grep -v '^\s' "$WORK/boot.log" >>"$OUT/log.txt" 2>/dev/null || true
  [ "$rc" = 0 ] || { note "bootstatus exited $rc"; return 1; }
  note "booted iOS $RUNTIME, udid $U ($(grep -c 'Data Migration' "$WORK/boot.log" 2>/dev/null || echo 0) migration lines)"
}

# Seed (option 3): the webclip bundle Safari's Add to Home Screen wrote on run 6 (scripts/ci/ios-probe-seed/: its
# Info.plist says FullScreen, URL dev), copied into a fresh device's data before its first boot, so SpringBoard
# finds it as it builds the Home Screen. No Safari, no download. Whether iOS 26 also needs the placeholder app
# install coordination made is what this tests.
seed_webclip() {
  local d="$DEVICES/$U/data/Library/WebClips" w
  mkdir -p "$d" || return 1
  for w in "$(cd "$(dirname "$0")" && pwd -P)"/ios-probe-seed/*.webclip; do
    cp -R "$w" "$d/" || return 1
    mkdir -p "$d/$(basename "$w")/Storage" "$d/$(basename "$w")/StagedCookies"
  done
  note "seeded $(ls "$d" | tr '\n' ' ')"
}
# What Add to Home Screen changed in the device (paths since the marker), and the WebClips and SpringBoard state.
export_webclip() {
  local d="$DEVICES/$U/data"
  mkdir -p "$OUT/seed"
  find "$d" -newer "$WORK/a2hs.marker" -type f 2>/dev/null | sed "s|^$d/||" | grep -v -e '^Library/Caches/' -e '/Caches/' | head -300 >"$OUT/seed/changed.txt"
  (cd "$d" && tar czf "$OUT/seed/webclip.tgz" Library/WebClips Library/SpringBoard 2>/dev/null) || true
  note "export: $(wc -l <"$OUT/seed/changed.txt" | tr -d ' ') files changed, webclip.tgz $(du -h "$OUT/seed/webclip.tgz" 2>/dev/null | cut -f1)"
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
  if [ "${code:0:1}" = 2 ] || [ "${code:0:1}" = 3 ]; then note "$ORIGIN answered $code"; return 0; fi
  # save and rows need dev itself: a prod icon cached under the dev key, or a sign-in at the wrong Cognito
  [ "$AFTER" = card ] || { note "$ORIGIN answered $code: no fallback for a $AFTER shard"; return 1; }
  note "$ORIGIN answered $code; falling back to the prod origin (read only, the sign-in card)"
  ORIGIN="$FALLBACK"
}

s_safari() {
  local t i s err app=""
  # Safari's cold launch outlasts openurl's own ~10 s timeout on a busy runner (runs 2-4: NSPOSIXErrorDomain 60, three
  # in a row once), so Safari is launched first and openurl only navigates it.
  cap 120 xcrun simctl launch "$U" com.apple.mobilesafari >/dev/null 2>&1 || note "Safari launch didn't confirm in 120 s"
  for i in $(seq 1 15); do
    late && break
    t="$(tree)" || continue
    [ "$(front_app "$t")" = Safari ] && { note "Safari in front on look $i"; break; }
    sleep 2
  done
  for i in 1 2 3; do
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
  touch "$WORK/a2hs.marker"
  # iOS 26 Safari keeps Share in the … menu (AXButton "More"); iOS 27 reportedly moved that button to tabs, so a
  # Share button in the bar is tried first
  # iOS 27: the … button opens tabs; Share is in the Page menu (left of the address bar) or on a long-press of it
  if ! tap_label '^Share$' AXButton 2; then
    tap_label '^(Page Menu|More)$' AXButton 3 || return 1
    sleep 1
    evidence a2hs-menu tree
    tap_label '^Share' '' 4 || return 1
  fi
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
  # View More expands the action list (iOS 26: collapsed, "View More" reads as "go down"); skip it if the row shows
  if hit="$(scan_text 'Add to Home Screen' 300 920 158)"; then
    note "Add to Home Screen visible without View More ($hit)"
  elif hit="$(scan_text 'go down' 760 920 366)" || hit="$(scan_text 'View More' 760 920 366)"; then
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
    # run 4: four gesture scrolls in a row dropped (still page 1), so tries alternate with a plain swipe
    if [ $((i % 2)) = 1 ]; then ax gesture scroll-left --screen-width "$W" --screen-height "$H" >/dev/null 2>&1 || true
    else ax swipe --start-x 400 --start-y 480 --end-x 60 --end-y 480 --duration 0.4 >/dev/null 2>&1 || true; fi
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

# --- after the Sign in card ----------------------------------------------------------------------------------------

REPO="$(cd "$(dirname "$0")/../.." && pwd -P)"
SIGNIN_RAN=""
CARD_MS=""
# sim.sh's own keyboard prefs (IOS-CHECK.md → Keyboard): the soft-keyboard pair, then every pinned key, so a device
# saved with them boots ready and sim.sh's readiness has nothing to reboot for.
kb_prefs() {
  local off on k
  read -r off <<<"$(bash -c 'source "$1"; echo "$SIM_KB_OFF"' _ "$REPO/tools/mailroom/jobs/sim.sh")"
  read -r on <<<"$(bash -c 'source "$1"; echo "$SIM_KB_ON"' _ "$REPO/tools/mailroom/jobs/sim.sh")"
  for k in HardwareKeyboardLastSeen AutomaticMinimizationEnabled $off; do
    xcrun simctl spawn "$U" defaults write com.apple.keyboard.preferences "$k" -bool false >/dev/null 2>&1 || return 1
  done
  for k in $on; do xcrun simctl spawn "$U" defaults write com.apple.keyboard.preferences "$k" -bool true >/dev/null 2>&1 || return 1; done
}
# Option 1: the signed-out device (Safari's tip closed, dev on the Home Screen, keyboard prefs pinned) shut down and
# cloned into the cache dir, which the workflow saves under $KEY. Never after a sign-in: no token is ever cached.
s_save() {
  local t
  [ -z "$SIGNIN_RAN" ] && [ -z "$PW" ] || { note "refused: a sign-in ran, or this shard holds the password"; return 1; }
  [ "$ORIGIN" = https://dev.aperture.rahuldatta.dev ] || { note "refused: the icon isn't dev's"; return 1; }
  kb_prefs && note "keyboard prefs written" || note "keyboard prefs not written"
  xcrun simctl shutdown "$U" >/dev/null 2>&1 || { note "shutdown failed"; return 1; }
  mkdir -p "$CACHE_DIR/device"
  t=$(now_ms)
  if ! cp -c -R "$DEVICES/$U" "$CACHE_DIR/device/$U" 2>/dev/null; then # no APFS clone: a plain copy, never into a partial one
    [ ! -e "$CACHE_DIR/device/$U" ] || mv "$CACHE_DIR/device/$U" "$WORK/partial-clone"
    cp -R "$DEVICES/$U" "$CACHE_DIR/device/$U" || return 1
  fi
  note "device $(du -sh "$CACHE_DIR/device/$U" | cut -f1), cloned in $(($(now_ms) - t)) ms; cache key $KEY"
  [ -z "${GITHUB_OUTPUT:-}" ] || echo "cache=save" >>"$GITHUB_OUTPUT"
}

# One plans.json job through sim.sh's run_sim, in a subshell: the Mac's code, the CI device type, and two shims —
# no Device Hub on Xcode 26, and the Keychain read answered from the environment's secret (sim.sh pipes it into
# `axe type --stdin`). Prints run_sim's "status reason json".
run_sim_ci() (
  PATH="$(dirname "$AXE"):$PATH"
  export PATH
  # shellcheck disable=SC2034 # read by the sourced sim.sh
  STATE="$WORK"
  # shellcheck disable=SC2034
  HELD=lock
  # shellcheck source=/dev/null
  source "$REPO/tools/mailroom/jobs/sim.sh"
  # Xcode 26 has no Device Hub and its device isn't the profile's; on xcode-27 sim.sh runs as on the Mac. Device
  # Hub only shows the sim (simctl boots without it): where it won't start on a runner, sim.sh is told it's up.
  if [ "$(xcodebuild -version | sed -n 's/^Xcode \([0-9]*\).*/\1/p')" -lt 27 ]; then
    # shellcheck disable=SC2034
    SIM_DEVICE_TYPE="$DEVICE_TYPE"
  fi
  if [ "$HUB" != up ]; then
    pgrep() { if [ "${1:-}" = -x ] && [ "${2:-}" = DeviceHub ]; then return 0; fi; command pgrep "$@"; }
  fi
  security() {
    if [ "${1:-}" = find-generic-password ]; then
      case " $* " in *" -w "*) printf '%s' "$PW" ;; esac
      return 0
    fi
    command security "$@"
  }
  # A sign-in failure, at the moment sim.sh decides it (it then quits the app): only derived facts leave — which known
  # control labels sit at which y down the centre, and whether the address bar's host is dev's Cognito. Labels and
  # yes/no only, never a value (a filled field's value is the password's length at least).
  sim_diag() {
    local y e l out="" x0 y0 v
    for y in $(seq 60 20 940); do
      e="$(SIM_SENSITIVE=true sim_point "$SIM_X" "$y")" || continue
      l="$(jq -r '.label // ""' <<<"$e")"
      case "$l" in Capture* | "Sign in" | "Sign In" | submit | Email* | Password* | Address | "Search tasks"* | Tasks | Home) out="$out $l@$y($(jq -r .role <<<"$e"))" ;; esac
    done
    read -r x0 y0 <<<"$SIM_PT_ADDRESS"
    e="$(SIM_SENSITIVE=false sim_point "$x0" "$y0")" || e="{}"
    v="$(jq -r '.value // "" | gsub("^[\u200e\u200f\u202a-\u202e\u2066-\u2069]+"; "")' <<<"$e")"
    if [[ "$v" =~ $SIM_COGNITO_RE ]]; then v=dev-cognito; elif [ -z "$v" ]; then v=empty; else v=other; fi
    printf 'labels:%s; bar at %s: %s/%s host=%s' "${out:- none}" "$SIM_PT_ADDRESS" "$(jq -r '.role // "-"' <<<"$e")" "$(jq -r '.label // "-"' <<<"$e")" "$v"
  }
  sim_err() {
    # shellcheck disable=SC2034 # read by the sourced sim.sh
    SIM_ST=error SIM_RS="$1" SIM_DT="${2:-}" SIM_NOTE="${3:-}"
    case "$1" in SIGNIN_FAILED | PASSWORD_MISSING) sim_diag >"$WORK/diag.txt" 2>/dev/null || true ;; esac
    return 1
  }
  # the runner boots in 67–287 s (phase 1), past sim.sh's 90 s cap for its re-arm and sign-in reboots
  # shellcheck disable=SC2034
  sim_boot() { sx 300 bootstatus "$SIM_U" -b >/dev/null 2>&1 || { sim_err SIM_UNAVAILABLE BOOT_FAILED "bootstatus failed or took over 300 s"; return 1; }; SIM_STATE=Booted; }
  local bad
  bad="$(validate_sim "$1" 2>/dev/null)" || true
  [ -z "$bad" ] || { echo "rejected $bad {}"; return 0; }
  mkdir -p "$3"
  run_sim "$1" "$2" "$(cd "$3" && pwd -P)"
)
# Slot A's lock (refs/locks/dev, a public annotated tag whose message is {"branch","sha","expiresAt"}) must be this
# branch's before anything signs in to dev: the lane takes it right after the push that starts the run, so the rows
# wait up to 3 min for it, then refuse.
lock_ok() {
  local i msg
  for i in $(seq 1 18); do
    if git fetch -q --no-tags origin "+refs/locks/dev:refs/probe/lock-dev" 2>/dev/null; then
      msg="$(git cat-file -p refs/probe/lock-dev 2>/dev/null | sed '1,/^$/d')"
      if jq -e '.branch == "ios-ci-probe" and ((.expiresAt | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) > now)' <<<"$msg" >/dev/null 2>&1; then
        note "slot A's lock is ios-ci-probe's (look $i)"
        return 0
      fi
    fi
    sleep 10
  done
  note "slot A's lock isn't ios-ci-probe's after 3 min: no sign-in"
  return 1
}
# Sign-in recon, no password: from the Sign in card, open dev's Cognito sheet and measure where iOS 26 puts what
# sim.sh's sign-in reads (its points were measured on iOS 27: the address bar at 228,85, Email ys 256–296, Password
# 326–396, submit 414–474). Nothing is typed, so the reads and the sheet's shot hold no secret and no user data; the
# address bar's value is kept only as its host class.
s_recon() {
  local hit y i e x out=""
  note "secret: $SHAPE"
  hit="$(scan_text 'Sign in' 400 700)" || { note "no Sign in button"; return 1; }
  y="${hit%% *}"
  tap_at "$X_MID" "$y" || return 1
  for i in $(seq 1 30); do
    sleep 2
    e="$(cap 8 "$AXE" describe-ui --point 228,85 --udid "$U" 2>/dev/null)" || continue
    if jq -e '(if type == "array" then .[0] else . end) | .AXLabel == "Address"' <<<"$e" >/dev/null 2>&1; then break; fi
  done
  note "sheet after ~$((i * 2)) s"
  sleep 2
  evidence signin-sheet tree
  : >"$OUT/recon.tsv"
  for x in 228 220; do
    for y in $(seq 30 6 720); do
      e="$(cap 8 "$AXE" describe-ui --point "$x,$y" --udid "$U" 2>/dev/null)" || continue
      jq -r --argjson x "$x" --argjson y "$y" --arg re 'amazoncognito\.com$' '(if type == "array" then .[0] else . end) as $e
        | ($e.AXValue // "" | tostring | gsub("^[\u200e\u200f]+"; "")) as $v
        | [$x, $y, ($e.role // "-"), ($e.AXLabel // "" | tostring | .[0:40]), ($e.AXUniqueId // "" | tostring | .[0:20]),
           ($e.pid // "-"), (if ($v | test($re)) then "cognito-host" elif $v == "" then "empty" else "text(\($v | length))" end),
           ($e.frame // {} | "\(.x // 0 | floor),\(.y // 0 | floor),\(.width // 0 | floor),\(.height // 0 | floor)")] | @tsv' \
        <<<"$e" >>"$OUT/recon.tsv" 2>/dev/null || true
    done
  done
  out="$(awk -F'\t' '$4 != "" && !s[$3 FS $4 FS $8]++ { printf "%s %s @%s,%s [%s] pid %s %s; ", $3, $4, $1, $2, $8, $6, $7 }' "$OUT/recon.tsv" | cut -c1-900)"
  note "sheet: $out"
  xcrun simctl terminate "$U" com.apple.webapp >/dev/null 2>&1 || true
}
# The real rows: ios-standalone's own plans, in its order. Only op, status, ms and reason codes leave the runner.
s_rows() {
  local sha j job out st rs js t left try dt last="${ROW_JOBS##* }" bad=""
  [ -n "$PW" ] || { note "no DEVCHECK_PASSWORD from the ios-probe environment: rows can't run"; return 1; }
  # yes/no facts about the secret's shape (devcheck's parser trims the line; a CR or quotes would ride along here)
  note "secret: $([[ "$PW" =~ ^[[:space:]] || "$PW" =~ [[:space:]]$ ]] && echo edge-space || echo no-edge-space), $([[ "$PW" == *$'\r'* ]] && echo cr || echo no-cr), $([[ "$PW" =~ ^[\"\'] || "$PW" =~ [\"\']$ ]] && echo quoted || echo unquoted)"
  lock_ok || return 1
  SIGNIN_RAN=1
  sha="$(curl -s --max-time 15 "$ORIGIN/" | sed -n 's/.*<meta name="aperture-build" content="\([0-9a-f]\{40\}\)".*/\1/p' | head -1)"
  [ -n "$sha" ] || { note "no aperture-build marker on $ORIGIN"; return 1; }
  note "dev serves ${sha:0:7}"
  : >"$OUT/rows.tsv"
  for j in $ROW_JOBS; do
    late && { bad="budget"; break; }
    job="$WORK/job-$j.json"
    left=$((DEADLINE - SECONDS - 60))
    [ "$left" -le 600 ] || left=600
    [ "$left" -ge 60 ] || { bad="budget"; break; }
    jq -e --arg n "$j" --arg sha "$sha" --argjson to "$left" --argjson last "$([ "$j" = "$last" ] && echo true || echo false)" \
      '. as $p | ($p.jobs[] | select(.name == $n)) as $j
       | {job: "sim", params: {sha: $sha, timeoutSec: $to, shutdown: $last, steps: $j.steps}}' \
      "$REPO/tools/mailroom/bench/plans.json" >"$job" || { note "no $j job in plans.json"; return 1; }
    t=$(now_ms)
    # IOS-CHECK.md → Failures: these are dropped input ("rerun the step"), so a job that ends on one runs once more
    for try in 1 2; do
      : >"$WORK/diag.txt"
      out="$(run_sim_ci "$job" "$WORK/p-$j" "$WORK/res-$j-$try" 2>>"$WORK/sim.err")" || true
      read -r st rs js <<<"$out"
      [ -n "$js" ] || js="{}"
      # only known shapes reach the artifact, whatever run_sim printed
      case "$st" in pass | fail | error | rejected) ;; *) st=error rs=BAD_OUT js="{}" ;; esac
      [[ "$rs" =~ ^(-|[A-Z_]+(\([0-9A-Za-z.-]{0,16}\))?)$ ]] || rs=BAD_OUT
      dt="$(jq -r '.detail // ""' <<<"$js" 2>/dev/null | tr -cd 'A-Z_')"
      [ -s "$WORK/diag.txt" ] && note "$j diag: $(tr -cd '[:print:]' <"$WORK/diag.txt" | cut -c1-400)"
      case "$st:$dt" in
        fail:ICON_SCROLL_DROPPED | fail:ICON_TAP_DROPPED | fail:HOME_PRESS_DROPPED | fail:TAP_DROPPED | fail:ERASED | fail:SWITCHER_FAILED | fail:NAV_UNCONFIRMED)
          [ "$try" = 1 ] && { note "$j: $dt (dropped input), rerun"; continue; } ;;
      esac
      break
    done
    printf 'job\t%s\t%s\t%s\t%s\n' "$j" "${st:-error}" "${rs:--}" "$(($(now_ms) - t))" >>"$OUT/rows.tsv"
    jq -r '.steps[] | "op\t\(.i)\t\(.op)\t\(.status)\t\(.ms)"' <<<"$js" >>"$OUT/rows.tsv" 2>/dev/null || true
    log "  rows: $j → ${st:-error} ${rs:--} in $(($(now_ms) - t)) ms"
    if [ "$st" != pass ]; then
      bad="$j ${st:-error} ${rs:--} $(jq -r '.detail // ""' <<<"$js" 2>/dev/null | tr -cd 'A-Z_')"
      break
    fi
  done
  [ -z "$bad" ] || {
    case "$bad" in *SIGNIN_FAILED*AUTH_REJECTED* | *AUTH_REJECTED*) note "sign-in rejected: password rotated? reset the ios-probe secret" ;; esac
    note "stopped at: $bad"
    return 1
  }
  note "all of: $ROW_JOBS passed"
}

summary() {
  {
    echo "## iOS probe, shard $SHARD — $SRC → $AFTER, iOS ${RUNTIME:-none}, $ORIGIN"
    echo
    [ -z "$CARD_MS" ] || echo "cold to the Sign in card: $((CARD_MS / 1000)) s"
    echo
    echo "| step | result | s | note |"
    echo "| --- | --- | --- | --- |"
    awk -F'\t' '{ printf "| %s | %s | %.1f | %s |\n", $1, $2, $3 / 1000, $4 }' "$OUT/steps.tsv"
    if [ -s "$OUT/rows.tsv" ]; then
      echo
      echo "| rows | job | status | reason | s |"
      echo "| --- | --- | --- | --- | --- |"
      awk -F'\t' '$1 == "job" { printf "| | %s | %s | %s | %.1f |\n", $2, $3, $4, $5 / 1000 }' "$OUT/rows.tsv"
    fi
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
log "shard $SHARD: $SRC → $AFTER"
case "$SRC" in
  restore) step restore s_restore ;;
  *) step create s_create ;; # cold, seed (seeding happens before the boot starts)
esac
step env s_env # beside the boot
step axe-install s_axe_install
step boot s_boot_wait
step device-hub s_hub
# A rows shard leaves the readiness tree, the icon and the launch to sim.sh's own `launch` op (the same reads).
[ "$AFTER" = rows ] || step axe-ready s_axe_ready
step origin s_origin
if [ "$SRC" = cold ]; then
  step safari s_safari
  step add-to-home-screen s_a2hs
  step export export_webclip
fi
if [ "$AFTER" != rows ]; then
  step home-screen-icon s_icon
  step launch-to-sign-in s_launch && CARD_MS=$(($(now_ms) - T0))
fi
case "$AFTER" in
  save) step save s_save ;;
  rows) step rows s_rows ;;
  recon) step signin-recon s_recon ;;
esac
[ -z "$FAILED" ]
