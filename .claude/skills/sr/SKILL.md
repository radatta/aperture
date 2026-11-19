---
name: sr
description: Status report — the board brief, verbatim (`/sr`). User-invoked only, in the hub's pane.
disable-model-invocation: true
---

# Sitrep

Hub only: you run in `/workspace` as the session `scripts/board/hub.json` names. In a lane's worktree, reply "type
this in the hub's pane" and stop; never `cd /workspace` to run it.

Run `pnpm -s board brief` from `/workspace` and paste its output verbatim in a code block. Add one line after it
only for what the brief can't know (a lane's message since its last write, say). No prose summary
(docs/ops/HUB.md → _The hub's duties_ → _Status_).
