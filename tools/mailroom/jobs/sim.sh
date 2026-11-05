# shellcheck shell=bash
# The `sim` job: drive the iOS Simulator on this Mac through a short, allowlisted plan of ops, inside the Aperture
# web app on the Home Screen of the dedicated `aperture-devcheck` sim, signed in as the dev test user. Sourced by
# runner.sh. The plan is DATA: SIM_JQ validates all of it before any simctl/axe call, and each op runs a fixed recipe
# below (AXe 1.8.0 for taps, typing and accessibility reads; simctl for boot, kill and prefs). Mirrors
# scripts/src/mailroom/sim.ts (the fixtures run both). Design, hazards and reason codes: docs/ops/IOS-CHECK.md.

SIM_NAME="aperture-devcheck"
SIM_AXE_VERSION="1.8.0"
SIM_TERMINATE_ID="com.apple.webapp"
SIM_HUB_ID="com.apple.dt.Devices"
SIM_EMAIL="rahul3datta+devcheck@gmail.com"
SIM_KEYCHAIN="aperture-devcheck-dev" # the dev test user's password: this Mac's Keychain only, never a file
SIM_COGNITO_RE='^aperture-dev-618015769091\.auth\.us-west-1\.amazoncognito\.com$'
SIM_KB="com.apple.keyboard.preferences"
# --- the device profile: every fixed point the recipes use, in points (SIM_W×SIM_H), measured on the device
# type below (IOS-CHECK.md → Device profile). A sim of any other type is PROFILE_MISMATCH, never mis-aimed taps.
SIM_DEVICE_TYPE="com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro-Max" # measured 2026-11-05
SIM_W=440
SIM_H=956
SIM_X=220                                      # the probe column for centred controls
SIM_Y_HOME=895                                 # Home's capture bar, no keyboard: the signed-in landmark
SIM_Y_SIGNIN=530                               # the Sign in card's button: the signed-out landmark
SIM_PT_ADDRESS="228 85"                        # the Cognito sheet's address bar
SIM_YS_EMAIL="276 266 286 256 296"             # the Email field, nearest first
SIM_YS_PASSWORD="366 356 376 346 386 336 396 326" # the Password field, after the form zoomed on focus
SIM_YS_SUBMIT="454 444 464 434 474 424 414"    # the form's submit button
SIM_Y_NEVER=588                                # Save Password's "Never for This Website"
SIM_PT_SPACE="221 856"                         # the soft keyboard's space bar
SIM_X_DONE=395                                 # the keyboard accessory bar's Done
SIM_YS_ACCESSORY="575 565 585 555 595 545 605" # that bar, nearest first
SIM_Y_NAV=168                                  # the nav row (page scrolled to the top)
SIM_XS_NAV="38 88 136 205 276 332 380 268 395" # tab centres: seven unscrolled, then Finances/Inbox/Settings swiped
SIM_X_BUILD=57                                 # Settings' build stamp, page scrolled to the bottom
SIM_YS_BUILD="935 920 905 890 875 860 845 830 815 800 785 770 755 740 725 710 695 680 665 650 635"
SIM_CARD_SWIPE="340 560 340 40"                # the app switcher: the app's card, swiped up
SIM_PT_BACKGROUND="400 880"                    # the app switcher: empty background, to leave it
SIM_SCROLL_X=220                               # where page swipes run
SIM_MAX_PROBES=400
if [ "$(uname)" = Darwin ]; then SIM_MV_NOFOLLOW=-fh; else SIM_MV_NOFOLLOW=-fT; fi # mv onto a link: replace it
SIM_TABS='["Home","Log","Tasks","Recruiting","Habits","Rolls","Flux","Finances","Inbox","Settings"]'
# The app's write buttons, refused for `tap` (lowercased, exact). A belt: the boundary is the test user's partition.
SIM_DENY='["save","save log","save task","save idea","mark done","start","stop","delete","complete","export json","generate token","rotate","connect google calendar","sign out","save password","not now","return","add to today","add place"]'

