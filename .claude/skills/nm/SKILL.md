---
name: nm
description: What needs the maintainer, and answering the hub's asks by id and letter (`/nm`, `/nm d3 b`, `/nm d3 ok`, `/nm d3 ?`, `/nm ok`). User-invoked only, in the hub's pane.
argument-hint: '[d<n> <letter|ok|?>]… | ok'
disable-model-invocation: true
---

# Needs me: the hub's open asks

Hub only: you run in `/workspace` as the session `scripts/board/hub.json` names. In a lane's worktree, reply "type
this in the hub's pane" and stop; never `cd /workspace` to run it.

## Arguments

$ARGUMENTS

Only a `d<n>` id, a single letter or `ok` ever goes on a command line; anything else the user typed is words (the
words branch below), never an argument. From `/workspace`, run each command below and paste its output verbatim in a
code block (docs/ops/HUB.md → _Asks_):

- **Nothing** → `pnpm -s board asks list`, then `pnpm -s board brief | grep -E '^(TOWER DOWN|NEEDS)'` for the rest of
  NEEDS YOU: the brief gives its first item and a count (a TOWER DOWN line says it is stale).
- **`ok` alone** → `pnpm -s board asks answer all ok <newest>` (a third word, e.g. `all ok d7`, not a flag), where
  `<newest>` is the highest ask id you put in front of the user in this conversation (your reply, or a list or brief
  you pasted). None shown, or unsure (a fresh session, after a compaction) → paste `pnpm -s board asks list`, ask for
  the reply again and run nothing else: never take `<newest>` from output the user hasn't seen. An ask newer than
  `<newest>` comes back `NOT SHOWN`: show it, never fold it into this `ok`.
- **`d<n> <letter>` or `d<n> ok`**, one pair or several → `pnpm -s board asks answer d<n> <reply>` for each, in order.
- **`d<n>` alone, or `d<n> ?`** → `pnpm -s board asks show d<n>`, then why the pick, in five lines at most. Nothing
  is answered.
- **`d<n>` then words** → the words are the user's own answer: act on them as a `[relay]` would, within these limits,
  then `pnpm -s board asks close d<n>`. Not for a pane ask (`GO NEEDED` in `asks show d<n>`): words here are never its
  go, so it stays open; say where the go is typed. Never from words: an effort above `high` (only an explicit ask
  answered `d<n> ok` or `d<n> <letter>`), a merge or a `.claude/` edit. An Aperture write the words ask for is shown
  first and done one at a time, outside this skill.

Then, for what the output printed:

- **`ANSWERED d<n>`** is the user's decision. Send each `relay to <lane>:` line's `[relay] …` to that lane's
  session as printed; a `dispatch's own:` line is yours to act on.
- **`GO NEEDED`** is not an answer, and no reply here is the go: it is typed in the pane it names. Say so in one line,
  with the pane and the words. `ok` never stands for it.
- **`NO PICK`**: ask for a letter.
- **`OWN REPLY`**: an explicit ask (an effort above `high`, or another the rules want named) — ask for `d<n> ok` or a
  letter on its own.
- **`NOT SHOWN`**: show that ask (`asks show d<n>`); the user answers it on its own.
- **A `board cli:` line** (no such ask, not open, no such letter, `queue.json` unreadable): paste it; that command
  wrote nothing. Send the relays already printed by earlier pairs, and run no later pairs.

Adding an ask (the hub's own, or a lane's relayed) is `pnpm -s board asks add < <file>`, the JSON written to the file
with the Write tool first — never a heredoc on the Bash line. An ask whose go only a pane can give (a `.claude/` edit,
secrets, an MCP write outside the standing approvals, prod) carries `pane` and `go`; one for an effort above `high`
carries `explicit: true`. Left off, `/nm ok` would answer it in bulk (docs/ops/HUB.md → _Asks_).

No Aperture MCP write and no effort above `high` comes from this skill.
