#!/bin/bash
# Install, update or remove the Mac mailroom (docs/ops/MAILROOM.md). Run on the Mac, from any checkout or worktree:
#   bash tools/mailroom/install.sh [--mode queue|poll]     install / update (re-run after any tools/mailroom/ change)
#   bash tools/mailroom/install.sh --uninstall
# It COPIES runner.sh + jobs/ out of the repo into ~/Library/Application Support/aperture-mailroom/bin — the trust
# boundary: launchd runs that copy, never the repo's, which the container can write — and prints the diff first.
# Needs only what macOS 15+ ships: bash, jq, curl, security, launchctl, plutil, shasum.
set -euo pipefail

LABEL="dev.rahuldatta.aperture.mailroom"
SRC="$(cd "$(dirname "$0")" && pwd -P)"
CHECKOUT="$(cd "$SRC/../.." && pwd -P)"
REPO="${CHECKOUT%%/.claude/worktrees/*}" # the main checkout: every worktree shares its .hostjobs/
HJ="$REPO/.hostjobs"
APP="$HOME/Library/Application Support/aperture-mailroom"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/aperture-mailroom/agent.log"
DOMAIN="gui/$(id -u)"

die() { echo "install: $*" >&2; exit 1; }
usage() { die "usage: bash tools/mailroom/install.sh [--mode queue|poll] | --uninstall"; }

mode=queue
case "${1:-}" in
  "") ;;
  --mode) mode="${2:-}"; [ "$mode" = queue ] || [ "$mode" = poll ] || usage ;;
  --uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    [ ! -d "$APP" ] || rm -r "$APP"
    echo "removed the agent and $APP."
    echo "kept: $HJ/ and the Keychain item — drop the token with \`security delete-generic-password -s aperture-mailroom-gh\` and revoke it on GitHub."
    exit 0 ;;
  *) usage ;;
esac

[ "$(uname)" = Darwin ] || die "run this on the Mac"
for t in jq curl security launchctl plutil shasum; do command -v "$t" >/dev/null || die "$t not found (needs macOS 15+)"; done
security find-generic-password -s aperture-mailroom-gh >/dev/null 2>&1 \
  || echo "note: no Keychain item aperture-mailroom-gh yet — jobs will fail TOKEN_MISSING until you add it (MAILROOM.md → Token)"
case "$HJ$APP$LOG" in *'&'* | *'<'* | *'>'*) die "a path holds an XML-special character" ;; esac
for f in "$SRC/runner.sh" "$SRC"/jobs/*.sh "$SRC/$LABEL.plist.tmpl"; do
  [ -f "$f" ] && [ ! -L "$f" ] || die "$f is missing or a symlink — refusing to install it"
done

# Stage the new copy, show what changes against the installed one, then swap it in.
stage="$(mktemp -d)"
trap 'rm -r "$stage"' EXIT
mkdir -p "$stage/jobs"
cp "$SRC/runner.sh" "$stage/runner.sh"
cp "$SRC"/jobs/*.sh "$stage/jobs/"
cat "$SRC/runner.sh" "$SRC"/jobs/*.sh | shasum -a 256 | cut -d' ' -f1 >"$stage/VERSION"
mkdir -p "$APP/bin/jobs" "$APP/state" "$(dirname "$LOG")" "$(dirname "$PLIST")"
echo "== changes to the installed runner ($APP/bin)"
diff -ru "$APP/bin" "$stage" || true
rm -f "$APP/bin/runner.sh" "$APP/bin/VERSION" "$APP"/bin/jobs/*.sh
cp "$stage/runner.sh" "$stage/VERSION" "$APP/bin/"
cp "$stage"/jobs/*.sh "$APP/bin/jobs/"
chmod 700 "$APP/bin/runner.sh"

# The shared folder the container writes into. Refuse symlinks: the runner would refuse them anyway.
for d in "$HJ" "$HJ/staging" "$HJ/inbox" "$HJ/results"; do
  [ ! -L "$d" ] || die "$d is a symlink — remove it and re-run"
  mkdir -p "$d"
done

if [ "$mode" = queue ]; then
  trigger="  <key>QueueDirectories</key>
  <array>
    <string>$HJ/inbox</string>
  </array>"
else
  trigger="  <key>StartInterval</key>
  <integer>15</integer>"
fi
tmpl="$(cat "$SRC/$LABEL.plist.tmpl")"
tmpl="${tmpl//@RUNNER@/$APP/bin/runner.sh}"
tmpl="${tmpl//@HOSTJOBS@/$HJ}"
tmpl="${tmpl//@STATE@/$APP/state}"
tmpl="${tmpl//@LOG@/$LOG}"
tmpl="${tmpl//@TRIGGER@/$trigger}"
printf '%s\n' "$tmpl" >"$PLIST"
plutil -lint "$PLIST" >/dev/null

# The stamp the container reads to tell "never installed" from "asleep" (pnpm mailroom → MAC_UNREACHABLE).
version="$(cat "$APP/bin/VERSION")"
rm -f "$HJ/installed.json"
(
  set -C
  jq -n --arg v "$version" --arg mode "$mode" '{installedAt: (now | todate), runnerVersion: $v, mode: $mode}' >"$HJ/installed.json"
)

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "installed $LABEL (mode $mode, runner ${version:0:12}) watching $HJ/inbox"
echo "check: launchctl print $DOMAIN/$LABEL | head -20   ·   log: $LOG"