# Prints a reason code, or nothing when the plan is good. Same order as sim.ts → validateSimParams.
SIM_JQ='
  def whole($re): type == "string" and (contains("\n") | not) and test($re);
  def int($lo; $hi): type == "number" and . == floor and . >= $lo and . <= $hi;
  def keysok($req; $opt): (keys - $req - $opt) == [] and ($req - keys) == [];
  def text: type == "string" and length <= 200 and (explode | all(. >= 32 and . != 127));
  def lbl: whole("^[A-Za-z0-9 .,:;()/+_&'"'"'?…-]{1,60}$");
  def asname: whole("^[a-z][a-z0-9-]{0,23}$");
  def role: type == "string" and (. as $r | ["AXButton","AXLink","AXTextArea","AXTextField","AXStaticText","AXCheckBox"] | index($r) != null);
  def where:
    ((has("near")) != (has("scan")))
    and (if has("near") then (.near | type == "object" and keysok(["x","y"]; []) and (.x | int(0; $w)) and (.y | int(0; $h)))
         else (.scan | type == "object" and keysok(["x","from","to"]; []) and (.x | int(0; $w)) and (.from | int(0; $h))
           and (.to | int(0; $h)) and ((((.to - .from) | fabs) / 30 | floor) + 1 <= 20)) end)
    and (if has("radius") then (has("near") and (.radius | int(10; 80))) else true end)
    and (if has("role") then (.role | role) else true end);
  def opok:
    . as $o | type == "object" and (.op | type) == "string" and
    if (["launch","signIn","blur","readBuild","shutdown"] | index($o.op)) != null then keysok(["op"]; [])
    elif .op == "kill" then keysok(["op","method"]; []) and (.method == "terminate" or .method == "switcher" or .method == "reboot")
    elif .op == "nav" then keysok(["op","tab"]; []) and (.tab | type == "string") and ($tabs | index($o.tab)) != null
    elif .op == "find" then keysok(["op","label","as"]; ["near","scan","radius","role"]) and (.label | lbl) and (.as | asname) and where
    elif .op == "absent" then keysok(["op","label"]; ["near","scan","radius","role"]) and (.label | lbl) and where
    elif .op == "tap" then keysok(["op","label"]; ["near","scan","radius","role","as"]) and (.label | lbl)
      and (if has("as") then (.as | asname) else true end) and where
    elif .op == "expect" then
      if has("signedIn") then keysok(["op","signedIn"]; []) and .signedIn == true
      else (.as | asname) and (keys | length) == 3 and
        (if has("valueIs") then (.valueIs | text)
         elif has("labelIs") then (.labelIs | text)
         elif has("enabled") then (.enabled | type == "boolean")
         elif has("aboveKeyboard") then .aboveKeyboard == true
         elif has("sameWidthAs") then (.sameWidthAs | asname)
         else false end) end
    elif .op == "keys" then keysok(["op","text"]; []) and (.text | whole("^[a-z ]{1,24}$"))
    elif .op == "erase" then keysok(["op","n"]; []) and (.n | int(1; 24))
    elif .op == "scroll" then keysok(["op","dir","pt"]; []) and (.dir == "up" or .dir == "down") and (.pt | int(100; 600))
    elif .op == "expectBuild" then keysok(["op"]; ["relaunches"]) and (if has("relaunches") then (.relaunches | int(0; 1)) else true end)
    elif .op == "shot" then keysok(["op","name"]; []) and (.name | whole("^[a-z0-9-]{1,32}$"))
    elif .op == "wait" then keysok(["op","s"]; []) and (.s | int(1; 30))
    else false end;
  def denied: .op == "tap" and ((.label | ascii_downcase | sub("^ +"; "") | sub(" +$"; "")) as $l | $deny | index($l)) != null;
  def crossok:
    . as $s | length as $n
    | ([$s[] | select(.op == "shot")] | length) <= 20
    and ([range(0; $n) | select($s[.].op == "kill") | ($s[. + 1].op // "") == "launch"] | all)
    and ([range(0; $n) | select($s[.].op == "shutdown") | . == $n - 1] | all)
    and ([range(0; $n) | select($s[.].op == "signIn") | . as $k | [$s[0:$k][] | select(.op == "launch")] | length > 0] | all)
    and (reduce $s[] as $o ({ok: true, def: []};
      if .ok | not then .
      else (if $o.op == "expect" and ($o | has("as")) then
              (.def | index($o.as)) != null
              and (if $o | has("sameWidthAs") then (.def | index($o.sameWidthAs)) != null else true end)
            else true end) as $refok
        | (($o.op == "find" or $o.op == "tap") and ($o | has("as"))) as $defines
        | {ok: ($refok and (if $defines then (.def | index($o.as)) == null else true end)),
           def: (.def + (if $defines then [$o.as] else [] end))}
      end) | .ok);
  try (
    .params as $p
    | if ($p | type) != "object" or ($p | keys) != ["sha","shutdown","steps","timeoutSec"] then "BAD_PARAM"
    elif ($p.sha | whole("^[0-9a-f]{40}$") | not) then "BAD_PARAM"
    elif ($p.timeoutSec | int(60; 600) | not) then "BAD_PARAM"
    elif ($p.shutdown | type) != "boolean" then "BAD_PARAM"
    elif ($p.steps | type) != "array" or ($p.steps | length) < 1 then "BAD_PARAM"
    elif ($p.steps | length) > 80 then "TOO_MANY_OPS"
    else ([$p.steps[] | if (opok | not) then "BAD_OP" elif denied then "DENIED_TAP" else empty end][0])
      // (if ($p.steps | crossok) then empty else "BAD_OP" end)
    end
  ) catch "BAD_PARAM"'

validate_sim() {
  local reason
  reason="$(jq -r --argjson w "$SIM_W" --argjson h "$SIM_H" --argjson tabs "$SIM_TABS" --argjson deny "$SIM_DENY" "$SIM_JQ" "$1" 2>/dev/null)" || reason="BAD_PARAM"
  printf '%s' "$reason"
  return 0
}

# --- plumbing ---------------------------------------------------------------------------------------------------
# sim_cap SECS CMD… — run CMD, kill it after SECS (macOS has no `timeout`); 124 when it was killed. Stdin passes
# through (a background command would otherwise read /dev/null).
sim_cap() {
  local cap="$1" pid wd rc
  shift
  "$@" <&0 &
  pid=$!
  (sleep "$cap" && kill -TERM "$pid" 2>/dev/null) >/dev/null 2>&1 &
  wd=$!
  wait "$pid"
  rc=$?
  pkill -P "$wd" 2>/dev/null || true
  kill "$wd" 2>/dev/null || true
  wait "$wd" 2>/dev/null || true
  if [ "$rc" = 143 ]; then return 124; fi
  return "$rc"
}

ax() { sim_cap 30 axe "$@" --udid "$SIM_U"; }
sx() { local cap="$1"; shift; sim_cap "$cap" xcrun simctl "$@"; }
sim_ms() { jq -nr 'now * 1000 | floor'; }

# An op's outcome: fail = the row's assertion didn't hold; error = the sim couldn't run it (needs you).
sim_fail() { SIM_ST=fail; SIM_RS=ASSERT; SIM_DT="$1"; SIM_NOTE="${2:-}"; return 1; }
sim_err() { SIM_ST=error; SIM_RS="$1"; SIM_DT="${2:-}"; SIM_NOTE="${3:-}"; return 1; }

# Write NAME into the job's result dir: pinned cwd, re-checked, never through an existing entry.
sim_rd() {
  local src="$1" name="$2"
  (
    cd "$SIM_RD" && [ "$(pwd -P)" = "$SIM_RD" ] || exit 1
    case "$name" in
      */*)
        [ -d shots ] || mkdir shots || exit 1
        [ ! -L shots ] && cd shots && [ "$(pwd -P)" = "$SIM_RD/shots" ] || exit 1
        name="${name#*/}" ;;
    esac
    if [ -e "$name" ] || [ -L "$name" ]; then exit 1; fi
    set -C
    cat -- "$src" >"./$name"
  ) 2>/dev/null
}

# The heartbeat the container watches: rewritten before every op (temp + rename: a rename never follows a link).
sim_progress() {
  jq -cn --argjson i "$1" --argjson of "$2" --arg op "$3" --arg booted "$SIM_BOOTED" --arg signed "$SIM_SIGNED" \
    '{at: (now | todate), i: $i, of: $of, op: $op, booted: $booted, signedIn: $signed}' >"$SIM_P.progress"
  (
    cd "$SIM_RD" && [ "$(pwd -P)" = "$SIM_RD" ] || exit 1
    if [ -e .progress.tmp ] || [ -L .progress.tmp ] || [ -d progress.json ]; then exit 1; fi
    (set -C && cat -- "$SIM_P.progress" >./.progress.tmp) && mv "$SIM_MV_NOFOLLOW" ./.progress.tmp ./progress.json
  ) 2>/dev/null || true
}

# Point reads run in $(…) subshells, so the count lives in a file; the run loop turns `.over` into TIMEOUT/PROBES.
sim_probe_budget() {
  local n
  n=$(($(cat "$SIM_P.probes" 2>/dev/null || echo 0) + 1))
  echo "$n" >"$SIM_P.probes"
  [ "$n" -le "$SIM_MAX_PROBES" ] || { : >"$SIM_P.over"; return 1; }
}

# One accessibility read at a point: {role,label,value,id,pid,enabled,frame{x,y,w,h},at{x,y}} or {}. While SIM_SENSITIVE
# (the sign-in form) no value survives: a typed password lives in AXValue, never in a label.
sim_point() {
  local raw
  sim_probe_budget || return 1
  raw="$(ax describe-ui --point "$1,$2" 2>/dev/null)" || raw=""
  [ -n "$raw" ] || raw='{}'
  jq -c --argjson sens "$SIM_SENSITIVE" --argjson x "$1" --argjson y "$2" '
    (if type == "array" then (.[0] // {}) else . end)
    | if type != "object" then {} else
      {role: ((.role // "") | tostring), label: ((.AXLabel // "") | tostring), value: ((.AXValue // "") | tostring | .[0:200]),
       id: ((.AXUniqueId // "") | tostring | .[0:40]), pid: (if (.pid | type) == "number" then .pid else null end), enabled: (.enabled != false),
       frame: ((.frame // {}) | {x: ((.x // 0) | floor), y: ((.y // 0) | floor), w: ((.width // .w // 0) | floor), h: ((.height // .h // 0) | floor)}),
       at: {x: $x, y: $y}}
      | if $sens then del(.value) else . end end' <<<"$raw" 2>/dev/null || echo '{}'
}

# Does element JSON $1 start with label $2 (case-insensitive, label or value) and have role $3 (any when empty)?
sim_match() {
  jq -e --arg l "$2" --arg r "$3" '($l | ascii_downcase) as $w
    | (.role // "") != "" and ($r == "" or .role == $r)
    and ([.label // "", .value // ""] | map(ascii_downcase | sub("^\\s+"; "")) | any(startswith($w)))' <<<"$1" >/dev/null 2>&1
}

sim_label_is() { jq -e --arg l "$2" '((.label // "") | ascii_downcase) == ($l | ascii_downcase)' <<<"$1" >/dev/null 2>&1; }

# The full tree's app: "Web" while the Home Screen web app is in front. The first reads after a boot can time out
# ("creating the simulator remote automation session": three in a row once): up to four tries.
sim_tree() {
  local t i
  for i in 1 2 3 4; do
    if t="$(ax describe-ui 2>/dev/null)"; then printf '%s' "$t"; return 0; fi
    [ "$i" = 4 ] || sleep 2
  done
  return 1
}
# Not in front is the row's failure; an unreadable tree is the sim's (needs you).
sim_in_app() {
  local t
  t="$(sim_tree)" || { sim_err SIM_UNAVAILABLE AX_TIMEOUT "describe-ui timed out four times"; return 1; }
  jq -e '[.. | objects | select(.role? == "AXApplication")][0].AXLabel == "Web"' <<<"$t" >/dev/null 2>&1 \
    || { sim_fail NOT_IN_APP "the Aperture web app isn't in front"; return 1; }
}

# Tap an element's frame centre — only when the frame is on screen (AXe reports success for an off-screen tap).
sim_tap_el() {
  local cx cy w h
  read -r cx cy w h < <(jq -r '.frame // {} | "\(((.x // 0) + (.w // 0) / 2) | floor) \(((.y // 0) + (.h // 0) / 2) | floor) \(.w // 0) \(.h // 0)"' <<<"$1")
  if [ "${w:-0}" -le 0 ] || [ "${h:-0}" -le 0 ] || [ "$cx" -lt 0 ] || [ "$cx" -gt "$SIM_W" ] || [ "$cy" -lt 0 ] || [ "$cy" -gt "$SIM_H" ]; then
    sim_fail OFF_SCREEN "target centre $cx,$cy is off the ${SIM_W}x$SIM_H screen"
    return 1
  fi
  ax tap -x "$cx" -y "$cy" --tap-style physical ${2:+--pre-delay "$2"} >/dev/null 2>&1 || sim_err SIM_UNAVAILABLE AXE_FAILED "tap failed"
}

# Probe points for a find/tap op, nearest first: a 30-pt grid within `radius` of `near`, or a straight `scan`.
sim_points() {
  jq -r --argjson w "$SIM_W" --argjson h "$SIM_H" 'if has("near") then ((.radius // 40) / 30 | floor) as $k | [range(-$k; $k + 1) * 30] as $o | .near as $n
      | [$o[] as $dx | $o[] as $dy | {d: ($dx * $dx + $dy * $dy), x: ($n.x + $dx), y: ($n.y + $dy)}] | sort_by(.d) | .[]
      | select(.x >= 0 and .x <= $w and .y >= 0 and .y <= $h) | "\(.x | floor) \(.y | floor)"
    else .scan as $s | (if $s.to >= $s.from then range($s.from; $s.to + 1; 30) else range($s.from; $s.to - 1; -30) end)
      | "\($s.x | floor) \(. | floor)" end' <<<"$1"
}

# SIM_HIT ← the first element matching the op's label (and role); a miss names what it saw instead.
sim_find() {
  local op="$1" label role x y e seen=""
  label="$(jq -r .label <<<"$op")"
  role="$(jq -r '.role // ""' <<<"$op")"
  sim_in_app || return 1
  while read -r x y; do
    e="$(sim_point "$x" "$y")" || return 1
    if sim_match "$e" "$label" "$role"; then
      SIM_HIT="$e"
      return 0
    fi
    seen="$seen$(jq -r '(.label // "") | gsub("[^A-Za-z0-9 .,:;()/+_&?-]"; "") | .[0:24]' <<<"$e")|"
  done < <(sim_points "$op")
  seen="$(printf '%s' "$seen" | tr '|' '\n' | awk 'NF && !s[$0]++' | head -3 | paste -sd ',' -)"
  sim_fail MISS "no \"$label\" found (saw: ${seen:-nothing})"
}

sim_read_put() { jq -c --arg k "$1" --argjson e "$2" '.[$k] = $e' "$SIM_P.reads" >"$SIM_P.reads.n" && mv -f "$SIM_P.reads.n" "$SIM_P.reads"; }
sim_read_get() { jq -c --arg k "$1" '.[$k] // {}' "$SIM_P.reads"; }

# --- the device -------------------------------------------------------------------------------------------------
sim_device() {
  local list n
  list="$(sx 30 list devices -j 2>/dev/null)" || { sim_err SIM_UNAVAILABLE SIM_MISSING "simctl list failed"; return 1; }
  n="$(jq --arg n "$SIM_NAME" '[.devices[][] | select(.name == $n and .isAvailable == true)] | length' <<<"$list" 2>/dev/null || echo 0)"
  [ "$n" != 0 ] || { sim_err SIM_UNAVAILABLE SIM_MISSING "no available $SIM_NAME sim"; return 1; }
  [ "$n" = 1 ] || { sim_err SIM_UNAVAILABLE SIM_AMBIGUOUS "$n sims named $SIM_NAME"; return 1; }
  read -r SIM_U SIM_STATE SIM_TYPE SIM_RUNTIME < <(jq -r --arg n "$SIM_NAME" '.devices | to_entries[] | .key as $rt | .value[]
    | select(.name == $n and .isAvailable == true)
    | "\(.udid) \(.state) \(.deviceTypeIdentifier // "-") \($rt | sub(".*SimRuntime\\."; "") | sub("-"; " ") | gsub("-"; "."))"' <<<"$list")
  [[ "$SIM_U" =~ ^[0-9A-F-]{36}$ ]] || { sim_err SIM_UNAVAILABLE SIM_MISSING "bad udid"; return 1; }
  [ "$SIM_TYPE" = "$SIM_DEVICE_TYPE" ] || {
    sim_err SIM_UNAVAILABLE PROFILE_MISMATCH "the sim is ${SIM_TYPE##*.}, the profile ${SIM_DEVICE_TYPE##*.} (IOS-CHECK.md -> Device profile)"
    return 1
  }
}

sim_boot() { sx 90 bootstatus "$SIM_U" -b >/dev/null 2>&1 || { sim_err SIM_UNAVAILABLE BOOT_FAILED "bootstatus failed or took over 90 s"; return 1; }; }
sim_shutdown() { sx 30 shutdown "$SIM_U" >/dev/null 2>&1 || true; }
sim_pref() { sx 30 spawn "$SIM_U" defaults read "$SIM_KB" "$1" 2>/dev/null | tr -d '[:space:]'; }
# The soft keyboard (IOS-CHECK.md → Keyboard): both prefs 0, applied only at boot; HID typing flips them back to 1.
sim_arm() {
  sx 30 spawn "$SIM_U" defaults write "$SIM_KB" HardwareKeyboardLastSeen -bool false >/dev/null 2>&1 \
    && sx 30 spawn "$SIM_U" defaults write "$SIM_KB" AutomaticMinimizationEnabled -bool false >/dev/null 2>&1 \
    || { sim_err SIM_UNAVAILABLE BOOT_FAILED "could not write the keyboard prefs"; return 1; }
  sim_shutdown
  sim_boot || return 1
  SIM_BOOTED=rebooted
}

sim_ready() {
  local v i
  if [ -z "$SIM_AXE_OK" ]; then
    v="$(sim_cap 30 axe --version 2>/dev/null | tr -d '[:space:]')" || v=""
    [ -n "$v" ] || { sim_err SIM_UNAVAILABLE AXE_MISSING "axe not found (brew install cameroncooke/axe/axe)"; return 1; }
    [ "$v" = "$SIM_AXE_VERSION" ] || { sim_err SIM_UNAVAILABLE "AXE_VERSION($(printf '%s' "$v" | tr -cd '0-9.' | cut -c1-12))" "want axe $SIM_AXE_VERSION"; return 1; }
    SIM_AXE_OK=1
    SIM_XCODE="$(sim_cap 30 xcodebuild -version 2>/dev/null | head -2 | tr '\n' ' ' | tr -cd 'A-Za-z0-9. ' | sed 's/ *$//' | cut -c1-40)" || SIM_XCODE=""
  fi
  sim_device || return 1
  if ! pgrep -x DeviceHub >/dev/null 2>&1; then
    sim_cap 30 open -g -b "$SIM_HUB_ID" >/dev/null 2>&1 || true
    i=0
    until pgrep -x DeviceHub >/dev/null 2>&1; do
      i=$((i + 1))
      [ "$i" -le 10 ] || { sim_err SIM_UNAVAILABLE DEVICE_HUB "Device Hub did not start"; return 1; }
      sleep 1
    done
  fi
  if [ "$SIM_STATE" != Booted ]; then
    sim_boot || return 1
    SIM_STATE=Booted
    [ "$SIM_BOOTED" != warm ] || SIM_BOOTED=cold
  fi
  if [ "$(sim_pref HardwareKeyboardLastSeen)" != 0 ] || [ "$(sim_pref AutomaticMinimizationEnabled)" != 0 ]; then
    sim_arm || return 1
  fi
  sim_tree >/dev/null || { sim_err SIM_UNAVAILABLE AX_TIMEOUT "describe-ui timed out four times"; return 1; }
  SIM_READY=1
}

# A plan that doesn't open with launch carries on from the last job's screen; it still gets the readiness checks,
# and if they had to boot the sim there is nothing open to carry on from.
sim_lazy_ready() {
  case "$1" in launch | shutdown | wait | kill) return 0 ;; esac
  [ -z "$SIM_READY" ] || return 0
  sim_ready || return 1
  [ "$SIM_BOOTED" = warm ] || { sim_err SIM_UNAVAILABLE NOT_LAUNCHED "the sim was off, or rebooted to re-arm the keyboard; this plan needs a launch first"; return 1; }
}

# The app's landmark: Home's capture bar (signed in) or the sign-in card. Echoes already | false | "" (neither).
sim_landmark() {
  local e
  e="$(sim_point "$SIM_X" "$SIM_Y_HOME")" || return 1
  if [ "$(jq -r '.role' <<<"$e")" = AXTextArea ] && sim_match "$e" "Capture" ""; then echo already; return 0; fi
  e="$(sim_point "$SIM_X" "$SIM_Y_SIGNIN")" || return 1
  if [ "$(jq -r '.role' <<<"$e")" = AXButton ] && sim_label_is "$e" "Sign in"; then echo false; return 0; fi
  echo ""
}

sim_icon() {
  local t
  t="$(sim_tree)" || return 1
  jq -c --argjson w "$SIM_W" --argjson h "$SIM_H" '[.. | objects | select(.AXLabel? == "Aperture" and .role? == "AXButton")
    | (.frame // {}) | {x: ((.x // 0) | floor), y: ((.y // 0) | floor), w: ((.width // 0) | floor), h: ((.height // 0) | floor)}
    | select(.w > 0 and .h > 0 and .x >= 0 and .x + .w <= $w and .y >= 0 and .y + .h <= $h)][0] // empty
    | {role: "AXButton", label: "Aperture", frame: .}' <<<"$t" 2>/dev/null
}

sim_icon_here() {
  local x y e
  read -r x y < <(jq -r '.frame | "\(.x + (.w / 2) | floor) \(.y + (.h / 2) | floor)"' <<<"$1")
  e="$(sim_point "$x" "$y")" || return 1
  [ "$(jq -r .role <<<"$e")" = AXButton ] && sim_label_is "$e" "Aperture"
}

# --- ops ----------------------------------------------------------------------------------------------------------
sim_op_launch() {
  local icon i s
  sim_ready || return 1
  ax batch --step "button home" --step "sleep 1" >/dev/null 2>&1 || true
  icon="$(sim_icon)" || true
  if [ -z "$icon" ]; then # after a boot the Home Screen opens on page 1; the icon lives on page 2
    ax gesture scroll-left --screen-width "$SIM_W" --screen-height "$SIM_H" >/dev/null 2>&1 || true
    icon="$(sim_icon)" || true
  fi
  [ -n "$icon" ] || { sim_err SIM_UNAVAILABLE WEBCLIP_MISSING "no on-screen Aperture icon (add dev to the sim's Home Screen)"; return 1; }
  # The tree can lag a page change; page 1 has a widget where page 2 has the icon (profile.md surprise 13).
  sim_icon_here "$icon" || { sim_err SIM_UNAVAILABLE WEBCLIP_MISSING "the Aperture icon isn't under its frame (wrong Home Screen page?)"; return 1; }
  sim_tap_el "$icon" || return 1
  i=0
  while :; do
    s="$(sim_landmark)" || return 1
    if [ -n "$s" ]; then
      SIM_SIGNED="$s"
      SIM_NOTE="signed in: $s; booted $SIM_BOOTED"
      return 0
    fi
    i=$((i + 1))
    [ "$i" -lt 20 ] || { sim_fail LANDMARK "neither Home nor the sign-in card after launch"; return 1; }
    if [ "$i" = 10 ]; then # the page can draw offset from its accessibility frames after a kill: nudge it
      ax swipe --start-x "$SIM_SCROLL_X" --start-y 450 --end-x "$SIM_SCROLL_X" --end-y 250 --duration 0.2 >/dev/null 2>&1 || true
      ax swipe --start-x "$SIM_SCROLL_X" --start-y 250 --end-x "$SIM_SCROLL_X" --end-y 450 --duration 0.2 >/dev/null 2>&1 || true
    fi
    sleep 2
  done
}

# Is the front sheet dev's Cognito? Read from the sheet's own address bar: native chrome (role, id "URL"), owned
# by another process than the page ($1, the Sign in button's pid), so the page can't draw a lookalike
# (IOS-CHECK.md → Sign-in).
sim_on_cognito() {
  local e x y v
  read -r x y <<<"$SIM_PT_ADDRESS"
  e="$(SIM_SENSITIVE=false && sim_point "$x" "$y")" || return 1
  jq -e --argjson app "${1:-null}" '.role == "AXGenericElement" and .id == "URL" and .label == "Address"
    and $app != null and .pid != null and .pid != $app' <<<"$e" >/dev/null 2>&1 || return 1
  v="$(jq -r '.value // "" | gsub("^[\u200e\u200f\u202a-\u202e\u2066-\u2069]+"; "")' <<<"$e")" # a leading LRM
  [[ "$v" =~ $SIM_COGNITO_RE ]]
}

# Tap a sign-in field until it has focus: the form zooms when one does, so a moved frame is the proof. A tap can be
# dropped silently (profile.md surprise 5), so one retap, then FORM_CHANGED.
sim_focus_field() {
  local e="$1" x y n i
  read -r x y < <(jq -r '.at | "\(.x) \(.y)"' <<<"$e")
  for i in 1 2; do
    sim_tap_el "$e" || return 1
    sleep 1
    n="$(sim_point "$x" "$y")" || return 1
    if sim_match "$n" "$2" "" && ! jq -e --argjson a "$e" '.frame == $a.frame' <<<"$n" >/dev/null 2>&1; then return 0; fi
  done
  sim_err SIGNIN_FAILED FORM_CHANGED "the $2 field never took focus"
}

# Sign in from Keychain when the app is signed out. The password goes Keychain → axe's stdin, nowhere else; from the
# first tap to Home nothing is read back but roles and button/field labels, and nothing is screenshotted.
sim_op_signIn() {
  local e pf pt i s app
  if [ "$SIM_SIGNED" != false ]; then SIM_NOTE="already signed in"; return 0; fi
  sim_cap 30 security find-generic-password -s "$SIM_KEYCHAIN" -a "$SIM_EMAIL" >/dev/null 2>&1 \
    || { sim_err PASSWORD_MISSING "" "no readable Keychain item $SIM_KEYCHAIN"; return 1; }
  e="$(sim_point "$SIM_X" "$SIM_Y_SIGNIN")" || return 1
  sim_label_is "$e" "Sign in" || { sim_err SIGNIN_FAILED FORM_CHANGED "no Sign in button"; return 1; }
  app="$(jq -c '.pid' <<<"$e")"
  sim_tap_el "$e" || return 1
  sleep 3
  sim_on_cognito "$app" || { sim_err SIGNIN_FAILED COGNITO_HOST "the sign-in page isn't dev's Cognito"; return 1; }
  SIM_SENSITIVE=true
  for pt in $SIM_YS_EMAIL; do
    e="$(sim_point "$SIM_X" "$pt")" || return 1
    sim_match "$e" "Email" "AXTextField" && break
    e=""
  done
  [ -n "$e" ] || { SIM_SENSITIVE=false; sim_err SIGNIN_FAILED FORM_CHANGED "no Email field"; return 1; }
  sim_focus_field "$e" Email || { SIM_SENSITIVE=false; return 1; }
  ax type "$SIM_EMAIL" >/dev/null 2>&1 || { SIM_SENSITIVE=false; sim_err SIM_UNAVAILABLE AXE_FAILED "typing failed"; return 1; }
  # The form zooms on focus, so the password field is found again.
  for pt in $SIM_YS_PASSWORD; do
    e="$(sim_point "$SIM_X" "$pt")" || return 1
    if jq -e '.role == "AXTextField" or .role == "AXSecureTextField"' <<<"$e" >/dev/null && sim_match "$e" "Password" ""; then break; fi
    e=""
  done
  [ -n "$e" ] || { SIM_SENSITIVE=false; sim_err SIGNIN_FAILED FORM_CHANGED "no Password field"; return 1; }
  sim_tap_el "$e" || { SIM_SENSITIVE=false; return 1; }
  pf="$e"
  # Again just before the password: the form flow ran since the first check.
  sim_on_cognito "$app" || { SIM_SENSITIVE=false; sim_err SIGNIN_FAILED COGNITO_HOST "the sign-in page isn't dev's Cognito"; return 1; }
  if ! sim_cap 30 security find-generic-password -s "$SIM_KEYCHAIN" -a "$SIM_EMAIL" -w 2>/dev/null | tr -d '\n' | ax type --stdin >/dev/null 2>&1; then
    SIM_SENSITIVE=false
    sim_err PASSWORD_MISSING "" "the Keychain read or the typing failed"
    return 1
  fi
  for pt in $SIM_YS_SUBMIT; do
    # never a read inside the filled password field (its value would carry the password's length)
    if jq -e --argjson y "$pt" '.frame.y <= $y and $y <= .frame.y + .frame.h' <<<"$pf" >/dev/null 2>&1; then continue; fi
    e="$(sim_point "$SIM_X" "$pt")" || return 1
    if [ "$(jq -r .role <<<"$e")" = AXButton ] && sim_label_is "$e" "submit"; then break; fi
    e=""
  done
  [ -n "$e" ] || { SIM_SENSITIVE=false; sim_err SIGNIN_FAILED FORM_CHANGED "no submit button"; return 1; }
  sim_tap_el "$e" 2 || { SIM_SENSITIVE=false; return 1; }
  i=0
  while :; do
    s="$(sim_landmark)" || { SIM_SENSITIVE=false; return 1; }
    [ "$s" != already ] || break
    i=$((i + 1))
    [ "$i" -lt 12 ] || { SIM_SENSITIVE=false; sim_err SIGNIN_FAILED AUTH_REJECTED "still not on Home 25 s after submit"; return 1; }
    sleep 2
  done
  SIM_SENSITIVE=false
  e="$(sim_point "$SIM_X" "$SIM_Y_NEVER")" || return 1
  if sim_label_is "$e" "Never for This Website"; then sim_tap_el "$e" || return 1; fi
  # HID typing flipped the keyboard prefs back: re-arm, reboot, relaunch.
  sim_arm || return 1
  sim_op_launch || return 1
  [ "$SIM_SIGNED" = already ] || { sim_err SIGNIN_FAILED AUTH_REJECTED "signed out again after the reboot"; return 1; }
  SIM_SIGNED=fresh
  SIM_NOTE="signed in fresh; rebooted to re-arm the keyboard"
}

sim_op_kill() {
  local m sx sy ex ey bx by
  m="$(jq -r .method <<<"$1")"
  case "$m" in
    terminate) sx 30 terminate "$SIM_U" "$SIM_TERMINATE_ID" >/dev/null 2>&1 || { sim_err SIM_UNAVAILABLE TERMINATE "simctl terminate failed"; return 1; } ;;
    switcher)
      ax batch --step "button home" --step "sleep 0.15" --step "button home" --step "sleep 1.5" >/dev/null 2>&1 \
        && read -r sx sy ex ey <<<"$SIM_CARD_SWIPE" && read -r bx by <<<"$SIM_PT_BACKGROUND" \
        && ax swipe --start-x "$sx" --start-y "$sy" --end-x "$ex" --end-y "$ey" --duration 0.2 >/dev/null 2>&1 \
        && ax tap -x "$bx" -y "$by" --tap-style physical >/dev/null 2>&1 \
        || { sim_err SIM_UNAVAILABLE AXE_FAILED "the app switcher gesture failed"; return 1; } ;;
    reboot)
      sim_shutdown
      sim_boot || return 1
      SIM_BOOTED=rebooted ;;
  esac
  SIM_SIGNED=unknown
  SIM_NOTE="killed by $m"
}

sim_to_top() { local i; for i in 1 2 3 4 5 6 7 8; do ax swipe --start-x "$SIM_SCROLL_X" --start-y 250 --end-x "$SIM_SCROLL_X" --end-y $((SIM_H - 74)) --duration 0.15 >/dev/null 2>&1 || true; done; }

sim_nav_probe() {
  local x e
  for x in $SIM_XS_NAV; do
    e="$(sim_point "$x" "$SIM_Y_NAV")" || return 1
    if [ "$(jq -r .role <<<"$e")" = AXLink ] && sim_label_is "$e" "$1"; then SIM_HIT="$e"; return 0; fi
  done
  return 2
}

sim_op_nav() {
  local tab rc
  tab="$(jq -r .tab <<<"$1")"
  sim_in_app || return 1
  sim_to_top
  sim_nav_probe "$tab"; rc=$?
  if [ "$rc" = 2 ]; then
    ax swipe --start-x $((SIM_W - 42)) --start-y "$SIM_Y_NAV" --end-x 40 --end-y "$SIM_Y_NAV" --duration 0.4 >/dev/null 2>&1 || true
    sim_nav_probe "$tab"; rc=$?
  fi
  if [ "$rc" = 2 ]; then
    ax swipe --start-x 40 --start-y "$SIM_Y_NAV" --end-x $((SIM_W - 42)) --end-y "$SIM_Y_NAV" --duration 0.4 >/dev/null 2>&1 || true
    ax swipe --start-x 40 --start-y "$SIM_Y_NAV" --end-x $((SIM_W - 42)) --end-y "$SIM_Y_NAV" --duration 0.4 >/dev/null 2>&1 || true
    sim_nav_probe "$tab"; rc=$?
  fi
  [ "$rc" != 1 ] || return 1
  [ "$rc" = 0 ] || { sim_fail MISS "no $tab tab in the nav row"; return 1; }
  sim_tap_el "$SIM_HIT" || return 1
  sleep 2
  SIM_NOTE="on $tab"
}

sim_op_find() {
  sim_find "$1" || return 1
  sim_read_put "$(jq -r .as <<<"$1")" "$SIM_HIT"
  SIM_NOTE="$(jq -r '"\(.role) at \(.frame.x),\(.frame.y) \(.frame.w)x\(.frame.h)"' <<<"$SIM_HIT")"
}

# The element must not be there: a find that misses passes; any other outcome of the find stands.
sim_op_absent() {
  SIM_DT=""
  if sim_find "$1"; then sim_fail PRESENT "a matching $(jq -r '.role' <<<"$SIM_HIT") is there"; return 1; fi
  [ "$SIM_DT" = MISS ] || return 1
  SIM_ST="" SIM_RS="" SIM_DT="" SIM_NOTE="none there"
}

sim_op_tap() {
  sim_find "$1" || return 1
  if jq -e --argjson deny "$SIM_DENY" '((.label // "") | ascii_downcase | sub("^ +"; "") | sub(" +$"; "")) as $l | $deny | index($l) != null' <<<"$SIM_HIT" >/dev/null; then
    sim_fail DENIED "the match is a write button; not tapped"
    return 1
  fi
  sim_tap_el "$SIM_HIT" || return 1
  if [ "$(jq -r '.as // ""' <<<"$1")" != "" ]; then sim_read_put "$(jq -r .as <<<"$1")" "$SIM_HIT"; fi
  sleep 1
  SIM_NOTE="$(jq -r '"tapped \(.role) at \(.frame.x + (.frame.w / 2 | floor)),\(.frame.y + (.frame.h / 2 | floor))"' <<<"$SIM_HIT")"
}

# The soft keyboard is up when its space bar answers; its accessory bar's top is the line a field must clear.
sim_kb_up() { local e x y; read -r x y <<<"$SIM_PT_SPACE"; e="$(sim_point "$x" "$y")" || return 1; sim_label_is "$e" "space"; }
# No soft keyboard where one is due: the keyboard recipe rests on undocumented iOS prefs, so an Xcode or iOS update
# can break it for every branch at once. That is the environment, not the row: error (needs you), never a fail.
sim_kb_missing() {
  sim_err SIM_UNAVAILABLE KEYBOARD_SETUP "no soft keyboard (prefs $(sim_pref HardwareKeyboardLastSeen)/$(sim_pref AutomaticMinimizationEnabled), $SIM_XCODE) - re-check IOS-CHECK.md Keyboard after an Xcode or iOS update"
}
sim_accessory_top() {
  local e y
  for y in $SIM_YS_ACCESSORY; do
    e="$(sim_point "$SIM_X_DONE" "$y")" || return 1
    if [ "$(jq -r .role <<<"$e")" = AXButton ] && jq -e '(.label // "") | ascii_downcase | test("^(done|previous|next)$")' <<<"$e" >/dev/null; then
      SIM_HIT="$e"
      jq -r '.frame.y' <<<"$e"
      return 0
    fi
  done
  return 2
}

sim_op_expect() {
  local a e r f top bottom w1 w2
  if [ "$(jq -r '.signedIn // false' <<<"$1")" = true ]; then
    case "$SIM_SIGNED" in already | fresh) SIM_NOTE="signed in ($SIM_SIGNED)"; return 0 ;; esac
    sim_fail LANDMARK "not signed in ($SIM_SIGNED)"
    return 1
  fi
  a="$(jq -r .as <<<"$1")"
  r="$(sim_read_get "$a")"
  if jq -e 'has("aboveKeyboard")' <<<"$1" >/dev/null; then
    sim_kb_up || { sim_kb_missing; return 1; }
    top="$(sim_accessory_top)" || { sim_kb_missing; return 1; }
    bottom="$(jq -r '.frame.y + .frame.h' <<<"$r")"
    SIM_NOTE="$a bottom $bottom vs keyboard top $top"
    [ "$bottom" -lt "$top" ] || { sim_fail BELOW_KEYBOARD "$SIM_NOTE"; return 1; }
    return 0
  fi
  if jq -e 'has("sameWidthAs")' <<<"$1" >/dev/null; then
    w1="$(jq -r '.frame.w' <<<"$r")"
    w2="$(sim_read_get "$(jq -r .sameWidthAs <<<"$1")" | jq -r '.frame.w')"
    SIM_NOTE="$a width $w1 vs $w2"
    [ $((w1 - w2)) -le 2 ] && [ $((w2 - w1)) -le 2 ] || { sim_fail WIDTH "$SIM_NOTE"; return 1; }
    return 0
  fi
  # value / label / enabled: read again at the point the element was found.
  e="$(sim_point "$(jq -r '.at.x' <<<"$r")" "$(jq -r '.at.y' <<<"$r")")" || return 1
  sim_read_put "$a" "$e"
  if jq -e 'has("enabled")' <<<"$1" >/dev/null; then
    f="$(jq -r .enabled <<<"$e")"
    SIM_NOTE="$a enabled $f"
    [ "$f" = "$(jq -r .enabled <<<"$1")" ] || { sim_fail ENABLED "$SIM_NOTE"; return 1; }
    return 0
  fi
  f="$(jq -r 'if has("valueIs") then "value" else "label" end' <<<"$1")"
  if jq -e --argjson e "$e" 'if has("valueIs") then ($e.value // "") == .valueIs else ($e.label // "") == .labelIs end' <<<"$1" >/dev/null; then
    SIM_NOTE="$a $f as expected"
    return 0
  fi
  sim_fail VALUE "$a $f differs"
}

# The soft keyboard's keys (part of the device profile).
sim_key_xy() {
  case "$1" in
    q) echo 26 688 ;; w) echo 69 688 ;; e) echo 113 688 ;; r) echo 156 688 ;; t) echo 199 688 ;;
    y) echo 243 688 ;; u) echo 286 688 ;; i) echo 329 688 ;; o) echo 373 688 ;; p) echo 416 688 ;;
    a) echo 48 744 ;; s) echo 91 744 ;; d) echo 134 744 ;; f) echo 178 744 ;; g) echo 221 744 ;;
    h) echo 264 744 ;; j) echo 308 744 ;; k) echo 351 744 ;; l) echo 394 744 ;;
    z) echo 91 800 ;; x) echo 134 800 ;; c) echo 178 800 ;; v) echo 221 800 ;; b) echo 264 800 ;;
    n) echo 308 800 ;; m) echo 351 800 ;; delete) echo 409 800 ;; space) echo 221 856 ;;
  esac
}

