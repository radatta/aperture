---
name: eta
description: Lane and plan ETAs, from the board (`/eta`). User-invoked only, in the hub's pane.
disable-model-invocation: true
---

# ETAs

Hub only: you run in `/workspace` as the session `scripts/board/hub.json` names. In a lane's worktree, reply "type
this in the hub's pane" and stop; never `cd /workspace` to run it.

Run `pnpm -s board eta` from `/workspace` and paste its output verbatim in a code block. If it refuses with
`(got eta)` (the verb isn't there), say "`pnpm board eta` is not on main yet (the board-eta lane)" and paste the
brief's LANES block instead (`set -o pipefail; pnpm -s board brief | sed -n '/^TOWER DOWN/p;/^LANES/,/^SLOTS/p'`): a
TOWER DOWN line comes with it, and a brief that refuses (no file yet) is pasted as it printed.
