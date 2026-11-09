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
SIM_EMAIL="devcheck@dev.aperture.rahuldatta.dev"
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
# The app's write buttons, refused for `tap` (lowercased: an entry, or an entry and a space). A belt: the boundary is the test user's partition.
SIM_DENY='["save","save log","save task","save idea","mark done","start","stop","delete","complete","export json","generate token","rotate","connect google calendar","sign out","save password","not now","return","add to today","add place","focus","send"]'

# Prints a reason code, or nothing when the plan is good. Same order as sim.ts → validateSimParams.
SIM_JQ='
  def whole($re): type == "string" and (contains("\n") | not) and test($re);
  def int($lo; $hi): type == "number" and . == floor and . >= $lo and . <= $hi;
  def keysok($req; $opt): (keys - $req - $opt) == [] and ($req - keys) == [];
  def text: type == "string" and length <= 200 and (explode | all(. >= 32 and . != 127));
  def lbl: whole("^[A-Za-z0-9 .,:;()/+_&'"'"'?…-]{1,60}$");
  def asname: whole("^[a-z][a-z0-9-]{0,23}$");
  def via: if has("via") then (.via | type == "string" and (. as $v | ["tap","post","hid","batch","batch15"] | index($v)) != null) else true end;
  def role: type == "string" and (. as $r | ["AXButton","AXLink","AXTextArea","AXTextField","AXStaticText","AXCheckBox"] | index($r) != null);
  def where:
    ((has("near")) != (has("scan")))
    and (if has("near") then (.near | type == "object" and keysok(["x","y"]; []) and (.x | int(0; $w)) and (.y | int(0; $h)))
         else (.scan | type == "object" and keysok(["x","from","to"]; []) and (.x | int(0; $w)) and (.from | int(0; $h))
           and (.to | int(0; $h)) and ((((.to - .from) | fabs) / 30 | floor) + 1 <= 20)) end)
    and (if has("radius") then (has("near") and (.radius | int(10; 80))) else true end)
    and (if has("hint") then (has("scan") and (.scan as $s | .hint | type == "object" and keysok(["x","y"]; []) and (.x | int(0; $w)) and (.y | int(0; $h))
      and ((.x - $s.x) | fabs) <= 20 and .y >= ([$s.from, $s.to] | min) and .y <= ([$s.from, $s.to] | max))) else true end)
    and (if has("role") then (.role | role) else true end);
  def opok:
    . as $o | type == "object" and (.op | type) == "string" and
    if (["launch","signIn","blur","shutdown"] | index($o.op)) != null then keysok(["op"]; [])
    elif .op == "readBuild" then keysok(["op"]; ["stay"]) and (if has("stay") then .stay == true else true end)
    elif .op == "kill" then keysok(["op","method"]; []) and (.method == "terminate" or .method == "switcher" or .method == "reboot")
    elif .op == "nav" then keysok(["op","tab"]; []) and (.tab | type == "string") and ($tabs | index($o.tab)) != null
    elif .op == "find" then keysok(["op","label","as"]; ["near","scan","hint","radius","role"]) and (.label | lbl) and (.as | asname) and where
    elif .op == "absent" then keysok(["op","label"]; ["near","scan","radius","role"]) and (.label | lbl) and where
    elif .op == "tap" then keysok(["op","label"]; ["near","scan","hint","radius","role","as","closes"]) and (.label | lbl)
      and (if has("as") then (.as | asname) else true end) and (if has("closes") then .closes == true else true end) and where
    elif .op == "expect" then
      if has("signedIn") then keysok(["op","signedIn"]; []) and .signedIn == true
      else (.as | asname) and (keys | length) == 3 and
        (if has("valueIs") then (.valueIs | text)
         elif has("labelIs") then (.labelIs | text)
         elif has("enabled") then (.enabled | type == "boolean")
         elif has("aboveKeyboard") then .aboveKeyboard == true
         elif has("sameWidthAs") then (.sameWidthAs | asname)
         else false end) end
    elif .op == "keys" then keysok(["op","text"]; ["in","via"]) and (.text | whole("^[a-z ]{1,24}$"))
      and (if has("in") then (.in | asname) else true end) and via
    elif .op == "erase" then keysok(["op","n"]; ["in","via"]) and (.n | int(1; 24)) and (if has("in") then (.in | asname) else true end) and via
    elif .op == "scroll" then keysok(["op","dir","pt"]; []) and (.dir == "up" or .dir == "down") and (.pt | int(100; 600))
    elif .op == "expectBuild" then keysok(["op"]; ["relaunches"]) and (if has("relaunches") then (.relaunches | int(0; 1)) else true end)
    elif .op == "shot" then keysok(["op","name"]; []) and (.name | whole("^[a-z0-9-]{1,32}$"))
    elif .op == "wait" then keysok(["op","s"]; []) and (.s | int(1; 30))
    else false end;
  def denied: .op == "tap" and ((.label | ascii_downcase | sub("^ +"; "") | sub(" +$"; "")) as $l | $deny | any(. as $d | $l == $d or ($l | startswith($d + " "))));
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
            elif ($o.op == "keys" or $o.op == "erase") and ($o | has("in")) then (.def | index($o.in)) != null
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
# through (a background command would otherwise read /dev/null). The watchdog is always the real sleep: the fixtures'
# stub skips short sleeps, and a point read's cap is 8 s.
sim_cap() {
  local cap="$1" pid wd rc
  shift
  "$@" <&0 &
  pid=$!
  (command sleep "$cap" && kill -TERM "$pid" 2>/dev/null) >/dev/null 2>&1 &
  wd=$!
  wait "$pid"
  rc=$?
  pkill -P "$wd" 2>/dev/null || true
  kill "$wd" 2>/dev/null || true
  wait "$wd" 2>/dev/null || true
  if [ "$rc" = 143 ]; then return 124; fi
  return "$rc"
}

# Every tool call refreshes the drain's locks (runner.sh takes a lock older than 15 min, or a fast one older than 5, as
# stale, and a second drain would drive this sim) and stops at the job's deadline: .late becomes TIMEOUT in the run loop,
# however deep the op is. A hand run (no lane) holds both locks, so both are touched (F91); HELD is runner.sh's list.
sim_late() {
  [ -n "${SIM_DEADLINE:-}" ] || return 1
  [ "$(date +%s)" -ge "$SIM_DEADLINE" ] || return 1
  : >"$SIM_P.late"
}
sim_touch() { for l in ${HELD:-lock}; do touch "${STATE:-.}/$l" 2>/dev/null || true; done; }
sim_tick() { sim_touch; }
ax() {
  local cap="${SIM_AX_CAP:-30}" left
  sim_tick
  if sim_late; then return 124; fi
  if [ -n "${SIM_DEADLINE:-}" ]; then
    left=$((SIM_DEADLINE - $(date +%s)))
    [ "$left" -ge "$cap" ] || cap="$left"
  fi
  sim_cap "$cap" axe "$@" --udid "$SIM_U"
}
sx() { local cap="$1"; shift; sim_tick; sim_cap "$cap" xcrun simctl "$@"; }
sim_ms() { jq -nr 'now * 1000 | floor'; }
# The Mac's load averages ("{ 1.20 1.05 0.98 }"), for a trial's record; "-" where there's no such sysctl.
sim_load() { sysctl -n vm.loadavg 2>/dev/null || echo -; }

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
  if sim_late; then return 1; fi
}

