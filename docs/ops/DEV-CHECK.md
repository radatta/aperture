# Dev check — Claude tests the deployed dev stage itself

`pnpm devcheck` drives headless Chromium, signed in as a dev-only test user, against
`https://dev.aperture.rahuldatta.dev`, after the branch is pushed to `dev`. It waits for the deploy, proves
the page is the commit under test, runs scenarios with screenshots in both themes, deletes everything it
created, and writes a report. It replaces the Claude-in-Chrome runbooks: a green full run with zero
leftovers, plus Claude reading the screenshots, is what "tested on dev" means (CLAUDE.md → _Feature workflow_,
phases 8–9). Code: `scripts/src/devcheck/`.

```
push to dev ─► Deploy run (gh) ─► edge serves <meta aperture-build=SHA> ─► sign in (Hosted UI, cached)
   ─► sweep earlier leftovers ─► in-page build check ─► scenarios ─► finally: delete ledger ids,
   verify none left, dev build unchanged ─► localNotes/devcheck/<run>/report.md + shots/
```

## Run it

From the worktree whose commit is on dev, with nothing else heavy running (no `pnpm test`, no dev server —
CLAUDE.md → COI ceilings):

```bash
pnpm devcheck --tier smoke                         # ~2 min: sign-in, main pages, an API read; writes nothing
pnpm devcheck --tier full                          # every scenario
pnpm devcheck --tier delta --scenario capture-task # smoke + the named feature scenarios
```

`--sha <40-hex>` checks a commit other than `HEAD`; `--no-deploy-wait` skips the deploy and edge wait (dev
already serves it). Exit 0 PASS, 1 FAIL, 2 CRASH. Read `report.md` first — its first line is the status — then
the screenshots. One run per container at a time (`localNotes/devcheck/run.lock`).

## One-time setup

1. **Test user** (dev pool only — never prod). On the Mac, the plan's operator step creates it with
   `aws cognito-idp admin-create-user` (invite suppressed, email verified) and a permanent random password,
   and writes `/workspace/.secrets/devcheck.dev.env` (mode 600, gitignored) with `DEVCHECK_EMAIL`,
   `DEVCHECK_PASSWORD`, `DEVCHECK_SUB`, `DEVCHECK_COGNITO_HOST`, `DEVCHECK_CLIENT_ID`, `DEVCHECK_POOL_ID`. The
   password is never shown; the harness reads the file. `docs/arch/INFRA.md` §6 records the user.
2. **Playwright, outside the repo** — it is no package's dependency (it would add a browser download to every
   CI install, and no test needs it): `mkdir -p ~/pw && cd ~/pw && npm init -y && npm install playwright && npx
playwright install chromium`. The harness loads it from `~/pw` (`DEVCHECK_PW_ROOT` overrides;
   `DEVCHECK_CHROMIUM` points at a system Chromium). Check `npm view playwright version` before refreshing.

## What it guarantees

- **Dev only.** The origin is a constant; every request asserts it. There is no prod switch.
- **The test user only.** The env file must name the test user, and before any write the signed-in
  session's email and `sub` (ID claims and access token) must match it — else `WRONG_USER`, no writes.
