# Dev check — Claude tests the deployed dev stage itself

`pnpm devcheck` drives headless Chromium, signed in as a dev-only test user, against
`https://dev.aperture.rahuldatta.dev`, after `pnpm bot deploy-dev` dispatched the commit. It waits for the deploy, proves
the page is the commit under test, runs scenarios with screenshots in both themes, deletes everything it
created, and writes a report that leads with which of the feature's coverage rows were proven (_Rows_, below).
It replaces the Claude-in-Chrome runbooks: a green full run with zero leftovers in which every row is proven,
covered off dev or listed for the user, plus Claude reading the screenshots, is what "tested on dev" means
(CLAUDE.md → _Feature workflow_, phases 8–9). Code: `scripts/src/devcheck/`.

```
pnpm bot deploy-dev ─► its run (gh) ─► edge serves <meta aperture-build=SHA> ─► sign in (Hosted UI, cached)
   ─► sweep earlier leftovers ─► in-page build check ─► scenarios ─► finally: delete ledger ids,
   verify none left, dev build unchanged ─► localNotes/devcheck/<run>/report.md + shots/
(before all of it: every scenario's rows checked at load — a gap is MATRIX_GAP, nothing waits on dev)
```

## Run it

From the worktree whose commit `pnpm bot deploy-dev` dispatched, with nothing else heavy running (no `pnpm test`, no dev server —
CLAUDE.md → COI ceilings):

```bash
pnpm devcheck --tier smoke                         # ~2 min: sign-in, main pages, an API read; creates nothing
pnpm devcheck --tier full                          # every scenario
pnpm devcheck --tier delta --scenario capture-task # smoke + the named feature scenarios
```

`--sha <40-hex>` checks a commit other than `HEAD`; `--no-deploy-wait` skips the deploy and edge wait (dev
already serves it). `--sha` is also how a scenario-only commit proves a build already on dev — `scripts/` isn't
deployed, so a fix to a scenario needs no redeploy: run it with `--sha <the deployed SHA>`, and the report's Build
line names both (`scenarios from …`). A build dev got from a merge to `main` has no `deploy-dev` run: add
`--no-deploy-wait`, taking the SHA from dev's `<meta name="aperture-build">`. Exit 0 PASS, 1 FAIL, 2 CRASH. The
load-time codes (`ENV_MISSING`, `PW_MISSING`, `MATRIX_GAP`, and `WRONG_USER` when the env file names someone else) stop the run before it starts: printed to stderr, exit 2,
no `report.md`. Otherwise read `report.md` first — its first line is the status — then the screenshots. One run per container at a time (`localNotes/devcheck/run.lock`).

## One-time setup

1. **Test user** (dev pool only — never prod). On the Mac, the plan's operator step creates it with
   `aws cognito-idp admin-create-user` (invite suppressed, email verified) and a permanent random password,
   and writes `/workspace/.secrets/devcheck.dev.env` (mode 600, gitignored) with `DEVCHECK_EMAIL`,
   `DEVCHECK_PASSWORD`, `DEVCHECK_SUB`, `DEVCHECK_COGNITO_HOST`, `DEVCHECK_CLIENT_ID`, `DEVCHECK_POOL_ID`. The
   password is never shown; the harness reads the file. `docs/arch/INFRA.md` §6 records the user. **Since the
   dev-account PR** dev's pool lives in the dev account (`--profile aperture-dev`), so the user was re-created
   there, the env file's pool, client, host and sub replaced, `devcheck.dev.state.json` deleted and the old
   ledgers archived — their ids name rows in a table that no longer exists.
2. **Playwright, outside the repo** — it is no package's dependency (it would add a browser download to every
   CI install, and no test needs it). `~/pw` is a scratch directory outside the monorepo, so npm there doesn't
   break the pnpm-only rule: `mkdir -p ~/pw && cd ~/pw && npm init -y && npm install playwright && npx
playwright install chromium`. The harness loads it from `~/pw` (`DEVCHECK_PW_ROOT` overrides;
   `DEVCHECK_CHROMIUM` points at a system Chromium). Check `npm view playwright version` before refreshing.

## What it guarantees