# One accessibility read at a point: {role,label,value,id,pid,enabled,frame{x,y,w,h},at{x,y}} or {}. While SIM_SENSITIVE
# (the sign-in form) no value survives: a typed password lives in AXValue, never in a label.
sim_point() {
  local raw rc=0
  sim_probe_budget || return 1
  # 8 s, not ax's 30: a read takes 0.4-0.7 s, ~2 s under load, and a hung one costs its whole cap (job …211837Z…-0239)
  raw="$(SIM_AX_CAP=8 ax describe-ui --point "$1,$2" 2>"$SIM_P.axerr")" || rc=$?
  if [ "$rc" != 0 ]; then # an empty spot errors too ("No translation object"); a hung or lost session is no answer at all
    raw=""
    if [ "$rc" = 124 ] || grep -q -i -e 'timed out' -e 'remote automation' "$SIM_P.axerr" 2>/dev/null; then : >"$SIM_P.unread"; fi
  fi
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

# A hung read answers {}, which isn't "nothing there". Clear the flag before an op's reads; on a negative path,
# `sim_hung_err "<doing what>" && return 1` makes it AX_TIMEOUT (needs you) instead of a false MISS or a wrong row.
sim_hung() { [ -e "$SIM_P.unread" ]; }
sim_hung_err() { sim_hung || return 1; sim_err SIM_UNAVAILABLE AX_TIMEOUT "a point read timed out $1"; return 0; }

# Does element JSON $1 start with label $2 (case-insensitive, label or value) and have role $3 (any when empty)?
sim_match() {
  jq -e --arg l "$2" --arg r "$3" '($l | ascii_downcase) as $w
    | (.role // "") != "" and ($r == "" or .role == $r)
    and ([.label // "", .value // ""] | map(ascii_downcase | sub("^\\s+"; "")) | any(startswith($w)))' <<<"$1" >/dev/null 2>&1
}

sim_label_is() { jq -e --arg l "$2" '((.label // "") | ascii_downcase) == ($l | ascii_downcase)' <<<"$1" >/dev/null 2>&1; }

# The full tree's app: "Web" while the Home Screen web app is in front. The first reads after a boot can time out
# ("creating the simulator remote automation session": four in a row before a fifth worked): up to eight tries.
sim_tree() {
  local t i
  for i in 1 2 3 4 5 6 7 8; do
    if sim_late; then return 1; fi
    if t="$(ax describe-ui 2>/dev/null)"; then printf '%s' "$t"; return 0; fi
    [ "$i" = 8 ] || sleep 2
  done
  return 1
}
# Not in front is the row's failure; an unreadable tree is the sim's (needs you).
sim_in_app() {
  local t
  t="$(sim_tree)" || { sim_err SIM_UNAVAILABLE AX_TIMEOUT "describe-ui timed out eight times"; return 1; }
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

# Probe points for a find/tap op, nearest first: a 30-pt grid within `radius` of `near`, or a straight `scan` — after
# its `hint`, where a passing run found the element: a hit there saves the scan, a miss costs one read and scans as ever.
sim_points() {
  jq -r --argjson w "$SIM_W" --argjson h "$SIM_H" '(if has("hint") then "\(.hint.x | floor) \(.hint.y | floor)" else empty end), if has("near") then ((.radius // 40) / 30 | floor) as $k | [range(-$k; $k + 1) * 30] as $o | .near as $n
      | [$o[] as $dx | $o[] as $dy | {d: ($dx * $dx + $dy * $dy), x: ($n.x + $dx), y: ($n.y + $dy)}] | sort_by(.d) | .[]
      | select(.x >= 0 and .x <= $w and .y >= 0 and .y <= $h) | "\(.x | floor) \(.y | floor)"
    else .scan as $s | (if $s.to >= $s.from then range($s.from; $s.to + 1; 30) else range($s.from; $s.to - 1; -30) end)
      | "\($s.x | floor) \(. | floor)" end' <<<"$1"
}

# SIM_HIT ← the first element matching the op's label (and role); a miss names what it saw instead.
sim_find() {
  local op="$1" label role x y e seen="" hint
  label="$(jq -r .label <<<"$op")"
  hint="$(jq -r 'has("hint")' <<<"$op")"
  role="$(jq -r '.role // ""' <<<"$op")"
  sim_in_app || return 1
  rm -f "$SIM_P.unread"
  while read -r x y; do
    e="$(sim_point "$x" "$y")" || return 1
    if sim_match "$e" "$label" "$role"; then
      SIM_HIT="$e"
      return 0
    fi
    # the label, or the value when there is none (typed text is an unlabelled AXStaticText); a role the op excluded is named
    seen="$seen$(jq -r '(if (.label // "") != "" then .label else (.value // "") end) | gsub("[^A-Za-z0-9 .,:;()/+_&?-]"; "") | .[0:24]' <<<"$e")"
    if [ -n "$role" ] && sim_match "$e" "$label" ""; then seen="$seen ($(jq -r '.role' <<<"$e"))"; fi
    seen="$seen|"
    # a hung hint read is no evidence either way (the scan covers its spot), so only the scan's own reads decide AX_TIMEOUT
    if [ "$hint" = true ]; then hint=false; rm -f "$SIM_P.unread"; fi
  done < <(sim_points "$op")
  sim_hung_err "looking for \"$label\"" && return 1
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
    | "\(.udid) \(.state | gsub(" "; "_")) \(.deviceTypeIdentifier // "-") \($rt | sub(".*SimRuntime\\."; "") | sub("-"; " ") | gsub("-"; "."))"' <<<"$list")
  [[ "$SIM_U" =~ ^[0-9A-F-]{36}$ ]] || { sim_err SIM_UNAVAILABLE SIM_MISSING "bad udid"; return 1; }
  [ "$SIM_TYPE" = "$SIM_DEVICE_TYPE" ] || {
    sim_err SIM_UNAVAILABLE PROFILE_MISMATCH "the sim is ${SIM_TYPE##*.}, the profile ${SIM_DEVICE_TYPE##*.} (IOS-CHECK.md -> Device profile)"
    return 1
  }
}

sim_boot() { sx 90 bootstatus "$SIM_U" -b >/dev/null 2>&1 || { sim_err SIM_UNAVAILABLE BOOT_FAILED "bootstatus failed or took over 90 s"; return 1; }; SIM_STATE=Booted; }
# simctl refuses a sim that is off or on its way there, so only a booted or booting one is asked; any other refusal
# is the caller's to report.
sim_shutdown() {
  case "$SIM_STATE" in Booted | Booting) ;; *) return 0 ;; esac
  sx 30 shutdown "$SIM_U" >/dev/null 2>&1 || { sim_err SIM_UNAVAILABLE SHUTDOWN_FAILED "simctl shutdown failed"; return 1; }
  SIM_STATE=Shutdown
}
sim_pref() { sx 30 spawn "$SIM_U" defaults read "$SIM_KB" "$1" 2>/dev/null | tr -d '[:space:]'; }
# Everything that changes what a key does or when it lands is pinned (the maintainer, 2026-11-08: typing must be as repeatable as it can be made;
# job …233129Z…-done-form-80c5 typed "cdcgac" three times and kept "Cdc"): autocorrect, auto-capitalisation, spell check,
# predictions and the suggestion bar, inline completion, the "." shortcut, smart quotes and dashes, slide to type, the
# hardware keyboard's own three, and the slide-to-type, gesture and inline-completion tips marked seen. Keys from
# pest-plugin-simulator PR 32 (iOS 26.5) and WDA; seen to reach the web app on 2026-11-08 (typed text no longer capitalised,
# no suggestion bar). IOS-CHECK.md → Keyboard lists what can't be pinned.
SIM_KB_OFF="KeyboardAutocorrection KeyboardAutocapitalization KeyboardCheckSpelling KeyboardPrediction KeyboardShowPredictionBar KeyboardInlineCompletion KeyboardPeriodShortcut SmartQuotesEnabled SmartDashesEnabled KeyboardContinuousPathEnabled HWKeyboardAutocorrection HWKeyboardAutocapitalization HWKeyboardPeriodShortcut"
SIM_KB_ON="DidShowContinuousPathIntroduction DidShowGestureKeyboardIntroduction DidShowInlineCompletionEducationTip"

# The pinned keys a `defaults export` plist ($1) doesn't hold at their value, space-separated ("" when all are pinned).
sim_kb_unpinned() {
  local tags k v want out=""
  tags="$(tr -d ' \t\r\n' <"$1" | awk '{gsub(/></, ">\n<"); print}')"
  for k in $SIM_KB_OFF $SIM_KB_ON; do
    v="$(awk -v k="<key>$k</key>" 'f { print; exit } $0 == k { f = 1 }' <<<"$tags")"
    case " $SIM_KB_ON " in *" $k "*) want=1 ;; *) want=0 ;; esac
    case "$want:$v" in 0:"<false/>" | 0:"<integer>0</integer>" | 1:"<true/>" | 1:"<integer>1</integer>") ;; *) out="$out $k" ;; esac
  done
  printf '%s' "${out# }"
}

# A precondition, read back every readiness check: anything not pinned is written (all of it), the web app is quit so
# its next launch reads them, and a second read must find them pinned, else KEYBOARD_SETUP (needs you, loudly).
sim_kb_pin() {
  local bad k
  SIM_KB_SET=""
  sx 30 spawn "$SIM_U" defaults export "$SIM_KB" - >"$SIM_P.kb" 2>/dev/null || : >"$SIM_P.kb"
  bad="$(sim_kb_unpinned "$SIM_P.kb")"
  [ -n "$bad" ] || return 0
  for k in $SIM_KB_OFF; do sx 30 spawn "$SIM_U" defaults write "$SIM_KB" "$k" -bool false >/dev/null 2>&1 || true; done
  for k in $SIM_KB_ON; do sx 30 spawn "$SIM_U" defaults write "$SIM_KB" "$k" -bool true >/dev/null 2>&1 || true; done
  sx 30 terminate "$SIM_U" "$SIM_TERMINATE_ID" >/dev/null 2>&1 || true
  SIM_KB_WROTE=1
  sx 30 spawn "$SIM_U" defaults export "$SIM_KB" - >"$SIM_P.kb" 2>/dev/null || : >"$SIM_P.kb"
  k="$(sim_kb_unpinned "$SIM_P.kb")"
  if [ -n "$k" ]; then
    sim_err SIM_UNAVAILABLE KEYBOARD_SETUP "keyboard prefs didn't take: $k ($SIM_XCODE) - re-check IOS-CHECK.md Keyboard after an Xcode or iOS update"
    return 1
  fi
  SIM_KB_SET="$(printf '%s' "$bad" | wc -w | tr -d ' ')"
}
# The soft keyboard (IOS-CHECK.md → Keyboard): both prefs 0, applied only at boot; HID typing flips them back to 1.
sim_arm() {
  sx 30 spawn "$SIM_U" defaults write "$SIM_KB" HardwareKeyboardLastSeen -bool false >/dev/null 2>&1 \
    && sx 30 spawn "$SIM_U" defaults write "$SIM_KB" AutomaticMinimizationEnabled -bool false >/dev/null 2>&1 \
    || { sim_err SIM_UNAVAILABLE BOOT_FAILED "could not write the keyboard prefs"; return 1; }
  sim_shutdown || return 1
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
  sim_kb_pin || return 1
  sim_tree >/dev/null || { sim_err SIM_UNAVAILABLE AX_TIMEOUT "describe-ui timed out eight times"; return 1; }
  SIM_READY=1
}

# A plan that doesn't open with launch carries on from the last job's screen; it still gets the readiness checks,
# and if they had to boot the sim there is nothing open to carry on from.
sim_lazy_ready() {
  case "$1" in launch | shutdown | wait | kill) return 0 ;; esac
  [ -z "$SIM_READY" ] || return 0
  sim_ready || return 1
  [ "$SIM_BOOTED" = warm ] && [ -z "$SIM_KB_WROTE" ] || { sim_err SIM_UNAVAILABLE NOT_LAUNCHED "the sim was off, rebooted to re-arm the keyboard, or its keyboard prefs were just pinned (the app quit); this plan needs a launch first"; return 1; }
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

