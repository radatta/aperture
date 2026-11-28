#!/bin/bash
# The hub's merge watcher: every 30 s it reads the `merged` rows the main sync appends to history/events-<day>.jsonl
# (merge-record.ts) and the Mac lines' markers in ran/<id> (ran.ts), and exits ONLY when there is something new:
#   10 = one or more PRs merged on main (one MERGED line each; any RAN lines ride along)
#   11 = a handed-out Mac line finished, no merge (one RAN line each)
#   74 = its own state file couldn't be written (stderr names it): a restart would announce the same again
#   73 = another copy holds the lock (the line names its pid)   74 also = the lock or pid file unusable
#   78 = jq is missing   2 = an argument (it takes none)
# What it reads and keeps, and the checks a marker passes before it is read: docs/ops/SESSION-BOARD.md → Watchers.
# Run: timeout 65m scripts/board/merge-watch.sh   (124 = an hour, nothing happened: restart it)
set -u
[ $# -eq 0 ] || { echo "usage: merge-watch.sh (no arguments; docs/ops/HUB.md → Watchers)" >&2; exit 2; }
source "$(dirname "${BASH_SOURCE[0]}")/watch-lib.sh"
W=merge-watch
EVERY=30 # a merge or a Mac line is a few minutes' news; the sync records merges every 120 s
sb_init_dirs
command -v jq >/dev/null || { echo "$W: jq missing" | tee -a "$BOARD_DIR/$W.log" >&2; exit 78; }
wl_singleton $W
HIST=$BOARD_DIR/history
ANN=$BOARD_DIR/merge-announced
RAN=$BOARD_DIR/ran
RANN=$BOARD_DIR/ran-announced
ID_RE='^[a-z0-9][a-z0-9-]{0,31}$' # ran.ts RAN_ID
US=$'\x1f'                         # field separator: not whitespace, so an empty field stays a field
mkdir -p "$RAN"
[ -e "$RANN" ] || : >"$RANN"
# markers a week old are done with, read or not
find "$RAN" -maxdepth 1 -type f -mmin +10080 -delete 2>/dev/null

fail() { echo "$W: cannot write $1" | tee -a "$BOARD_DIR/$W.log" >&2; exit 74; }
put() { local t="$1.tmp.$$"; cat >"$t" && mv -f "$t" "$1" || { rm -f "$t"; return 1; }; } # sb_write, empty allowed

# The merged rows of the two newest events files (name order is date order), one per line as
# sha US pr US mergedAt US title; a torn line, a bad sha or a non-numeric pr is dropped, the text fields lose control
# bytes (US among them), so a field never splits.
merges() {
  local files=("$HIST"/events-*.jsonl)
  [ -e "${files[0]}" ] || return 0
  local n=${#files[@]} pick=("${files[@]: -2}")
  [ "$n" -ge 2 ] || pick=("${files[0]}")
  grep -h -F '"kind":"merged"' "${pick[@]}" 2>/dev/null | jq -Rr --arg us "$US" '
    fromjson? | objects | select(.kind == "merged" and (.pr | type) == "number" and (.sha | type) == "string")
    | select(.sha | test("^[0-9a-f]{40}$"))
    | [.sha, (.pr | floor | tostring), ((.mergedAt // "") | tostring | gsub("[[:cntrl:]]"; " ")),
       ((.title // "") | tostring | gsub("[[:cntrl:]]"; " ") | .[0:120])] | join($us)'
}

if [ ! -e "$ANN" ]; then
  merges | cut -d "$US" -f1 | tail -n 200 >"$ANN.tmp.$$" && mv -f "$ANN.tmp.$$" "$ANN" || fail "$ANN"
  echo "$(date '+%m-%d %H:%M') first run: seeded $(wc -l <"$ANN") merge(s), none announced" >>"$BOARD_DIR/$W.log"
fi

declare -A pending=() # marker id → its mtime, for one read that wasn't a number yet
while :; do
  now=$(date +%s) # wl_at reads it
  lines=() shas=() rans=()
  declare -A batch=()
  while IFS="$US" read -r sha pr at title; do
    [ -n "$sha" ] || continue
    [ -z "${batch[$sha]:-}" ] || continue
    grep -qxF "$sha" "$ANN" 2>/dev/null && continue
    batch[$sha]=1
    shas+=("$sha")
    hm='?'
    [ -z "$at" ] || hm=$(date -d "$at" +%H:%M 2>/dev/null) || hm='?' # date -d '' would read as midnight
    lines+=("$(wl_at +%H:%M) MERGED PR $pr ${sha:0:7} at $hm \"$title\"")
  done < <(merges)
  unset batch

  for f in "$RAN"/*; do
    id=${f##*/}
    [[ "$id" =~ $ID_RE ]] || continue
    [ ! -L "$f" ] && [ -f "$f" ] || continue
    read -r size mt < <(stat -c '%s %Y' -- "$f" 2>/dev/null) || continue
    [ "${size:-9}" -le 8 ] || continue
    grep -qxF "$id $mt" "$RANN" && continue
    # timeout around the open too: a FIFO swapped in after the -f check blocks in open(), not in the read
    code=$(timeout 1 head -c 4 -- "$f" 2>/dev/null)
    if [[ "$code" =~ ^[0-9]{1,3}$ ]]; then
      rans+=("$id $mt")
      lines+=("$(wl_at +%H:%M) RAN $id exit $((10#$code))")
    elif [ "${pending[$id]:-}" = "$mt" ]; then
      rans+=("$id $mt")
      lines+=("$(wl_at +%H:%M) RAN $id unreadable (not an exit code)")
    else
      pending[$id]=$mt
    fi
  done

  if [ ${#shas[@]} -gt 0 ] || [ ${#rans[@]} -gt 0 ]; then
    # recorded before the exit, so a restart is quiet; a write that fails still says its lines, then exits 74 rather
    # than wake the hub in a loop (what it recorded is never said again, so it is never lost unsaid)
    bad=''
    if [ ${#shas[@]} -gt 0 ]; then
      { cat "$ANN" 2>/dev/null; printf '%s\n' "${shas[@]}"; } | tail -n 200 | sb_write "$ANN" || bad=$ANN
    fi
    if [ ${#rans[@]} -gt 0 ]; then
      # one entry per marker still on disk (the week's prune bounds it), so none is ever dropped and said again
      { cat "$RANN" 2>/dev/null; printf '%s\n' "${rans[@]}"; } | while read -r i m; do
        [[ "$i" =~ $ID_RE ]] && [ -e "$RAN/$i" ] && printf '%s %s\n' "$i" "$m"
      done | put "$RANN" || bad=$RANN
    fi
    for l in "${lines[@]}"; do wl_say $W "$l"; done
    [ -z "$bad" ] || fail "$bad"
    [ ${#shas[@]} -gt 0 ] && exit 10
    exit 11
  fi
  sleep "$EVERY" 8>&-
done
