---
name: back
description: The maintainer is back — what moved since /away, then the brief (`/back`). User-invoked only, in the hub's pane.
disable-model-invocation: true
---

# Back

Hub only: you run in `/workspace` as the session `scripts/board/hub.json` names. In a lane's worktree, reply "type
this in the hub's pane" and stop; never `cd /workspace` to run it.

Run `pnpm -s board back`, then `pnpm -s board brief`, from `/workspace`, and paste both verbatim in one code block.
Normal replies again. Only `back: no away.json` → paste the brief alone and say there was no `/away`; any other
`board cli:` line is pasted as is.
