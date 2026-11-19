---
paths:
  - 'CLAUDE.md'
  - '.claude/**'
---

# Editing the agent rules: `CLAUDE.md` and `.claude/`

- **A lane never edits these files**: it writes a patch and asks, and the hub applies it on the user's go typed in
  the hub's pane; no relay covers it. A session outside a lane, other than the hub (its own rule changes go as a
  lane), takes the go typed in its own pane (CLAUDE.md → _Approval_; the steps: `docs/ops/HUB.md` → _Agent-rule
  edits_).
- **One home per fact.** Root `CLAUDE.md` holds what every session needs every time, above all the safety rules
  (the COI command rule, `.secrets/`, hard-blocked git, MCP write approval). Phase detail lives in
  `docs/ops/FEATURE-WORKFLOW.md`; edit-time detail in a path-scoped file here. A rule here loads only when a
  matching file is read or edited, never on a Bash command — so nothing a session must follow while only running
  commands belongs in one. A rule with no `paths:` costs as much as `CLAUDE.md` itself, and `@imports` load at launch
  too. Tight prose, but a move or a trim never loses a true detail: each fact keeps exactly one home, and every
  other place points at it.
- **Root stays under 200 lines** (Claude Code's guidance: longer files cost context and adherence).
- **A guard change isn't done until a fixture proves both its deny and its allow:** run
  `python3 .claude/hooks/testdata/run-fixtures.py` after touching any hook (`.claude/hooks/README.md` → _Testing_).
  It isn't in CI, so say in the PR body that it ran.
- **Kill-shape text goes through Write/Edit only.** A fixture or rule quoting the COI command rule's shapes, or the
  force-push and force-delete words the hooks match, is written with the Write or Edit tool, never echoed in a Bash
  line (CLAUDE.md → _Commands_).
- **`.claude/settings.json` and `settings.local.json` are read-only mounts** in `/workspace`; a hook registration
  changes from the Mac (`docs/ops/COI-SANDBOX.md`). A worktree's copies are ordinary tracked files, so a patch can
  change them: its ask says so. A new hook reaches only sessions started after it is registered.
- `.claude/**` also matches `.claude/worktrees/**`, so a session in `/workspace` (the hub) loads this file when it
  reads any lane's files: noise, except when the hub applies a lane's patch (first bullet).
