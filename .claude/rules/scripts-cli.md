---
paths:
  - 'scripts/src/bot/**'
  - 'scripts/src/mailroom/**'
  - 'scripts/src/lane/**'
  - 'scripts/src/board/cli.ts'
  - 'scripts/src/claude-edit/**'
  - 'package.json'
---

# Editing the bot, mailroom, lane, board and claude-edit CLIs

- **Every command has a `FLAGS` entry and calls `cliGuard` first** — before any token, git, network or stdin read
  (`scripts/src/bot/help.ts`: `deploy-dev --help` once ran a real dev deploy). Each CLI's test pins that every usage
  command has a flags entry.
- **A token never reaches an argv**, and neither does kickoff or job text: COI reads every process's argv
  (`docs/ops/LANES.md` → _Start_, step 8).
- **Tests script the world**: the `fakeRun` / scripted-run seams, never the network or a real push.
- **Before anything is published** — `pnpm bot push`, `pnpm mailroom open-pr` — the identifier scan and the
  commit-identity check run on what would go out (`docs/ops/IDENTIFIERS.md`).
- **A root script name must not be a pnpm built-in** (pnpm's `lane` shadowed ours): `scripts/src/root-scripts.test.ts`
  checks every one.