# The icon from the full tree, and only with the pill reading page 2: page 1 has a widget where page 2 has the icon, and
# --point can't confirm it (it names a neighbouring icon inside this frame: profile.md, P12 finding 1). Scrolls only on
# an explicit page 1: past the last page is the App Library. No pill is a stale tree (root Safari after Safari ran, P12).
sim_icon_in() {
  jq -c --argjson w "$SIM_W" --argjson h "$SIM_H" '[.. | objects | select(.AXLabel? == "Aperture" and .role? == "AXButton")
    | (.frame // {}) | {x: ((.x // 0) | floor), y: ((.y // 0) | floor), w: ((.width // 0) | floor), h: ((.height // 0) | floor)}
    | select(.w > 0 and .h > 0 and .x >= 0 and .x + .w <= $w and .y >= 0 and .y + .h <= $h)][0] // empty
    | {role: "AXButton", label: "Aperture", frame: .}' <<<"$1" 2>/dev/null
}
sim_icon_count() {
  jq --argjson w "$SIM_W" --argjson h "$SIM_H" '[.. | objects | select(.AXLabel? == "Aperture" and .role? == "AXButton")
    | select((.frame.width // 0) > 0 and (.frame.height // 0) > 0 and (.frame.x // -1) >= 0 and (.frame.x + .frame.width) <= $w and (.frame.y // -1) >= 0 and (.frame.y + .frame.height) <= $h)] | length' <<<"$1" 2>/dev/null
}
sim_find_icon() {
  local t page app="" i e prev="" scrolled=""
  SIM_ICON=""
  SIM_PRESSES=1 # the caller's
  for i in 1 2 3 4 5 6; do
    t="$(sim_tree)" || { sim_err SIM_UNAVAILABLE AX_TIMEOUT "describe-ui timed out eight times"; return 1; }
    page="$(jq -r 'first(.. | objects | .AXValue? | select(type == "string" and test("^Page [0-9]+ of [0-9]+$"))) // ""' <<<"$t" 2>/dev/null)"
    case "$page" in
      "Page 2 of 2")
        e="$(sim_icon_in "$t")" || true
        [ -n "$e" ] || break
        if [ "$(sim_icon_count "$t")" != 1 ]; then
          sim_err SIM_UNAVAILABLE WEBCLIP_MISSING "more than one Aperture icon on Home Screen page 2; remove the extra one by hand"
          return 1
        fi
        if [ "$e" = "$prev" ]; then SIM_ICON="$e"; return 0; fi # two reads agree
        prev="$e"
        sleep 1
        ;;
      "Page 1 of 2")
        prev=""
        if [ -z "$scrolled" ]; then
          ax gesture scroll-left --screen-width "$SIM_W" --screen-height "$SIM_H" >/dev/null 2>&1 || true
          scrolled=1
        fi
        sleep 1
        ;;
      "")
        # No Home Screen: a press AXe reported done can be one iOS never got (job …192707Z…-relaunch-bd33 left the app
        # in front), so press again, three presses in all; another app in front with no pill is a stale tree.
        prev=""
        app="$(jq -r '[.. | objects | select(.role? == "AXApplication")][0].AXLabel // ""' <<<"$t" 2>/dev/null)"
        if [ "$SIM_PRESSES" -lt 3 ]; then
          ax batch --step "button home" --step "sleep 1" >/dev/null 2>&1 || true
          SIM_PRESSES=$((SIM_PRESSES + 1))
        else
          sleep 2
        fi
        ;;
      *) break ;;
    esac
  done
  if [ -z "$page" ] && [ "$app" = Web ]; then
    sim_fail HOME_PRESS_DROPPED "the app is still in front after $SIM_PRESSES home presses AXe reported done: iOS dropped the input; rerun the step, don't debug the app"
    return 1
  fi
  if [ -z "$page" ]; then sim_err SIM_UNAVAILABLE HOME_TREE_STALE "no page pill, ${app:-no app} in front after $SIM_PRESSES home presses; reboot the sim (IOS-CHECK.md -> Failures)"; return 1; fi
  sim_err SIM_UNAVAILABLE WEBCLIP_MISSING "no on-screen Aperture icon on Home Screen page 2 (found: $page); add dev to the sim's Home Screen"
}

# --- ops ----------------------------------------------------------------------------------------------------------
# An aborted job can leave the app mid-typing (job …043422Z…-trial-idle-2: a hung read in `keys` left the bar focused,
# the keyboard up and an edit menu over it), and launch resumes that state, so neither landmark ever shows (the next
# five jobs failed LANDMARK). Terminate it, read back that it's gone, and open it again from the icon; once.
# simctl refuses to terminate an app that isn't running (mac-sim's idle4 round), so only a running one is terminated.
sim_launch_again() {
  if sim_web_alive; then
    sx 30 terminate "$SIM_U" "$SIM_TERMINATE_ID" >/dev/null 2>&1 || { sim_err SIM_UNAVAILABLE TERMINATE "simctl terminate failed"; return 1; }
    ! sim_web_alive || sleep 1 # the process takes a moment to exit (as after the switcher's swipe)
    if sim_web_alive; then sim_err SIM_UNAVAILABLE TERMINATE "the web app still runs after terminate"; return 1; fi
  else
    SIM_AGAIN_DEAD="; no web process though the tree showed the app, so not terminated"
  fi
  ax batch --step "button home" --step "sleep 1" >/dev/null 2>&1 || true
  sim_find_icon || return 1
  sim_tap_el "$SIM_ICON"
}

# A leftover draft (job …060606Z…-idle5-1 stopped mid-keys and never erased) changes how the bar reads: empty label, the
# draft as its value (peek jobs …062810Z… and …062816Z…), never "Capture log", so neither landmark shows (idle5-2..4
# failed LANDMARK). Is element $1 that: no label, some text, on the bar's row?
sim_draft_el() {
  jq -e --argjson x "$SIM_X" '(.label // "") == "" and (.value // "") != "" and ((.role // "") | IN("AXButton", "AXLink") | not)
    and (.frame.y // 0) >= 850 and (.frame.y // 0) <= 930 and (.frame.x // 0) <= $x and ((.frame.x // 0) + (.frame.w // 0)) >= $x' <<<"$1" >/dev/null 2>&1
}
# Focus it, delete it (its length plus two), put the keyboard down. No read-back here: the landmark loop is it — the bar
# reads "Capture log" again only once it's empty. No keyboard after the tap leaves the draft for the polls to fail on.
sim_clear_draft() {
  local n i=0
  n="$(jq -r '(.value // "") | length + 2 | if . > 24 then 24 else . end' <<<"$1")"
  sim_tap_el "$1" || return 1
  sleep 1
  if ! sim_kb_up; then
    sim_hung_err "looking for the keyboard after tapping a leftover draft" && return 1
    SIM_DRAFT_TRY=" (a leftover draft in the bar; tapping it brought no keyboard, so nothing was deleted)"
    return 0
  fi
  while [ "$i" -lt "$n" ]; do sim_key delete || return 1; i=$((i + 1)); done
  sim_op_blur || return 1
  if sim_kb_up; then sim_fail BLUR "the keyboard stayed up after deleting a leftover draft"; return 1; fi
  sim_hung_err "checking the keyboard went down after deleting a leftover draft" && return 1
  SIM_DRAFT_DEL="$n"
  SIM_DRAFT_TRY=" (a leftover draft in the bar; $n deletes didn't bring Home's bar back)"
}

sim_op_launch() {
  local i s t e clean="" taps=1 again="" cleared=""
  SIM_AGAIN_DEAD="" SIM_DRAFT_DEL="" SIM_DRAFT_TRY=""
  sim_ready || return 1
  ax batch --step "button home" --step "sleep 1" >/dev/null 2>&1 || true
  sim_find_icon || return 1
  sim_tap_el "$SIM_ICON" || return 1
  i=0
  while :; do
    rm -f "$SIM_P.unread"
    s="$(sim_landmark)" || return 1
    [ -e "$SIM_P.unread" ] || clean=1 # at least one pass read every point and got an answer
    if [ -n "$s" ]; then
      SIM_SIGNED="$s"
      SIM_NOTE="signed in: $s; booted $SIM_BOOTED"
      [ "${SIM_PRESSES:-1}" -le 1 ] || SIM_NOTE="$SIM_NOTE; home pressed $SIM_PRESSES times"
      [ "$taps" -le 1 ] || SIM_NOTE="$SIM_NOTE; icon tapped $taps times"
      [ -z "${SIM_KB_SET:-}" ] || SIM_NOTE="$SIM_NOTE; pinned the keyboard prefs ($SIM_KB_SET off)"
      [ -z "$again" ] || SIM_NOTE="$SIM_NOTE; relaunched (it resumed mid-typing, keyboard up$SIM_AGAIN_DEAD)"
      [ -z "$SIM_DRAFT_DEL" ] || SIM_NOTE="$SIM_NOTE; deleted a leftover draft in the bar ($SIM_DRAFT_DEL deletes)"
      return 0
    fi
    i=$((i + 1))
    if [ "$i" -ge 20 ]; then
      if [ -z "$clean" ]; then # every pass had a read hang: that saw nothing, which isn't the page being wrong
        sim_err SIM_UNAVAILABLE AX_TIMEOUT "point reads timed out looking for Home or the sign-in card"
        return 1
      fi
      # Still the Home Screen after every tap is AXe's taps dropped (job …223625Z…-relaunch-07aa), not the app.
      if t="$(sim_tree)" && sim_tree_home "$t"; then
        sim_fail ICON_TAP_DROPPED "still the Home Screen after $taps icon taps AXe reported done: iOS dropped the input; rerun the step, don't debug the app"
        return 1
      fi
      sim_fail LANDMARK "neither Home nor the sign-in card after launch$SIM_DRAFT_TRY"
      return 1
    fi
    case "$i" in
      3 | 6 | 10)
        # Read back the icon tap: still the Home Screen means it dropped, so tap again (a swipe there opens Search), up
        # to four taps. In the app, the page can draw offset from its accessibility frames after a kill: at 10, nudge it.
        # An unreadable tree does neither.
        t="$(sim_tree)" || t=""
        if [ -n "$t" ] && sim_tree_home "$t"; then
          sim_tap_el "$SIM_ICON" || return 1
          taps=$((taps + 1))
        elif [ -z "$again" ] && [ -n "$t" ] && jq -e '[.. | objects | select(.role? == "AXApplication")][0].AXLabel == "Web"' <<<"$t" >/dev/null 2>&1 \
          && sim_kb_up; then
          sim_launch_again || { SIM_NOTE="${SIM_NOTE:-$SIM_DT} (in launch's relaunch of an app left mid-typing)"; return 1; }
          again=1 i=0 clean="" taps=1
          sleep 2
          continue
        elif [ -z "$cleared" ] && [ -n "$t" ] && jq -e '[.. | objects | select(.role? == "AXApplication")][0].AXLabel == "Web"' <<<"$t" >/dev/null 2>&1 \
          && e="$(sim_point "$SIM_X" "$SIM_Y_HOME")" && sim_draft_el "$e"; then
          cleared=1
          sim_clear_draft "$e" || { SIM_NOTE="${SIM_NOTE:-$SIM_DT} (in launch's delete of a leftover draft)"; return 1; }
          i=0 clean=""
          sleep 2
          continue
        elif [ "$i" = 10 ] && [ -n "$t" ] && jq -e '[.. | objects | select(.role? == "AXApplication")][0].AXLabel == "Web"' <<<"$t" >/dev/null 2>&1; then
          ax swipe --start-x "$SIM_SCROLL_X" --start-y 450 --end-x "$SIM_SCROLL_X" --end-y 250 --duration 0.2 >/dev/null 2>&1 || true
          ax swipe --start-x "$SIM_SCROLL_X" --start-y 250 --end-x "$SIM_SCROLL_X" --end-y 450 --duration 0.2 >/dev/null 2>&1 || true
        fi
        ;;
    esac
    sleep 2
  done
}

