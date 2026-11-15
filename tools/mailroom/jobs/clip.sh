# shellcheck shell=bash
# The `clip` job: hand the container the image on the Mac's clipboard, as PNG, so Ctrl+V in a container Claude Code
# pastes it (tools/coi/xclip asks for it). Sourced by runner.sh. Images only — this file never asks the pasteboard
# for text. One JXA read (public.png, else public.tiff re-encoded), gated Mac-side: a terminal must be frontmost (a
# paste is happening there), each copied image serves at most CLIP_PER_CC times, at most CLIP_PER_MIN serves a minute,
# and every serve logs a line and shows a banner. Design: docs/ops/MAILROOM.md → The clip job.

CLIP_FRONT_IDS="com.googlecode.iterm2 com.apple.Terminal" # bundle ids that may be frontmost when it serves
CLIP_MAX_BYTES=16777216 # 16 MiB of PNG
CLIP_PER_CC=3 # serves per copied image (the pasteboard's changeCount): two sessions and a retry
CLIP_PER_MIN=6
CLIP_BANNER=0 # 1 = a macOS notification per serve; off by the maintainer's choice (2026-11-13): the log line is the record

# A job is {} params and a short life: a queued paste is worthless a minute later.
CLIP_JQ='try (
  if (.params | type) != "object" or (.params | length) != 0 then "BAD_PARAM"
  elif .expiresInMin > 2 then "BAD_PARAM"
  else empty end
) catch "BAD_PARAM"'

validate_clip() {
  local reason
  reason="$(jq -r "$CLIP_JQ" "$1" 2>/dev/null)" || reason="BAD_PARAM"
  printf '%s' "$reason"
  return 0
}

# The read, as JXA on stdin (never a file the container can write). argv: OUT MAX FRONT_IDS SPENT_CC.
# Prints {cc, front, source, bytes, types}; exit 0 written · 3 no image · 4 image listed but unreadable (privacy) ·
# 5 over MAX · 6 not frontmost · 7 this copy already served CLIP_PER_CC times · 9 text copied with the image ·
# else failed. All of it is checked before any pasteboard data is read, and only image data is ever read. A copy
# that also carries plain text or rich text (an Excel range, a Word or Keynote selection: apps render the text as an
# image beside it) is refused: the text would cross as a picture.
CLIP_JXA='ObjC.import("AppKit");
ObjC.import("stdlib");
function run(argv) {
  const out = argv[0], max = Number(argv[1]), fronts = argv[2].split(" "), spent = Number(argv[3]);
  const say = (o, code) => {
    const s = $.NSString.alloc.initWithUTF8String(JSON.stringify(o) + "\n");
    $.NSFileHandle.fileHandleWithStandardOutput.writeData(s.dataUsingEncoding($.NSUTF8StringEncoding));
    $.exit(code);
  };
  const app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  const front = app.isNil() ? "" : ObjC.unwrap(app.bundleIdentifier) || "";
  const pb = $.NSPasteboard.generalPasteboard;
  const cc = Number(pb.changeCount);
  if (!fronts.includes(front)) say({ cc: cc, front: front }, 6);
  if (cc === spent) say({ cc: cc, front: front }, 7);
  const types = ObjC.deepUnwrap(pb.types) || [];
  const source = types.includes("public.png") ? "png" : types.includes("public.tiff") ? "tiff" : "";
  if (!source) say({ cc: cc, front: front }, 3);
  const text = ["public.utf8-plain-text", "public.utf16-plain-text", "public.plain-text", "public.rtf", "com.apple.flat-rtfd", "public.rtfd"];
  if (types.some((t) => text.includes(t))) say({ cc: cc, front: front, types: types.slice(0, 12) }, 9);
  let data = pb.dataForType(source === "png" ? "public.png" : "public.tiff");
  if (data.isNil() || Number(data.length) === 0) say({ cc: cc, front: front, source: source }, 4);
  if (source === "tiff") {
    const rep = $.NSBitmapImageRep.imageRepWithData(data);
    if (rep.isNil()) say({ cc: cc, front: front, source: source }, 8);
    data = rep.representationUsingTypeProperties(4, $({})); // 4 = NSBitmapImageFileTypePNG
    if (data.isNil()) say({ cc: cc, front: front, source: source }, 8);
  }
  const bytes = Number(data.length);
  if (bytes > max) say({ cc: cc, front: front, source: source, bytes: bytes }, 5);
  if (!data.writeToFileAtomically(out, false)) say({ cc: cc, front: front, source: source }, 8);
  say({ cc: cc, front: front, source: source, bytes: bytes }, 0);
}'

