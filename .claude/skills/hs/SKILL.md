---
name: hs
description: A hard stop at a time — lanes work until a minute before it, then stop clean (`/hs 22:30`, `/hs off`). User-invoked only, in the hub's pane.
argument-hint: '<HH:MM> | off'
disable-model-invocation: true
---

# Hard stop at a time

Hub only: you run in `/workspace` as the session `scripts/board/hub.json` names. In a lane's worktree, reply "type
this in the hub's pane" and stop; never `cd /workspace` to run it.

## Arguments

$ARGUMENTS

No time → ask for one and stop. Anything but `HH:MM` or `off` → say that is what it takes and stop, running nothing.
Otherwise run `pnpm -s board stop <HH:MM>` (or `pnpm -s board stop off`) from `/workspace` with the time as given, and
paste its line; a refusal is pasted as is.

What the hub does when `pace-watch.sh` exits 12 or 74 for this stop: docs/ops/HUB.md → _Watchers_ (those rows, and
_Soft and hard stop_). A stop at a time is never "stop now".