# Is tree $1 the Home Screen: not the web app, with the page pill?
sim_tree_home() {
  jq -e '([.. | objects | select(.role? == "AXApplication")][0].AXLabel // "") != "Web"
    and any(.. | objects | .AXValue?; type == "string" and test("^Page [0-9]+ of [0-9]+$"))' <<<"$1" >/dev/null 2>&1
}

# Is the front sheet dev's Cognito? Read from the sheet's own address bar: native chrome (role, id "URL"), owned
# by another process than the page ($1, the Sign in button's pid), so the page can't draw a lookalike
# (IOS-CHECK.md → Sign-in).
sim_on_cognito() {
  local e x y v
  read -r x y <<<"$SIM_PT_ADDRESS"
  e="$(SIM_SENSITIVE=false && sim_point "$x" "$y")" || return 1
  jq -e --argjson app "${1:-null}" --argjson bar "${2:-null}" --argjson form "${3:-null}" '.role == "AXGenericElement" and .id == "URL" and .label == "Address"
    and $app != null and .pid != null and .pid != $app
    and ($bar == null or .pid == $bar) and ($form == null or .pid != $form)' <<<"$e" >/dev/null 2>&1 || return 1
  SIM_BAR_PID="$(jq -c .pid <<<"$e")"
  v="$(jq -r '.value // "" | gsub("^[\u200e\u200f\u202a-\u202e\u2066-\u2069]+"; "")' <<<"$e")" # a leading LRM
  [[ "$v" =~ $SIM_COGNITO_RE ]]
}

# Tap a sign-in field until it has focus: the form zooms when one does, so a moved frame is the proof. A tap can be
# dropped silently (profile.md surprise 5), so one retap, then FORM_CHANGED.
sim_focus_field() {
  local e="$1" pt n i
  for i in 1 2; do
    sim_tap_el "$e" || return 1
    sleep 1
    for pt in $SIM_YS_EMAIL; do # the zoom moves the field off the point it was found at
      n="$(sim_point "$SIM_X" "$pt")" || return 1
      if sim_match "$n" "$2" "" && ! jq -e --argjson a "$e" '.frame == $a.frame' <<<"$n" >/dev/null 2>&1; then return 0; fi
    done
  done
  sim_err SIGNIN_FAILED FORM_CHANGED "the $2 field never took focus"
}

# Prove the focus is in Password before any secret moves: the tree marks no focus between fields (profile.md, P12) and a
# dropped tap would type the password into Email, in clear. One harmless key first: it must reach Password as a single
# bullet with Email unchanged, and delete must empty the field again. These reads carry no secret: only the x was typed.
# --duration matters: a bare `axe key` exits 0 and did nothing here (profile.md, P13 and P14).
sim_pw_focused() {
  local pf="$1" ef="$2" px py ex ey p m i
  read -r px py < <(jq -r '.at | "\(.x) \(.y)"' <<<"$pf")
  read -r ex ey < <(jq -r '.at | "\(.x) \(.y)"' <<<"$ef")
  for i in 1 2; do
    sim_tap_el "$pf" || return 1
    sleep 1
    ax key 27 --duration 0.2 >/dev/null 2>&1 || { sim_err SIM_UNAVAILABLE AXE_FAILED "typing failed"; return 1; }
    sleep 1
    p="$(SIM_SENSITIVE=false && sim_point "$px" "$py")" || return 1
    m="$(SIM_SENSITIVE=false && sim_point "$ex" "$ey")" || return 1
    if jq -e '.value == "•"' <<<"$p" >/dev/null 2>&1 && jq -e --arg v "$SIM_EMAIL" '.value == $v' <<<"$m" >/dev/null 2>&1; then
      ax key 42 --duration 0.2 >/dev/null 2>&1 || { sim_err SIM_UNAVAILABLE AXE_FAILED "typing failed"; return 1; }
      sleep 1
      p="$(SIM_SENSITIVE=false && sim_point "$px" "$py")" || return 1
      jq -e '.value == "Password"' <<<"$p" >/dev/null 2>&1 && return 0
      sim_err SIGNIN_FAILED FORM_CHANGED "the Password field didn't empty"
      return 1
    fi
    if ! jq -e --arg v "$SIM_EMAIL" '.value == $v' <<<"$m" >/dev/null 2>&1; then ax key 42 --duration 0.2 >/dev/null 2>&1 || true; fi
    sleep 1
  done
  sim_err SIGNIN_FAILED FORM_CHANGED "the Password field never took focus"
}

# A failure after the first tap leaves the sheet up, maybe the filled form: gone before the next op can read or shoot it.
sim_op_signIn() {
  local rc=0
  SIM_SHEET=""
  sim_sign_in "$@" || rc=$?
  if [ "$rc" != 0 ] && [ -n "$SIM_SHEET" ]; then
    SIM_SENSITIVE=false
    sx 30 terminate "$SIM_U" "$SIM_TERMINATE_ID" >/dev/null 2>&1 || true
  fi
  return "$rc"
}
sim_sign_in() {
  local e ef fp n pf pt i s app clean pass x y
  if [ "$SIM_SIGNED" != false ]; then SIM_NOTE="already signed in"; return 0; fi
  sim_cap 30 security find-generic-password -s "$SIM_KEYCHAIN" -a "$SIM_EMAIL" >/dev/null 2>&1 \
    || { sim_err PASSWORD_MISSING "" "no readable Keychain item $SIM_KEYCHAIN"; return 1; }
  e="$(sim_point "$SIM_X" "$SIM_Y_SIGNIN")" || return 1
  sim_label_is "$e" "Sign in" || { sim_err SIGNIN_FAILED FORM_CHANGED "no Sign in button"; return 1; }
  app="$(jq -c '.pid' <<<"$e")"
  SIM_SHEET=1
  for i in 1 2; do # a tap can drop silently (reported fine, the card still there 8 s later); tapping again is safe
    sim_tap_el "$e" || return 1
    sleep 3
    n="$(sim_point "$SIM_X" "$SIM_Y_SIGNIN")" || return 1
    sim_label_is "$n" "Sign in" && jq -e --argjson a "$app" '.pid == $a' <<<"$n" >/dev/null 2>&1 || break
  done
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
  # The form zooms on focus, so both fields are found again.
  for pt in $SIM_YS_EMAIL; do
    ef="$(sim_point "$SIM_X" "$pt")" || return 1
    sim_match "$ef" "Email" "AXTextField" && break
    ef=""
  done
  [ -n "$ef" ] || { SIM_SENSITIVE=false; sim_err SIGNIN_FAILED FORM_CHANGED "no Email field"; return 1; }
  for pt in $SIM_YS_PASSWORD; do
    e="$(sim_point "$SIM_X" "$pt")" || return 1
    if jq -e '.role == "AXTextField" or .role == "AXSecureTextField"' <<<"$e" >/dev/null && sim_match "$e" "Password" ""; then break; fi
    e=""
  done
  [ -n "$e" ] || { SIM_SENSITIVE=false; sim_err SIGNIN_FAILED FORM_CHANGED "no Password field"; return 1; }
  pf="$e"
  sim_pw_focused "$pf" "$ef" || { SIM_SENSITIVE=false; return 1; }
  # Again just before the password: the form flow ran since the first check.
  # The same bar as before, and not the form's own process: a full page drawn at another origin has one pid for both.
  fp="$(jq -c .pid <<<"$pf")"
  if [ "$fp" = null ] || ! sim_on_cognito "$app" "$SIM_BAR_PID" "$fp"; then
    SIM_SENSITIVE=false
    sim_err SIGNIN_FAILED COGNITO_HOST "the sign-in page isn't dev's Cognito"
    return 1
  fi
  if ! sim_cap 30 security find-generic-password -s "$SIM_KEYCHAIN" -a "$SIM_EMAIL" -w 2>/dev/null | tr -d '\n' | ax type --stdin >/dev/null 2>&1; then
    SIM_SENSITIVE=false
    sim_err PASSWORD_MISSING "" "the Keychain read or the typing failed"
    return 1
  fi
  e=""
  for pt in $SIM_YS_SUBMIT; do
    # never a read inside the filled password field (its value would carry the password's length)
    if jq -e --argjson y "$pt" '.frame.y <= $y and $y <= .frame.y + .frame.h' <<<"$pf" >/dev/null 2>&1; then continue; fi
    e="$(sim_point "$SIM_X" "$pt")" || return 1
    if [ "$(jq -r .role <<<"$e")" = AXButton ] && sim_label_is "$e" "submit"; then break; fi
    e=""
  done
  [ -n "$e" ] || { SIM_SENSITIVE=false; sim_err SIGNIN_FAILED FORM_CHANGED "no submit button"; return 1; }
  sim_tap_el "$e" 2 || { SIM_SENSITIVE=false; return 1; }
  # A dropped submit tap reads like a wrong password: when the same form's submit button is still there, tap it once more.
  clean=""
  s=""
  for pass in 1 2; do
    i=0
    while [ "$i" -lt 12 ]; do
      rm -f "$SIM_P.unread"
      s="$(sim_landmark)" || { SIM_SENSITIVE=false; return 1; }
      [ -e "$SIM_P.unread" ] || clean=1
      [ "$s" != already ] || break 2
      i=$((i + 1))
      sleep 2
    done
    [ "$pass" = 1 ] || break
    read -r x y < <(jq -r '.at | "\(.x) \(.y)"' <<<"$e")
    rm -f "$SIM_P.unread"
    n="$(sim_point "$x" "$y")" || { SIM_SENSITIVE=false; return 1; }
    sim_hung_err "re-reading the submit button" && { SIM_SENSITIVE=false; return 1; }
    [ "$(jq -r .role <<<"$n")" = AXButton ] && sim_label_is "$n" "submit" && jq -e --argjson p "$fp" '.pid == $p' <<<"$n" >/dev/null 2>&1 || break
    sim_tap_el "$n" 2 || { SIM_SENSITIVE=false; return 1; }
  done
  if [ "$s" != already ]; then
    SIM_SENSITIVE=false
    if [ -z "$clean" ]; then sim_err SIM_UNAVAILABLE AX_TIMEOUT "point reads timed out looking for Home after submit"; return 1; fi
    sim_err SIGNIN_FAILED AUTH_REJECTED "still not on Home after submit"
    return 1
  fi
  SIM_SENSITIVE=false
  e="$(sim_point "$SIM_X" "$SIM_Y_NEVER")" || return 1
  if sim_label_is "$e" "Never for This Website"; then sim_tap_el "$e" || return 1; fi
  # HID typing flipped the keyboard prefs back: re-arm, reboot, relaunch.
  sim_arm || return 1
  sim_op_launch || return 1
  # The session should survive a restart, so this is the row's failure, not the environment's; the card can show for a
  # moment before the tokens are restored (inference), so give it a few reads first.
  clean=""
  i=0
  while [ "$SIM_SIGNED" != already ] && [ "$i" -lt 5 ]; do
    sleep 2
    rm -f "$SIM_P.unread"
    s="$(sim_landmark)" || return 1
    [ -e "$SIM_P.unread" ] || clean=1
    [ "$s" != already ] || SIM_SIGNED=already
    i=$((i + 1))
  done
  if [ "$SIM_SIGNED" != already ] && [ -z "$clean" ]; then # reads that all hung aren't "signed out"
    sim_err SIM_UNAVAILABLE AX_TIMEOUT "a point read timed out looking for Home after the reboot"
    return 1
  fi
  [ "$SIM_SIGNED" = already ] || { sim_fail LANDMARK "signed out again after the reboot"; return 1; }
  SIM_SIGNED=fresh
  SIM_NOTE="signed in fresh; rebooted to re-arm the keyboard"
}

