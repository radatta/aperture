# Dev check — Claude tests the deployed dev stage itself

`pnpm devcheck` drives headless Chromium, signed in as a dev-only test user, against
`https://dev.aperture.rahuldatta.dev`, after `pnpm bot deploy-dev` dispatched the commit. It waits for the deploy, proves
the page is the commit under test, runs scenarios with screenshots in both themes, deletes everything it
created, and writes a report that leads with which of the feature's coverage rows were proven (_Rows_, below).
It replaces the Claude-in-Chrome runbooks: a green full run with zero leftovers in which every row is proven,
covered off dev or listed for the user, plus Claude reading the screenshots, is what "tested on dev" means
(FEATURE-WORKFLOW.md, phases 8–9). Code: `scripts/src/devcheck/`.

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

From the worktree whose commit `pnpm bot deploy-dev` dispatched, with nothing else heavy running (no `pnpm test`, no dev
server — CLAUDE.md → COI ceilings) but another session's dev check on the other slot, which is fine once the run count allows it (_Dev slots_). Wrapped as
`HEAVY_CLASS=ui scripts/board/heavy.sh -- pnpm devcheck …`, the run shows on the board with its peaks, and its job event
carries where the time went — the deploy wait, sign-in, each scenario, cleanup (SESSION-BOARD.md → _Perf fields_):

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
`PW_MISSING`, `MATRIX_GAP`, `LANES_REFUSED`, and `WRONG_USER` when the env file names someone else — stop the run before it starts:
printed to stderr, exit 2, no `report.md`. Otherwise read `report.md` first — its first line is the status, and when the
harness itself failed (the deploy wait, a sign-in, the build check, cleanup) the error's text follows it, with a
`**Failed:** <code> — <message>` line per failure under _Leftovers_ (a step's error is in its _Steps_ row, so a
step-only failure's first line is exactly `# Dev check — FAIL: STEP_FAILED`) — then the screenshots. One run per slot at a time (`localNotes/devcheck/run.lock` for `dev`, `run.devb.lock` for `devb` — _Dev slots_).

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
scope (`config.ts` → `SLOT_TARGETS`). So is the run lock (`run.lock` for `dev`, `run.devb.lock`; `config.ts` → `runLockFile`): two
sessions can each run one devcheck at once, one per slot — each slot's functions have their own reservations
(CI-BOT.md → _Dev deploy blast radius_ → Compute), and each run sweeps only its own slot's ledger and table. One slot at a time stays inside the kill
alarms, but both slots on back-to-back full runs trip the three-hour Duration alarm in 2.0–2.6 h: a full run is
~250k Lambda ms (measured 2026-11-26). So **before each run on dev, the lane counts** (the lock doesn't): the
runs whose `run-start` falls in the last three hours and the last hour (ids and `t` are UTC) in
`/workspace/localNotes/devcheck/`'s `ledger.dev.web.jsonl` and `ledger.dev.jsonl` (slot A: one run per id across the
two; an id in `ledger.dev.jsonl` had iOS rows) and `ledger.devb.jsonl` (slot B: its own runs, even at the same id).
Only ids ending `-smoke`, `-delta`, `-full` or `-all` are runs. If its own run would pass 12 in three hours or 6 in
the hour (the counts and weights: CI-BOT.md → _Dev deploy blast radius_ → Compute), it waits until it wouldn't and
tells the hub `[info]`. On devb, iOS rows read needs-you (`SIM_SLOT_A_ONLY`: the sim is slot A's) — when the branch
touches iOS paths the reason says to release devb and `deploy-dev` again, which sends such a branch to dev
(CI-BOT.md → _Dev slots_). The `dev-slot-b` scenario's
rows are slot-relative — the BFF's `/api/health` names the run's slot, the app and `/mcp` answer at its origin, its
reminders are configured and its poller ticking — so it stays as a standing check that a run is where its lock says.

**The test user's daily LeetCode Start gate is per stage.** A full run starts ~20–25 sittings (2026-11-17 count),
so prod's caps — 100 Starts and 400 Start attempts a user a day — ran a slot's test user dry after four or five
runs, and every sitting row then failed `Too many sittings started today.` until the app day turned over (04:00 PT).
On a dev slot the BFF lifts them to 1000 and 4000, keyed off its `STAGE` (shared `sittings.ts` →
`sittingStartsPerDay`, `lcStartAttemptsPerDay`); any other stage, an unset one included, keeps prod's. The gate
row isn't readable through the API, so the harness estimates it (`budget.ts`): every Start is in the slot's ledger
before its call, so the report's header gives today's count over the app day the BFF keys the gate by (the test
user's `dayStartHour`, read at run start: "Sitting starts today (ledger estimate): ~N of 1000, resets 04:00 PT"),
and a step that fails on either cap's refusal — thrown, swallowed by the step (the API client's answers) or the
page's own Start, while that step runs — reads **needs-you** with the reason, as does the rest of its scenario, and
the run stays green. A starts refusal only when the count is plausible, half the cap or more: under it the step stays
a failure, "check the gate counter" (a counter bug, or another writer on the test user, isn't a spent budget). An
attempts refusal whenever the ledger has a Start today — that gate also counts resumes and refused Starts, which
the ledger never sees. Once the budget has run out in a run, a later Start refused because a sitting the cut-short
scenario opened is still open (`Another sitting is still open`) reads needs-you too.

## Two users

On slot A a full run is two lanes (`lanes.ts`), one test user each: by default one after the other, the iPhone lane
first (`serial`); `DEVCHECK_LANES=parallel` runs them at once, so the run takes about as long as its longer lane
instead of both. Measured 2026-11-18 on one build: parallel 644–1029 s a full run (5 runs, 3 cold), serial 1449 s.
Parallel isn't the default because it peaked the BFF at 18 concurrent, its whole reservation (0 throttles, CloudWatch
over the 5 runs): the Simulator's cold Home beside the browser lane's is the known 429 shape below, and the bar for
the default was a peak of at most 15. It returns as the default with a BFF reservation that holds two cold Homes at once (12 + 12 + the
harness's ~2 each):

| Lane    | Scenarios                                                               | Signs in as                                                                                                             | Its files                                                         |
| ------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| iPhone  | `user: 'iphone'`: `ios-standalone`, `ios-probe`, `category-suggest-ios` | `identifiers.json` → `email.devTestUser`, the Simulator's own user (its email and Keychain item are pinned in `sim.sh`) | `devcheck.dev.env`, `devcheck.dev.state.json`, `ledger.dev.jsonl` |
| browser | every other one                                                         | `email.devTestUserWeb`                                                                                                  | `devcheck.dev.web.env`, `…web.state.json`, `ledger.dev.web.jsonl` |

**Why two users.** Separate partitions, so neither lane's tasks, plans or categories show in the other's lists and
counts — `areas`' Home picker caps at 30 and the iPhone lane plans 16 tasks for today, to name one. What the two still
share is the stage: the BFF's reserved concurrency (18) and MCP's (9), the DynamoDB ceiling, the LeetCode catalog
(only `lc-catalog` reads it) and the build marker, which each lane checks itself. A 429 from the two users' load
together reads like any other (_Throttles (429)_), and when the lanes ran side by side the report says so beside it.

**How a lane runs.** Each lane is a whole pipeline run — its own deploy wait (shared: the iPhone lane sends no sim
job before the build is confirmed), sign-in, sweep of its own ledger, settings baseline, in-page build check, steps,
cleanup and leak check — so nothing about cleanup changes with two writers: each ledger has one. The iPhone lane's
browser page parks on `/api/health` after its build check (an `/api/` path never boots the app from the service
worker), so no second app polls dev while the Simulator works. The lanes merge into one report in scenario order:
the header's `Lanes:` line gives each lane's time and the wall, the iPhone lane's harness lines start `iPhone user:`,
its created records say `(iPhone user)`, and its screenshots sit in `shots/iphone/`. A lane that fails or crashes
fails or crashes the run, by lane; the other still finishes and cleans up.

**When it's one user.** devb (no Simulator), slot A before the browser user's env file exists (setup step 1b), or
`DEVCHECK_LANES=one-user`: every scenario in one lane as `email.devTestUser`, as before lanes — so merging needed no
setup first. Otherwise slot A runs both lanes, serial unless `DEVCHECK_LANES=parallel`. An explicit `serial` or `parallel` where the run can't have two users (devb, no env file)
refuses (`LANES_REFUSED`) rather than quietly timing one. When no iPhone step will run (a branch touching no iOS path), its scenarios stay in the
browser lane, every step deferred, and no second user signs in — unless the iPhone ledger holds an earlier run's
leftovers, which that lane then sweeps.

**Scenarios that name the user** read `ctx.testUser` (the lane's), never the constant: `identifier-cleanup` checks
the session is that user. `category-suggest-ios` seeds its own Garden history in the iPhone user's partition — in a
one-user run `category-suggest` seeded it already, and it skips its seed.

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
   `ENV_MISSING`. Appended on the Mac (`<mac-repo>` is the Mac repo path, from the gitignored `.local/mac-root`:
   main checkout; shown in the SessionStart context) with: `cd <mac-repo> && id=$(aws
cloudformation describe-stacks --profile aperture-dev --region us-west-1 --stack-name ApertureApp-dev --query
"Stacks[0].Outputs[?OutputKey=='McpClientId'].OutputValue" --output text) && [ -n "$id" ] && [ "$id" != "None" ]
&& ! grep -q '^DEVCHECK_CLAUDE_CLIENT_ID=' .secrets/devcheck.dev.env && printf 'DEVCHECK_CLAUDE_CLIENT_ID=%s\n'
"$id" >> .secrets/devcheck.dev.env && chmod 600 .secrets/devcheck.dev.env` (one line; a recreated dev stack
   means removing the old line and rerunning it).
   1b. **The browser lane's user** (slot A only; _Two users_). The same kind of user, `identifiers.json` →
   `email.devTestUserWeb`, made in dev's pool under the `aperture-dev` break-glass profile (the freeze denies
   `AdminCreateUser` to every other principal, `cdk/src/lib/org-stack.ts`), writing
   `.secrets/devcheck.dev.web.env` with all seven keys (the claude client's included: the append line above writes
   only the original user's file). On the Mac, one line (`<email>` is `email.devTestUserWeb`): `cd <mac-repo> &&
if [ -e .secrets/devcheck.dev.web.env ]; then echo 'already there, not overwritten'; else ( set -C && em=<email> &&
acct=$(aws sts get-caller-identity --profile aperture-dev --region us-west-1 --query Account --output text) &&
pool=$(aws cloudformation
describe-stacks --profile aperture-dev --region us-west-1 --stack-name ApertureData-dev --query
"Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" --output text) && client=$(aws cloudformation
describe-stacks --profile aperture-dev --region us-west-1 --stack-name ApertureApp-dev --query
"Stacks[0].Outputs[?OutputKey=='UserPoolClientId'].OutputValue" --output text) && claude=$(aws cloudformation
describe-stacks --profile aperture-dev --region us-west-1 --stack-name ApertureApp-dev --query
"Stacks[0].Outputs[?OutputKey=='McpClientId'].OutputValue" --output text) && [ -n "$pool" ] && [ -n "$client" ] &&
[ -n "$claude" ] && [ "$pool" != None ] && [ "$client" != None ] && [ "$claude" != None ] && { aws cognito-idp admin-get-user --profile aperture-dev --region us-west-1 --user-pool-id
"$pool" --username "$em" >/dev/null 2>&1 || aws cognito-idp admin-create-user --profile aperture-dev --region
us-west-1 --user-pool-id "$pool" --username "$em" --message-action SUPPRESS --user-attributes Name=email,Value="$em"
Name=email_verified,Value=true >/dev/null; } && pw="$(openssl rand -base64 24)Aa1_" && t=$(mktemp) && printf
'{"UserPoolId":"%s","Username":"%s","Password":"%s","Permanent":true}' "$pool" "$em" "$pw" >| "$t" && aws
cognito-idp admin-set-user-password --profile aperture-dev --region us-west-1 --cli-input-json "file://$t"; r=$?;
rm -f "$t"; [ "$r" = 0 ] && sub=$(aws
cognito-idp admin-get-user --profile aperture-dev --region us-west-1 --user-pool-id "$pool" --username "$em" --query
"UserAttributes[?Name=='sub'].Value" --output text) && umask 077 && printf
'DEVCHECK_EMAIL=%s\nDEVCHECK_PASSWORD=%s\nDEVCHECK_SUB=%s\nDEVCHECK_COGNITO_HOST=%s\nDEVCHECK_CLIENT_ID=%s\nDEVCHECK_POOL_ID=%s\nDEVCHECK_CLAUDE_CLIENT_ID=%s\n'
"$em" "$pw" "$sub" "aperture-dev-$acct.auth.us-west-1.amazoncognito.com" "$client" "$pool" "$claude" >
.secrets/devcheck.dev.web.env && echo done ); fi`. It refuses an existing file (up front, and `set -C` at the
   write), runs nothing if the `cd` fails, reuses a user a failed earlier try made, keeps the password off every argv (zsh's builtin `printf` into a mode-600 `mktemp` file, `>|` past
   `set -C`, removed right after the call — `file:///dev/stdin` fails on macOS with "Invalid JSON received"; `_` is
   the guaranteed symbol, `!` would trip zsh) and prints nothing secret; the subshell keeps `umask` and `pw` out of the operator's shell.
   Until the file exists, slot A runs one user. One more user in the pool costs nothing: Cognito's free tier on the Lite and Essentials plans is
   10,000 monthly active users with no end date ([pricing](https://aws.amazon.com/cognito/pricing/); the pool sets
   no feature plan, so never Plus), the admin calls that create it carry no charge, and the claude client signs in
   with a code and PKCE, not the paid machine-to-machine grant. It needs no Keychain item: the Simulator stays the
   original user. Step 3's fixture bank is per user, so the browser user links its own.
2. **Playwright, outside the repo** — it is no package's dependency (it would add a browser download to every
   CI install, and no test needs it). `~/pw` is a scratch directory outside the monorepo, so npm there doesn't
   break the pnpm-only rule: `mkdir -p ~/pw && cd ~/pw && npm init -y && npm install playwright && npx
playwright install chromium`. The harness loads it from `~/pw` (`DEVCHECK_PW_ROOT` overrides;
   `DEVCHECK_CHROMIUM` points at a system Chromium). Check `npm view playwright version` before refreshing.

3. **Fixture bank** (the `finance` scenario). Once per user that runs it — on slot A the browser lane's
   (`devcheck.dev.web.env`), on devb its one user — from Safari on the Mac: read
   `DEVCHECK_EMAIL` / `DEVCHECK_PASSWORD` from that user's env file, sign in to dev in a private window,
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
  `NoSuchKey` — and `isGone` (`api/core.ts`) counts both as gone.
- **The test user only.** The env file must name the test user, and before any write the signed-in
  session's email and `sub` (ID claims and access token) must match it — else `WRONG_USER`, no writes. The MCP
  session is held to the same check (below). A step can outlive the hour-long token (an iOS step runs minutes
  while the page sits idle), so before every API request a session with under 60 s left is re-read from the
  page, which renews itself, and if the page hasn't, renewed from here with the page's refresh token at the
  env's dev-pool token endpoint (`login.ts` `refreshSession`, `assertDevCognitoUrl`, never following a
  redirect), then checked again (`WRONG_USER`). Nothing is written back to the page or logged. **Before the
  browser loads anything**, every launch renews the cached session the same way, with the cache's refresh token,
  whatever its age (`login.ts` `cachedState`, through `launchCached`). The new tokens are checked: `WRONG_USER` throws
  before any browser, and the cache goes. They are then handed to the context in memory. So the app never starts on a
  dead, boundary or server-refused token, and never renews at launch. The log line starts `renewed the cached
session before launch`.
  - The file isn't written: it is re-saved after sign-in, as before.
  - A dead refresh token (`invalid_grant`) discards the cache, so the run signs in through the form.
  - Any other failure (the network, a 5xx, no answer in 15 s) loads the cache as it is, logged, and the app renews it
    itself. The timeout frees the request, but one Cognito already took can't be recalled.
  - Refresh-token rotation is off on the dev clients. If it were on, the file would go stale between sign-ins: a run
    that dies before `saveState`, or a mid-run renew, leaves the old refresh token, and the next launch signs in
    through the form.

  Why: F226, a first load that 401-burst on 2026-11-17 and failed every scenario's console row.

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
- **Every other kind is cleaned by id, by its own ledger `via`** (_Ledgers_ lists them; `ledgerKind()` in
  `scripts/src/devcheck/api/core.ts` tells them apart, so a delete for one kind refuses another's id). Where a kind
  needs more than that, the header of the scenario that writes it says how it's written, cleaned and what it leaves
  behind — Flux sets (`scenarios/flux-history.ts`), log entries (`log-mcp.ts`), categories (`parts-v2b-reads.ts`),
  habits, archived rather than deleted (`day-guards.ts`), places and the place token (`places.ts`), capture tokens
  (`siri-capture.ts`) — and a new kind's goes there too, not here
  (`git grep -l 'ledger kinds\? (DEV-CHECK' scripts/src/devcheck/scenarios` finds them).
- **Verified, not assumed.** After cleanup every id this run created or swept is read back (`getTask` → null).
  A coach attempt's answer is one export read per pass (sweep, removals, read-back), plus one per throw: the
  export is an eventual read, any throw drops the held answer before the retry, a returned delete removes its
  own id from it, and the read-back takes its own after the last removal — except for an attempt this run
  called `gone`, which got no delete and so is read back on its own read. A task already gone
  (deleted with its parent) is `gone`, not a failure. A create still in flight when a step
  fails is waited for (30 s) and recorded; one that never answers is a possible leak. Tasks the ledger doesn't
  know are never deleted: ones there before the run are listed, ones that appeared during it (a create path the
  recorder missed) fail the run — keep the test user free of recurring series, whose day's occurrence can
  appear mid-run around the 4am day start. Before any delete the server is asked for parts the ledger doesn't
  know; a task with one is never deleted (deleting a parent deletes its parts) and the run fails. A crashed or
  killed run (Ctrl-C, a timeout — its cleanup doesn't run) leaves its recorded ids pending, and the next run
  sweeps them first. A create still in flight at the kill was never recorded: a task, place, category or capture
  token the next run lists as not in the ledger; an API create of any kind, from its `intent` line, once under
  _Possible leak from a killed earlier run_ (never failing the run; a `reported` line marks it shown).
  **Categories go last**, in the sweep and in cleanup alike: the server refuses `deleteCategory` while a task, habit,
  series or roll is on one, and a task can predate the category it was moved to, so no creation order is enough
  (F203: a sweep that took them oldest-first left a killed run's `Garden`, and the next category-suggest saw two).
  A category still refused after every ledgered row went names what holds it, and a row the ledger never recorded
  is never touched. **A dropped connection is retried**: a removal or read-back that hits one (`terminated`, a
  socket-level `fetch failed`) is tried again after 0.5 s and 2 s, each retry listed under _Retried after a dropped
  connection_; only then is it a failure (F177). Never a create — one whose answer died may have landed. Loading the app writes server-side too (`getDay` materialises the day), always as the test user —
  the cached session is checked and renewed before any page loads.
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

Home's cold load is 15 `/api` calls, at most 12 on the wire at once (measured on devb 2026-11-13, no cap), under
the BFF's reserved concurrency on dev, 18 ([CI-BOT.md](CI-BOT.md) → _Dev deploy blast radius_ → Compute), with room
for the harness's own calls. The app has had no client-side cap since
2026-11: the cap of 8 (`inflight-cap`) patched the account quota of 10, and the quota is 1,000 now. (Before the cap, a
dated _Known 429s_ rule here let a run count as green with them.) A 429 means
Lambda never started the function, so that attempt was never tested — the app's retry (`app/src/data/retry.ts`) may
have recovered the call, but the method isn't proven by this run. Chromium logs every 429 as a console error, retried
or not, and the report's _Throttled (429)_ section names each (`/api/<method>`), which Chromium's line doesn't. Treat
one as a bug — a refetch storm, a burst wider than the reservation, the harness bursting on its own — never as weather:
every scenario that closes with `noConsoleErrors` (smoke's too; `failed-reads`, the last, in a full run) fails on any real 429 the run has seen so far, naming the `/api` method (another origin's by host and path). It reads
the responses themselves (`ctx.throttled()`), so it also catches a 429 inside an injected-failure window, whose console
line is dropped. Failures a scenario injects on
purpose (_Injected failures_) are listed apart, under _Injected by the harness_, and never count here. The harness's
own `/api` and `/mcp` clients back off a Lambda 429 and retry, so no console sees it and a call that succeeds may
still have been throttled; `ctx.api.throttles()` and `ctx.mcp.throttles()` count those, for a step that must prove
none happened (`dev-concurrency-caps`). With two lanes side by side (`DEVCHECK_LANES=parallel`, _Two users_) the
Simulator's cold Home loads land on the same reservation as the browser lane's steps; the report says so beside any
429, and the default serial run is how to tell the two apart.

The test user's rows aren't all kept: dev's table expires tombstones ([TECH.md](../arch/TECH.md) §2.3, rule 4), so a scenario can't count on one being physically there. The `dead-rows` scenario covers the delete paths.

## Read cost

On the dev slots only (`isDevSlot(STAGE)`, so prod's handler and requests are unchanged), the BFF and `/mcp`
Lambdas ask DynamoDB for `ReturnConsumedCapacity: 'TOTAL'` and log one line per request when it ends, a throw
included (`lambdas/src/ddb/meter.ts`):
`{"event":"ddb_units","v":1,"edge","op","status","at","ms","ru","wu","n","by"}`. `op` is the RPC method, a
fixed route, or the MCP method plus a known tool name. Nothing from the request's own data reaches it.
`ru`/`wu` are the read and write units, and `n` the calls. `by` holds the top 8 accesses as
`[verb+c:kind, calls, units, items, dead]`, with the rest summed as `other`. The verb is `q`, `g`, `x` (a GSI
query), `p`, `d`, `u` or `b`, with a `c` added for a consistent read. The kind is the sort key's leading word.
`dead` counts the tombstoned rows the read returned. A read is billed on everything its key condition
covers, so a JS filter after it saves nothing. A refused conditional write records no units, and DynamoDB work
still running after the handler returns isn't on its line: both are small undercounts. The worker Lambdas
aren't metered, and `devcheck:local` writes no line: its table is the in-memory doc (LOCAL-CHECK.md).

**Its log cost.** The line is about 250 bytes, roughly 2 MB of CloudWatch ingest per full run (1.74 MB over 7,287 lines, measured 2026-11-26) on top of the
Lambda's own START/END/REPORT lines. CloudWatch Logs' always-free tier is 5 GB a month, one figure for
ingestion, storage and Logs Insights scans. The dev account's whole intake over the month before the meter
(2026-10-27 to 11-26) was about 333 MB across every group, with 96 MB stored: about 120 full runs a month. At
that pace the meter adds about 240 MB a month. Even at 30 full runs a day it adds about 1.8 GB, and the total
stays under 2.2 GB. Not measured: prod's share, if the free tier is shared across the organization. Re-measure
with the maintainer's break-glass profile. `IncomingBytes` is per log group, so a plain
`get-metric-statistics` call reads almost nothing; sum the groups with a search:

```
aws cloudwatch get-metric-data --profile aperture-dev --region us-west-1 --start-time <iso> --end-time <iso> --metric-data-queries "[{\"Id\":\"logs\",\"Expression\":\"SUM(SEARCH('{AWS/Logs,LogGroupName} MetricName=\\\"IncomingBytes\\\"', 'Sum', 86400))\"}]" --query 'MetricDataResults[0].Values' --output text
```

The values are bytes per day; add them up. Past the free tier, the meter is the first thing to shorten.

The harness stamps each step's start (`StepResult.at`) and the run's (`RunResult.startedAt`) into
`report.json`. `pnpm devcheck:cost` joins the lines to those windows and prints units and Lambda ms per phase,
scenario, step, op and access, plus the top 10 requests:

1. About 3 min into the run, prove the line is there:
   `pnpm bot logs --groups bff,mcp --since 5m --filter '%ddb_units%'` (`bff-devb,mcp-devb` on devb). Without
   `--groups`, `bot logs` reads the held slot's groups, but falls back to slot A's when it can't read the lock,
   so name them.
2. The fetches cover a past window and the reader drops every request outside the run, so release the slot's
   lock first. At least 2 min after the run ends (log delivery), print the run's two fetches, one minute
   before its start to two after its end, with its slot's groups, and run both:

   ```
   pnpm devcheck:cost --report localNotes/devcheck/<run>/report.json --window
   ```

   One is `--filter '%ddb_units%'`; the other is `--filter REPORT`, for the Lambda's own Duration.

3. Read the two fetch directories:

   ```
   pnpm devcheck:cost --report localNotes/devcheck/<run>/report.json --logs localNotes/devlogs/<units key> --logs localNotes/devlogs/<REPORT key> --out localNotes/read-cost-<run>.md
   ```

   Pass `--before <an earlier out>.json` for deltas. The steps that ran in one run only are named, because
   the totals then compare different work. To compare two runs, give both the same slow-step selection
   (`--feature`; _Slow tier_), because a diff that reaches a scenario's `slowPaths` changes which steps run.

That is three of `pnpm bot logs`' ten fetches an hour (CI-BOT.md). The reader refuses, exit 1:

- a fetch that hit its line cap or failed;
- a fetch directory with no `.log` file, or missing one edge's group (a partial artifact);
- a fetch with no units line inside the run (the wrong slot, a window that misses it, or an unmetered build);
- a report without the stamps;
- a two-user report, parallel or serial. The merged report keeps one lane's windows, so the other lane's
  requests would land in the wrong step.

## Ledgers

| File (in the main checkout's `localNotes/devcheck/`) | Written by                        | Covers                                                                                                 |
| ---------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `ledger.dev.jsonl`                                   | the harness                       | the test user's partition (browser, API and MCP creates) — on slot A with two users, the iPhone lane's |
| `ledger.dev.web.jsonl`                               | the harness                       | the browser lane's user's partition (_Two users_)                                                      |
| `mcp-ledger.dev.jsonl`                               | `.claude/hooks/mcp-dev-ledger.sh` | the MCP agent's partition on `aperture-dev`                                                            |

One ledger per user, never shared: cleanup reads a ledger's ids back with its user's token, so another user's id
would read as gone. A one-user run on slot A leaves `ledger.dev.web.jsonl` alone and logs any ids pending in it; the
next two-user run's browser lane sweeps them.

Append-only JSONL, one line per event. The harness writes `{t, run, op, id?, via?, title?, status?, of?}`, `op`
one of `run-start`, `intent` (an API create about to be sent — one with no `created` or `refused` after it is
reported as a possible leak; `refused` is a param error, or a domain normalizer's refusal, the server raised before any write), `created`,
`deleted`, `gone`, `swept`, `reported` (a killed earlier run's orphan `intent`, shown once; `of` names that
run), `run-end`; `title` is for the report only. A `created`
line's `via` names what cleanup reads back and removes (`ledgerKind`, `api/core.ts`): a task, a Flux set, a place, the
place token (`place-token:<run>`), a finance rule, a recurring series (deleted with the occurrences `getDay`
spawned for it — the series id is their record, [tasks/recurring](../areas/tasks/recurring.md) §6), and on the fixture bank's rows a bucket set
(`finance-bucket:<run>:<row>`), a refund link (`finance-link:<run>:<row>`) or a period mark
(`finance-mark:<run>:<row>`) — recorded before the click that makes it, cleared (unsorted / unlinked / unmarked)
at cleanup; the row itself is the fixture's and stays. The LeetCode coach's: an attempt (`coach:attempt`, its id from
the answer, deleted), and, with no id of their own, a slot change (`coach-slot:<run>:<day>:<slug>`, restored), the
floor (`coach-floor:<run>:<day>`, turned off) and the focus override (`coach-focus:<run>`, cleared) — each recorded
before its call; a past day's slot change or floor reads as gone. `lc-coach-ai` records `coach-focus:<run>` before every `startCoachPick` that could move the focus (an AI pick may; a start with the setting off can't); the day row's pick itself isn't ledgered — it can't be
deleted or redone (one a day, coach.md → _The AI pick_). `lc-catalog`'s import (`startCatalogImport`, `import_catalog`) isn't ledgered either: the catalog is stage-wide public metadata, not the test user's data, and stays for the next run, which reuses it (coach.md → _The full LeetCode catalog_). Its model spend is the stage's $0.25 stop (coach.md). Its catalog steps are slow tier: they run on `--feature lc-catalog` or when the catalog's own code moves (the scenario's `slowPaths`). Its `mcp-model` row lives a few runs per slot: dev's capped catalog (300) leaves at most 300 problems to the model, 50 a kick, and the slot's $0.25 stop never resets on its own; after that the row reads _Needs you_ with the reason, and the model path is proven off dev (`lambdas/src/catalog/import.test.ts`) and by the prod import's own status. The MCP hook
writes `{t, op, id, parent?, via, session}`, `op` one of `created`, `reparented`, `tainted` (the id has a part
the hook never recorded — it never clears, so that parent stays undeletable), `deleted`. It denies an `aperture-dev` `delete_task` unless the id has a `created`
line and no `tainted` one, and records the parts a parent's delete took with it (CLAUDE.md → _Aperture MCP
connector_, standing approval 1; `docs/areas/mcp/index.md`). The MCP result shape it parses is inferred, not
yet pinned against a live call — a mismatch records nothing, so deletes deny.

## Reason codes

| Code                       | Means                                                                                                                                                                                                                  | Do                                                                                                                                                                                                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ENV_MISSING`              | env file absent or a key missing — `devcheck.<slot>.env`, or on slot A the browser user's `devcheck.dev.web.env`                                                                                                       | setup step 1 (the browser user's: step 1b, or `DEVCHECK_LANES=one-user` meanwhile)                                                                                                                                                                                       |
| `SLOT_UNKNOWN`             | the dev locks couldn't be read at start, so the run can't tell which slot its branch deployed to (_Dev slots_)                                                                                                         | rerun; `pnpm bot lock status` shows both locks                                                                                                                                                                                                                           |
| `NO_LOCK`                  | the branch holds no dev lock and another branch holds `dev` live — the run would land in that branch's test (_Dev slots_)                                                                                              | `pnpm bot deploy-dev` takes a slot (or wait for `dev` to free)                                                                                                                                                                                                           |
| `PW_MISSING`               | no Playwright in `~/pw`                                                                                                                                                                                                | setup step 2                                                                                                                                                                                                                                                             |
| `DEPLOY_NOT_FOUND`         | no dispatched deploy run for the SHA                                                                                                                                                                                   | did `pnpm bot deploy-dev` run for it?                                                                                                                                                                                                                                    |
| `DEPLOY_FAILED`            | the run failed                                                                                                                                                                                                         | read the run; a failed `verify` job names why in its `::error::` line                                                                                                                                                                                                    |
| `DEPLOY_TIMEOUT`           | run never finished, or the edge kept serving another build                                                                                                                                                             | the message names what it serves                                                                                                                                                                                                                                         |
| `AUTH_REDIRECT_UNEXPECTED` | Sign in didn't reach the dev Hosted UI                                                                                                                                                                                 | check the env file's host                                                                                                                                                                                                                                                |
| `AUTH_PAGE_CHANGED`        | the Hosted UI form isn't the classic one                                                                                                                                                                               | screenshot in `shots/`; update `login.ts` deliberately                                                                                                                                                                                                                   |
| `AUTH_REJECTED`            | Cognito refused the credentials, or the session refresh mid-run                                                                                                                                                        | password expired or user disabled — operator; a refresh's `invalid_grant` means the cached session is dead: rerun — the launch renew discards a dead cache and signs in through the form                                                                                 |
| `WRONG_USER`               | the session isn't the test user                                                                                                                                                                                        | rerun — at launch a wrong cached or renewed identity discards the cache itself; if it repeats, the env file `.secrets/devcheck.<slot>.env` (the browser lane's: `devcheck.dev.web.env`) doesn't name the pool's test user (its `DEVCHECK_SUB` or credentials) — operator |
| `LANES_REFUSED`            | `DEVCHECK_LANES` isn't `one-user`, `serial` or `parallel`, or asks for two users where the run can't have them (devb, or no `devcheck.dev.web.env`) — refused before the lock                                          | unset it, or set up the browser user (step 1b)                                                                                                                                                                                                                           |
| `BUILD_MISMATCH_IN_PAGE`   | the page kept an old build after 3 reloads                                                                                                                                                                             | rerun; persistent → service-worker bug                                                                                                                                                                                                                                   |
| `MATRIX_GAP`               | a row no step proves through its own entry, or an off-dev row's test file or title isn't there (at load)                                                                                                               | the message names the scenario and row; fix the scenario, never the rule                                                                                                                                                                                                 |
| `MCP_AUTH_FAILED`          | the claude-client sign-in or code swap failed, before any step: Cognito's error, a state mismatch, no callback (or two), a callback that wasn't blocked — a token expiring mid-run fails its step instead              | the message names Cognito's `error`: `invalid_client` means the client needs a secret now (fall back to a test-user agent token); `redirect_mismatch` means `CLAUDE_CALLBACK` drifted from `cdk/src/config/claudeConnector.ts`; else rerun                               |
| `STEP_FAILED`              | a scenario step threw                                                                                                                                                                                                  | its row has the error and a screenshot                                                                                                                                                                                                                                   |
| `LEDGER_GUARD`             | a delete named an unrecorded id                                                                                                                                                                                        | a harness bug — never bypass                                                                                                                                                                                                                                             |
| `LEFTOVERS`                | a ledger id survived cleanup, a create's id was never recorded, an unrecorded task appeared, a delete was blocked by unrecorded parts, or a removal / read-back threw (the report's "Removal or read-back threw" line) | rerun (the sweep retries); else by hand                                                                                                                                                                                                                                  |
| `DEV_CHANGED_MID_RUN`      | dev's build changed during the run — main won                                                                                                                                                                          | read the merged PRs, rebase, gate, push, `deploy-dev`, rerun                                                                                                                                                                                                             |

## Writing a scenario

A feature adds one file, `scripts/src/devcheck/scenarios/<feature>.ts`, and edits no list: `scenarios/index.ts`
finds it on disk, and a file that exports no Scenario, two, or one whose `id` isn't its file name fails the load.
It sets `order` to place itself in the run: the scenarios that predate discovery sit at 10, 20, … 440 in their old
order (`LEGACY_ORDER`, whose comments say why each sits where it does), a tie breaks by `id`, and
`pnpm --dir scripts exec tsx src/devcheck/list.ts` prints the result (`--json`: the fingerprint a refactor diffs
before and after). A scenario that sends Simulator jobs sets `user: 'iphone'` and sends nothing else to the
browser: on slot A it runs in the iPhone lane as the Simulator's user, with its own data (_Two users_). Detail that's about this scenario alone — what it leaves behind, a kind it ledgers, why it
sits where it does — goes in its header comment, not here. A new API or MCP method goes in its area's file
(`api/<area>.ts`, `mcp/<area>.ts`, next to the composers `api.ts` and `mcp.ts`), so lanes don't all edit one
client. Its `rows` are the plan's dev-test matrix (_Rows_, below); a Chrome runbook maps onto its steps one for
one:

```ts
export const quickAdd: Scenario = {
  id: 'quick-add', // its file's name: quick-add.ts
  title: 'Quick add parses a line',
  order: 65, // after capture-dock (60), before parts-v2 (70)
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
extends `pw-types.ts`. A feature scenario ends with `noConsoleErrors` (`scenario.ts`): the console and throttle check is its own
step, proving no row, so a console error or a real 429 fails the run without unproving the rows the feature's steps did prove. Chromium's
`Failed to load resource` line names no URL, so the report's _Failed loads_ lists, in order, every non-injected
response ≥ 400 and every request that got none or whose body failed (not a `net::ERR_ABORTED`, the page cancelling its own), as
`<status or net error> <METHOD> <host/path>` with the query dropped: trace a console error by it. It fails nothing itself.

### Injected failures

A failure dev won't produce on demand (a read that 429s, a dropped connection, a stop that doesn't land) is
injected **by the harness**, never by a switch in shipped code: `ctx.intercept(method, { status?, times?,
abort?, forward?, body? })` puts a Playwright route on the page for dev's `/api/<method>`. The next `times` calls (default:
every call) get `status` (default 429) with `body` as JSON (default `{}`), or a dropped connection, and the rest
pass through. `forward` sends the real call first (`route.fetch()`) and drops its answer: a write that lands but
reads as failed, as `mock-ui-cancel-5xx` needs. A row needing an exact model reply can get a canned one this way (status 200): `category-suggest`
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
is stopped or discarded through the dock before the timer steps, judged by the server's list. `pulse-tracking` leaves
its completed pulse session rows the same way, on tasks the cleanup deletes, and the user's one `pulsestate` row: empty
after a run, or holding the slow step's open session after one that ran it (the next run's first pulse settles it).
`timer-credit`'s `done-stop` step shortens the test user's work block to 1 minute. The settings row isn't ledgered: the step restores it in its `finally`, and because a killed run skips that, each run also puts `DEV_WORK_MIN` back right after the sweep. The same write turns the coach's AI pick off
(`coachAiPick: false`), so no other scenario's Home or coach read starts one; `lc-coach-ai` turns it on per step and
off in each step's `finally`. It also puts the coach's plan mode back to `auto` (`coach-fixes` sets one per step and
restores it in its `finally`), so a killed run never leaves a later scenario's plan in another mix.
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
(every step; the app files its rows can see and its harness), and `ios-probe` (IOS-CHECK.md → _Probe job_: the same plans cut to their probes, ~4–5 min of Mac time), which is opt-in — its `slowPaths` are its own two files, so it runs on `--feature`/`--scenario ios-probe` — and deferred with `ios-standalone runs in full this run` whenever ios-standalone's steps run (`probeSkip`, passed to the pipeline as `skip`). `pulse-tracking`'s `window-lapse` (a real 15.5-min silence, no calls while it waits; its `slowPaths` are the shared and Lambda `pulse.ts` and the scenario; off-dev cover in `lambdas/src/backend.pulse.test.ts`): a run that includes it takes ~16 min more, so start it in the background and renew the dev lock (`pnpm bot lock renew`) before and midway. Running it automatically is the user's call (devcheck runtime); the seam, if it's wanted only when the headless check flags something: `pnpm devcheck:local` already runs that check, so it would write its verdict keyed by the head sha to the devcheck home, and `run.ts` would add `ios-probe` to the slow list when that verdict, for this sha, failed or warned. ios-standalone's paths are narrower than everything that could affect those rows (IOS-CHECK.md → the trade), so for it "can't have changed" is a judgement, not a proof. Also `lc-coach-ai`'s real-pick steps, `ai-day` through `swap-after` (one Opus call, up to ~1 min, one a day on the test user — a same-day rerun reads them as _Needs you_): its `slowPaths` name the AI pick's own files (shared `coachAi.ts` and `coach.ts`, `lambdas/src/coach/**`, `coachWorker.ts`, the prompt and `liveAnthropic.ts`, `useCoach.ts`, `TodayCard.tsx`, the scenario), not `backend.ts`; the guardrails, the claim and every fallback are covered off dev by `coachAi.test.ts` and `lambdas/src/coach/pick.test.ts`. Also `timer-credit`'s `done-stop` (a 1-minute block on the clock): its `slowPaths` name `lambdas/src/sessions.ts`, not `backend.ts`, which nearly every branch touches; the one-line session delegates left there are covered off dev by the contract suite through `handleRpc`. And `timed-reminders`' poller chain, `fuse-test` through `catch-up-sent` (real minute ticks: ~3.5 min to the end-to-end send, then ~9 more for the retry device N's 3 retries, its run-out and its catch-up 5 minutes on): its `slowPaths` name the reminder code (`lambdas/src/push/**` with the BFF's `PushService`, `pushDispatch.ts`, `ddb/pushRegistry.ts`, shared `reminders.ts`, the push UI, cdk `push-dispatch.ts`), not `backend.ts`, the ddb/rpc layer or `app-stack.ts`; the delegates and remind-index writes are covered off dev by the contract suite and `push/dispatch.test.ts`, the push IAM and schedule by `cdk/src/stacks.test.ts`. And `lc-sittings`' `grace-over` (waits up to 10 min after Done for the sitting's grace to run out): its `slowPaths` name `packages/shared/src/sittings.ts`, not `backend.ts`; the refusal past the grace is also covered off dev by the contract suite on the Lambda and `lambdas/src/index.test.ts`. And `siri-capture`'s `api-dup-window` (a 61 s wait past the duplicate window), `api-cap` (200 captures, two at a time, to the daily cap, ~1 min) and `api-parse-cap` (real Sonnet parses, one at a time, until the user's 40 a day are spent — ~3–4 min and about $0.20), `api-busy` (eight captures at once through one token, four of them parses) and `api-latency` (six real parses timed, one at a time — ~30 s): its `slowPaths` name the token store and the caps (`lambdas/src/auth/scopedToken.ts`, `lambdas/src/ddb/scopedTokens.ts`, shared `capture.ts`), not `backend.ts` or `index.ts`, which nearly every branch touches — so a change to `captureForToken`'s order of count, parse and create alone doesn't run them; the counters, the window and the parse cap are also covered off dev by `lambdas/src/backend.capture.test.ts`. `api-cap` and `api-parse-cap` start clear of UTC midnight (the caps' day) by more than they run — 3 and 7 min — waiting it out if not (`api-dup-window` needs no wait: a roll can only make its second capture a new one, which it expects). And `capture-titles`' every model step (`api-sample`, `mcp-sample`, `ui-review`, `api-spoken`, `api-overflow` — about 45 real Sonnet parses, ~1–2 min): its `slowPaths` name the parse itself (shared `quickParse.ts`, `titleWords.ts`, `spokenTime.ts`, the prompt and `liveAnthropic.ts`, the scenario); the title rules are covered off dev by `packages/shared/src/titleWords.test.ts`. And `lc-timer-pauses`' chain on one sitting, `pause` through `reads-mcp` (a real 3.6-min pause on LeetCode's timer and 3.2 counted minutes after it, ~7–8 min with the UI): its `slowPaths` are the scenario alone, so a change to the fold runs it only with `--feature lc-timer-pauses` — naming shared `sittings.ts` would add those minutes to every branch that touches it, the user's call (devcheck runtime); the fold is covered off dev by `packages/shared/src/sittings.test.ts` and its cheap `edges` and `many-pauses` steps run on every full run.

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
test_ (proven on dev, and off dev with its test) and _Needs you_, that `report-<branch>.md`
pastes as they are (the `[pr-open]` message carries what HUB.md → _Checkpoints_ names) — from _Other scenarios (regression)_: per-scenario counts and a _Not proven_ list, no paste lists,
since those belong to their own features. Without `--feature` there are no paste lists: the table is every
scenario's, and a branch with no scenario of its own reports "no feature rows". On a run that isn't PASS the lists
carry its verdict: they hold only once a run passes.
Shared, in the main checkout: the ledgers and the run locks, one of each per slot (_Dev slots_). Secrets beside the env file:
`.secrets/devcheck.dev.state.json` (the cached session and the Hosted UI cookie, mode 600 — re-saved after the MCP
sign-in; the before-launch renew patches the loaded copy in memory, never the file).

## Why not Claude in Chrome

Found while running the quick-add runbooks (2026-10-13): a container session has no Chrome tools — the
extension talks to Claude over native messaging on the same machine, and the container has no Chrome (viewing
the session from the desktop app doesn't add them). The extension also refuses to delete data even when asked,
so a runbook could only list what to clean. The dev check runs where Claude runs and cleans up by id.
