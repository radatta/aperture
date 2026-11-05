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
   ─► sweep earlier leftovers ─► MCP sign-in (claude client, PKCE) ─► in-page build check ─► scenarios
   ─► finally: delete ledger ids,
   verify none left, dev build unchanged ─► localNotes/devcheck/<run>/report.md + shots/
(before all of it: every scenario's rows checked at load — a gap is MATRIX_GAP, nothing waits on dev)
```

## Run it

From the worktree whose commit `pnpm bot deploy-dev` dispatched, with nothing else heavy running (no `pnpm test`, no dev server —
CLAUDE.md → COI ceilings):

```bash
pnpm devcheck --tier smoke                         # ~2 min: sign-in, main pages, an API read; creates nothing
pnpm devcheck --tier full --feature attachment-delete  # the phase 8 run: every scenario, the feature's rows apart
pnpm devcheck --tier full                              # every scenario, no feature (a branch with none of its own)
pnpm devcheck --tier delta --scenario capture-task     # smoke + the named scenarios (--feature defaults to them)
```

`--sha <40-hex>` checks a commit other than `HEAD`; `--no-deploy-wait` skips the deploy and edge wait (dev
already serves it). `--sha` is also how a scenario-only commit proves a build already on dev — `scripts/` isn't
deployed, so a fix to a scenario needs no redeploy: run it with `--sha <the deployed SHA>`, and the report's Build
line names both (`scenarios from …`). A build dev got from a merge to `main` has no `deploy-dev` run: add
`--no-deploy-wait`, taking the SHA from dev's `<meta name="aperture-build">`.

`--feature <id,…>` names the feature's scenario(s): _Feature coverage_ shows their rows, with the two paste lists,
under _This feature_, and every other scenario's under _Other scenarios (regression)_ as per-scenario counts and a
_Not proven_ list. `--tier delta` defaults it to `--scenario` (smoke excluded). An unknown id, `smoke`, or a scenario
not in the run is an error, like a bad `--scenario`.

Exit 0 PASS, 1 FAIL, 2 CRASH. The load-time errors — a bad `--scenario`/`--feature`, and the codes `ENV_MISSING`,
`PW_MISSING`, `MATRIX_GAP`, and `WRONG_USER` when the env file names someone else — stop the run before it starts:
printed to stderr, exit 2, no `report.md`. Otherwise read `report.md` first — its first line is the status, and when the
harness itself failed (the deploy wait, a sign-in, the build check, cleanup) the error's text follows it, with a
`**Failed:** <code> — <message>` line per failure under _Leftovers_ (a step's error is in its _Steps_ row; the
_Known 429s_ line below is unchanged, since `STEP_FAILED` carries no text there) — then the screenshots. One run per container at a time (`localNotes/devcheck/run.lock`).

## One-time setup

1. **Test user** (dev pool only — never prod). On the Mac, the plan's operator step creates it with
   `aws cognito-idp admin-create-user` (invite suppressed, email verified) and a permanent random password,
   and writes `/workspace/.secrets/devcheck.dev.env` (mode 600, gitignored) with `DEVCHECK_EMAIL`,
   `DEVCHECK_PASSWORD`, `DEVCHECK_SUB`, `DEVCHECK_COGNITO_HOST`, `DEVCHECK_CLIENT_ID`, `DEVCHECK_POOL_ID`. The
   password is never shown; the harness reads the file. `docs/arch/INFRA.md` §6 records the user. **Since the
   dev-account PR** dev's pool lives in the dev account (`--profile aperture-dev`), so the user was re-created
   there, the env file's pool, client, host and sub replaced, `devcheck.dev.state.json` deleted and the old
   ledgers archived — their ids name rows in a table that no longer exists.
   `DEVCHECK_CLAUDE_CLIENT_ID` (the `aperture-claude-dev` client, for _MCP as the test user_ below) came later —
   not a secret, kept beside the rest so the harness reads one file; required, so a file without it is
   `ENV_MISSING`. Appended on the Mac with: `cd /Users/rahuldatta/Coding/Personal/aperture && id=$(aws
cloudformation describe-stacks --profile aperture-dev --region us-west-1 --stack-name ApertureApp-dev --query
"Stacks[0].Outputs[?OutputKey=='McpClientId'].OutputValue" --output text) && [ -n "$id" ] && [ "$id" != "None" ]
&& ! grep -q '^DEVCHECK_CLAUDE_CLIENT_ID=' .secrets/devcheck.dev.env && printf 'DEVCHECK_CLAUDE_CLIENT_ID=%s\n'
"$id" >> .secrets/devcheck.dev.env && chmod 600 .secrets/devcheck.dev.env` (one line; a recreated dev stack
   means removing the old line and rerunning it).
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
  session's email and `sub` (ID claims and access token) must match it — else `WRONG_USER`, no writes. The MCP
  session is held to the same check (below).
- **MCP as the test user.** Dev's `/mcp` accepts only tokens minted for the claude client (D14,
  `docs/areas/mcp/index.md`), so after the sweep the harness signs the test user in as `aperture-claude-dev` —
  authorization code + PKCE, no secret (a public client), the Hosted UI cookie reused so the form usually
  doesn't show (`mcp-login.ts`). The redirect to claude.ai's callback never leaves the browser: Chromium resolves claude.ai/claude.com
  nowhere and runs with no proxy (`browser.ts`), the sign-in page aborts any direct request to them, and the
  sign-in proves the callback request failed in the browser — nothing answered — and was the only one. The code is swapped only at the
  env's dev-pool token endpoint (`assertDevCognitoUrl`), never following a redirect. The token's email and `sub`
  (ID token), `sub`, `client_id` and `token_use` (access token) must be the test user's claude-client access
  token — else `WRONG_USER` or `MCP_AUTH_FAILED` before any step runs. It lives in memory for the run (never on
  disk: no refresh token is kept), the BFF refuses it (D14), and errors name Cognito's `error` field, never a
  token, code or body. Smoke checks MCP and the API list the same backlog; capture-task's MCP task showing in the
  app's Backlog is the stronger same-partition proof. `ctx.mcp` (`mcp.ts`) mirrors `api.ts`: declared reads and
  writes, creates ledgered from the response (`via: mcp:create_task`), deletes only of ledger ids (a parent with
  an unrecorded part is refused; an attachment only when the server lists it on a recorded task).
- **Edits only on the run's own tasks.** A write that changes a task — the API client's `setTaskActual`, MCP's
  `completeTask` and `setReflection` — runs only on a ledger id (`LEDGER_GUARD` otherwise, before any request).
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
- **Places and the place token are two more kinds** (`scenarios/places.ts`, [tasks/places](../areas/tasks/places.md)).
  A place is recorded from the create's id (`via: api:upsertPlace`, or `ui:upsertPlace` when the browser's
  request has no `id` — a rename is never recorded, so cleanup can't delete a place the run didn't make) and is
  deleted with `deletePlace(id, null)` (finished errands keep the old slug — harmless, tasks are cleaned by id). The
  token is recorded as `place-token:<run>` _before_ `rotatePlaceToken` (never the token itself), and
  `revokePlaceToken` is refused unless a run-minted token is still unresolved — a Settings Generate/Rotate click records the same id first (`recordPlaceTokenMint`), so a browser-minted token is cleaned too; cleanup revokes it, which leaves the
  test user an inactive `ptoken` pointer (never deleted), and a revoke racing another device throws; cleanup catches per id, so the loop goes on, the run reports it, and the next run's sweep retries it. A step that shows the token runs inside `hidingSecret`: any failure blanks the page (`about:blank`) and skips the failure screenshot, so the token never lands in `screenshots/`. `ledgerKind()` tells task, Flux, place and token apart by `via`, so a task delete refuses a
  place id and vice versa. An unrecorded place that appears during the run is a `LEFTOVERS` failure, like a task.
  The scenario drives the daily read cap on dev (sequential GETs to the server's own 429, ~40–60 s).
  Every run, smoke included, lists places after the sweep — so this harness needs a dev build with the places
  methods.
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
calls back off on a 429 (five retries, 500 ms → 8 s), and so does the app (`app/src/data/retry.ts`), so most of
the burst now recovers on screen. But Chromium logs every 429 response as a console
error, retried or not, so they still surface: in the
smoke scenario's _No console errors on the way_ step, and again in every later step that re-reads the run's cumulative
console list (`pipeline.ts`). The report's _Throttled (429)_ section names each one (`/api/<method>`), which Chromium's
console line doesn't; a call that was retried and recovered is still listed there. Failures a scenario injects on
purpose (_Injected failures_) are listed apart, under _Injected by the harness_, and never count here. The run still
reports FAIL — the test is not weakened. Only the workflow's verdict changes: **a
full run counts as green (CLAUDE.md → _Feature workflow_, phases 8–9) when all of these hold in its `report.md`:**

- the first line is exactly `# Dev check — FAIL: STEP_FAILED`, and `Leftovers: **0**`;
- no step is `skipped`;
- every `fail` step is a console-error check: smoke's _No console errors on the way_, reading `N console error(s): …`,
  or a later scenario's (its last step, `noConsoleErrors`) reading `console errors: …` with exactly N `\|`-separated
  entries — nothing new after the burst;
- the _Console errors_ section lists exactly N lines, each containing `status of 429`, and N ≤ 16 (Chromium logs
  one line per throttled attempt, and the app retries a 429 twice, so one call can log up to three; a refetch
  loop or request storm, also all 429s, would exceed it);
- the _Throttled (429)_ section names no BFF method the feature changed. A 429 means Lambda never started the
  function, so that attempt was never tested — the app's retry may have recovered the call, but a listed method
  isn't proven by this run; if it names one, rerun until it doesn't;
- every _Feature coverage_ row — _This feature_ and _Other scenarios_ alike — is `pass`, `off dev` or `needs you`. This rule never makes a row green: a 429 that
  fails a proving step leaves its row not proven — rerun until it passes.

Anything else is a bug, as always. The burst is one too — a known defect with a dated fix (the in-flight cap below);
this rule records it, it does not excuse it. Log each such run in the feature's `decisions.md` and its PR body. **The
rule expires** when the quota reaches 30, or when the client in-flight cap ships (its own PR, due if no raise by
2026-11-08) — then remove this section.

## Ledgers

| File (in the main checkout's `localNotes/devcheck/`) | Written by                        | Covers                                                   |
| ---------------------------------------------------- | --------------------------------- | -------------------------------------------------------- |
| `ledger.dev.jsonl`                                   | the harness                       | the test user's partition (browser, API and MCP creates) |
| `mcp-ledger.dev.jsonl`                               | `.claude/hooks/mcp-dev-ledger.sh` | the MCP agent's partition on `aperture-dev`              |

Append-only JSONL, one line per event. The harness writes `{t, run, op, id?, via?, title?, status?}`, `op`
one of `run-start`, `intent` (an API create about to be sent — one with no `created` after it is reported as a
possible leak), `created`, `deleted`, `gone`, `swept`, `run-end`; `title` is for the report only. The MCP hook
writes `{t, op, id, parent?, via, session}`, `op` one of `created`, `reparented`, `tainted` (the id has a part
the hook never recorded — it never clears, so that parent stays undeletable), `deleted`. It denies an `aperture-dev` `delete_task` unless the id has a `created`
line and no `tainted` one, and records the parts a parent's delete took with it (CLAUDE.md → _Aperture MCP
connector_, standing approval 2; `docs/areas/mcp/index.md`). The MCP result shape it parses is inferred, not
yet pinned against a live call — a mismatch records nothing, so deletes deny.

## Reason codes

| Code                       | Means                                                                                                                                                                                                     | Do                                                                                                                                                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ENV_MISSING`              | env file absent or a key missing                                                                                                                                                                          | setup step 1                                                                                                                                                                                                                               |
| `PW_MISSING`               | no Playwright in `~/pw`                                                                                                                                                                                   | setup step 2                                                                                                                                                                                                                               |
| `DEPLOY_NOT_FOUND`         | no dispatched deploy run for the SHA                                                                                                                                                                      | did `pnpm bot deploy-dev` run for it?                                                                                                                                                                                                      |
| `DEPLOY_FAILED`            | the run failed                                                                                                                                                                                            | read the run; a failed `verify` job names why in its `::error::` line                                                                                                                                                                      |
| `DEPLOY_TIMEOUT`           | run never finished, or the edge kept serving another build                                                                                                                                                | the message names what it serves                                                                                                                                                                                                           |
| `AUTH_REDIRECT_UNEXPECTED` | Sign in didn't reach the dev Hosted UI                                                                                                                                                                    | check the env file's host                                                                                                                                                                                                                  |
| `AUTH_PAGE_CHANGED`        | the Hosted UI form isn't the classic one                                                                                                                                                                  | screenshot in `shots/`; update `login.ts` deliberately                                                                                                                                                                                     |
| `AUTH_REJECTED`            | Cognito refused the credentials                                                                                                                                                                           | password expired or user disabled — operator                                                                                                                                                                                               |
| `WRONG_USER`               | the session isn't the test user                                                                                                                                                                           | delete `.secrets/devcheck.dev.state.json`, rerun                                                                                                                                                                                           |
| `BUILD_MISMATCH_IN_PAGE`   | the page kept an old build after 3 reloads                                                                                                                                                                | rerun; persistent → service-worker bug                                                                                                                                                                                                     |
| `MATRIX_GAP`               | a row no step proves through its own entry, or an off-dev row's test file or title isn't there (at load)                                                                                                  | the message names the scenario and row; fix the scenario, never the rule                                                                                                                                                                   |
| `MCP_AUTH_FAILED`          | the claude-client sign-in or code swap failed, before any step: Cognito's error, a state mismatch, no callback (or two), a callback that wasn't blocked — a token expiring mid-run fails its step instead | the message names Cognito's `error`: `invalid_client` means the client needs a secret now (fall back to a test-user agent token); `redirect_mismatch` means `CLAUDE_CALLBACK` drifted from `cdk/src/config/claudeConnector.ts`; else rerun |
| `STEP_FAILED`              | a scenario step threw                                                                                                                                                                                     | its row has the error and a screenshot                                                                                                                                                                                                     |
| `LEDGER_GUARD`             | a delete named an unrecorded id                                                                                                                                                                           | a harness bug — never bypass                                                                                                                                                                                                               |
| `LEFTOVERS`                | a ledger id survived cleanup, a create's id was never recorded, an unrecorded task appeared, a delete was blocked by unrecorded parts, or a removal / read-back threw (the report's "Removal or read-back threw" line)                                                                  | rerun (the sweep retries); else by hand                                                                                                                                                                                                    |
| `DEV_CHANGED_MID_RUN`      | dev's build changed during the run — main won                                                                                                                                                             | read the merged PRs, rebase, gate, push, `deploy-dev`, rerun                                                                                                                                                                               |

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
ledger-guarded writes), `mcp` (the same, through dev's `/mcp` as the test user), `intercept` (_Injected failures_), `shot`, `createdIds()`, `consoleErrors()`, `dates` (LA today/tomorrow) and `nonce`
(makes a title findable on screen — never a cleanup key). A step throws to fail; the rest of that scenario is
skipped, the next one still runs, cleanup always does. Prefer the grammar line (space, pipe, space) when the
model isn't what's under test: no Haiku spend, deterministic fields. A step that needs more of Playwright
extends `pw-types.ts`. A feature scenario ends with `noConsoleErrors` (`scenario.ts`): the console check is its own
step, proving no row, so a console error fails the run without unproving the rows the feature's steps did prove.

### Injected failures

A failure dev won't produce on demand (a read that 429s, a dropped connection, a stop that doesn't land) is
injected **by the harness**, never by a switch in shipped code: `ctx.intercept(method, { status?, times?,
abort? })` puts a Playwright route on the page for dev's `/api/<method>`. The next `times` calls (default:
every call) get `status` (default 429) or a dropped connection, and the rest pass through. The returned handle
counts `hits()` and `passed()`; `release()` unroutes it, because a live page route turns off the page's HTTP
cache. The pipeline releases any a step left live when its scenario ends, so a step that threw mid-intercept
can't fail the next scenario's reads.

While any intercept is live, the console's `Failed to load resource: … status of N` and `net::ERR_FAILED` lines are
the harness's own doing and are left out of _Console errors_. Chromium's line names no URL, so the drop covers
the whole window (a few seconds per step), not one method. To keep a real failure in that
window from hiding, every non-injected response ≥ 400 other than a 429 — `/api` or not — is recorded from the
response itself, as `HTTP <status> on /api/<method>` (or the host and path) `(during an injected failure)`, and a
real 429 still lands in _Throttled (429)_. Only a dropped real connection inside the window goes unrecorded. Injected responses are known by their
request, not their method, and are listed under _Injected by the harness_, never _Throttled (429)_. `failed-reads` runs last in `SCENARIOS` for this reason. It
starts and stops one ad-hoc focus timer through the dock, which leaves a seconds-long completed session in the test
user's history each run. Sessions have no delete method, so they're not ledgered; a timer an aborted run left running
is stopped or discarded through the dock before the timer steps, judged by the server's list.

### Rows

A row is one entry point × one case, as the user would say it (`what`), `nominal` or `edge`. `entry` is `ui`,
`api`, `mcp`, `ios`, `raycast` or `extension`; a step drives `ui`, `api` or `mcp` (`STEP_ENTRIES` in
`scenario.ts`). Each row is exactly one of:

- **Proven on dev** — steps name it in `proves`. At least one must drive the row's own entry; every step naming
  it must pass. An `api` step can verify a UI row's server half, never stand in for the UI.
- **Off dev** (`offDev: { file, test, why }`) — **if dev can produce the failure naturally, prove it on dev; if
  it can't, a named unit test covers it; no test-only switches in shipped code.** One exception, so a feature
  with many screens doesn't prove the same path on each: a case may be covered off dev when a dev-proven row of
  the **same scenario** already runs everything only dev can run for it: the same client branch (the http
  client's 429 loop, the query layer's retry, or no retry) and, when the failure isn't injected by the harness,
  the same BFF method. What differs (another screen's copy, a pure decision) must run entirely in the named
  test. Its `why` starts `same path as <row> (proven on dev)`, and `matrix.ts` checks that row exists and dev
  proves it. The exception never covers a new entry point, a server-side effect, or a branch no dev row takes.
- **Needs you** (`needsYou: '<why>'`) — what headless Chromium can't reach: iOS Safari specifics, Raycast, the
  Safari extension, a camera, a Google account.

Walk the plan's matrix through **the edge-case checklist**: empty / max / invalid input; cancel; repeat
(idempotent); survives a reload; the neighbouring item unaffected; ownership (another user's id). `smoke` alone
has no rows (`MATRIX_EXEMPT`) — it proves the harness, not a feature.

### Selectors and upkeep

- **Roles and labels, never CSS** (`getByRole`, `getByLabel`, `getByText`), and **assert behaviour** — what the
  server holds, what the user sees — not DOM shape. A class or layout change shouldn't break a scenario.
- **You change the UI, you update its scenario**, in the same PR.
- **An old scenario failing on an unrelated PR** (with `--feature`, under _Other scenarios (regression)_ → _Not proven_) is
  still a bug (phase 9) — read its code path first. To show it
  isn't this branch, the fallback is the fails-on-main baseline: the last green full run's report (the archived
  worktrees' `localNotes/devcheck/`), else redeploying `main` to dev and rerunning — two extra deploys, so last.
  A failure confirmed on `main` gets its own small PR, logged; it doesn't block this one.
- **Every scenario runs on every full run.** When a full run passes 3 minutes, revisit: area tags (a PR runs
  smoke, its own scenario and the areas its diff touches, the full suite on `main`), a time budget, a failure in
  an untouched area reported apart, retiring scenarios a redesign replaced. Not before.

## Artifacts

Per run, in the worktree (archived with it): `localNotes/devcheck/<run>/report.md`, `report.json` (the same result for
tooling: `codes` is the dedup'd list, `failures` the harness failures as `{code, message}`), `shots/`.
`report.md`'s _Feature coverage_ splits _This feature_ (`--feature`) — its table and two lists, _You don't need to
test_ (proven on dev, and off dev with its test) and _Needs you_, that `report-<branch>.md` and the `CC done` notes
paste as they are — from _Other scenarios (regression)_: per-scenario counts and a _Not proven_ list, no paste lists,
since those belong to their own features. Without `--feature` there are no paste lists: the table is every
scenario's, and a branch with no scenario of its own reports "no feature rows". On a run that isn't PASS the lists
carry its verdict: they hold only if the run counts as green (_Known 429s_).
Shared, in the main checkout: the two ledgers and `run.lock`. Secrets beside the env file:
`.secrets/devcheck.dev.state.json` (the cached session and the Hosted UI cookie, mode 600 — re-saved after the MCP
sign-in).

## Why not Claude in Chrome

Found while running the quick-add runbooks (2026-10-13): a container session has no Chrome tools — the
extension talks to Claude over native messaging on the same machine, and the container has no Chrome (viewing
the session from the desktop app doesn't add them). The extension also refuses to delete data even when asked,
so a runbook could only list what to clean. The dev check runs where Claude runs and cleans up by id.