# One on-screen key, confirmed by its label first (HID typing would hide the soft keyboard).
sim_key() {
  local k="$1" x y e
  read -r x y < <(sim_key_xy "$k")
  e="$(sim_point "$x" "$y")" || return 1
  sim_label_is "$e" "$k" || { sim_fail MISS "the $k key isn't where the layout puts it"; return 1; }
  ax tap -x "$x" -y "$y" --tap-style physical >/dev/null 2>&1 || { sim_err SIM_UNAVAILABLE AXE_FAILED "key tap failed"; return 1; }
  sleep 0.6
}

sim_op_keys() {
  local text ch i
  text="$(jq -r .text <<<"$1")"
  sim_kb_up || { sim_kb_missing; return 1; }
  i=0
  while [ "$i" -lt "${#text}" ]; do
    ch="${text:$i:1}"
    [ "$ch" != " " ] || ch=space
    sim_key "$ch" || return 1
    i=$((i + 1))
  done
  SIM_NOTE="typed ${#text} keys"
}

sim_op_erase() {
  local n i=0
  n="$(jq -r '.n | floor' <<<"$1")"
  sim_kb_up || { sim_kb_missing; return 1; }
  while [ "$i" -lt "$n" ]; do sim_key delete || return 1; i=$((i + 1)); done
  SIM_NOTE="erased $n"
}

