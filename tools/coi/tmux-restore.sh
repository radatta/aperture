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
  tmux list-panes -a -F '#{window_index} #{window_name} #{pane_pid} #{pane_current_path}' | sort -n | while read -r idx name ppid cwd; do
    cpid=$(ps -o pid=,comm= --ppid "$ppid" | awk '$2=="claude"{print $1; exit}')
    [ -n "$cpid" ] || continue
    meta="$HOME/.claude/sessions/$cpid.json"
    [ -f "$meta" ] || continue
    sid=$(jq -r .sessionId "$meta"); scwd=$(jq -r .cwd "$meta")
    flags=$(ps -o args= -p "$cpid" | grep -o -- '--dangerously-skip-permissions' || true)
    printf '%s\t%s\t%s\t%s\n' "$name" "$sid" "$scwd" "$flags" >> "$tsv.tmp"
  done
  mv "$tsv.tmp" "$tsv"
  echo "saved $(wc -l < "$tsv") windows -> $tsv"
}

restore() {
  [ -f "$tsv" ] || { echo "no $tsv"; exit 1; }
  if [ -n "${TMUX:-}" ]; then sess=$(tmux display -p '#S'); else sess=aperture; tmux has-session -t "$sess" 2>/dev/null || tmux new-session -d -s "$sess" -n _boot -c /workspace; fi
  while IFS=$'\t' read -r name sid cwd flags; do
    if tmux list-windows -t "$sess" -F '#{window_name}' | grep -qx "$name"; then echo "skip $name (window exists)"; continue; fi
    tmux new-window -d -t "$sess:" -n "$name" -c "$cwd"
    tmux send-keys -t "$sess:$name" "claude --resume $sid -n $name $flags" Enter
    echo "restored $name"
    sleep 3 # stagger the 12 startups
  done < "$tsv"
  [ -n "${TMUX:-}" ] || exec tmux attach -t "$sess"
}

case "${1:-restore}" in save) save ;; restore) restore ;; *) echo "usage: $0 [save|restore]"; exit 2 ;; esac
