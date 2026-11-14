#!/bin/bash
# Install, update or remove the Mac stats agent (docs/ops/TOWER.md → Mac stats). It installs what GitHub holds at one
# commit — by default main's head — fetched with the mailroom's read-only token (Keychain item aperture-mailroom-gh,
# Contents: read); it never installs the files in this folder, which the container can write. Run it fetched the same
# way, from the main checkout (the exact line is in TOWER.md):
#   cd <main checkout> && /bin/bash <(curl … /contents/tools/macstats/install.sh?ref=main) [--ref <sha>]
#   … --uninstall
# The mailroom's installer is the pattern (tools/mailroom/install.sh); this one shares nothing with it but the token.
# Needs only what macOS 15+ ships plus jq: bash, jq, curl, security, launchctl, plutil, shasum.
set -euo pipefail
export LC_ALL=C

LABEL="dev.rahuldatta.aperture.macstats"
REPO_SLUG="radatta/aperture"
KEYCHAIN="aperture-mailroom-gh"
REPO="$(pwd -P)"
OUT="$REPO/localNotes/board"
APP="$HOME/Library/Application Support/aperture-macstats"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/aperture-macstats/agent.log"
DOMAIN="gui/$(id -u)"

die() { echo "install: $*" >&2; exit 1; }
usage() { die "usage: install.sh [--ref <40-hex commit>] | --uninstall  (run from the main checkout)"; }

main() {
  ref=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --ref) ref="${2:-}"; [[ "$ref" =~ ^[0-9a-f]{40}$ ]] || usage; shift 2 ;;
      --uninstall)
        launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
        rm -f "$PLIST"
        [ ! -d "$APP" ] || rm -r "$APP"
        echo "removed the agent and $APP."
        echo "kept: $OUT/mac-stats.json (the tower shows it stale, then silent) and the Keychain item."
        exit 0 ;;
      *) usage ;;
    esac
  done

  [ "$(uname)" = Darwin ] || die "run this on the Mac"
  for t in jq curl security launchctl plutil shasum; do command -v "$t" >/dev/null || die "$t not found"; done
  [ -d "$REPO/.git" ] || die "run from the main checkout (cd to it first) — localNotes/board/ lives there"
  case "$OUT$APP$LOG" in *'&'* | *'<'* | *'>'*) die "a path holds an XML-special character" ;; esac
  TOKEN="$(security find-generic-password -s "$KEYCHAIN" -w 2>/dev/null || true)"
  [ -n "$TOKEN" ] || die "no Keychain item $KEYCHAIN — the mailroom's token (MAILROOM.md → The token)"

  # get PATH OUT [raw] — one GitHub read with the token as a header fd (never argv); fails loudly.
  get() {
    local accept='application/vnd.github+json'
    [ -z "${3:-}" ] || accept='application/vnd.github.raw+json'
    curl -sSf --max-time 30 -o "$2" -H @<(printf 'Authorization: Bearer %s\n' "$TOKEN") -H "Accept: $accept" \
      -H 'X-GitHub-Api-Version: 2022-11-28' -H 'User-Agent: aperture-macstats-install' \
      "https://api.github.com/repos/$REPO_SLUG/$1" || die "GitHub read failed: $1"
  }

  stage="$(mktemp -d)"
  trap 'rm -r "$stage"' EXIT
  get commits/main "$stage/main.json"
  main_sha="$(jq -r .sha "$stage/main.json")"
  [[ "$main_sha" =~ ^[0-9a-f]{40}$ ]] || die "could not read main's head"
  [ -n "$ref" ] || ref="$main_sha"

  mkdir -p "$stage/bin"
  get "contents/tools/macstats/macstats.sh?ref=$ref" "$stage/bin/macstats.sh" raw
  get "contents/tools/macstats/$LABEL.plist.tmpl?ref=$ref" "$stage/plist.tmpl" raw
  version="$(shasum -a 256 "$stage/bin/macstats.sh" | cut -d' ' -f1)"
  printf '%s\n' "$version" >"$stage/bin/VERSION"

  tmpl="$(cat "$stage/plist.tmpl")"
  tmpl="${tmpl//@SCRIPT@/$APP/bin/macstats.sh}"
  tmpl="${tmpl//@OUT@/$OUT}"
  tmpl="${tmpl//@STATE@/$APP/state}"
  tmpl="${tmpl//@LOG@/$LOG}"
  tmpl="${tmpl//@VERSION@/$version}"
  printf '%s\n' "$tmpl" >"$stage/$LABEL.plist"
  plutil -lint "$stage/$LABEL.plist" >/dev/null || die "the rendered plist is invalid: $(plutil -lint "$stage/$LABEL.plist")"

  # The one folder it writes into: a real directory, never a symlink (the agent refuses one anyway).
  for d in "$REPO/localNotes" "$OUT"; do
    [ ! -L "$d" ] || die "$d is a symlink — remove it and re-run"
    mkdir -p "$d"
  done

  echo "== installing $REPO_SLUG@${ref:0:12} — changes against what is installed:"
  mkdir -p "$APP/bin" "$APP/state" "$(dirname "$LOG")" "$(dirname "$PLIST")"
  diff -ruN "$APP/bin" "$stage/bin" || true
  if [ -f "$PLIST" ]; then diff -u "$PLIST" "$stage/$LABEL.plist" || true; else diff -u /dev/null "$stage/$LABEL.plist" || true; fi
  if [ "$ref" != "$main_sha" ]; then
    echo "!! $ref is NOT main's head — an unmerged commit nobody has approved. Read tools/macstats/ at that commit on"
    echo "!! github.com first, and re-run without --ref once it merges."
    read -r -p "Install this unmerged commit? [y/N] " answer || answer=""
    [ "$answer" = y ] || die "not installed"
  fi

  rm -f "$APP/bin/macstats.sh" "$APP/bin/VERSION"
  cp "$stage/bin/macstats.sh" "$stage/bin/VERSION" "$APP/bin/"
  chmod 700 "$APP/bin/macstats.sh"
  cp "$stage/$LABEL.plist" "$PLIST"

  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  for try in 1 2 3 4 5; do
    if launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null; then break; fi
    [ "$try" -lt 5 ] || die "launchctl bootstrap failed 5 times — run: launchctl bootstrap $DOMAIN $PLIST"
    sleep 1
  done
  echo "installed $LABEL (agent ${version:0:12}, $REPO_SLUG@${ref:0:12}), writing $OUT/mac-stats.json every 15 s"
  echo "check: open http://localhost:6183 → HEALTH → Mac   ·   log: $LOG"
}

main "$@" # last line: a truncated download defines nothing and runs nothing