sim_op_blur() {
  local rc
  sim_accessory_top >/dev/null; rc=$?
  [ "$rc" != 1 ] || return 1
  [ "$rc" = 0 ] || { SIM_NOTE="no keyboard to dismiss"; return 0; }
  sim_tap_el "$SIM_HIT" || return 1
  sleep 1
  SIM_NOTE="keyboard dismissed"
}

sim_op_scroll() {
  local pt
  pt="$(jq -r '.pt | floor' <<<"$1")"
  if [ "$(jq -r .dir <<<"$1")" = down ]; then
    ax swipe --start-x "$SIM_SCROLL_X" --start-y 650 --end-x "$SIM_SCROLL_X" --end-y $((650 - pt)) --duration 0.3 >/dev/null 2>&1
  else
    ax swipe --start-x "$SIM_SCROLL_X" --start-y 200 --end-x "$SIM_SCROLL_X" --end-y $((200 + pt)) --duration 0.3 >/dev/null 2>&1
  fi || { sim_err SIM_UNAVAILABLE AXE_FAILED "swipe failed"; return 1; }
  sleep 1
}

sim_op_readBuild() {
  local i y e b
  sim_op_nav '{"op":"nav","tab":"Settings"}' || return 1
  for i in 1 2 3 4 5 6 7 8; do ax swipe --start-x $((SIM_W - 12)) --start-y 700 --end-x $((SIM_W - 12)) --end-y 150 --duration 0.15 >/dev/null 2>&1 || true; done
  b=""
  for y in $SIM_YS_BUILD; do
    e="$(sim_point "$SIM_X_BUILD" "$y")" || return 1
    b="$(jq -r '(.value // "") | select(test("^Build [0-9a-f]{7}$")) | .[6:]' <<<"$e")"
    [ -z "$b" ] || break
  done
  [ -n "$b" ] || { sim_fail MISS "no build stamp at the bottom of Settings"; return 1; }
  echo "$b" >>"$SIM_P.builds"
  sim_op_nav '{"op":"nav","tab":"Home"}' || return 1
  SIM_NOTE="running $b"
}

