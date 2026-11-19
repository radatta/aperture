---
name: away
description: The maintainer is stepping away — stamp the time, terse replies until /back (`/away`, `/away ping`). User-invoked only, in the hub's pane.
argument-hint: '[ping]'
disable-model-invocation: true
---

# Away

Hub only: you run in `/workspace` as the session `scripts/board/hub.json` names. In a lane's worktree, reply "type
this in the hub's pane" and stop; never `cd /workspace` to run it.

## Arguments

$ARGUMENTS

Run `pnpm -s board away` from `/workspace` (`pnpm -s board away ping` when the arguments say `ping`; anything
else → say `/away` takes only `ping` and stop) and paste its line. Until `/back`:

- one- or two-line replies, no tables;
- a phone ping only if `ping` was given, and only for a new open ask or NEEDS YOU item;
- work goes on as approved. A stop at a time is `/hs`, not this.
