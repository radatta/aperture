---
name: burn
description: Usage now and where it lands at the weekly reset (and at a time), low–high (`/burn`, `/burn 23:00`). User-invoked only, in the hub's pane.
argument-hint: '[HH:MM]'
disable-model-invocation: true
---

# Burn

Hub only: you run in `/workspace` as the session `scripts/board/hub.json` names. In a lane's worktree, reply "type
this in the hub's pane" and stop; never `cd /workspace` to run it.

## Arguments

$ARGUMENTS

Run `pnpm -s usage burn` from `/workspace` and paste its output verbatim in a code block. A first word of the form
`HH:MM` adds `--at <HH:MM>`; any other first word runs no `--at`, and the words are the user's question. It scans
first (a few seconds). No prose beyond one line for a question the user asked with it.