sim_op_kill() {
  local m
  m="$(jq -r .method <<<"$1")"
  SIM_NOTE=""
  case "$m" in
    terminate) sx 30 terminate "$SIM_U" "$SIM_TERMINATE_ID" >/dev/null 2>&1 || { sim_err SIM_UNAVAILABLE TERMINATE "simctl terminate failed"; return 1; } ;;
    switcher) sim_kill_switcher || return 1 ;;
    reboot)
      sim_shutdown || return 1
      sim_boot || return 1
      SIM_BOOTED=rebooted ;;
  esac
  SIM_SIGNED=unknown
  SIM_NOTE="killed by $m; web: $(sim_web_alive && echo alive || echo gone)$SIM_NOTE"
}

# The standalone web app's process, by name (a backgrounded app is still running; a killed one is gone).
sim_web_alive() { pgrep -f 'RuntimeRoot/Applications/Web.app/Web' >/dev/null 2>&1; }

# What one tree read shows in front: SIM_FRONT_APP (the first AXApplication's label) and SIM_FRONT_PAGE (the Home
# Screen's "Page N of M" pill, or "").
sim_front() {
  local t
  t="$(sim_tree)" || { sim_err SIM_UNAVAILABLE AX_TIMEOUT "describe-ui timed out eight times"; return 1; }
  SIM_FRONT_APP="$(jq -r '[.. | objects | select(.role? == "AXApplication")][0].AXLabel // ""' <<<"$t" 2>/dev/null)"
  SIM_FRONT_PAGE="$(jq -r 'first(.. | objects | .AXValue? | select(type == "string" and test("^Page [0-9]+ of [0-9]+$"))) // ""' <<<"$t" 2>/dev/null)"
}