# clip_cap SECS CMD… — run CMD, kill it after SECS (macOS has no `timeout`); 124 when it was killed. Stdin passes
# through. A copy of sim.sh's sim_cap, so this job stands alone.
clip_cap() {
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

# Write clip.png into the job's result dir: pinned cwd, re-checked, never through an existing entry.
clip_rd() {
  local src="$1" rd="$2"
  (
    cd "$rd" && [ "$(pwd -P)" = "$rd" ] || exit 1
    if [ -e clip.png ] || [ -L clip.png ]; then exit 1; fi
    set -C
    cat -- "$src" >./clip.png
  ) 2>/dev/null
}

# The MIXED_TEXT result's {types}: the JXA report's type names, anchored. A function, not an inline "… $(jq …)":
# the Mac's bash 3.2 brace-expands {1,80} inside a double-quoted $( ) that holds a nested " (the word came out
# twice with empty types), so the result was not JSON and no result.json was written.
clip_types() { jq -c '{types: [.types[]? | strings | select(test("^[A-Za-z0-9._-]{1,80}$"))][:12]}' 2>/dev/null || echo '{}'; }

# Mac-private state ($STATE/clip.json): {serves: [epoch s in the last minute], cc, n: serves of that cc}.
# Anything else in it (a hand edit, a clock jump) reads as numbers in range or not at all, so it can't jam a cap.
clip_state() {
  jq -c --argjson now "$1" 'if type == "object" then . else error end
    | {serves: [(.serves | arrays)[] | numbers | select(. > $now - 60 and . <= $now)],
       cc: ((.cc | numbers) // -1), n: ((.n | numbers) // 0)}' "$STATE/clip.json" 2>/dev/null || echo '{"serves":[],"cc":-1,"n":0}'
}

# run_clip W PRIVATE_PREFIX RESULT_DIR → "STATUS REASON EXTRA_JSON"
run_clip() {
  local p="$2" rd="$3" now st spent meta rc front bytes cc source sha magic size kb
  now="$(date +%s)"
  st="$(clip_state "$now")"
  if [ "$(jq '.serves | length' <<<"$st")" -ge "$CLIP_PER_MIN" ]; then
    echo "rejected RATE_LIMITED {}"
    return 0
  fi
  spent="$(jq --argjson k "$CLIP_PER_CC" 'if .n >= $k then .cc else -1 end' <<<"$st")"
  rc=0
  meta="$(clip_cap 10 osascript -l JavaScript - "$p.png" "$CLIP_MAX_BYTES" "$CLIP_FRONT_IDS" "$spent" <<<"$CLIP_JXA" 2>/dev/null)" || rc=$?
  front="$(jq -r '.front // "" | select(test("^[A-Za-z0-9.-]{1,100}$"))' <<<"$meta" 2>/dev/null || true)"
  case "$rc" in
    0) ;;
    3) echo "rejected NO_IMAGE {}"; return 0 ;;
    4) echo "error PASTEBOARD_DENIED {}"; return 0 ;;
    5) echo "rejected TOO_LARGE {}"; return 0 ;;
    6) echo "rejected NOT_FRONTMOST $(jq -cn --arg f "$front" '{frontmost: $f}')"; return 0 ;;
    7) echo "rejected REPEAT {}"; return 0 ;;
    9) echo "rejected MIXED_TEXT $(clip_types <<<"$meta")"; return 0 ;;
    124) echo "error TIMEOUT {}"; return 0 ;;
    *) echo "error CLIP_FAILED {}"; return 0 ;;
  esac
  # Trust the file, not the report: a regular file, PNG magic, within the cap.
  cc="$(jq -r '.cc | select(type == "number" and . == floor and . >= 0)' <<<"$meta" 2>/dev/null || true)"
  source="$(jq -r '.source | select(. == "png" or . == "tiff")' <<<"$meta" 2>/dev/null || true)"
  if [ -z "$cc" ] || [ -z "$source" ] || [ -L "$p.png" ] || [ ! -f "$p.png" ]; then
    echo "error CLIP_FAILED {}"
    return 0
  fi
  size="$(wc -c <"$p.png" | tr -d ' ')"
  magic="$(head -c 8 "$p.png" | od -An -tx1 | tr -d ' \n')"
  if [ "$size" -gt "$CLIP_MAX_BYTES" ]; then echo "rejected TOO_LARGE {}"; return 0; fi
  if [ "$magic" != 89504e470d0a1a0a ]; then echo "error CLIP_FAILED {}"; return 0; fi
  if ! clip_rd "$p.png" "$rd"; then echo "error CLIP_FAILED {}"; return 0; fi
  sha="$(sha256 <"$p.png")"
  jq -c --argjson now "$now" --argjson cc "$cc" '.serves += [$now] | if .cc == $cc then .n += 1 else .cc = $cc | .n = 1 end' \
    <<<"$st" >"$STATE/clip.json.n" && mv -f "$STATE/clip.json.n" "$STATE/clip.json"
  kb=$(((size + 1023) / 1024))
  log "clip served $kb KiB sha ${sha:0:12} cc $cc from $source, $front frontmost" >&2
  if [ "$CLIP_BANNER" = 1 ]; then
    clip_cap 5 osascript -e "display notification \"Sent a $kb KB image to the container\" with title \"Aperture mailroom\"" >/dev/null 2>&1 || true
  fi
  echo "served - $(jq -cn --argjson b "$size" --arg s "$sha" --argjson cc "$cc" --arg src "$source" --arg f "$front" \
    '{clip: {bytes: $b, sha256: $s, changeCount: $cc, source: $src, frontmost: $f}}')"
}
