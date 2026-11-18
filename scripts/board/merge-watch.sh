#!/bin/bash
# The hub's merge watcher (docs/ops/SESSION-BOARD.md → Watchers → merge-watch): every 30 s it reads the `merged` rows
# the main sync appends to history/events-<day>.jsonl (merge-record.ts) and the Mac lines' exit codes in ran/<id>
# (ran.ts), and exits ONLY when there is something new, so the hub wakes just then:
#   10 = one or more PRs merged on main (one MERGED line each; any RAN lines ride along)
#   11 = a handed-out Mac line finished, no merge (one RAN line each)
#   2  = an argument (it takes none)
# Once each: merge-announced keeps the announced merge shas (the last 200); a missing one is the first run, which
# seeds it with every sha already there and announces none. ran-announced keeps `<id> <mtime>` per marker read, so the
# same line run again (a new mtime) fires again. A marker is read only when its name could be one ran.ts issued, it
# is a plain file (no symlink) of at most 8 bytes, and then only its first 4 bytes, as a 1–3 digit number; anything
# else waits one tick (a write caught mid-way) and is then announced as unreadable, its content never echoed.
# Run: timeout 65m scripts/board/merge-watch.sh   (124 = an hour, nothing happened: restart it)
set -u
[ $# -eq 0 ] || { echo "usage: merge-watch.sh (no arguments; docs/ops/HUB.md → Watchers)" >&2; exit 2; }
source "$(dirname "${BASH_SOURCE[0]}")/watch-lib.sh"
W=merge-watch
EVERY=30 # a merge or a Mac line is a few minutes' news; the sync records merges every 120 s
sb_init_dirs
HIST=$BOARD_DIR/history
ANN=$BOARD_DIR/merge-announced
RAN=$BOARD_DIR/ran
RANN=$BOARD_DIR/ran-announced
ID_RE='^[a-z0-9][a-z0-9-]{0,31}$' # ran.ts RAN_ID
mkdir -p "$RAN"
touch "$RANN"
# markers a week old are done with, read or not
find "$RAN" -maxdepth 1 -type f -mmin +10080 -delete 2>/dev/null

# The merged rows of the two newest events files (name order is date order), as `sha<TAB>pr<TAB>mergedAt<TAB>title`;
# a torn line, a bad sha or a non-numeric pr is dropped, and the title loses any control byte.
merges() {
  local files=("$HIST"/events-*.jsonl)
  [ -e "${files[0]}" ] || return 0
  local n=${#files[@]} pick=("${files[@]: -2}")
  [ "$n" -ge 2 ] || pick=("${files[0]}")
  grep -h -F '"kind":"merged"' "${pick[@]}" 2>/dev/null | jq -Rr '
    fromjson? | objects | select(.kind == "merged" and (.pr | type) == "number" and (.sha | type) == "string")
    | select(.sha | test("^[0-9a-f]{40}$"))
    | [.sha, (.pr | floor | tostring), ((.mergedAt // "") | tostring),
       ((.title // "") | tostring | gsub("[[:cntrl:]]"; " ") | .[0:120])] | @tsv'
}

if [ ! -e "$ANN" ]; then
  merges | cut -f1 | tail -n 200 >"$ANN.tmp.$$" && mv -f "$ANN.tmp.$$" "$ANN"
  echo "$(date '+%m-%d %H:%M') first run: seeded $(wc -l <"$ANN") merge(s), none announced" >>"$BOARD_DIR/$W.log"
fi

declare -A pending=() # marker id → its mtime, for one read that wasn't a number yet
while :; do
  now=$(date +%s)
  lines=() shas=() rans=()
  declare -A batch=()
  while IFS=$'\t' read -r sha pr at title; do
    [ -n "$sha" ] || continue
    [ -z "${batch[$sha]:-}" ] || continue
    grep -qxF "$sha" "$ANN" 2>/dev/null && continue
    batch[$sha]=1
    shas+=("$sha")
    hm=$(date -d "$at" +%H:%M 2>/dev/null) || hm='?'
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
    code=''
    IFS= read -r -n 4 code <"$f" 2>/dev/null
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
    # recorded before the exit, so a restart is quiet
    if [ ${#shas[@]} -gt 0 ]; then
      { cat "$ANN" 2>/dev/null; printf '%s\n' "${shas[@]}"; } | tail -n 200 | sb_write "$ANN"
    fi
    if [ ${#rans[@]} -gt 0 ]; then
      { cat "$RANN" 2>/dev/null; printf '%s\n' "${rans[@]}"; } | tail -n 200 | sb_write "$RANN"
    fi
    for l in "${lines[@]}"; do wl_say $W "$l"; done
    [ ${#shas[@]} -gt 0 ] && exit 10
    exit 11
  fi
  sleep "$EVERY"
done