# Double home opens the switcher, a swipe up on the card kills the app, a tap on the background leaves (a home press
# doesn't). Each step is read back, since AXe reports presses and swipes iOS never got (job …192707Z…-relaunch-bd33):
# swipe only once the switcher is in front (neither the app nor the Home Screen), and tap only once the app's process
# is gone and the switcher is still in front, so neither lands in a live app or on the Home Screen. Two tries, then SWITCHER_FAILED. Its note lists what each miss saw.
sim_kill_switcher() {
  local try sx sy ex ey bx by e why="" sawcard="" inswitcher=""
  read -r sx sy ex ey <<<"$SIM_CARD_SWIPE"
  read -r bx by <<<"$SIM_PT_BACKGROUND"
  for try in 1 2; do
    # After a swipe that left the app running the switcher is still up: pressing home there reopens the app (relaunch
    # job …011904Z… run 2026-11-09T01-14-43), so the card is read and swiped again without pressing.
    if [ -z "$inswitcher" ]; then
      ax batch --step "button home" --step "sleep 0.15" --step "button home" --step "sleep 1.5" >/dev/null 2>&1 \
        || { sim_err SIM_UNAVAILABLE AXE_FAILED "the app switcher gesture failed"; return 1; }
      sim_front || return 1
      if [ "$SIM_FRONT_APP" = Web ] || [ -n "$SIM_FRONT_PAGE" ]; then
        why="$why; the switcher didn't open (${SIM_FRONT_APP:-no app}${SIM_FRONT_PAGE:+, $SIM_FRONT_PAGE})"
        continue
      fi
    fi
    inswitcher=""
    # Only Aperture's own card is swiped (the switcher also holds Safari's): it reads AXGenericElement "Aperture".
    rm -f "$SIM_P.unread"
    e="$(sim_point "$sx" "$sy")" || return 1
    sim_hung_err "reading the switcher card" && return 1
    if ! sim_match "$e" Aperture ""; then
      why="$why; no Aperture card at $sx,$sy ($(jq -r '"\(.role) \(.label // "")"' <<<"$e"))"
      # leave the switcher (its background, as below) so the next try, or op, starts from the Home Screen
      ax tap -x "$bx" -y "$by" --tap-style physical >/dev/null 2>&1 || { sim_err SIM_UNAVAILABLE AXE_FAILED "the app switcher gesture failed"; return 1; }
      sleep 1
      continue
    fi
    sawcard=1
    ax swipe --start-x "$sx" --start-y "$sy" --end-x "$ex" --end-y "$ey" --duration 0.2 >/dev/null 2>&1 \
      || { sim_err SIM_UNAVAILABLE AXE_FAILED "the app switcher gesture failed"; return 1; }
    sleep 1
    ! sim_web_alive || sleep 1
    if ! sim_web_alive; then
      # The last card gone can close the switcher by itself: on the Home Screen the background spot is a dock icon.
      sim_front || return 1
      if [ -n "$SIM_FRONT_PAGE" ] || [ "$SIM_FRONT_APP" = Web ]; then
        SIM_NOTE="$why; no switcher left to leave (${SIM_FRONT_APP:-no app}${SIM_FRONT_PAGE:+, $SIM_FRONT_PAGE})"
        return 0
      fi
      ax tap -x "$bx" -y "$by" --tap-style physical >/dev/null 2>&1 || { sim_err SIM_UNAVAILABLE AXE_FAILED "the app switcher gesture failed"; return 1; }
      SIM_NOTE="$why"
      return 0
    fi
    why="$why; still running after the swipe"
    inswitcher=1
  done
  # Still in the switcher (the card read as Aperture's, then a swipe left it running): leave it by its background.
  # Swiped and still running is the gesture not killing (2 of 2 runs on 2026-11-08, iOS 27.0), not a dropped input:
  # needs you (the maintainer, option a), never a pass, until the swipe is re-trialled.
  if [ -n "$inswitcher" ]; then
    ax tap -x "$bx" -y "$by" --tap-style physical >/dev/null 2>&1 || true
    sim_err SIM_UNAVAILABLE SWITCHER_FAILED "the switcher swipe didn't kill the app: re-trial the gesture (IOS-CHECK.md -> Failures)$why"
    return 1
  fi
  if [ -z "$sawcard" ] && [ "${why#*no Aperture card}" != "$why" ]; then
    sim_fail SWITCHER_FAILED "no Aperture card in the app switcher in two tries$why: was the app running? Rerun from a launch"
    return 1
  fi
  sim_fail SWITCHER_FAILED "the app switcher didn't kill the app in two tries$why: iOS dropped the input; rerun the step, don't debug the app"
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

# Hit-first: one read where the tab sits with the page at its top and the row not swiped (the first seven of SIM_XS_NAV;
# a swiped row puts another tab there, or this one, which the label decides).
# The row scrolls with the page (AppNav is in the flow, not sticky), so the tab's centre within 4 pt of SIM_Y_NAV means
# the page is at its top, as the swipes would leave it. Anything else (the page scrolled, the row swiped sideways,
# relaunch's shifted AX geometry, a hung read) is 2: today's full path. 1 is the probe budget.
sim_nav_fast() {
  local x e
  x="$(jq -nr --arg t "$1" --argjson tabs "$SIM_TABS" --arg xs "$SIM_XS_NAV" '($tabs | index($t)) as $i | ($xs | split(" ")) as $x
    | if $i != null and $i < 7 then $x[$i] else empty end')"
  [ -n "$x" ] || return 2
  e="$(sim_point "$x" "$SIM_Y_NAV")" || return 1
  if [ "$(jq -r .role <<<"$e")" = AXLink ] && sim_label_is "$e" "$1" \
    && jq -e --argjson y "$SIM_Y_NAV" '(((.frame.y // 0) + (.frame.h // 0) / 2) - $y | fabs) <= 4' <<<"$e" >/dev/null 2>&1; then
    SIM_HIT="$e"
    return 0
  fi
  return 2
}

sim_op_nav() {
  local tab rc how=""
  tab="$(jq -r .tab <<<"$1")"
  sim_in_app || return 1
  rm -f "$SIM_P.unread"
  sim_nav_fast "$tab"; rc=$?
  [ "$rc" != 1 ] || return 1
  if [ "$rc" = 0 ]; then
    how=" (fast)"
  else
    sim_to_top
    rm -f "$SIM_P.unread"
    sim_nav_probe "$tab"; rc=$?
  fi
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
  if [ "$rc" != 0 ]; then
    sim_hung_err "looking for the $tab tab" && return 1
    sim_fail MISS "no $tab tab in the nav row"
    return 1
  fi
  sim_tap_el "$SIM_HIT" || return 1
  sleep 2
  SIM_NOTE="on $tab$how"
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
  local cx cy e
  sim_find "$1" || return 1
  if jq -e --argjson deny "$SIM_DENY" '((.label // "") | ascii_downcase | sub("^ +"; "") | sub(" +$"; "")) as $l | $deny | any(. as $d | $l == $d or ($l | startswith($d + " ")))' <<<"$SIM_HIT" >/dev/null; then
    sim_fail DENIED "the match is a write button; not tapped"
    return 1
  fi
  sim_tap_el "$SIM_HIT" || return 1
  if [ "$(jq -r '.as // ""' <<<"$1")" != "" ]; then sim_read_put "$(jq -r .as <<<"$1")" "$SIM_HIT"; fi
  sleep 1
  SIM_NOTE="$(jq -r '"tapped \(.role) at \(.frame.x + (.frame.w / 2 | floor)),\(.frame.y + (.frame.h / 2 | floor))"' <<<"$SIM_HIT")"
  # A tapped field must take focus: no soft keyboard means the tap dropped (job …054323Z…-done-form-e8e2 read as
  # KEYBOARD_SETUP), so tap it once more. But a keyboard can come up late, and a retap then lands on it (job
  # …014933Z…-capture-7ac9 typed a space into the bar at 198,895): wait a second, look again, and retap only where a
  # point read still shows the field. A keyboard still missing is the next op's to report.
  case "$(jq -r .role <<<"$SIM_HIT")" in
    AXTextArea | AXTextField)
      if ! sim_kb_up; then
        sim_hung_err "checking the field took focus" && return 1
        sleep 1
        if sim_kb_up; then
          SIM_NOTE="$SIM_NOTE; the keyboard came up late"
        else
          sim_hung_err "checking the field took focus" && return 1
          read -r cx cy < <(jq -r '.frame // {} | "\(((.x // 0) + (.w // 0) / 2) | floor) \(((.y // 0) + (.h // 0) / 2) | floor)"' <<<"$SIM_HIT")
          rm -f "$SIM_P.unread"
          e="$(sim_point "$cx" "$cy")" || return 1
          sim_hung_err "checking the field is still there" && return 1
          if sim_match "$e" "$(jq -r '.label // ""' <<<"$SIM_HIT")" "$(jq -r .role <<<"$SIM_HIT")"; then
            sim_tap_el "$SIM_HIT" || return 1
            sleep 1
            SIM_NOTE="$SIM_NOTE; tapped again (no keyboard after the first)"
          else
            SIM_NOTE="$SIM_NOTE; not tapped again (the field's spot reads $(jq -r '"\(.role) \(.label // "")"' <<<"$e"))"
          fi
        fi
      fi
      ;;
  esac
  [ "$(jq -r '.closes // false' <<<"$1")" != true ] || sim_tap_gone "$1" || return 1
}

# A `closes` tap must make its element go: read its centre (where it was tapped) now and 1 s later; any other element
# there, or none, is gone (closed, or covered by what it opened). Still there both times means the tap dropped (job
# …230610Z…-done-form-4385: Cancel left the task modal open), so one more tap at that same spot, then TAP_DROPPED.
sim_tap_gone() {
  local label role cx cy e try look
  label="$(jq -r .label <<<"$1")"
  role="$(jq -r '.role // ""' <<<"$1")"
  read -r cx cy < <(jq -r '.frame // {} | "\(((.x // 0) + (.w // 0) / 2) | floor) \(((.y // 0) + (.h // 0) / 2) | floor)"' <<<"$SIM_HIT")
  for try in 1 2; do
    for look in 1 2; do
      [ "$look" = 1 ] || sleep 1
      rm -f "$SIM_P.unread"
      e="$(sim_point "$cx" "$cy")" || return 1
      sim_hung_err "checking \"$label\" went away" && return 1
      sim_match "$e" "$label" "$role" || return 0
    done
    [ "$try" = 1 ] || break
    sim_tap_el "$SIM_HIT" || return 1
    sleep 1
    SIM_NOTE="$SIM_NOTE; tapped again (still there after the first)"
  done
  sim_fail TAP_DROPPED "\"$label\" is still there after 2 taps AXe reported done: iOS dropped the input; rerun the step, don't debug the app"
}

# The soft keyboard is up when its space bar answers; its accessory bar's top is the line a field must clear.
sim_kb_up() { local e x y; read -r x y <<<"$SIM_PT_SPACE"; rm -f "$SIM_P.unread"; e="$(sim_point "$x" "$y")" || return 1; sim_label_is "$e" "space"; }
# No soft keyboard where one is due: the keyboard recipe rests on undocumented iOS prefs, so an Xcode or iOS update
# can break it for every branch at once. That is the environment, not the row: error (needs you), never a fail.
sim_kb_missing() {
  sim_hung_err "looking for the soft keyboard" && return 1
  sim_err SIM_UNAVAILABLE KEYBOARD_SETUP "no soft keyboard (prefs $(sim_pref HardwareKeyboardLastSeen)/$(sim_pref AutomaticMinimizationEnabled), $SIM_XCODE) - re-check IOS-CHECK.md Keyboard after an Xcode or iOS update"
}
sim_accessory_top() {
  local e y
  rm -f "$SIM_P.unread"
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
  local a e r f top bottom w1 w2 seen
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
  rm -f "$SIM_P.unread"
  e="$(sim_point "$(jq -r '.at.x' <<<"$r")" "$(jq -r '.at.y' <<<"$r")")" || return 1
  sim_hung_err "reading $a again" && return 1
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
  # What it saw, filtered like a MISS note. No sign-in value can get here: expect runs between ops, and a sensitive read has none.
  seen="$(jq -r --arg f "$f" 'if $f == "value" then .value else .label end | . // "" | gsub("[^A-Za-z0-9 .,:;()/+_&?-]"; "") | .[0:40]' <<<"$e")"
  sim_fail VALUE "$a $f is \"$seen\", want \"$(jq -r '.valueIs // .labelIs' <<<"$1")\""
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

# A key at the spot the layout puts it, confirmed by its label (HID typing would hide the soft keyboard): SIM_KX SIM_KY.
sim_key_at() {
  local e
  read -r SIM_KX SIM_KY < <(sim_key_xy "$1")
  rm -f "$SIM_P.unread"
  e="$(sim_point "$SIM_KX" "$SIM_KY")" || return 1
  sim_label_is "$e" "$1" && return 0
  sim_hung_err "reading the $1 key" && return 1
  sim_fail MISS "the $1 key isn't where the layout puts it"
}

# One on-screen key, sent the way SIM_VIA says: tap (the default), or a trial's other per-key ways (IOS-CHECK.md →
# Input-gap trial). post keeps the process up after the touch; hid has AXe wait before it (the env var is AXe's).
sim_key() {
  local rc=0
  sim_key_at "$1" || return 1
  case "$SIM_VIA" in
    post) ax tap -x "$SIM_KX" -y "$SIM_KY" --tap-style physical --post-delay 0.5 >/dev/null 2>&1 || rc=$? ;;
    hid)
      export AXE_HID_STABILIZATION_MS=500
      ax tap -x "$SIM_KX" -y "$SIM_KY" --tap-style physical >/dev/null 2>&1 || rc=$?
      unset AXE_HID_STABILIZATION_MS ;;
    *) ax tap -x "$SIM_KX" -y "$SIM_KY" --tap-style physical >/dev/null 2>&1 || rc=$? ;;
  esac
  [ "$rc" = 0 ] || { sim_err SIM_UNAVAILABLE AXE_FAILED "key tap failed"; return 1; }
  if [ "$SIM_VIA" = post ]; then sleep 0.1; else sleep 0.6; fi
}

