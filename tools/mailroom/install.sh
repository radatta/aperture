#!/bin/bash
# Install, update or remove the Mac mailroom (docs/ops/MAILROOM.md → Install). It installs what GitHub holds at one
# commit — by default main's head, code the user approved and merged — fetched with the mailroom token (Contents:
# read). It never installs the files in this folder: the container can write them. Run it fetched the same way,
# from the main checkout (the exact line is in MAILROOM.md):
#   cd <main checkout> && bash <(curl … /contents/tools/mailroom/install.sh?ref=main) [--mode queue|poll] [--ref <sha>]
#   … --uninstall
# Needs only what macOS 15+ ships: bash, jq, curl, security, launchctl, plutil, shasum.
set -euo pipefail
export LC_ALL=C # glob order = the container's sort, for VERSION

LABEL="dev.rahuldatta.aperture.mailroom"
REPO_SLUG="radatta/aperture"
KEYCHAIN="aperture-mailroom-gh"
REPO="$(pwd -P)"
HJ="$REPO/.hostjobs"
APP="$HOME/Library/Application Support/aperture-mailroom"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/aperture-mailroom/agent.log"
DOMAIN="gui/$(id -u)"

die() { echo "install: $*" >&2; exit 1; }
usage() { die "usage: install.sh [--mode queue|poll] [--ref <40-hex commit>] | --uninstall  (run from the main checkout)"; }

