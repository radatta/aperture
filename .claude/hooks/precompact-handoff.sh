#!/bin/bash
# PreCompact hook, no matcher — fires on manual `/compact` and on auto compaction (idle AND context-full;
# both report trigger "auto"). Writes a handoff before the context is summarised: forks this session with
# `claude -p --resume <sid> --fork-session` and runs the `handoff` skill in the fork, which reuses the
# parent's prompt cache. Compaction waits for this hook.
#
# Always exits 0 and prints nothing — a failed handoff must never block or clutter compaction. Every run
# appends one line to localNotes/handoffs/precompact.log; a fork that wrote to stderr keeps it beside it.
# Flags, permission model, measurements: docs/ops/COMPACTION-HANDOFF.md. Pairs with the PostCompact hook
# (post-compact-summary.sh) and the SessionStart "compact" hook (post-compact-context.sh).

set -uo pipefail  # deliberately NOT -e: every failure is logged, then exit 0

INPUT=$(cat)
source "${BASH_SOURCE[0]%/*}/_hook-common.sh"; hook_cd "$INPUT" || exit 0
git rev-parse --git-dir >/dev/null 2>&1 || exit 0
cd "$(git rev-parse --show-toplevel)" || exit 0  # handoffs live at the repo root even if the session cd'd into app/

DIR=localNotes/handoffs
LOG="$DIR/precompact.log"
mkdir -p "$DIR" || exit 0
log() { printf '%s %s\n' "$(date -Is)" "$*" >> "$LOG"; }
skip() { log "skip reason=$1${2:+ $2}"; exit 0; }

# The fork inherits this env var, so if the fork itself compacts it never forks again.
[ -n "${APERTURE_HANDOFF_FORK:-}" ] && skip fork

SID=$(jq -r '.session_id // empty' <<<"$INPUT" 2>/dev/null)
TRIGGER=$(jq -r '.trigger // empty' <<<"$INPUT" 2>/dev/null)
TRANSCRIPT=$(jq -r '.transcript_path // empty' <<<"$INPUT" 2>/dev/null)
CUSTOM=$(jq -r '.custom_instructions // empty' <<<"$INPUT" 2>/dev/null)

# Only a UUID and a fixed word ever reach the fork's argv (filename + COI argv safety).
[[ "$SID" =~ $SID_RE ]] || skip bad-session-id
SID8=${SID:0:8}
case "$TRIGGER" in manual | auto) ;; *) TRIGGER=unknown ;; esac
BRANCH=$(handoff_branch)
[ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ] || skip no-transcript "sid=$SID8"
CLAUDE_BIN=$(command -v claude || echo "$HOME/.local/bin/claude")
[ -x "$CLAUDE_BIN" ] || skip no-claude "sid=$SID8"

exec 9>"$DIR/.lock-$SID8"
flock -n 9 || skip locked "sid=$SID8"

# `/compact <instructions>` reach the fork via a file, never argv: user-typed text on a command line is
# COI's kill surface (CLAUDE.md → COI container). The trap runs if Claude Code kills this hook, but the
# fork (its own process group under `timeout`) may outlive it — hence `9>&-`, so it never holds the lock.
INSTR="$DIR/.instructions-$SID8.txt"
trap 'rm -f "$INSTR" "$DIR/.lock-$SID8"' EXIT
EXTRA=""
if [ -n "$CUSTOM" ]; then printf '%s\n' "$CUSTOM" > "$INSTR" && EXTRA=" instructions=file"; fi

find "$DIR" -maxdepth 1 -name '.fork-*.err' -mtime +7 -delete 2>/dev/null
ERR="$DIR/.fork-$SID8-$(date +%s).err"
START=$(date +%s)
# dontAsk: unlisted tools are denied without a prompt, and the flag outranks a `bypassPermissions`
# defaultMode (a resumed -p session doesn't inherit the parent's mode). Only scoped rules: a bare tool
# name, --tools or --permission-prompts would change the tool array and miss the prompt cache.
# `--output` writes a file from git log/diff, hence its denies.
OUT=$(APERTURE_HANDOFF_FORK=1 timeout -k 15 "${APERTURE_HANDOFF_TIMEOUT:-480}" "$CLAUDE_BIN" -p \
  --resume "$SID" --fork-session \
  --permission-mode dontAsk \
  --allowedTools \
  "Read" "Grep" "Glob" "Edit(localNotes/handoffs/**)" \
  "Bash(git status *)" "Bash(git log *)" "Bash(git diff *)" "Bash(git branch --show-current)" \
  "Bash(gh pr list *)" "Bash(gh pr view *)" "Bash(gh run list *)" \
  "Bash(ls *)" "Bash(date *)" "Bash(head *)" "Bash(tail *)" "Bash(grep *)" \
  --disallowedTools \
  "Bash(git log *--output*)" "Bash(git diff *--output*)" \
  "Bash(git push *)" "Bash(git commit *)" "Bash(git add *)" "Bash(git stash *)" \
  "Bash(git checkout *)" "Bash(git switch *)" "Bash(git reset *)" "Bash(git rebase *)" \
  "Bash(gh pr create *)" "Bash(gh pr merge *)" "Bash(gh pr close *)" "Bash(rm *)" \
  --max-turns 20 --max-budget-usd 2 \
  --output-format json --no-session-persistence \
  "/handoff session=$SID trigger=$TRIGGER$EXTRA" </dev/null 2>"$ERR" 9>&-)
RC=$?
DUR=$(($(date +%s) - START))

# total_cost_usd is cumulative over the resumed session's whole history, so tokens are logged instead.
# subtype names a max-turns / max-budget stop.
STATS=$(jq -rs 'last | "fork=\(.session_id // "-" | .[0:8]) subtype=\(.subtype // "-") turns=\(.num_turns // "-") cache_read=\(.usage.cache_read_input_tokens // "-") cache_new=\(.usage.cache_creation_input_tokens // "-") out=\(.usage.output_tokens // "-") denials=\(.permission_denials // [] | length) error=\(.is_error)"' <<<"$OUT" 2>/dev/null)
# An error result (is_error: a refused API call, a usage limit) names its cause: its first 160 chars, stripped
# to [A-Za-z0-9 ._:/-], go on the log line as err="…" — before file=, which post-compact-context.sh anchors
# on at end of line — and the whole result JSON joins the fork's stderr in the .err file.
ERRTXT=$(jq -rs 'last | select(.is_error==true) | .result // "" | tostring | .[0:160]' <<<"$OUT" 2>/dev/null)
ERRTXT=${ERRTXT//[^A-Za-z0-9 ._:\/-]/}
FILE=$(find "$DIR" -maxdepth 1 -name "handoff-*-$SID8.md" -newermt "@$START" -printf '%f\n' 2>/dev/null | sort | tail -1)
log "trigger=$TRIGGER sid=$SID8 branch=$BRANCH rc=$RC dur=${DUR}s ${STATS:-stats=unparsable}${ERRTXT:+ err=\"$ERRTXT\"} file=${FILE:-none}"

if [ -n "$OUT" ] && { [ "$RC" -ne 0 ] || [ "${STATS##* error=}" = true ]; }; then printf '%s\n' "$OUT" >> "$ERR"; fi
[ -s "$ERR" ] || rm -f "$ERR"
exit 0