- **Dev only.** The origin is a constant; every request asserts it. There is no prod switch. The one other
  host is the dev Files bucket, for `scenarios/attachment-delete.ts`: the harness PUTs bytes to, and GETs,
  only a presigned URL the dev BFF just minted, after `assertPresignedDevUrl` checks the host is the dev
  Files bucket (`aperturedata-dev-files…`, so never prod's), the key is under `u/`, and the URL is signed.
  A deleted object answers that GET with 403, not 404 — the roles have no `s3:ListBucket`, so S3 hides
  `NoSuchKey` — and `isGone` (`api.ts`) counts both as gone.
- **The test user only.** The env file must name the test user, and before any write the signed-in
  session's email and `sub` (ID claims and access token) must match it — else `WRONG_USER`, no writes.
- **Deletes by recorded id only.** Every task the run creates is recorded in a ledger from the server's create
  response — the API client's `createTask`, and the browser's `createTask`/`createTasks`/`splitTask`
  responses (a split's follow-up, and its parent only when the split task was already recorded and the parent
  didn't exist before the run — deleting a parent deletes its parts). Cleanup deletes ledger ids and nothing else; the delete
  wrapper refuses any other id (`LEDGER_GUARD`). Never by title or marker word — the model rewrites titles.
- **Attachments are written only on a run's own tasks.** `createAttachment`/`deleteAttachment` refuse a task the
  ledger never recorded, and `deleteAttachment` refuses an attachment this run didn't create. They're never
  ledgered themselves: the task's delete cascade removes them, bytes included.
- **Flux sets are the other kind written** (`scenarios/flux-history.ts` writes two a run: a finished set and one stopped early). Their id is minted by the
  harness (the client mints it in the app too — [flux](../areas/flux/index.md) D47), so `recordFluxSet` records
  it as `created` with `via: api:recordFluxSet` _before_ the call — a set the server stored is never unrecorded.
  Cleanup, the sweep and the read-back go by that `via`: a Flux id is read with `listFluxSets` and deleted with
  `deleteFluxSet` (a soft-delete), never through the task methods (`deleteTask` refuses a Flux id), and never
  through the History tab, which can't tell one set from another. Its `day` is the app's day (the test user's
  `dayStartHour`), not the calendar date, so the scenario also passes before 4am. The scenario's one
  non-ledger write: a test user who never opened Flux has the disclaimer accepted (a Settings field, logged).
- **Verified, not assumed.** After cleanup every id this run created or swept is read back (`getTask` → null).
  A task already gone (deleted with its parent) is `gone`, not a failure. A create still in flight when a step
  fails is waited for (30 s) and recorded; one that never answers is a possible leak. Tasks the ledger doesn't
  know are never deleted: ones there before the run are listed, ones that appeared during it (a create path the
  recorder missed) fail the run — keep the test user free of recurring series, whose day's occurrence can
  appear mid-run around the 4am day start. Before any delete the server is asked for parts the ledger doesn't
  know; a task with one is never deleted (deleting a parent deletes its parts) and the run fails. A crashed or
  killed run (Ctrl-C, a timeout — its cleanup doesn't run) leaves its recorded ids pending, and the next run
  sweeps them first; a create still in flight at the kill was never recorded, so the next run lists it as not in
  the ledger. Loading the app writes server-side too (`getDay` materialises the day), always as the test user —
  the cached session is checked before any page loads.
- **A row is proven only through its own entry point.** A UI row proven only through the API is a gap, not
  a pass. Every scenario's rows are checked when the run loads, before the deploy wait — a row no step proves
  through its entry, or an off-dev row naming a test that isn't there, is `MATRIX_GAP` — and again by
  `scenarios/index.test.ts` in the gate (_Rows_, below).
- **The right build.** The dispatched `deploy-dev <sha> <key>` run for the SHA (matched by name; `dev` pushes were
  retired at dev-cutover) must succeed, then the edge must serve that SHA in `<meta name="aperture-build">`.
  In the page it reloads up to 3 times — the PWA's service worker can serve the previous shell first — else
  `BUILD_MISMATCH_IN_PAGE`. If dev's build changes before the run ends, `DEV_CHANGED_MID_RUN`, and no row
  counts as proven — its steps may have driven another build.

## Known 429s

**A stopgap, decided 2026-11-01 (dev-cutover).** The dev account's Lambda concurrency quota is low for now
([CI-BOT.md](CI-BOT.md) → _Dev deploy blast radius_ → Compute). A devcheck runs right after a deploy, so the BFF is
cold, and Home mounts about 10 RPCs at once — the burst exceeds the quota and some get HTTP 429. The harness's own API
calls back off on a 429 (five retries, 500 ms → 8 s); the browser's don't, so they surface as console errors: in the
smoke scenario's _No console errors on the way_ step, and again in every later step that re-reads the run's cumulative
console list (`pipeline.ts`). The report's _Throttled (429)_ section names each one (`/api/<method>`), which Chromium's
console line doesn't. The run still reports FAIL — the test is not weakened. Only the workflow's verdict changes: **a
full run counts as green (CLAUDE.md → _Feature workflow_, phases 8–9) when all of these hold in its `report.md`:**

- the first line is exactly `# Dev check — FAIL: STEP_FAILED`, and `Leftovers: **0**`;
- no step is `skipped`;
- every `fail` step is a console-error check: smoke's _No console errors on the way_, reading `N console error(s): …`,
  or a later scenario's (its last step, `noConsoleErrors`) reading `console errors: …` with exactly N `\|`-separated
  entries — nothing new after the burst;
- the _Console errors_ section lists exactly N lines, each containing `status of 429` or `failed (429)`, and N ≤ 16
  (one throttled call can log two lines — the resource's and the app's own `Error: … failed (429)`; a refetch loop or
  request storm, also all 429s, would exceed it);
- the _Throttled (429)_ section names no BFF method the feature changed. A 429 means Lambda never started the
  function, so that call was never tested; if it names one, rerun until it doesn't;
- every _Feature coverage_ row is `pass`, `off dev` or `needs you`. This rule never makes a row green: a 429 that
  fails a proving step leaves its row not proven — rerun until it passes.

Anything else is a bug, as always. The burst is one too — a known defect with a dated fix (the in-flight cap below);
this rule records it, it does not excuse it. Log each such run in the feature's `decisions.md` and its PR body. **The
rule expires** when the quota reaches 30, or when the client in-flight cap ships (its own PR, due if no raise by
2026-11-08) — then remove this section.

## Ledgers

| File (in the main checkout's `localNotes/devcheck/`) | Written by                        | Covers                                            |
| ---------------------------------------------------- | --------------------------------- | ------------------------------------------------- |
| `ledger.dev.jsonl`                                   | the harness                       | the test user's partition (browser + API creates) |
| `mcp-ledger.dev.jsonl`                               | `.claude/hooks/mcp-dev-ledger.sh` | the MCP agent's partition on `aperture-dev`       |

Append-only JSONL, one line per event. The harness writes `{t, run, op, id?, via?, title?, status?}`, `op`
one of `run-start`, `intent` (an API create about to be sent — one with no `created` after it is reported as a
possible leak), `created`, `deleted`, `gone`, `swept`, `run-end`; `title` is for the report only. The MCP hook
writes `{t, op, id, parent?, via, session}`, `op` one of `created`, `reparented`, `tainted` (the id has a part
the hook never recorded — it never clears, so that parent stays undeletable), `deleted`. It denies an `aperture-dev` `delete_task` unless the id has a `created`
line and no `tainted` one, and records the parts a parent's delete took with it (CLAUDE.md → _Aperture MCP
connector_, standing approval 2; `docs/areas/mcp/index.md`). The MCP result shape it parses is inferred, not
yet pinned against a live call — a mismatch records nothing, so deletes deny.

## Reason codes

| Code                       | Means                                                                                                                                    | Do                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `ENV_MISSING`              | env file absent or a key missing                                                                                                         | setup step 1                                                             |
| `PW_MISSING`               | no Playwright in `~/pw`                                                                                                                  | setup step 2                                                             |
| `DEPLOY_NOT_FOUND`         | no dispatched deploy run for the SHA                                                                                                     | did `pnpm bot deploy-dev` run for it?                                    |
| `DEPLOY_FAILED`            | the run failed                                                                                                                           | read the run; a failed `verify` job names why in its `::error::` line    |
| `DEPLOY_TIMEOUT`           | run never finished, or the edge kept serving another build                                                                               | the message names what it serves                                         |
| `AUTH_REDIRECT_UNEXPECTED` | Sign in didn't reach the dev Hosted UI                                                                                                   | check the env file's host                                                |
| `AUTH_PAGE_CHANGED`        | the Hosted UI form isn't the classic one                                                                                                 | screenshot in `shots/`; update `login.ts` deliberately                   |
| `AUTH_REJECTED`            | Cognito refused the credentials                                                                                                          | password expired or user disabled — operator                             |
| `WRONG_USER`               | the session isn't the test user                                                                                                          | delete `.secrets/devcheck.dev.state.json`, rerun                         |
| `BUILD_MISMATCH_IN_PAGE`   | the page kept an old build after 3 reloads                                                                                               | rerun; persistent → service-worker bug                                   |
| `MATRIX_GAP`               | a row no step proves through its own entry, or an off-dev row's test file or title isn't there (at load)                                 | the message names the scenario and row; fix the scenario, never the rule |
| `STEP_FAILED`              | a scenario step threw                                                                                                                    | its row has the error and a screenshot                                   |
| `LEDGER_GUARD`             | a delete named an unrecorded id                                                                                                          | a harness bug — never bypass                                             |
| `LEFTOVERS`                | a ledger id survived cleanup, a create's id was never recorded, an unrecorded task appeared, or a delete was blocked by unrecorded parts | rerun (the sweep retries); else by hand                                  |
| `DEV_CHANGED_MID_RUN`      | dev's build changed during the run — main won                                                                                            | read the merged PRs, rebase, gate, push, `deploy-dev`, rerun             |

## Writing a scenario

A feature adds `scripts/src/devcheck/scenarios/<feature>.ts` and lists it in `scenarios/index.ts`. Its `rows`
are the plan's dev-test matrix (_Rows_, below); a Chrome runbook maps onto its steps one for one:

```ts
export const quickAdd: Scenario = {
  id: 'quick-add',
  title: 'Quick add parses a line',
  tiers: ['full'],
  rows: [
    { id: 'save', entry: 'ui', kind: 'nominal', what: 'Auto Enter saves the parsed fields' },
    {
      id: 'raycast',
      entry: 'raycast',
      kind: 'nominal',
      what: 'Raycast quick-add saves',
      needsYou: 'Raycast runs on the Mac',
    },
  ],
  steps: [
    {
      id: 'capture',
      title: 'Auto Enter saves',
      entry: 'ui',
      proves: ['save'],
      async run(ctx) {
        await ctx.ui.goto('/tasks');
        await ctx.ui.captureTask(`devcheck ${ctx.nonce} tomorrow 20m`);
        await ctx.shot('receipt'); // light + dark
      },
    },
    {
      id: 'server',
      title: 'Fields landed',
      entry: 'api', // verifies the UI row's server half; never its only proof
      proves: ['save'],
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
extends `pw-types.ts`. A feature scenario ends with `noConsoleErrors` (`scenario.ts`): the console check is its own
step, proving no row, so a console error fails the run without unproving the rows the feature's steps did prove.

### Rows

A row is one entry point × one case, as the user would say it (`what`), `nominal` or `edge`. `entry` is `ui`,
`api`, `mcp`, `ios`, `raycast` or `extension`; a step drives `ui` or `api` today (`STEP_ENTRIES` in `scenario.ts`
— the MCP-as-test-user PR adds `mcp`). Each row is exactly one of:

- **Proven on dev** — steps name it in `proves`. At least one must drive the row's own entry; every step naming
  it must pass. An `api` step can verify a UI row's server half, never stand in for the UI.
- **Off dev** (`offDev: { file, test, why }`) — **if dev can produce the failure naturally, prove it on dev; if
  it can't, a named unit test covers it; no test-only switches in shipped code.** Bad input, size limits, an
  expired link or another user's id happen on dev, so they're proven there; S3 refusing a delete doesn't. `file`
  is a repo-relative `.test.ts(x)`, `test` the title of a runnable `it()`/`test()` opening its own line in it, verbatim (not `it.skip`,
  `it.todo` or a bare string); both are checked. One test per row — a failure with a UI
  half and a BFF half is two rows.
- **Needs you** (`needsYou: '<why>'`) — what headless Chromium can't reach: iOS Safari specifics, Raycast, the
  Safari extension, a camera, a Google account, MCP until the next PR.

Walk the plan's matrix through **the edge-case checklist**: empty / max / invalid input; cancel; repeat
(idempotent); survives a reload; the neighbouring item unaffected; ownership (another user's id). `smoke` alone
has no rows (`MATRIX_EXEMPT`) — it proves the harness, not a feature.

### Selectors and upkeep

- **Roles and labels, never CSS** (`getByRole`, `getByLabel`, `getByText`), and **assert behaviour** — what the
  server holds, what the user sees — not DOM shape. A class or layout change shouldn't break a scenario.
- **You change the UI, you update its scenario**, in the same PR.
- **An old scenario failing on an unrelated PR** is still a bug (phase 9) — read its code path first. To show it
  isn't this branch, the fallback is the fails-on-main baseline: the last green full run's report (the archived
  worktrees' `localNotes/devcheck/`), else redeploying `main` to dev and rerunning — two extra deploys, so last.
  A failure confirmed on `main` gets its own small PR, logged; it doesn't block this one.
- **Every scenario runs on every full run.** When a full run passes 3 minutes, revisit: area tags (a PR runs
  smoke, its own scenario and the areas its diff touches, the full suite on `main`), a time budget, a failure in
  an untouched area reported apart, retiring scenarios a redesign replaced. Not before.

## Artifacts

Per run, in the worktree (archived with it): `localNotes/devcheck/<run>/report.md`, `report.json`, `shots/`.
`report.md`'s _Feature coverage_ ends in two lists — _You don't need to test_ (proven on dev, and off dev with its
test) and _Needs you_ — that `report-<branch>.md` and the `CC done` notes paste as they are. On a run that isn't
PASS they carry its verdict: they hold only if the run counts as green (_Known 429s_).
Shared, in the main checkout: the two ledgers and `run.lock`. Secrets beside the env file:
`.secrets/devcheck.dev.state.json` (the cached session, mode 600).

## Why not Claude in Chrome

Found while running the quick-add runbooks (2026-10-13): a container session has no Chrome tools — the
extension talks to Claude over native messaging on the same machine, and the container has no Chrome (viewing
the session from the desktop app doesn't add them). The extension also refuses to delete data even when asked,
so a runbook could only list what to clean. The dev check runs where Claude runs and cleans up by id.
