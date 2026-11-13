# Dev check — Claude tests the deployed dev stage itself

`pnpm devcheck` drives headless Chromium, signed in as a dev-only test user, against
`https://dev.aperture.rahuldatta.dev`, after `pnpm bot deploy-dev` dispatched the commit. It waits for the deploy, proves
the page is the commit under test, runs scenarios with screenshots in both themes, deletes everything it
created, and writes a report that leads with which of the feature's coverage rows were proven (_Rows_, below).
It replaces the Claude-in-Chrome runbooks: a green full run with zero leftovers in which every row is proven,
covered off dev or listed for the user, plus Claude reading the screenshots, is what "tested on dev" means
(CLAUDE.md → _Feature workflow_, phases 8–9). Code: `scripts/src/devcheck/`.

Before the dev lock, the same scenarios run locally in seconds: `pnpm devcheck:local` (`docs/ops/LOCAL-CHECK.md`) — a
pre-flight for step bugs, never a substitute for this check.

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
pnpm devcheck --tier all                               # every scenario, every slow step (Slow tier, below)
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
`**Failed:** <code> — <message>` line per failure under _Leftovers_ (a step's error is in its _Steps_ row, so a
step-only failure's first line is exactly `# Dev check — FAIL: STEP_FAILED`) — then the screenshots. One run per container at a time (`localNotes/devcheck/run.lock`; per slot once the quota allows — _Dev slots_).

## Dev slots

The dev account has two stacks, `dev` (slot A) and `devb` (slot B, CI-BOT.md → _Dev slots_). **A run targets the slot
its branch's dev lock is on** — read at start from `refs/locks/dev` / `refs/locks/devb` with the container's read-only
token (`slot.ts`), never from a flag. No lock of its own → `dev`, as every run was before slot B (a check of main's
deploy holds none) — unless another branch holds `dev` live: then the run stops (`NO_LOCK`) rather than sweep and
write into that branch's test. So a run never lands on a stack another branch holds live. A lock read that fails stops the
run too (`SLOT_UNKNOWN`). The report's header names the target (`· on devb (https://…)`). Everything a run keeps is
per slot: the env file
(`.secrets/devcheck.<slot>.env`), the signed-in state (`devcheck.<slot>.state.json`), the ledger
(`ledger.<slot>.jsonl`) and every guard — the origin, the Files bucket, the Hosted UI host and the MCP
scope (`config.ts` → `SLOT_TARGETS`). The run lock stays one for both slots while the dev account's Lambda quota is
10: two runs (~10 calls in flight each) would throttle each other. Once it reads ≥ 160 with the reservations in
(CI-BOT.md → Compute), `PER_SLOT_RUNS` in `config.ts` gives each slot its own (`run.devb.lock`), so two sessions can
each run one devcheck at once. On devb, iOS rows read needs-you (`SIM_SLOT_A_ONLY`: the sim is slot A's). The `dev-slot-b` scenario's
rows are slot-relative — the BFF's `/api/health` names the run's slot, the app and `/mcp` answer at its origin, its
reminders are configured and its poller ticking — so it stays as a standing check that a run is where its lock says.

## One-time setup

1. **Test user** (dev pool only — never prod). On the Mac, the plan's operator step creates it with
   `aws cognito-idp admin-create-user` (invite suppressed, email verified) and a permanent random password,
   and writes `/workspace/.secrets/devcheck.dev.env` (mode 600, gitignored; slot B's is `devcheck.devb.env`, from the
   same line against `ApertureData-devb` / `ApertureApp-devb`, with the claude client below in it) with `DEVCHECK_EMAIL`,
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

3. **Fixture bank** (the `finance` scenario). Once, as the test user, from Safari on the Mac: read
   `DEVCHECK_EMAIL` / `DEVCHECK_PASSWORD` from `.secrets/devcheck.dev.env`, sign in to dev in a private window,
   Finances → **Connect a bank** → _First Platypus Bank_ (non-OAuth; an OAuth institution may drop custom
   fields) → username `user_custom`, password = the JSON in `scripts/src/devcheck/fixtures/plaid-fixture.json`
   (a Plaid Sandbox `user_custom` config: a card and a checking account with fixed `DEVCHECK …` rows,
   `roll_dates_forward` so the newest row lands on the link day) → tick both accounts → Continue. The rows
   then stand still; the All tab lists this period and last, so they age off it in about six weeks — the
   scenario says needs-you (`relink`) rather than fail: remove the bank in the app and link it again. The rows
   must carry no period mark of your own: a hand-marked `DEVCHECK REBATE` reads needs-you (the harness
   unmarks only a mark it recorded). Nothing in the harness drives Plaid Link.

## What it guarantees

- **Dev only.** The origin is a constant; every request asserts it. There is no prod switch. The one other
  host is the dev Files bucket, for `scenarios/attachment-delete.ts`: the harness PUTs bytes to, and GETs,
  only a presigned URL the dev BFF just minted, after `assertPresignedDevUrl` checks the host is the dev
  Files bucket (`aperturedata-dev-files…`, so never prod's), the key is under `u/`, and the URL is signed.
  A deleted object answers that GET with 403, not 404 — the roles have no `s3:ListBucket`, so S3 hides
  `NoSuchKey` — and `isGone` (`api.ts`) counts both as gone.
- **The test user only.** The env file must name the test user, and before any write the signed-in
  session's email and `sub` (ID claims and access token) must match it — else `WRONG_USER`, no writes. The MCP
  session is held to the same check (below). A step can outlive the hour-long token (an iOS step runs minutes
  while the page sits idle), so before every API request a session with under 60 s left is re-read from the
  page, which renews itself, and if the page hasn't, renewed from here with the page's refresh token at the
  env's dev-pool token endpoint (`login.ts` `refreshSession`, `assertDevCognitoUrl`, never following a
  redirect), then checked again (`WRONG_USER`). Nothing is written back to the page or logged.
- **MCP as the test user.** Dev's `/mcp` accepts only tokens minted for the claude client (D14,
  `docs/areas/mcp/index.md`), so after the sweep the harness signs the test user in as `aperture-claude-dev` —
  authorization code + PKCE, no secret (a public client), the Hosted UI cookie reused so the form usually
  doesn't show (`mcp-login.ts`). The redirect to claude.ai's callback never leaves the browser: Chromium resolves claude.ai/claude.com
  nowhere and runs with no proxy (`browser.ts`), the sign-in page aborts any direct request to them, and the
  sign-in proves the callback request failed in the browser — nothing answered — and was the only one. The code is swapped only at the
  env's dev-pool token endpoint (`assertDevCognitoUrl`), never following a redirect. The token's email and `sub`
  (ID token), `sub`, `client_id` and `token_use` (access token) must be the test user's claude-client access
  token — else `WRONG_USER` or `MCP_AUTH_FAILED` before any step runs. It lives in memory for the run (never on
  disk: no refresh token is kept, so a step using it with under 60 s left fails instead, the same margin as the
  app session's renewal), the BFF refuses it (D14), and errors name Cognito's `error` field, never a
  token, code or body. Smoke checks MCP and the API list the same backlog; capture-task's MCP task showing in the
  app's Backlog is the stronger same-partition proof. `ctx.mcp` (`mcp.ts`) mirrors `api.ts`: declared reads and
  writes, creates ledgered from the response (`via: mcp:create_task`), deletes only of ledger ids (a parent with
  an unrecorded part is refused; an attachment only when the server lists it on a recorded task).
- **Edits only on the run's own tasks.** A write that changes a task — the API client's `setTaskActual`, MCP's
  `completeTask` and `setReflection` — runs only on a ledger id (`LEDGER_GUARD` otherwise, before any request).
  One read writes: MCP's `liveSitting` (`live_sitting`) counts the pull on the open sitting. The scenario pulls only
  while it expects its own sitting to be the open one, or none, and cleanup tombstones that count with the sitting.
- **Deletes by recorded id only.** Every task the run creates is recorded in a ledger from the server's create
  response — the API client's `createTask`, and the browser's `createTask`/`createTasks`/`splitTask`
  responses (a split's follow-up, and its parent only when the split task was already recorded and the parent
  didn't exist before the run — deleting a parent deletes its parts). Cleanup deletes ledger ids and nothing else; the delete
  wrapper refuses any other id (`LEDGER_GUARD`). Never by title or marker word — the model rewrites titles.
- **Attachments are written only on a run's own tasks.** `createAttachment`/`deleteAttachment` refuse a task the
  ledger never recorded, and `deleteAttachment` refuses an attachment this run didn't create. They're never
  ledgered themselves: the task's delete cascade removes them, bytes included.
- **Flux sets are the other kind written** (`scenarios/flux-history.ts` writes five a run: two chin tucks, a finished set and one stopped early, and three rotation sets). Their id is minted by the
  harness (the client mints it in the app too — [flux](../areas/flux/index.md) D47), so `recordFluxSet` records
  it as `created` with `via: api:recordFluxSet` _before_ the call — a set the server stored is never unrecorded.
  Cleanup, the sweep and the read-back go by that `via`: a Flux id is read with `listFluxSets` and deleted with
  `deleteFluxSet` (a soft-delete), never through the task methods (`deleteTask` refuses a Flux id). The scenario's one UI delete
  (row `chip-order`) picks the run's own stopped set by its text; the sweep's delete of it is then a no-op. Its `day` is the app's day (the test user's
  `dayStartHour`), not the calendar date, so the scenario also passes before 4am. The scenario's two
  non-ledger writes, both Settings fields on the test user's own row: a test user who never opened Flux has the
  disclaimer accepted (logged), and row `sets-remembered` empties `fluxSets` first and puts the prior map back in
  the step's `finally`.
  One more a run leaves behind: `getFluxWeekNote` stores the week's note row (`fluxnote#<weekStart>`) in the
  test user's partition — derived from the sets, overwritten when they change, never listed as a leftover.
- **A log entry is one more kind** (`scenarios/log-mcp.ts`): recorded from the create's id (`via: api:createLogEntry`; a
  capture-bar line from the POST's response, `ui:createLogEntry`), read back over the whole test-user log
  (`listLogRange({})`, so a crashed run's leftover is found too) and tombstoned with `deleteLogEntry` — an RPC that exists
  for this cleanup only (no UI, no MCP tool).
- **A category is one more kind** (`scenarios/parts-v2b-reads.ts`): recorded from the create's id (`via: api:upsertCategory`),
  deleted with `deleteCategory(id, null)`. Cleanup runs newest-first and the category is made after the run's tasks, so it goes
  before them — a run task on a run category would make the delete refuse, so no scenario puts one there. The same scenario sets the
  test user's own day row (capacity, intent) through the UI and puts the prior values back in the step's `finally` —
  a singleton, nothing to ledger (an intent that was never set comes back as `''`; the API has no null intent).
- **A habit is one more kind** (`scenarios/day-guards.ts`): recorded from the create's id (`via: api:upsertHabit`). The API
  has no habit delete, so cleanup _archives_ it (`upsertHabit({ …, active: false })`) and "exists" means listed and active —
  the run ends at 0 leftovers, and one archived `devcheck <nonce> habit` per run stays on the dev test user, by design, until a
  tombstoning `deleteHabit` lands (day-guards' follow-up). Its checks are tombstones the archive leaves behind.
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

## Throttles (429)

The app keeps a page's burst under the BFF's reserved concurrency on dev, 18 ([CI-BOT.md](CI-BOT.md) →
_Dev deploy blast radius_ → Compute; the account quota of 10 before 2026-11): at most 8 `/api` calls in flight (`app/src/data/httpClient.ts` →
`MAX_IN_FLIGHT`), leaving room for the harness's own calls, so Home's ~10 RPCs on a cold BFF no longer get HTTP 429
(`inflight-cap`, 2026-11; before it, a dated _Known 429s_ rule here let a run count as green with them). A 429 means
Lambda never started the function, so that attempt was never tested — the app's retry (`app/src/data/retry.ts`) may
have recovered the call, but the method isn't proven by this run. Chromium logs every 429 as a console error, retried
or not, so one fails the run like any other console error, and the report's _Throttled (429)_ section names each
(`/api/<method>`), which Chromium's line doesn't. Treat one as a bug — a burst wider than the cap, a refetch storm, the
harness bursting on its own — never as weather; the `inflight-cap` scenario fails on any the run's console saw (one
inside an injected-failure window is dropped from the console and shows under _Throttled (429)_ (and _Failed loads_) — read that
section too). The same scenario holds every `/api` response while Home and three nav taps want more than 8 calls,
then releases them: it fails unless exactly 8 were on the wire and the rest went out after. Failures a scenario injects on
purpose (_Injected failures_) are listed apart, under _Injected by the harness_, and never count here. The harness's
own `/api` and `/mcp` clients back off a Lambda 429 and retry, so no console sees it and a call that succeeds may
still have been throttled; `ctx.api.throttles()` and `ctx.mcp.throttles()` count those, for a step that must prove
none happened (`dev-concurrency-caps`).

The test user's rows aren't all kept: dev's table expires tombstones ([TECH.md](../arch/TECH.md) §2.3, rule 4), so a scenario can't count on one being physically there. The `dead-rows` scenario covers the delete paths.

## Ledgers

| File (in the main checkout's `localNotes/devcheck/`) | Written by                        | Covers                                                   |
| ---------------------------------------------------- | --------------------------------- | -------------------------------------------------------- |
| `ledger.dev.jsonl`                                   | the harness                       | the test user's partition (browser, API and MCP creates) |
| `mcp-ledger.dev.jsonl`                               | `.claude/hooks/mcp-dev-ledger.sh` | the MCP agent's partition on `aperture-dev`              |

Append-only JSONL, one line per event. The harness writes `{t, run, op, id?, via?, title?, status?}`, `op`
one of `run-start`, `intent` (an API create about to be sent — one with no `created` or `refused` after it is
reported as a possible leak; `refused` is a param error the server raised before any write), `created`,
`deleted`, `gone`, `swept`, `run-end`; `title` is for the report only. A `created`
line's `via` names what cleanup reads back and removes (`api.ts` `ledgerKind`): a task, a Flux set, a place, the
place token (`place-token:<run>`), a finance rule, a recurring series (deleted with the occurrences `getDay`
spawned for it — the series id is their record, [tasks/recurring](../areas/tasks/recurring.md) §6), and on the fixture bank's rows a bucket set
(`finance-bucket:<run>:<row>`), a refund link (`finance-link:<run>:<row>`) or a period mark
(`finance-mark:<run>:<row>`) — recorded before the click that makes it, cleared (unsorted / unlinked / unmarked)
at cleanup; the row itself is the fixture's and stays. The MCP hook
writes `{t, op, id, parent?, via, session}`, `op` one of `created`, `reparented`, `tainted` (the id has a part
the hook never recorded — it never clears, so that parent stays undeletable), `deleted`. It denies an `aperture-dev` `delete_task` unless the id has a `created`
line and no `tainted` one, and records the parts a parent's delete took with it (CLAUDE.md → _Aperture MCP
connector_, standing approval 2; `docs/areas/mcp/index.md`). The MCP result shape it parses is inferred, not
yet pinned against a live call — a mismatch records nothing, so deletes deny.

## Reason codes

| Code                       | Means                                                                                                                                                                                                                  | Do                                                                                                                                                                                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ENV_MISSING`              | env file absent or a key missing                                                                                                                                                                                       | setup step 1                                                                                                                                                                                                                               |
| `SLOT_UNKNOWN`             | the dev locks couldn't be read at start, so the run can't tell which slot its branch deployed to (_Dev slots_)                                                                                                         | rerun; `pnpm bot lock status` shows both locks                                                                                                                                                                                             |
| `NO_LOCK`                  | the branch holds no dev lock and another branch holds `dev` live — the run would land in that branch's test (_Dev slots_)                                                                                              | `pnpm bot deploy-dev` takes a slot (or wait for `dev` to free)                                                                                                                                                                             |
| `PW_MISSING`               | no Playwright in `~/pw`                                                                                                                                                                                                | setup step 2                                                                                                                                                                                                                               |
| `DEPLOY_NOT_FOUND`         | no dispatched deploy run for the SHA                                                                                                                                                                                   | did `pnpm bot deploy-dev` run for it?                                                                                                                                                                                                      |
| `DEPLOY_FAILED`            | the run failed                                                                                                                                                                                                         | read the run; a failed `verify` job names why in its `::error::` line                                                                                                                                                                      |
| `DEPLOY_TIMEOUT`           | run never finished, or the edge kept serving another build                                                                                                                                                             | the message names what it serves                                                                                                                                                                                                           |
| `AUTH_REDIRECT_UNEXPECTED` | Sign in didn't reach the dev Hosted UI                                                                                                                                                                                 | check the env file's host                                                                                                                                                                                                                  |
| `AUTH_PAGE_CHANGED`        | the Hosted UI form isn't the classic one                                                                                                                                                                               | screenshot in `shots/`; update `login.ts` deliberately                                                                                                                                                                                     |
| `AUTH_REJECTED`            | Cognito refused the credentials, or the session refresh mid-run                                                                                                                                                        | password expired or user disabled — operator; a refresh's `invalid_grant` means the cached session is dead: the operator deletes `.secrets/devcheck.dev.state.json`, then rerun                                                            |
| `WRONG_USER`               | the session isn't the test user                                                                                                                                                                                        | delete `.secrets/devcheck.dev.state.json`, rerun                                                                                                                                                                                           |
| `BUILD_MISMATCH_IN_PAGE`   | the page kept an old build after 3 reloads                                                                                                                                                                             | rerun; persistent → service-worker bug                                                                                                                                                                                                     |
| `MATRIX_GAP`               | a row no step proves through its own entry, or an off-dev row's test file or title isn't there (at load)                                                                                                               | the message names the scenario and row; fix the scenario, never the rule                                                                                                                                                                   |
| `MCP_AUTH_FAILED`          | the claude-client sign-in or code swap failed, before any step: Cognito's error, a state mismatch, no callback (or two), a callback that wasn't blocked — a token expiring mid-run fails its step instead              | the message names Cognito's `error`: `invalid_client` means the client needs a secret now (fall back to a test-user agent token); `redirect_mismatch` means `CLAUDE_CALLBACK` drifted from `cdk/src/config/claudeConnector.ts`; else rerun |
| `STEP_FAILED`              | a scenario step threw                                                                                                                                                                                                  | its row has the error and a screenshot                                                                                                                                                                                                     |
| `LEDGER_GUARD`             | a delete named an unrecorded id                                                                                                                                                                                        | a harness bug — never bypass                                                                                                                                                                                                               |
| `LEFTOVERS`                | a ledger id survived cleanup, a create's id was never recorded, an unrecorded task appeared, a delete was blocked by unrecorded parts, or a removal / read-back threw (the report's "Removal or read-back threw" line) | rerun (the sweep retries); else by hand                                                                                                                                                                                                    |
| `DEV_CHANGED_MID_RUN`      | dev's build changed during the run — main won                                                                                                                                                                          | read the merged PRs, rebase, gate, push, `deploy-dev`, rerun                                                                                                                                                                               |

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
step, proving no row, so a console error fails the run without unproving the rows the feature's steps did prove. Chromium's
`Failed to load resource` line names no URL, so the report's _Failed loads_ lists, in order, every non-injected
response ≥ 400 and every request that got none or whose body failed (not a `net::ERR_ABORTED`, the page cancelling its own), as
`<status or net error> <METHOD> <host/path>` with the query dropped: trace a console error by it. It fails nothing itself.

### Injected failures

A failure dev won't produce on demand (a read that 429s, a dropped connection, a stop that doesn't land) is
injected **by the harness**, never by a switch in shipped code: `ctx.intercept(method, { status?, times?,
abort?, body? })` puts a Playwright route on the page for dev's `/api/<method>`. The next `times` calls (default:
every call) get `status` (default 429) with `body` as JSON (default `{}`), or a dropped connection, and the rest
pass through. A row needing an exact model reply can get a canned one this way (status 200): `category-suggest`
does, beside three rows that go through the real parse and assert only what holds whatever the model says. The returned handle
counts `hits()` and `passed()`; `release()` unroutes it, because a live page route turns off the page's HTTP
cache. The pipeline releases any a step left live when its scenario ends, so a step that threw mid-intercept
can't fail the next scenario's reads.

While a failing intercept (dropped, or status ≥ 400) is live, the console's `Failed to load resource: … status of N` and `net::ERR_FAILED` lines are
the harness's own doing and are left out of _Console errors_. Chromium's line names no URL, so the drop covers
the whole window (a few seconds per step), not one method. To keep a real failure in that
window from hiding, every non-injected response ≥ 400 other than a 429 — `/api` or not — is recorded from the
response itself, as `HTTP <status> on /api/<method>` (or the host and path) `(during an injected failure)`, and a
real 429 still lands in _Throttled (429)_. A real `net::ERR_FAILED` inside the window fails nothing but is listed under _Failed loads_; any other net error's console line still fails the run. Injected responses are known by their
request, not their method, and are listed under _Injected by the harness_, never _Throttled (429)_. `failed-reads` runs last in `SCENARIOS` for this reason. It
starts and stops one ad-hoc focus timer through the dock, which leaves a seconds-long completed session in the test
user's history each run. Sessions have no delete method, so they're not ledgered; a timer an aborted run left running
is stopped or discarded through the dock before the timer steps, judged by the server's list.
`timer-credit`'s `done-stop` step shortens the test user's work block to 1 minute. The settings row isn't ledgered: the step restores it in its `finally`, and because a killed run skips that, each run also puts `DEV_WORK_MIN` back right after the sweep.
`plan-write-refetch` starts three work timers on its own tasks through the API (`startSession`, on a ledgered task only), right before its timer steps, and stops them
through the night rows; a failed step skips the rest of its scenario, so a timer it leaves running is cleared by
`timer-credit`'s `clearTimers` later in the run, and the run's ledger cleanup deletes the task beneath it.

### Rows

A row is one entry point × one case, as the user would say it (`what`), `nominal` or `edge`. `entry` is `ui`,
`api`, `mcp`, `ios`, `raycast` or `extension`; a step drives `ui`, `api`, `mcp` or `ios` (`STEP_ENTRIES` in
`scenario.ts`; an `ios` step runs a plan on the Mac's iOS Simulator through `ctx.ios` — IOS-CHECK.md). Each row
is exactly one of:

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
- **Needs you** (`needsYou: '<why>'`) — what no step can reach: Raycast, the Safari extension, a camera, a Google
  account, and the iOS cases the Simulator can't (IOS-CHECK.md).

A step can say so at run time too — `needsYou(reason)` (`scenario.ts`) — for what the build can't help: the
fixture bank not linked or aged out, the Mac asleep. That step and the rest of its scenario read `needs you`
with the reason (they never ran because of it), the rows its steps prove likewise, the run stays green and the
report's _Needs you_ list names it. The exception is `needsYou(reason, {stepOnly: true})`, for a cause that is
that step's alone and that later steps don't build on (the sim's soft keyboard): only that step reads `needs
you`, and the rest of the scenario runs. It never counts among the run's own failures, and it is never for a bug: a
real throw still fails the step. A failed `ios` row is never called unrelated or a flake before a rerun with the
Simulator up (IOS-CHECK.md → _Failures_). An `ios` step whose sim couldn't run reads `iOS this run: <reason>`; when any
does, the status line says `PASS — iOS NOT RUN (<reason>): <n> iPhone rows untested` and the PR's first line
repeats it (IOS-CHECK.md → Results).

### Slow tier

A step can be **slow** (`cost: 'slow'`) — a wall-clock wait, a sim run — and its scenario then declares the paths
that can affect it (`slowPaths`: repo-relative globs, `**` crosses folders; `matrix.ts` refuses one without the
other). A slow step runs when the run is `--tier all`, a `delta` run (the scenario was named), `--feature` names its
scenario, or the branch's diff against `origin/main` (committed and not) touches one of its `slowPaths`; an
unreadable diff runs them all. Otherwise it is **deferred**: not run, its status `deferred`, the scenario's later
steps still running — so a slow step is never a cheap step's prerequisite. A row whose proving steps were all
deferred reads `deferred`, in the report's own _Deferred (slow tier)_ list, never in _Not proven_ or the paste
lists. **For the all-clear a deferred row counts like off dev** — the branch touches none of its paths, so it
can't have changed what the row proves. A row with any proving step that ran is judged on those steps, with
one exception: when every step through the row's own entry point was deferred, the row reads `deferred`, so a
`ui` row never passes on its `api` step alone (a step that failed still fails it). Slow today: `ios-standalone`
(every step; the app files its rows can see and its harness). Its paths are narrower than everything that could affect those rows (IOS-CHECK.md → the trade), so for it "can't have changed" is a judgement, not a proof. Also `timer-credit`'s `done-stop` (a 1-minute block on the clock): its `slowPaths` name `lambdas/src/sessions.ts`, not `backend.ts`, which nearly every branch touches; the one-line session delegates left there are covered off dev by the contract suite through `handleRpc`. And `timed-reminders`' poller chain, `fuse-test` through `api-e2e-sent` (real minute ticks, ~3.5 min): its `slowPaths` name the reminder code (`lambdas/src/push/**` with the BFF's `PushService`, `pushDispatch.ts`, `ddb/pushRegistry.ts`, shared `reminders.ts`, the push UI, cdk `push-dispatch.ts`), not `backend.ts`, the ddb/rpc layer or `app-stack.ts`; the delegates and remind-index writes are covered off dev by the contract suite and `push/dispatch.test.ts`, the push IAM and schedule by `cdk/src/stacks.test.ts`. And `lc-sittings`' `grace-over` (waits up to 10 min after Done for the sitting's grace to run out): its `slowPaths` name `packages/shared/src/sittings.ts`, not `backend.ts`; the refusal past the grace is also covered off dev by the contract suite on the Lambda and `lambdas/src/index.test.ts`.

Walk the plan's matrix through **the edge-case checklist**: empty / max / invalid input; cancel; repeat
(idempotent); survives a reload; the neighbouring item unaffected; ownership (another user's id). `smoke` alone
has no rows (`MATRIX_EXEMPT`) — it proves the harness, not a feature.

### Selectors and upkeep

- **Roles and labels, never CSS** (`getByRole`, `getByLabel`, `getByText`), and **assert behaviour** — what the
  server holds, what the user sees — not DOM shape. A class or layout change shouldn't break a scenario.
- **You change the UI, you update its scenario**, in the same PR — its iOS probe points too (`pnpm ios-probe`, IOS-CHECK.md → _Probe check_).
- **An old scenario failing on an unrelated PR** (with `--feature`, under _Other scenarios (regression)_ → _Not proven_) is
  still a bug (phase 9) — read its code path first. To show it
  isn't this branch, the fallback is the fails-on-main baseline: the last green full run's report (the archived
  worktrees' `localNotes/devcheck/`), else redeploying `main` to dev and rerunning — two extra deploys, so last.
  A failure confirmed on `main` gets its own small PR, logged; it doesn't block this one.
- **Every scenario runs on every full run; its slow steps only where the branch can affect them** (_Slow tier_).
  When a full run's cheap steps pass 3 minutes, revisit: area tags for whole scenarios, a time budget, a failure
  in an untouched area reported apart, retiring scenarios a redesign replaced. Not before.

## Artifacts

Per run, in the worktree (archived with it): `localNotes/devcheck/<run>/report.md`, `report.json` (the same result for
tooling: `codes` is the dedup'd list, `failures` the harness failures as `{code, message}`), `shots/`.
`report.md`'s _Feature coverage_ splits _This feature_ (`--feature`) — its table and two lists, _You don't need to
test_ (proven on dev, and off dev with its test) and _Needs you_, that `report-<branch>.md` and the `CC done` notes
paste as they are — from _Other scenarios (regression)_: per-scenario counts and a _Not proven_ list, no paste lists,
since those belong to their own features. Without `--feature` there are no paste lists: the table is every
scenario's, and a branch with no scenario of its own reports "no feature rows". On a run that isn't PASS the lists
carry its verdict: they hold only once a run passes.
Shared, in the main checkout: the ledgers (one per slot) and `run.lock` (_Dev slots_). Secrets beside the env file:
`.secrets/devcheck.dev.state.json` (the cached session and the Hosted UI cookie, mode 600 — re-saved after the MCP
sign-in).

## Why not Claude in Chrome

Found while running the quick-add runbooks (2026-10-13): a container session has no Chrome tools — the
extension talks to Claude over native messaging on the same machine, and the container has no Chrome (viewing
the session from the desktop app doesn't add them). The extension also refuses to delete data even when asked,
so a runbook could only list what to clean. The dev check runs where Claude runs and cleans up by id.
