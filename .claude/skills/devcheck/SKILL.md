---
name: devcheck
description: Test the deployed dev stage as the dev test user — headless Chromium, screenshots, cleanup by recorded id. Use at the Feature workflow's dev test (phase 8) after `pnpm bot deploy-dev` dispatched the branch, or when asked to check something on dev.
---

# Run the dev check

The reference is `docs/ops/DEV-CHECK.md`. This is the procedure.

## Before

- The branch's commit is on dev through `pnpm bot deploy-dev` (a `deploy-dev <sha> <key>` run). `git rev-parse HEAD` is what
  the check expects unless you pass `--sha`.
- Nothing heavy is running in the container — no `pnpm test`, no dev server, no other headless browser. A
  second dev check refuses to start (`run.lock`).
- Setup exists: `/workspace/.secrets/devcheck.dev.env` and `~/pw` with Playwright. Missing → the run fails
  `ENV_MISSING` / `PW_MISSING`; that is an operator step, not something to work around.

## Run

```bash
pnpm devcheck --tier full                                   # the phase 8 run
pnpm devcheck --tier delta --scenario <feature-scenario>    # iterating on one feature
```

It waits for the deploy (up to ~25 min) and the edge itself — run it in the background with a long timeout
rather than polling `gh` by hand. Exit 0 PASS, 1 FAIL, 2 CRASH.

## After

1. Read `localNotes/devcheck/<run>/report.md`. The first line is the status.
2. **Read the screenshots** — both themes. A PASS with a broken-looking screen is not tested; say what you see.
3. On FAIL, the reason codes table in `docs/ops/DEV-CHECK.md` says what to do. `DEV_CHANGED_MID_RUN` means
   main won: read the merged PRs, rebase, gate, ask for the push again, rerun.
4. Leftovers must be 0. Never delete anything the report lists as "not in the ledger" — report it.

## A feature's own scenario

Phase 8 wants proof of what the feature changed, not just smoke. Add `scripts/src/devcheck/scenarios/<feature>.ts`
(template in the doc), register it in `scenarios/index.ts`, and it rides the PR like any other test. Steps
mirror what you would have asked the user to click; every created task comes from the UI or `ctx.api.writes`,
so cleanup knows its id.
