# Local check — the dev check's scenarios, before the dev lock

`pnpm devcheck:local` runs the dev check's scenarios and pipeline (`docs/ops/DEV-CHECK.md`) against a local stack in
the container: no deploy, no dev lock, nothing past `127.0.0.1`. It exists to catch scenario step bugs, locator
mistakes, cross-scenario ordering and leaked timers in seconds instead of a 5–8 min turn on the shared lock.
**It is a pre-flight, never a proof: dev remains the proof.** A red local run blocks `pnpm bot deploy-dev`; a green
one says nothing about dev. Code: `scripts/src/devcheck/local/`, `lambdas/src/local/`.

```
pnpm devcheck:local
  harness ── mints a per-run RSA key → a JWKS (public half) + test-user tokens (app client, claude client)
    ├─ local server (child, killed by PID) — lambdas/src/local/serve.ts
    │    edge.ts = CloudFront stand-in: app-stack.ts's header/query allowlists, stamps the origin secret
    │    ├─ /api/*  → the real BFF handler    (createBffHandler)
    │    └─ /mcp    → the real MCP handler    (createMcpHandler)
    │         real Cognito verifier fed the JWKS (D14 holds) · one InMemoryDoc · inert Google/Claude/Plaid/S3
    ├─ vite dev (child) — http mode, proxies /api /mcp to the edge, BUILD_SHA = HEAD, not watching
    └─ Chromium, signed in by a seeded oidc store → the same pipeline: scenarios → cleanup by ledger id
         → localNotes/devcheck-local/<run>/report.md  "# Local check — … (pre-flight; dev remains the proof)"
```

## Run it

From the feature's worktree, after the gate, before `pnpm bot deploy-dev`:

```bash
HEAVY_CLASS=ui scripts/board/heavy.sh -- pnpm devcheck:local --tier delta --scenario <feature>  # iterate (~30 s)
HEAVY_CLASS=ui scripts/board/heavy.sh -- pnpm devcheck:local --tier full --feature <feature>    # the pre-flight
```

Same flags as `pnpm devcheck` except `--sha` and `--no-deploy-wait` (it always serves the worktree). Exit 0 PASS, 1
FAIL, 2 CRASH. Not alongside your own `pnpm test`; several lanes' local checks can run at once (ports are
kernel-chosen per run, the table and ledger are per run). Needs `~/pw` (Playwright) and nothing else: no test-user
credentials, no AWS.

Measured (2026-11-07): smoke 25 s, full 190 s (startup 1–5 s), ~2.8 GiB peak for the run's processes.

## What runs locally

Every scenario and step except what `scripts/src/devcheck/local/skips.ts` leaves to dev — reported `deferred` with
`local: … runs on dev`, never failed: every `ios` step (the Mac's Simulator), `ios-standalone`, `flux-perf`
(service-worker precache, brotli wasm at the edge), `per-slot-runs` (the slot is the dev lock's), `attachment-delete` (presigned S3), `finance` (the Plaid
Sandbox bank), `category-suggest`'s three real-parse steps (real Haiku), `lc-sittings`' `draft-real` (the real Haiku review draft), `lc-coach`'s `b-draft-cause` (the same draft's cause) and `grace-over` (a wall-clock wait of up to 10 min after Done), `sitting-auto-close`'s idle chain (`pull` through `reopen-repeat`, a ~50-min wall-clock wait), `siri-capture`'s ten model steps (`api-voice-parse`, `api-typed`, `api-typed-ahead`, `api-typed-named-day`, `api-typed-today`, `ui-typed-bar`, `api-relative`, `api-wrap`, `api-roll`, `api-parse-cap`: real Haiku parses), `dev-concurrency-caps`' `poller-ticks` (the poller's minute schedule), `cognito-refresh`'s `renews` (a real
refresh-token grant at Cognito), and `timed-reminders`' poller chain and health line (the push-dispatch poller's minute
ticks; locally the BFF gets a throwaway VAPID public key so Settings' opt-in runs). `skips.test.ts` fails the gate if a
named scenario or step disappears.

Never caught locally — dev's alone: DynamoDB eventual reads and timing races (the in-memory table is instant and
consistent), Lambda concurrency and 429s, real Haiku output (parse is off: raw save; Flux's week note is its deterministic line), Google, Plaid, S3, Web Push, the
deployed shell and service worker, the Simulator.

After the scenarios it runs the **iOS probe check** on its own stub-mode Vite (IOS-CHECK.md → _Probe check_, ~35 s,
one more Chromium): its result is the report's last section, and a failed probe makes the run exit 1.

Beyond dev's checks, the end of a local run fails `LEFTOVERS` on any **running timer** — the table is fresh, so one
left running is this run's leak (the class that broke phone-nits and timer-credit on dev, 2026-11-06).

## Vite doesn't watch

The check's Vite runs with `APERTURE_NO_WATCH` (`app/vite.config.ts` → `server.watch: null`; the probe's stub Vite
too): an edit to the worktree mid-run — the session's own, between rounds — used to full-reload the page under a
step (F168/F170, 2026-11-17: siri-capture's mint lost its page, failed-reads' stop its error line, at the second
Vite logged `page reload`). Not `hmr: false`, which would strand the dep optimizer's own reload. A module first
loaded after an edit is still served edited, so the report says when it can't vouch for the run: under `Target:`,
**Vite reloaded the page mid-run** (any reload, optimizer or restart line in `vite.log` after sign-in) and **The
working tree changed during the run** (its uncommitted diff and untracked files, start vs end); the probe's text
names a `page reload` in `vite-probe.log`. Don't edit the worktree during a local run.

## Guarantees

- **Never off the machine.** The origin can only be switched to `http://127.0.0.1:<port>` (`config.ts`
  `useLocalOrigin`); the page aborts any request off that origin; the server refuses a live `TABLE_NAME`,
  `USER_POOL_ID` or `FILES_BUCKET`, routes every handler call through inert deps (`lambdas/src/local/deps.ts` —
  the edges' live clients exist at import but are never called), and its verifier never fetches a JWKS.
- **The deployed code paths, not a bypass.** The edges are the deployed `handler`s' own factories; auth is the real
  `aws-jwt-verify` with a JWKS passed in (`createCognitoVerifier`'s `jwks` option, which the deployed edges never
  pass). Origin secret, D14 and per-user partitions behave as on dev, the agent and device tokens are set (no
  'local' fallback), and a Lambda 403/404 comes back as the app shell with a 200, as CloudFront's errorResponses
  do (`lambdas/src/local/edge.test.ts`, which also fails if the allowlists drift from `app-stack.ts`). The OAuth
  well-known metadata answers "not configured" locally — the façade is dev's.
- **Lambda's clock.** The server runs with `TZ=UTC`, as Lambda does — the container is Los Angeles time, and a UTC
  day-key bug only shows on a UTC server.
- **Separate from dev's state.** Its own ledger and report under `localNotes/devcheck-local/<run>/`, no run lock;
  `open-pr.ts` reads only `localNotes/devcheck/`, so a local report never feeds a PR.

## When it fails

`LOCAL_SERVER_FAILED`: the server or Vite didn't start — `server.log` / `vite.log` in the run dir (a
`Cannot find module '../lightningcss…'` is the shared-`node_modules` trap: `CI=true pnpm install`). Anything else
reads as on dev: the report, its rows and screenshots. A step that fails only locally is still a bug to read
before dismissing — dev-test bugs are bugs (FEATURE-WORKFLOW.md → phase 9).
