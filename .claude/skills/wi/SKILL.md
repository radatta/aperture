---
name: wi
description: What an id is — an F-number, a PR, an ask or a lane (`/wi F209`, `/wi 206`, `/wi d3`, `/wi warm-caches`). User-invoked only, in the hub's pane.
argument-hint: '<F-number | PR n | d<n> | lane>'
disable-model-invocation: true
---

# What is

Hub only: you run in `/workspace` as the session `scripts/board/hub.json` names. In a lane's worktree, reply "type
this in the hub's pane" and stop; never `cd /workspace` to run it.

## Arguments

$ARGUMENTS

No id → ask for one and stop. An id that isn't `F<n>`, `<n>`, `PR <n>`, `#<n>`, `d<n>` or a lane name
(`^[a-z0-9][a-z0-9-]*$`) → say what is accepted and stop, running nothing. Otherwise run `pnpm -s board wi '<id>'`
from `/workspace` (one argument: `'PR 206'`
quoted) and paste its output verbatim. `not found` → say so in one line. Explain further only if asked.
