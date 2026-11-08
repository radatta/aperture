#!/usr/bin/env bash
# Save / restore the COI tmux windows, each one resuming its Claude session.
#   bash tools/coi/tmux-restore.sh save      # snapshot windows -> localNotes/tmux-sessions.tsv
#   bash tools/coi/tmux-restore.sh           # restore (inside tmux: into this session; else a new one)
# The snapshot holds session ids, so it lives in the gitignored localNotes/, not beside this script.
set -euo pipefail
tsv=/workspace/localNotes/tmux-sessions.tsv

save() {
  mkdir -p "${tsv%/*}"
  : > "$tsv.tmp"
  # name last: read hands it the rest of the line, so it may hold spaces, tabs or nothing
  tmux list-panes -a -F $'#{window_index}\t#{pane_pid}\t#{window_name}' | sort -n | while IFS=$'\t' read -r _ ppid name; do
    cpid=$(ps -o pid=,comm= --ppid "$ppid" | awk '$2=="claude"{print $1; exit}' || true) # a childless pane fails ps
    [ -n "$cpid" ] || continue
    meta="$HOME/.claude/sessions/$cpid.json"
    [ -f "$meta" ] || continue
    sid=$(jq -r .sessionId "$meta"); scwd=$(jq -r .cwd "$meta")
    flags=$(ps -o args= -p "$cpid" | grep -o -- '--dangerously-skip-permissions' || true)
    printf '%s\t%s\t%s\t%s\n' "$name" "$sid" "$scwd" "$flags" >> "$tsv.tmp"
  done
  # no Claude windows (e.g. right after a rebuild) keeps the last snapshot rather than emptying it
  [ -s "$tsv.tmp" ] || { rm -f "$tsv.tmp"; echo "no Claude windows; kept $tsv" >&2; exit 1; }
  mv "$tsv.tmp" "$tsv"
  echo "saved $(wc -l < "$tsv") windows -> $tsv"
}

restore() {
  [ -f "$tsv" ] || { echo "no $tsv"; exit 1; }
  if [ -n "${TMUX:-}" ]; then sess=$(tmux display -p '#S'); else sess=aperture; tmux has-session -t "$sess" 2>/dev/null || tmux new-session -d -s "$sess" -n _boot -c /workspace; fi
  while IFS=$'\t' read -r name sid cwd flags; do
    if grep -qxF -- "$name" <<<"$(tmux list-windows -t "$sess" -F '#{window_name}')"; then echo "skip $name (window exists)"; continue; fi
    win=$(tmux new-window -d -P -F '#{window_id}' -t "$sess:" -n "$name" -c "$cwd")
    tmux send-keys -t "$win" "$(printf 'claude --resume %q -n %q' "$sid" "$name") $flags" Enter
    echo "restored $name"
    sleep 3 # stagger the startups
  done < "$tsv"
  [ -n "${TMUX:-}" ] || exec tmux attach -t "$sess"
}

case "${1:-restore}" in save) save ;; restore) restore ;; *) echo "usage: $0 [save|restore]"; exit 2 ;; esac
