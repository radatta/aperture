---
paths:
  - 'CLAUDE.md'
  - '.claude/**'
---

# Editing the agent rules: `CLAUDE.md` and `.claude/`

- **The user's go, in this pane.** Any edit here needs the user's go typed in the acting session's own pane — a hub
  relay never covers it (`docs/ops/HUB.md` → _Approval_).
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
- **`.claude/settings.json` and `settings.local.json` are read-only mounts** in the container; a hook registration
  changes from the Mac (`docs/ops/COI-SANDBOX.md`). A new hook reaches only sessions started after it is registered.
- `.claude/**` also matches `.claude/worktrees/**`, so a session in `/workspace` (the hub) loads this file when it
  reads any lane's files: noise, not a rule change.
