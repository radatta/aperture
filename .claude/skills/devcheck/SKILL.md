---
name: devcheck
description: Test the deployed dev stage as the dev test user — headless Chromium, screenshots, cleanup by recorded id. Use at the Feature workflow's dev test (phase 8) after `pnpm bot deploy-dev` dispatched the branch, or when asked to check something on dev.
---

# Run the dev check

The reference is `docs/ops/DEV-CHECK.md`. This is the procedure.

## Before

- The local check passed first: `pnpm devcheck:local --tier full --feature <feature-scenario>` (`docs/ops/LOCAL-CHECK.md`)
  — the same scenarios in the container in seconds, no lock. It catches step bugs; it proves nothing about dev.
- The branch's commit is on dev through `pnpm bot deploy-dev` (a `deploy-dev <sha> <key>` run). `git rev-parse HEAD` is what
  the check expects unless you pass `--sha` — which is also how a scenario-only fix proves the build already on
  dev (`scripts/` isn't deployed, so no redeploy).
- Nothing heavy is running in the container — no `pnpm test`, no dev server, no other headless browser — except
  another session's dev check on the other slot, which is fine. A second dev check on the same slot refuses to start
  (`run.lock` / `run.devb.lock`). `HEAVY_CLASS=ui scripts/board/heavy.sh -- pnpm devcheck …` puts the run on the board.
- Setup exists: `/workspace/.secrets/devcheck.dev.env` and `~/pw` with Playwright. Missing → the run fails
  `ENV_MISSING` / `PW_MISSING`; that is an operator step, not something to work around.

## Run

```bash
pnpm devcheck --tier full --feature <feature-scenario>      # the phase 8 run
pnpm devcheck --tier delta --scenario <feature-scenario>    # iterating on one feature (--feature defaults to it)
```

It waits for the deploy (up to ~25 min) and the edge itself — run it in the background with a long timeout
rather than polling `gh` by hand. Exit 0 PASS, 1 FAIL, 2 CRASH. A branch with no scenario of its own (harness,
docs, infra) runs without `--feature`; naming a scenario that isn't in the run is an error, not an empty section.

## After

1. Read `localNotes/devcheck/<run>/report.md`. The first line is the status; then _Feature coverage_ — every row
   — under _This feature_ and _Other scenarios (regression)_ alike — must be `pass`, `off dev` or `needs you`. A
   `fail` or `skipped` row is not proven, whatever the status line says; under _Other scenarios_ it
   is a regression, still a bug (phase 9; the fails-on-main fallback in the doc).
2. **Read the screenshots** — both themes. A PASS with a broken-looking screen is not tested; say what you see.
3. On FAIL, the reason codes table in `docs/ops/DEV-CHECK.md` says what to do. A line under _Throttled (429)_ is a
   bug too, never weather (its _Throttles (429)_). `DEV_CHANGED_MID_RUN` means main won:
   read the merged PRs, rebase, gate, `pnpm bot push --after-rebase` (a `.github/workflows/` branch: the user's push),
   `pnpm bot deploy-dev`, rerun.
4. Leftovers must be 0. Never delete anything the report lists as "not in the ledger" — report it.
5. Paste _This feature_'s _You don't need to test_ and _Needs you_ into `report-<branch>.md` and the `[pr-open]` message —
   never _Other scenarios_'. Without `--feature` (a branch with no scenario of its own) there are none: write "no
   feature rows".

## A feature's own scenario

Phase 8 wants proof of what the feature changed, not just smoke. Add `scripts/src/devcheck/scenarios/<feature>.ts`
(template in the doc), register it in `scenarios/index.ts`, and it rides the PR like any other test. Its `rows`
are the plan's matrix and each step names its `entry` and the rows it `proves` (`docs/ops/DEV-CHECK.md` → _Rows_):
a row nothing proves through its own entry is `MATRIX_GAP` at load, and `scenarios/index.test.ts` fails the gate
on it first. Steps mirror what you would have asked the user to click; every created task comes from the UI or
`ctx.api.writes`, so cleanup knows its id.