# Keys in order. batch/batch15 send them all in one AXe process, so one HID session (AXe issue 71: a new process can
# lose its first touch before the sim's input service is up), after a lead sleep. Every key is read at its spot
# first, so a key off its spot is MISS before any tap goes out. Letters, space and delete never change the layout,
# so reading them all up front sees what a per-key read would.
sim_send() {
  local k lead=1 steps
  case "$SIM_VIA" in batch | batch15) ;; *)
    for k in "$@"; do sim_key "$k" || return 1; done
    return 0 ;;
  esac
  [ "$SIM_VIA" != batch15 ] || lead=1.5
  steps=(--step "sleep $lead")
  for k in "$@"; do
    sim_key_at "$k" || return 1
    [ "${#steps[@]}" = 2 ] || steps+=(--step "sleep 0.6")
    steps+=(--step "tap -x $SIM_KX -y $SIM_KY")
  done
  ax batch --tap-style physical "${steps[@]}" >/dev/null 2>&1 || { sim_err SIM_UNAVAILABLE AXE_FAILED "key batch failed"; return 1; }
  sleep 0.6
}

sim_type_keys() {
  local ch i=0 ks=()
  while [ "$i" -lt "${#1}" ]; do
    ch="${1:$i:1}"
    [ "$ch" != " " ] || ch=space
    ks+=("$ch")
    i=$((i + 1))
  done
  sim_send "${ks[@]}"
}
sim_deletes() {
  local i=0 ks=()
  while [ "$i" -lt "$1" ]; do ks+=(delete); i=$((i + 1)); done
  sim_send "${ks[@]}"
}

# A trial op's line in trial.jsonl: how many of its n taps the first read-back found dropped.
sim_trial() {
  jq -cn --argjson i "$SIM_OPI" --arg op "$1" --arg via "$SIM_VIA" --argjson n "$2" --argjson drops "$3" --argjson ms "$4" \
    '{i: $i, op: $op, via: $via, n: $n, drops: $drops, sendMs: $ms}' >>"$SIM_P.trial"
}