sim_op_expectBuild() {
  local want got first
  want="$(printf '%s' "$SIM_SHA" | cut -c1-7)"
  got="$(tail -1 "$SIM_P.builds" 2>/dev/null)"
  [ -n "$got" ] || { sim_fail STALE_BUILD "no build read yet"; return 1; }
  if [ "$got" = "$want" ]; then SIM_NOTE="current at first launch ($got)"; return 0; fi
  if [ "$(jq -r '.relaunches // 1 | floor' <<<"$1")" = 1 ]; then
    first="$got"
    sim_op_kill '{"op":"kill","method":"terminate"}' && sim_op_launch && sim_op_readBuild || return 1
    got="$(tail -1 "$SIM_P.builds")"
    if [ "$got" = "$want" ]; then SIM_NOTE="first launch ran $first, second $got"; return 0; fi
  fi
  sim_fail STALE_BUILD "ran build $got, expected $want — rerun"
}

sim_op_shot() {
  local name
  name="$(jq -r .name <<<"$1")"
  SIM_SHOTS=$((SIM_SHOTS + 1))
  rm -f -- "$SIM_P.shot.png"
  ax screenshot --output "$SIM_P.shot.png" >/dev/null 2>&1 && [ -f "$SIM_P.shot.png" ] \
    || { sim_err SIM_UNAVAILABLE AXE_FAILED "screenshot failed"; return 1; }
  name="$(printf '%02d' "$SIM_SHOTS")-$name.png"
  sim_rd "$SIM_P.shot.png" "shots/$name" || { sim_err SIM_UNAVAILABLE RESULT_DIR "could not store the screenshot"; return 1; }
  echo "shots/$name" >>"$SIM_P.shots"
  SIM_NOTE="shots/$name"
}

