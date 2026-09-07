#!/usr/bin/env bash
# Make COI's VM-local state durable by relocating it onto the Mac disk.
#
# RUN THIS IN THE LIMA VM: `limactl shell incus`, then this script's path under /Users/...
# There is no container half any more — the old scripts/coi-container-setup.sh was deleted on
# 2026-09-07 because its symlink made COI skip ~/.claude/projects at export time, which is what
# made the restore look broken. See docs/COI-SANDBOX.md → One-time setup step 12.
#
# Why: `~` in the Lima VM is /home/<user>.guest — VM-local. COI writes its own state there,
# including the Claude Code session it exports on `coi shutdown`
# (~/.coi/sessions-claude/<id>/.claude/, transcript included). A VM rebuild destroys all of it.
# That is not hypothetical: a one-character YAML error in `limactl edit` wiped two session
# transcripts and the aperture-night profile. See docs/COI-INCIDENTS.md → Incident D.
#
# This is the load-bearing step. `coi shell --resume` restores a destroyed container FROM
# ~/.coi/sessions-claude/ — verified 2026-09-07, transcripts back byte-identical along with
# history.jsonl, settings, session-env and credentials. So this script protects the mechanism the
# whole workflow depends on.
#
# Scope: it protects what `coi shutdown` exports. It does NOT help when there is no graceful
# shutdown (Mac reboot, clamshell sleep, `limactl stop` on its own, a dropped terminal) — nothing
# is exported at all in those cases. Shut down at every real break to keep that window small.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="$REPO/localNotes/coi-state"
COI_HOME="$HOME/.coi"
LINKED=(sessions-claude profiles)

CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

red() { printf '\033[31m%s\033[0m\n' "$*"; }
grn() { printf '\033[32m%s\033[0m\n' "$*"; }
ylw() { printf '\033[33m%s\033[0m\n' "$*"; }
die() { red "error: $*"; exit 1; }

# --- guards: this must run in the Lima VM ------------------------------------------------------

[[ "$(hostname)" == coi-* ]] && die "this is the container, not the VM — exit, then run: limactl shell incus"
[[ -d /workspace ]] && die "/workspace exists — looks like the container. Run this in the Lima VM."
[[ -d "$COI_HOME" ]] || die "no $COI_HOME — coi isn't installed here, so this isn't the Lima VM."
[[ -d "$REPO/.git" ]] || die "$REPO doesn't look like the repo (no .git). Is the mount present?"

# --- state -------------------------------------------------------------------------------------

status_of() {   # ok | missing | wrong-target | real-dir | not-a-dir
  local name="$1" link="$COI_HOME/$1" want="$STATE/$1"
  if [[ -L "$link" ]]; then
    [[ "$(readlink -f "$link")" == "$(readlink -f "$want")" ]] && echo ok || echo wrong-target
  elif [[ ! -e "$link" ]]; then echo missing
  elif [[ -d "$link" ]]; then echo real-dir
  else echo not-a-dir
  fi
}

report() {
  local bad=0
  for name in "${LINKED[@]}"; do
    case "$(status_of "$name")" in
      ok)           grn "  ok           ~/.coi/$name -> $STATE/$name" ;;
      missing)      ylw "  missing      ~/.coi/$name (will be created)";                  bad=1 ;;
      real-dir)     ylw "  not linked   ~/.coi/$name is a real directory (will migrate)"; bad=1 ;;
      wrong-target) red "  wrong target ~/.coi/$name -> $(readlink "$COI_HOME/$name")";   bad=1 ;;
      not-a-dir)    red "  unexpected   ~/.coi/$name exists and is not a directory";      bad=1 ;;
    esac
  done
  return $bad
}

link_one() {
  local name="$1" link="$COI_HOME/$name" want="$STATE/$name" ts
  mkdir -p "$want"

  case "$(status_of "$name")" in
    ok) return 0 ;;
    wrong-target) die "~/.coi/$name points at $(readlink "$link") — not touching it. Move it aside yourself." ;;
    not-a-dir)    die "~/.coi/$name is a file, not a directory. Inspect it before re-running." ;;
    real-dir)
      # copy across, then set the original aside. Nothing is ever deleted.
      if [[ -n "$(ls -A "$link" 2>/dev/null)" ]]; then
        cp -a "$link"/. "$want"/ || die "copy from ~/.coi/$name failed; nothing was changed."
        echo "  copied       $(find "$link" -mindepth 1 | wc -l) entries -> $want"
      fi
      ts=$(date +%Y%m%d-%H%M%S)
      mv "$link" "$link.pre-symlink-$ts"
      ylw "  set aside    ~/.coi/$name -> $name.pre-symlink-$ts (delete once you're happy)"
      ;;
  esac

  ln -s "$want" "$link"
  grn "  linked       ~/.coi/$name -> $want"
}

# --- run -----------------------------------------------------------------------------------------

echo "repo:  $REPO"
echo "state: $STATE"
echo

if (( CHECK_ONLY )); then
  echo "checking:"
  if report; then grn "VM-side state is wired up."; exit 0
  else red "VM-side state is NOT wired up — re-run without --check."; exit 1; fi
fi

mkdir -p "$STATE"
chmod 700 "$STATE"

echo "applying:"
for name in "${LINKED[@]}"; do link_one "$name"; done

echo
echo "verifying:"
report || die "verification failed — see above."
echo
grn "done."

if find "$STATE" -name '.credentials.json' -print -quit 2>/dev/null | grep -q .; then
  echo
  ylw "note: exported sessions include .credentials.json, so Claude credentials now sit in"
  ylw "      plaintext on the Mac disk under localNotes/ (gitignored, mode 700). Prune it or"
  ylw "      accept it knowingly — coi's 'host cred isolation' check only covers the other"
  ylw "      direction (host creds leaking INTO containers)."
fi

cat <<'NOTE'

Nothing else to run. `coi shell --resume` reads ~/.coi/sessions-claude/ back into a fresh
container, and this script keeps that directory alive across a VM rebuild.

Unconfirmed: whether coi recreates these paths with `mkdir -p` (a symlink survives) or replaces
them. Re-run with --check after a shutdown cycle. If it reports "not linked", this is a
per-session step, not one-time.
NOTE