main() {
  mode=queue
  ref=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --mode) mode="${2:-}"; [ "$mode" = queue ] || [ "$mode" = poll ] || usage; shift 2 ;;
      --ref) ref="${2:-}"; [[ "$ref" =~ ^[0-9a-f]{40}$ ]] || usage; shift 2 ;;
      --uninstall)
        launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
        rm -f "$PLIST"
        [ ! -d "$APP" ] || rm -r "$APP"
        echo "removed the agent and $APP."
        echo "kept: .hostjobs/ and the Keychain item — drop the token with \`security delete-generic-password -s $KEYCHAIN\` and revoke it on GitHub."
        exit 0 ;;
      *) usage ;;
    esac
  done

  [ "$(uname)" = Darwin ] || die "run this on the Mac"
  for t in jq curl security launchctl plutil shasum; do command -v "$t" >/dev/null || die "$t not found (needs macOS 15+)"; done
  [ -d "$REPO/.git" ] || die "run from the main checkout (cd to it first) — .hostjobs/ lives there, shared by every worktree"
  case "$HJ$APP$LOG" in *'&'* | *'<'* | *'>'*) die "a path holds an XML-special character" ;; esac
  TOKEN="$(security find-generic-password -s "$KEYCHAIN" -w 2>/dev/null || true)"
  [ -n "$TOKEN" ] || die "no Keychain item $KEYCHAIN — add the token first (MAILROOM.md → The token)"

  # get PATH OUT [raw] — one GitHub read with the token as a header fd (never argv); fails loudly.
  get() {
    local accept='application/vnd.github+json'
    [ -z "${3:-}" ] || accept='application/vnd.github.raw+json'
    curl -sSf --max-time 30 -o "$2" -H @<(printf 'Authorization: Bearer %s\n' "$TOKEN") -H "Accept: $accept" \
      -H 'X-GitHub-Api-Version: 2022-11-28' -H 'User-Agent: aperture-mailroom-install' \
      "https://api.github.com/repos/$REPO_SLUG/$1" || die "GitHub read failed: $1"
  }

  stage="$(mktemp -d)"
  trap 'rm -r "$stage"' EXIT
  get commits/main "$stage/main.json"
  main_sha="$(jq -r .sha "$stage/main.json")"
  [[ "$main_sha" =~ ^[0-9a-f]{40}$ ]] || die "could not read main's head"
  [ -n "$ref" ] || ref="$main_sha"

  # Fetch the runner, its jobs and the plist template at that commit.
  mkdir -p "$stage/bin/jobs"
  get "contents/tools/mailroom/jobs?ref=$ref" "$stage/jobs.json"
  jobs="$(jq -r '.[] | select(.type == "file") | .name | select(test("^[a-z0-9-]+\\.sh$"))' "$stage/jobs.json")"
  [ -n "$jobs" ] || die "no jobs at $ref"
  get "contents/tools/mailroom/runner.sh?ref=$ref" "$stage/bin/runner.sh" raw
  for j in $jobs; do get "contents/tools/mailroom/jobs/$j?ref=$ref" "$stage/bin/jobs/$j" raw; done
  get "contents/tools/mailroom/$LABEL.plist.tmpl?ref=$ref" "$stage/plist.tmpl" raw
  cat "$stage/bin/runner.sh" "$stage"/bin/jobs/*.sh | shasum -a 256 | cut -d' ' -f1 >"$stage/bin/VERSION"

  if [ "$mode" = queue ]; then
    trigger="  <key>QueueDirectories</key>
    <array>
      <string>$HJ/inbox</string>
    </array>"
  else
    trigger="  <key>StartInterval</key>
    <integer>15</integer>"
  fi
  tmpl="$(cat "$stage/plist.tmpl")"
  tmpl="${tmpl//@RUNNER@/$APP/bin/runner.sh}"
  tmpl="${tmpl//@HOSTJOBS@/$HJ}"
  tmpl="${tmpl//@STATE@/$APP/state}"
  tmpl="${tmpl//@LOG@/$LOG}"
  tmpl="${tmpl//@TRIGGER@/$trigger}"
  printf '%s\n' "$tmpl" >"$stage/$LABEL.plist"
  plutil -lint "$stage/$LABEL.plist" >/dev/null || die "the rendered plist is invalid: $(plutil -lint "$stage/$LABEL.plist")"

  # The shared folder the container writes into, checked before anything is swapped (no half-install). Refuse
  # symlinks: the runner would refuse them anyway.
  for d in "$HJ" "$HJ/staging" "$HJ/inbox" "$HJ/results"; do
    [ ! -L "$d" ] || die "$d is a symlink — remove it and re-run"
    mkdir -p "$d"
  done

  echo "== installing $REPO_SLUG@${ref:0:12} — changes against what is installed:"
  mkdir -p "$APP/bin/jobs" "$APP/state" "$(dirname "$LOG")" "$(dirname "$PLIST")"
  diff -ru "$APP/bin" "$stage/bin" || true
  diff -u "$PLIST" "$stage/$LABEL.plist" 2>/dev/null || true
  if [ "$ref" != "$main_sha" ]; then
    echo "!! $ref is NOT main's head — an unmerged commit nobody has approved. Read tools/mailroom/ at that commit on"
    echo "!! github.com first (MAILROOM.md → Trial), and re-run without --ref once it merges."
    read -r -p "Install this unmerged commit? [y/N] " answer || answer=""
    [ "$answer" = y ] || die "not installed"
  fi

  rm -f "$APP/bin/runner.sh" "$APP/bin/VERSION" "$APP"/bin/jobs/*.sh
  cp "$stage/bin/runner.sh" "$stage/bin/VERSION" "$APP/bin/"
  cp "$stage"/bin/jobs/*.sh "$APP/bin/jobs/"
  chmod 700 "$APP/bin/runner.sh"
  cp "$stage/$LABEL.plist" "$PLIST"

  # The stamp the container reads to tell "never installed" from "asleep" (pnpm mailroom → MAC_UNREACHABLE). Only
  # a hint — the container can forge it — so a failure to write it doesn't stop the install.
  version="$(cat "$APP/bin/VERSION")"
  (
    rm -f "$HJ/installed.json"
    set -C
    jq -n --arg v "$version" --arg ref "$ref" --arg mode "$mode" \
      '{installedAt: (now | todate), runnerVersion: $v, ref: $ref, mode: $mode}' >"$HJ/installed.json"
  ) 2>/dev/null || echo "note: could not write $HJ/installed.json (something replaced it) — the agent is still installed"

  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  # bootout returns before the old instance is gone; bootstrap can fail ("5: Input/output error") until it is.
  for try in 1 2 3 4 5; do
    if launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null; then break; fi
    [ "$try" -lt 5 ] || die "launchctl bootstrap failed 5 times — run: launchctl bootstrap $DOMAIN $PLIST"
    sleep 1
  done
  echo "installed $LABEL (mode $mode, runner ${version:0:12}, $REPO_SLUG@${ref:0:12}) watching $HJ/inbox"
  echo "check: launchctl print $DOMAIN/$LABEL | head -20   ·   log: $LOG"
}

main "$@" # last line: a truncated download defines nothing and runs nothing