sim_op_wait() { sleep "$(jq -r '.s | floor' <<<"$1")"; }
sim_op_shutdown() { sim_shutdown; SIM_BOOTED=off; SIM_NOTE="shut down"; }

# --- the run ------------------------------------------------------------------------------------------------------
run_sim() {
  local w="$1" n i op opj t0 status=pass reason=- detail="" started budget caf
  SIM_P="$2"
  SIM_RD="$3"
  SIM_SHA="$(jq -r .params.sha "$w")"
  SIM_U="" SIM_STATE="" SIM_TYPE="" SIM_RUNTIME="" SIM_AXE_OK="" SIM_XCODE="" SIM_HIT="{}" SIM_NOTE=""
  SIM_BOOTED=warm SIM_SIGNED=unknown SIM_SENSITIVE=false SIM_READY="" SIM_SHOTS=0
  SIM_ST="" SIM_RS="" SIM_DT=""
  echo '{}' >"$SIM_P.reads"
  echo 0 >"$SIM_P.probes"
  rm -f -- "$SIM_P.over"
  : >"$SIM_P.steps"
  : >"$SIM_P.builds"
  : >"$SIM_P.shots"
  started="$(date +%s)"
  budget="$(jq -r '.params.timeoutSec | floor' "$w")"
  caffeinate -is -w "$$" >/dev/null 2>&1 &
  caf=$!
  n="$(jq '.params.steps | length' "$w")"
  i=0
  # Every op needs the device; resolve it once up front (launch re-checks it with the rest of the readiness).
  if ! sim_device; then status="$SIM_ST" reason="$SIM_RS" detail="$SIM_DT"; fi
  while [ "$i" -lt "$n" ]; do
    opj="$(jq -c ".params.steps[$i]" "$w")"
    op="$(jq -r .op <<<"$opj")"
    if [ "$status" != pass ]; then
      jq -cn --argjson i "$i" --arg op "$op" '{i: $i, op: $op, status: "skipped", ms: 0}' >>"$SIM_P.steps"
      i=$((i + 1))
      continue
    fi
    t0="$(sim_ms)"
    if [ $(($(date +%s) - started)) -gt "$budget" ]; then
      SIM_ST=error SIM_RS=TIMEOUT SIM_DT="" SIM_NOTE="over the ${budget} s budget"
      status=error
    else
      sim_progress "$i" "$n" "$op"
      touch "$STATE/lock" 2>/dev/null || true # a long job must not look like a stale lock
      SIM_NOTE=""
      if sim_lazy_ready "$op" && "sim_op_$op" "$opj"; then
        status=pass
      else
        [ ! -e "$SIM_P.over" ] || { SIM_ST=error SIM_RS=TIMEOUT SIM_DT=PROBES SIM_NOTE="over $SIM_MAX_PROBES point reads"; }
        status="${SIM_ST:-error}"
      fi
    fi
    jq -cn --argjson i "$i" --arg op "$op" --arg st "$status" --argjson ms "$(($(sim_ms) - t0))" --arg note "$SIM_NOTE" \
      '{i: $i, op: $op, status: $st, ms: $ms} + (if $note == "" then {} else {note: ($note | .[0:240])} end)' >>"$SIM_P.steps"
    if [ "$status" != pass ]; then reason="${SIM_RS:-SIM_UNAVAILABLE}"; detail="$SIM_DT"; fi
    i=$((i + 1))
  done
  if [ "$status" = pass ] && [ -n "$SIM_U" ] && [ "$(jq -r .params.shutdown "$w")" = true ] && [ "$SIM_BOOTED" != off ]; then
    sim_shutdown
    SIM_BOOTED=off
  fi
  kill "$caf" 2>/dev/null || true
  printf '%s %s %s\n' "$status" "$reason" "$(jq -cn --arg detail "$detail" --arg name "$SIM_NAME" --arg udid "$SIM_U" \
    --arg rt "$SIM_RUNTIME" --arg axe "$SIM_AXE_VERSION" --arg xcode "$SIM_XCODE" --arg booted "$SIM_BOOTED" --arg signed "$SIM_SIGNED" \
    --slurpfile steps "$SIM_P.steps" --slurpfile reads "$SIM_P.reads" \
    --rawfile builds "$SIM_P.builds" --rawfile shots "$SIM_P.shots" \
    '{detail: (if $detail == "" then null else $detail end),
      device: {name: $name, udid: (if $udid == "" then null else $udid end), runtime: (if $rt == "" then null else $rt end), axe: $axe,
        xcode: (if $xcode == "" then null else $xcode end)},
      booted: $booted, signedIn: $signed,
      buildsSeen: ($builds | split("\n") | map(select(test("^[0-9a-f]{7}$")))),
      steps: $steps, reads: $reads[0],
      shots: ($shots | split("\n") | map(select(. != "")))}')"
}