- **Deletes by recorded id only.** Every task the run creates is recorded in a ledger from the server's create
  response — the API client's `createTask`, and the browser's `createTask`/`createTasks`/`splitTask`
  responses (a split's new parent and follow-up). Cleanup deletes ledger ids and nothing else; the delete
  wrapper refuses any other id (`LEDGER_GUARD`). Never by title or marker word — the model rewrites titles.
- **Verified, not assumed.** After cleanup every ledger id is read back (`getTask` → null). A task already gone
  (deleted with its parent) is `gone`, not a failure. Tasks in the test partition the ledger doesn't know are
  listed, never deleted. A crashed run's ids stay pending and the next run sweeps them first.
- **The right build.** The deploy run for the SHA must succeed (a `dev` push run by `headSha`, or a dispatched
  `deploy-dev <sha> <key>` run by name), then the edge must serve that SHA in `<meta name="aperture-build">`.
  In the page it reloads up to 3 times — the PWA's service worker can serve the previous shell first — else
  `BUILD_MISMATCH_IN_PAGE`. If dev's build changes before the run ends, `DEV_CHANGED_MID_RUN`.

## Ledgers

| File (in the main checkout's `localNotes/devcheck/`) | Written by                        | Covers                                            |
| ---------------------------------------------------- | --------------------------------- | ------------------------------------------------- |
| `ledger.dev.jsonl`                                   | the harness                       | the test user's partition (browser + API creates) |
| `mcp-ledger.dev.jsonl`                               | `.claude/hooks/mcp-dev-ledger.sh` | the MCP agent's partition on `aperture-dev`       |

Append-only JSONL, one line per event: `{t, run, op, id, via, title?}` with `op` one of `run-start`,
`intent` (an API create about to be sent — one with no `created` after it is reported as a possible leak),
`created`, `deleted`, `gone`, `swept`, `run-end`. `title` is for the report only. The MCP hook denies an
`aperture-dev` `delete_task` whose id has no `created` line, and records the parts a parent's delete took
with it (CLAUDE.md → _Aperture MCP connector_, standing approval 2).

## Reason codes

| Code                       | Means                                                             | Do                                                                      |
| -------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `ENV_MISSING`              | env file absent or a key missing                                  | setup step 1                                                            |
| `PW_MISSING`               | no Playwright in `~/pw`                                           | setup step 2                                                            |
| `DEPLOY_NOT_FOUND`         | no deploy run for the SHA                                         | was it pushed to dev?                                                   |
| `DEPLOY_FAILED`            | the run failed                                                    | read the run; a failed `changes` job means dev was behind main — rebase |
| `DEPLOY_TIMEOUT`           | run never finished, or the edge kept serving another build        | the message names what it serves                                        |
| `AUTH_REDIRECT_UNEXPECTED` | Sign in didn't reach the dev Hosted UI                            | check the env file's host                                               |
| `AUTH_PAGE_CHANGED`        | the Hosted UI form isn't the classic one                          | screenshot in `shots/`; update `login.ts` deliberately                  |
| `AUTH_REJECTED`            | Cognito refused the credentials                                   | password expired or user disabled — operator                            |
| `WRONG_USER`               | the session isn't the test user                                   | delete `.secrets/devcheck.dev.state.json`, rerun                        |
| `BUILD_MISMATCH_IN_PAGE`   | the page kept an old build after 3 reloads                        | rerun; persistent → service-worker bug                                  |
| `STEP_FAILED`              | a scenario step threw                                             | its row has the error and a screenshot                                  |
| `LEDGER_GUARD`             | a delete named an unrecorded id                                   | a harness bug — never bypass                                            |
| `LEFTOVERS`                | a ledger id survived cleanup, or a create's id was never recorded | rerun (the sweep retries); else by hand                                 |
| `DEV_CHANGED_MID_RUN`      | dev's build changed during the run — main won                     | read the merged PRs, rebase, gate, push, rerun                          |

## Writing a scenario

A feature adds `scripts/src/devcheck/scenarios/<feature>.ts` and lists it in `scenarios/index.ts`. A Chrome
runbook maps onto it step for step:

```ts
export const quickAdd: Scenario = {
  id: 'quick-add',
  title: 'Quick add parses a line',
  tiers: ['full'],
  steps: [
    {
      id: 'capture',
      title: 'Auto Enter saves',
      async run(ctx) {
        await ctx.ui.goto('/tasks');
        await ctx.ui.captureTask(`devcheck ${ctx.nonce} tomorrow 20m`);
        await ctx.shot('receipt'); // light + dark
      },
    },
    {
      id: 'server',
      title: 'Fields landed',
      async run(ctx) {
        const task = await ctx.api.reads.getTask(ctx.createdIds().at(-1)!);
        if (task?.estimateMin !== 20) throw new Error(JSON.stringify(task));
      },
    },
  ],
};
```

`ctx` has `page` (Playwright), `ui` (`goto`, `captureTask`, `expectText`, `setTheme`), `api` (reads, and the
ledger-guarded writes), `shot`, `createdIds()`, `consoleErrors()`, `dates` (LA today/tomorrow) and `nonce`
(makes a title findable on screen — never a cleanup key). A step throws to fail; the rest of that scenario is
skipped, the next one still runs, cleanup always does. Prefer the grammar line (space, pipe, space) when the
model isn't what's under test: no Haiku spend, deterministic fields. A step that needs more of Playwright
extends `pw-types.ts`.

## Artifacts

Per run, in the worktree (archived with it): `localNotes/devcheck/<run>/report.md`, `report.json`, `shots/`.
Shared, in the main checkout: the two ledgers and `run.lock`. Secrets beside the env file:
`.secrets/devcheck.dev.state.json` (the cached session, mode 600).

## Why not Claude in Chrome

Found while running the quick-add runbooks (2026-10-13): a container session has no Chrome tools — the
extension talks to Claude over native messaging on the same machine, and the container has no Chrome (viewing
the session from the desktop app doesn't add them). The extension also refuses to delete data even when asked,
so a runbook could only list what to clean. The dev check runs where Claude runs and cleans up by id.
