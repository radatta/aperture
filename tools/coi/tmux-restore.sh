#!/usr/bin/env bash
# Save / restore the COI tmux windows, each one resuming its Claude session.
#   bash tools/coi/tmux-restore.sh save      # snapshot windows -> localNotes/tmux-sessions.tsv
#   bash tools/coi/tmux-restore.sh           # restore (inside tmux: into this session; else a new one), after links
#   bash tools/coi/tmux-restore.sh links     # ~/.tmux.conf and ~/.local/bin/xclip → /workspace (main), e.g. after a rebuild
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
    # the flags a relaunch keeps: bypass, and a lane's auto-compact window (docs/ops/LANES.md → Start step 8)
    flags=$(ps -o args= -p "$cpid" | grep -oE -- '--dangerously-skip-permissions|--autocompact [0-9]+' | tr '\n' ' ' || true)
    flags=${flags% }
    printf '%s\t%s\t%s\t%s\n' "$name" "$sid" "$scwd" "$flags" >> "$tsv.tmp"
  done
  # no Claude windows (e.g. right after a rebuild) keeps the last snapshot rather than emptying it
  [ -s "$tsv.tmp" ] || { rm -f "$tsv.tmp"; echo "no Claude windows; kept $tsv" >&2; exit 1; }
  mv "$tsv.tmp" "$tsv"
  echo "saved $(wc -l < "$tsv") windows -> $tsv"
}

# Container config that lives in the repo: linked, so a merged change is live once /workspace is on it.
links() {
  mkdir -p "$HOME/.local/bin"
  ln -sfn /workspace/tools/coi/tmux.conf "$HOME/.tmux.conf"
  ln -sfn /workspace/tools/coi/xclip "$HOME/.local/bin/xclip" # Ctrl+V of a Mac image (docs/ops/COI-SANDBOX.md)
  echo "linked ~/.tmux.conf, ~/.local/bin/xclip"
}

restore() {
  links
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

case "${1:-restore}" in save) save ;; restore) restore ;; links) links ;; *) echo "usage: $0 [save|restore|links]"; exit 2 ;; esac
