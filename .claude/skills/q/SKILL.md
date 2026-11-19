---
name: q
description: Queue or start lanes (`/q a b c`, `/q a collab`, `/q ! a`, `/q top a`, `/q -a`). User-invoked only, in the hub's pane.
argument-hint: '<lane>… [collab] | ! <lane> | top <lane> | -<lane>'
disable-model-invocation: true
---

# Queue lanes

Hub only: you run in `/workspace` as the session `scripts/board/hub.json` names. In a lane's worktree, reply "type
this in the hub's pane" and stop; never `cd /workspace` to run it.

## Arguments

$ARGUMENTS

No lane named → ask which and stop. The typed `/q` is the user's approval to start the lanes it names, and only
those (docs/ops/HUB.md → _Watchers_: `autoStart` entries are approved starts).

- A lane name matches `^[a-z0-9][a-z0-9-]*$` (a branch name, never a leading `-`); any other is named and skipped.
- **`<lane>…`** → for each, its kickoff must exist at `/workspace/localNotes/kickoffs/<lane>.md`; a missing one is
  named and that lane skipped — never written and queued in the same turn (the kickoff goes to the user first).
  Append to `/workspace/localNotes/board/queue.json` `autoStart`
  `{branch, order, class: "p1", after: [], kickoff, approvedAt: <now ISO>, note}`, the next `order` after the last:
  the whole file written with the Write tool to `queue.json.tmp` beside it, then `mv` (never jq or node on the Bash
  line: `note` is free text). The mode goes in `note`: `autonomous`, or `collaborative` when `collab` is given.
- **`! <lane>`** → from `/workspace`, `pnpm lanes start <lane> --kickoff /workspace/localNotes/kickoffs/<lane>.md`
  now. A pace or cap refusal is printed as is and the lane queued instead; never `--over-cap` or `--over-pace`.
- **`top <lane>`** → give it the lowest `order`. **`-<lane>`** → drop its entry.

Then run `(cd /workspace/scripts && node ../localNotes/board/pq-check.ts)` (a subshell: the hub stays in
`/workspace`) and paste its first line. Nothing here writes Aperture data or sets an effort above `high`.
