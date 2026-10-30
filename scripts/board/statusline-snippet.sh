#!/bin/bash
# Sourced at the end of ~/.claude/statusline-command.sh: appends the board line (written by the sampler every
# 30 s) to every session's status line. Builtins only — no processes; silent when the board is absent.
if [ -r /workspace/localNotes/board/status.line ]; then
  IFS= read -r _board </workspace/localNotes/board/status.line
  [ -n "$_board" ] && printf ' \033[2m· %s\033[0m' "${_board#board: }"
  unset _board
fi