# The field, read where `in` was found: SIM_TYPED_OK=1 when it holds the text (case-insensitive: the app's fields
# auto-capitalise), and SIM_TYPED is what it read, filtered like a MISS note.
sim_typed_read() {
  local e
  SIM_TYPED_OK="" SIM_TYPED_LEN=0
  rm -f "$SIM_P.unread"
  e="$(sim_point "$2" "$3")" || return 1
  sim_hung_err "reading the typed text" && return 1
  SIM_TYPED="$(jq -r '"\(.role // "") \"\((.value // "") | gsub("[^A-Za-z0-9 .,:;()/+_&?-]"; "") | .[0:40])\""' <<<"$e")"
  SIM_TYPED_LEN="$(jq -r '(.value // "") | length' <<<"$e")"
  if jq -e --arg t "$1" '((.value // "") | ascii_downcase) == $t' <<<"$e" >/dev/null 2>&1; then SIM_TYPED_OK=1; fi
}

# Taps can be dropped silently, and a key AXe reports done may never land. With `in`, the field is read back: a slow
# tap gets a second look (at the field's frame centre: the point it was found at can sit outside its frame, as the
# Done form's Reflection does), then up to two retypes (deletes first: extra ones do nothing on an empty field), and
# the note says so, so a rising drop rate stays visible. Assumes the field held nothing before.
# A trial's `via` also counts the first read-back's drops (letters missing; at least 1 when it reads wrong) in trial.jsonl.
sim_op_keys() {
  local text field x y cx cy tries=0 first="" via t0 ms drops
  text="$(jq -r .text <<<"$1")"
  field="$(jq -r '.in // ""' <<<"$1")"
  via="$(jq -r '.via // ""' <<<"$1")"
  SIM_VIA="${via:-tap}"
  sim_kb_up || { sim_kb_missing; return 1; }
  t0="$(sim_ms)"
  sim_type_keys "$text" || return 1
  ms=$(($(sim_ms) - t0))
  SIM_NOTE="typed ${#text} keys"
  [ -n "$field" ] || return 0
  read -r x y cx cy < <(sim_read_get "$field" | jq -r '"\(.at.x // 0) \(.at.y // 0) \((.frame.x // 0) + (.frame.w // 0) / 2 | floor) \((.frame.y // 0) + (.frame.h // 0) / 2 | floor)"')
  while :; do
    sim_typed_read "$text" "$x" "$y" || return 1
    if [ -z "$SIM_TYPED_OK" ]; then
      sleep 1
      sim_typed_read "$text" "$cx" "$cy" || return 1
    fi
    if [ -n "$via" ] && [ "$tries" = 0 ]; then
      drops=0
      if [ -z "$SIM_TYPED_OK" ]; then drops=$((${#text} - SIM_TYPED_LEN)); [ "$drops" -ge 1 ] || drops=1; fi
      sim_trial keys "${#text}" "$drops" "$ms"
      SIM_NOTE="$SIM_NOTE; via $via, drops $drops"
    fi
    [ -z "$SIM_TYPED_OK" ] || break
    [ -n "$first" ] || first="$SIM_TYPED"
    if [ "$tries" -ge 2 ]; then
      sim_fail TYPED "typed \"$text\" 3 times; the field reads $SIM_TYPED at $x,$y"
      return 1
    fi
    tries=$((tries + 1))
    sim_deletes $((${#text} + 2)) || return 1
    sim_type_keys "$text" || return 1
  done
  case "$tries" in
    1) SIM_NOTE="$SIM_NOTE; retyped once (first read $first)" ;;
    2) SIM_NOTE="$SIM_NOTE; retyped twice (first read $first)" ;;
  esac
}

# The field read where `in` found it: SIM_ERASED_OK=1 when it is the same role (and label) and holds nothing: "" or the
# value `in` recorded while it was empty (iOS reads a placeholder as the AXValue). Else SIM_LEFT is the characters
# left (0 when it isn't the field), and SIM_ERASED what it read, filtered like a MISS note.
sim_erased_read() {
  local e
  SIM_ERASED_OK="" SIM_LEFT=0 SIM_ERASED_FIELD=""
  rm -f "$SIM_P.unread"
  e="$(sim_point "$2" "$3")" || return 1
  sim_hung_err "reading the erased field" && return 1
  SIM_ERASED="$(jq -r '"\(.role // "") \"\((.value // "") | gsub("[^A-Za-z0-9 .,:;()/+_&?-]"; "") | .[0:40])\""' <<<"$e")"
  jq -e --argjson r "$1" '(.role // "") != "" and (.role // "") == ($r.role // "")
    and (($r.label // "") == "" or ((.label // "") | ascii_downcase) == (($r.label // "") | ascii_downcase))' <<<"$e" >/dev/null 2>&1 || return 0
  SIM_ERASED_FIELD=1
  if jq -e --argjson r "$1" '(.value // "") == "" or (.value // "") == ($r.value // "")' <<<"$e" >/dev/null 2>&1; then
    SIM_ERASED_OK=1
  else
    SIM_LEFT="$(jq -r '(.value // "") | length | if . > 24 then 24 else . end' <<<"$e")"
  fi
}

# Deletes AXe reports done can be ones iOS never got (job …230610Z…-done-form-4385 left a Z after six), so with `in`
# the field is read back (where `in` found it, then at its centre, as keys does) and anything left gets that many
# deletes plus two, at most twice, before ERASED. `in` must have found the field empty, before any keys.
# A trial's `via` also counts the first read-back's letters left in trial.jsonl (with n = the letters typed, each is a
# dropped delete).
sim_op_erase() {
  local n field r x y cx cy rounds=0 more first="" more1="" found via t0 ms drops
  n="$(jq -r '.n | floor' <<<"$1")"
  via="$(jq -r '.via // ""' <<<"$1")"
  SIM_VIA="${via:-tap}"
  sim_kb_up || { sim_kb_missing; return 1; }
  t0="$(sim_ms)"
  sim_deletes "$n" || return 1
  ms=$(($(sim_ms) - t0))
  SIM_NOTE="erased $n"
  field="$(jq -r '.in // ""' <<<"$1")"
  [ -n "$field" ] || return 0
  r="$(sim_read_get "$field")"
  read -r x y cx cy < <(jq -r '"\(.at.x // 0) \(.at.y // 0) \((.frame.x // 0) + (.frame.w // 0) / 2 | floor) \((.frame.y // 0) + (.frame.h // 0) / 2 | floor)"' <<<"$r")
  while :; do
    sim_erased_read "$r" "$x" "$y" || return 1
    found="$SIM_ERASED_FIELD"
    if [ -z "$SIM_ERASED_OK" ]; then
      sleep 1
      sim_erased_read "$r" "$cx" "$cy" || return 1
      [ -z "$SIM_ERASED_FIELD" ] || found=1
    fi
    if [ -n "$via" ] && [ "$rounds" = 0 ] && [ -n "$found" ]; then
      drops=0
      [ -n "$SIM_ERASED_OK" ] || drops="$SIM_LEFT"
      sim_trial erase "$n" "$drops" "$ms"
      SIM_NOTE="$SIM_NOTE; via $via, drops $drops"
    fi
    [ -z "$SIM_ERASED_OK" ] || break
    if [ -z "$found" ]; then # the field moved, or the page changed: not dropped input, and more deletes can't help
      sim_fail MISS "the field \`$field\` found isn't at $x,$y or its centre after erasing (saw $SIM_ERASED)"
      return 1
    fi
    [ -n "$first" ] || first="$SIM_ERASED"
    if [ "$rounds" -ge 2 ]; then
      sim_fail ERASED "deleted $n, then more twice; the field still reads $SIM_ERASED at $x,$y: iOS dropped the input; rerun the step, don't debug the app"
      return 1
    fi
    more=$((SIM_LEFT + 2))
    [ "$more" -le 24 ] || more=24
    [ -z "$more1" ] && more1="$more" || more1="$more1 and $more"
    rounds=$((rounds + 1))
    sim_deletes "$more" || return 1
  done
  case "$rounds" in
    1) SIM_NOTE="$SIM_NOTE; deleted $more1 more (first read $first)" ;;
    2) SIM_NOTE="$SIM_NOTE; deleted more twice, $more1 (first read $first)" ;;
  esac
}

# Done is a tap like any other: the keyboard must be gone afterwards (one retap), or the next op aims at a moved page.
sim_op_blur() {
  local rc
  sim_accessory_top >/dev/null; rc=$?
  [ "$rc" != 1 ] || return 1
  if [ "$rc" != 0 ]; then
    sim_hung_err "looking for the keyboard's Done" && return 1
    SIM_NOTE="no keyboard to dismiss"
    return 0
  fi
  sim_tap_el "$SIM_HIT" || return 1
  sleep 1
  SIM_NOTE="keyboard dismissed"
  if sim_kb_up; then
    sleep 1
    # Done again only where it is now: a keyboard that went down late leaves a page button at the old spot.
    sim_accessory_top >/dev/null; rc=$?
    [ "$rc" != 1 ] || return 1
    if [ "$rc" = 0 ]; then
      sim_tap_el "$SIM_HIT" || return 1
      sleep 1
      SIM_NOTE="keyboard dismissed on the second tap"
    fi
    if sim_kb_up; then sim_fail BLUR "the keyboard stayed up after Done"; return 1; fi
  fi
  [ ! -e "$SIM_P.over" ] && [ ! -e "$SIM_P.late" ] || return 1 # a read refused for the budget is no answer
  sim_hung_err "checking the keyboard went down" && return 1
  return 0
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

# nav can't confirm the tab switched (no active-tab signal), so a stamp that isn't there gets one more visit: a dropped
# Settings tap leaves the page where it was (job …065125Z…-launch-4810 stayed on Home), and the note says so.
# The stamp's y is read first where the last readBuild on this Mac found it (the runner's state dir, kept only when it is
# one of SIM_YS_BUILD), then the rest of SIM_YS_BUILD as before. `stay` skips the trip back Home (relaunch: nothing
# after it needs Home); expectBuild's relaunch keeps the op's choice.
sim_op_readBuild() {
  local i y e b try last ys
  SIM_RB_AGAIN="" # expectBuild's relaunch note keeps it too
  SIM_RB_STAY=false
  if [ -n "${1:-}" ] && [ "$(jq -r '.stay // false' <<<"$1" 2>/dev/null)" = true ]; then SIM_RB_STAY=true; fi
  last="$(head -c 8 "${STATE:-/nonexistent}/sim-build-y" 2>/dev/null | tr -d '\n')"
  case " $SIM_YS_BUILD " in *" $last "*) [[ "$last" =~ ^[0-9]+$ ]] || last="" ;; *) last="" ;; esac
  ys="$last"
  for y in $SIM_YS_BUILD; do [ "$y" = "$last" ] || ys="$ys $y"; done
  for try in 1 2; do
    sim_op_nav '{"op":"nav","tab":"Settings"}' || return 1
    for i in 1 2 3 4 5 6 7 8; do ax swipe --start-x $((SIM_W - 12)) --start-y 700 --end-x $((SIM_W - 12)) --end-y 150 --duration 0.15 >/dev/null 2>&1 || true; done
    b=""
    rm -f "$SIM_P.unread"
    for y in $ys; do
      e="$(sim_point "$SIM_X_BUILD" "$y")" || return 1
      b="$(jq -r '(.value // "") | select(test("^Build [0-9a-f]{7}$")) | .[6:]' <<<"$e")"
      [ -z "$b" ] || break
    done
    [ -z "$b" ] || break
    sim_hung_err "looking for the build stamp" && return 1
    [ "$try" = 2 ] || SIM_RB_AGAIN="; went to Settings again (no stamp the first time)"
  done
  if [ -z "$b" ]; then
    sim_fail MISS "no build stamp found after two Settings visits"
    return 1
  fi
  echo "$b" >>"$SIM_P.builds"
  if [ -n "${STATE:-}" ] && [ "$y" != "$last" ]; then { printf '%s\n' "$y" >"$STATE/sim-build-y.tmp" && mv -f "$STATE/sim-build-y.tmp" "$STATE/sim-build-y"; } 2>/dev/null || true; fi
  if [ "$SIM_RB_STAY" = true ]; then
    SIM_NOTE="running $b$SIM_RB_AGAIN; stayed on Settings"
    return 0
  fi
  sim_op_nav '{"op":"nav","tab":"Home"}' || return 1
  SIM_NOTE="running $b$SIM_RB_AGAIN"
}

sim_op_expectBuild() {
  local want got first
  want="$(printf '%s' "$SIM_SHA" | cut -c1-7)"
  got="$(tail -1 "$SIM_P.builds" 2>/dev/null)"
  [ -n "$got" ] || { sim_fail STALE_BUILD "no build read yet"; return 1; }
  if [ "$got" = "$want" ]; then SIM_NOTE="current at first launch ($got)"; return 0; fi
  if [ "$(jq -r '.relaunches // 1 | floor' <<<"$1")" = 1 ]; then
    first="$got"
    sim_op_kill '{"op":"kill","method":"terminate"}' && sim_op_launch && sim_op_readBuild "{\"stay\":${SIM_RB_STAY:-false}}" || return 1
    got="$(tail -1 "$SIM_P.builds")"
    if [ "$got" = "$want" ]; then SIM_NOTE="first launch ran $first, second $got$SIM_RB_AGAIN"; return 0; fi
  fi
  sim_fail STALE_BUILD "ran build $got, expected $want — rerun"
}

# What the screen showed when a row failed or the sim stopped mid-plan; a plan's own shots already reached their cap, or a sign-in, gets none. Its own
# failure changes nothing about the row's.
sim_fail_shot() {
  local st="$SIM_ST" rs="$SIM_RS" dt="$SIM_DT" note="$SIM_NOTE"
  if [ "$1" != signIn ] && [ "$SIM_SENSITIVE" = false ] && [ "$SIM_SHOTS" -lt 20 ]; then sim_op_shot '{"name":"fail"}' || true; fi
  SIM_ST="$st" SIM_RS="$rs" SIM_DT="$dt" SIM_NOTE="$note"
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
sim_op_shutdown() { sim_shutdown || return 1; SIM_BOOTED=off; SIM_NOTE="shut down"; }

# --- the run ------------------------------------------------------------------------------------------------------
run_sim() {
  local w="$1" n i op opj t0 status=pass reason=- detail="" started budget caf load0
  SIM_P="$2"
  SIM_RD="$3"
  sim_rd "$w" plan.json || true # what ran, beside what it found
  SIM_SHA="$(jq -r .params.sha "$w")"
  SIM_U="" SIM_STATE="" SIM_TYPE="" SIM_RUNTIME="" SIM_AXE_OK="" SIM_XCODE="" SIM_HIT="{}" SIM_NOTE="" SIM_TYPED="" SIM_TYPED_OK="" SIM_RB_AGAIN="" SIM_RB_STAY=false
  SIM_BOOTED=warm SIM_SIGNED=unknown SIM_SENSITIVE=false SIM_READY="" SIM_SHOTS=0 SIM_KB_WROTE="" SIM_KB_SET=""
  SIM_ST="" SIM_RS="" SIM_DT="" SIM_VIA=tap SIM_OPI=0
  load0="$(sim_load)"
  echo '{}' >"$SIM_P.reads"
  echo 0 >"$SIM_P.probes"
  rm -f -- "$SIM_P.over" "$SIM_P.late" "$SIM_P.unread" "$SIM_P.axerr"
  : >"$SIM_P.steps"
  : >"$SIM_P.builds"
  : >"$SIM_P.shots"
  : >"$SIM_P.trial"
  started="$(date +%s)"
  budget="$(jq -r '.params.timeoutSec | floor' "$w")"
  SIM_DEADLINE=$((started + budget))
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
      sim_touch # a long job must not look like a stale lock
      SIM_NOTE="" SIM_VIA=tap SIM_OPI="$i"
      if sim_lazy_ready "$op" && "sim_op_$op" "$opj"; then
        status=pass
      else
        [ ! -e "$SIM_P.over" ] || { SIM_ST=error SIM_RS=TIMEOUT SIM_DT=PROBES SIM_NOTE="over $SIM_MAX_PROBES point reads"; }
        [ ! -e "$SIM_P.late" ] || { SIM_ST=error SIM_RS=TIMEOUT SIM_DT="" SIM_NOTE="over the ${budget} s budget"; }
        status="${SIM_ST:-error}"
        # a failure, or a sim that was up and then couldn't go on (not a blown budget: nothing more may run)
        if [ "$status" = fail ] || { [ "$status" = error ] && [ -n "$SIM_READY" ] && [ "$SIM_RS" != TIMEOUT ] && [ "$SIM_DT" != BOOT_FAILED ] && [ "$SIM_DT" != SHUTDOWN_FAILED ]; }; then sim_fail_shot "$op"; fi
      fi
    fi
    jq -cn --argjson i "$i" --arg op "$op" --arg st "$status" --argjson ms "$(($(sim_ms) - t0))" --arg note "$SIM_NOTE" \
      '{i: $i, op: $op, status: $st, ms: $ms} + (if $note == "" then {} else {note: ($note | .[0:240])} end)' >>"$SIM_P.steps"
    if [ "$status" != pass ]; then reason="${SIM_RS:-SIM_UNAVAILABLE}"; detail="$SIM_DT"; fi
    i=$((i + 1))
  done
  # The rows already passed; a sim that wouldn't shut down says so in `booted` (the container's finish() asks again).
  if [ "$status" = pass ] && [ -n "$SIM_U" ] && [ "$(jq -r .params.shutdown "$w")" = true ] && [ "$SIM_BOOTED" != off ]; then
    if sim_shutdown; then SIM_BOOTED=off; fi
  fi
  kill "$caf" 2>/dev/null || true
  if [ -s "$SIM_P.trial" ]; then
    { jq -cn --arg a "$load0" --arg b "$(sim_load)" '{load: {start: $a, end: $b}}'; cat "$SIM_P.trial"; } >"$SIM_P.trialout"
    sim_rd "$SIM_P.trialout" trial.jsonl || true
  fi
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
