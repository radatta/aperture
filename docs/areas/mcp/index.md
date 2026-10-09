# MCP server — Claude Code and claude.ai → Aperture

An MCP (Model Context Protocol) server that lets **Claude Code** read and write the user's Aperture data
during coding sessions — tasks, calibration, LeetCode history, calendar events, attachments — so the task
list is always in sync with the assistant helping work it. One hosted endpoint (`/mcp`); **claude.ai
(web + phone)** connects to the same endpoint via a Cognito OAuth path (the metadata-façade section below).

The operator is Claude, not the user's thumbs, so the tool grammar is strict and concrete (ISO dates,
minutes, category **ids** from `list_categories`) — the same posture as [bulk-add](../tasks/bulk-add.md).

## Shape

```
Claude Code   --x-aperture-agent-token-->  CloudFront /mcp  -->  aperture-mcp Lambda
claude.ai     --OAuth bearer (Cognito)--->                       ├─ MCP JSON-RPC (hand-rolled, stateless)
                                                                 ├─ resolve credential → userId (your sub)
                                                                 └─ tools/call → handleRpc(userId, …)
                                                                                     ↓
                                                              DynamoDB · Google Calendar · S3 (attachments)
```

The MCP Lambda reuses the BFF's `handleRpc(userId, method, args)` in-process, so every RPC goes through the
same dispatch, the same writes-discipline, and the same state machines — the MCP server adds a transport
and an auth path, nothing more.

## Auth — a static agent token, disambiguated by credential

Claude Code authenticates with a long-lived **agent token** sent as the raw `x-aperture-agent-token`
header (no `Bearer` prefix). Same class + delivery as the recruiting **device token** (a plain Lambda env
var from a gitignored file / `APERTURE_AGENT_TOKEN` in CI, NOT Secrets Manager), validated with
`timingSafeEqual` in `resolveAgentUserId`, attributed to the same Cognito `sub` (`DEVICE_USER_ID`). It is
kept **distinct** from the device token so the two revoke independently.

The token is **unscoped by method** (`*`) — it's a full app session — so the edge disambiguates by
**credential, not method**: the agent header present → validate it, never fall through; else a Cognito
bearer (claude.ai — see the OAuth façade below); else 401. This is the reverse of the recruiting seam
(which keys on the single ingest method name), and the reason is the same `*` decision that keeps
tool-adds free: a new tool never touches auth.

### The agent token is a full app session — with a bounded ceiling

Accepted deliberately (single user; the operator role is exactly "act as me"). What the token **can** do:
every task/log/story/settings row, calendar event inserts on the connected Google accounts, and up to
20 MB × 10 files per task in the Files bucket. What it **cannot** do, by construction:

- **connect/disconnect a Google account** — that's the browser-only OAuth callback, not a tool.
- **read refresh tokens or client secrets** — no tool exposes them, and the MCP function's IAM is
  `ssm:GetParameter` only (no `PutParameter`/`DeleteParameter`).
- **touch S3 keys outside `u/<sub>/`** — keys are minted server-side; IAM is object-scoped to `u/*`.
- **delete a calendar event Aperture didn't create** — the pointer rule (only events whose `eventId`
  Aperture stored).
- **spend the Claude API key beyond the parse** — `parse_task` sends one line to Haiku per call and
  returns fields; it writes nothing. There is no rate cap on it (single user, ~$0.0003 a call, every call
  logged as `event: parse_task`) — a leaked token could run up model spend until it's rotated.
- **reach Plaid or change anything financial** — the MCP role has no Plaid SSM path or Lambda-invoke IAM,
  and the edge pins the Plaid gateway + sync invoker to no-ops (cdk `stacks.test` "the MCP function gets
  nothing Plaid"; `mcp/index.test` drives a finance tool through the edge and asserts the live ones are
  never built). The finance tools only read rows already synced.

**Privacy — finance data leaves the app here.** The finance tools put merchant names, amounts, notes,
account names + last 4 digits, and balances into the Claude conversation (and so claude.ai's history and
retention, and the phone). Full account numbers and Plaid tokens are never stored or exposed. To keep
finances out of voice, disable the three tools on the claude.ai connector if it offers per-tool control
(unverified), or remove them from `FINANCE_TOOLS`.

Revocation is one secret rotation + redeploy + re-register, independent of the recruiting `DEVICE_TOKEN`.
(Rejected alternative: a DynamoDB-only ceiling — the user wanted calendar + attachments too.)

## Tools (v1)

| group            | tools                                                                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| tasks            | `list_tasks {status?}`, `list_backlog`, `create_task`, `create_tasks {tasks[]}`, `update_task`, `complete_task {id, actualMin?}`, `split_task`, `delete_task {id}`, `parse_task {text}` (quick add's Haiku parse, writes nothing — [quick-add](../tasks/quick-add.md)) |
| categories       | `list_categories`, `create_category`, `update_category {id, label?, isWork?, order?, active?}`                                                      |
| calibration / LC | `get_calibration {from,to}`, `list_leetcode_attempts {from?,to?}`                                                                                   |
| calendar         | `list_calendars`, `create_calendar_event`, `delete_calendar_event`, `sync_calendar_event {taskId}`, `get_day_busy`                                  |
| attachments      | `list_attachments`, `attach_file`, `create_attachment_upload` + `confirm_attachment`, `get_attachment_download_url`, `delete_attachment`            |
| finances (read)  | `get_finance_overview {today?}`, `list_finance_transactions {from?,to?,unsorted?,bucket?,merchant?,today?,limit?}`, `list_finance_rules`           |

Notes that matter (carried in the tool descriptions, since the model can't infer them):

- **`complete_task` requires `actualMin`** — completing feeds calibration, and a 0-actual completion would
  pollute the signature metric. It chains `→ in_progress → done` (freezing the calibration baseline) and **replaces**
  any timer-tracked minutes, echoing the previous value so an overwrite is visible. **A parent** (a task with
  parts, [tasks/parts.md](../tasks/parts.md)) is the exception: `actualMin` is a param error there (its actual
  is Σ its parts), and the call is refused while a part is open, with the shared message naming the parts.
- **Parent + parts** ([tasks/parts.md](../tasks/parts.md)): `parentId` on `create_task`/`create_tasks` makes a
  task a part (breaking a deliverable down is one `create_tasks` call), and `update_task {parentId}` attaches or
  (`null`) detaches. `list_tasks` annotates a parent with `parts: {total, done, estimateMin}`, from the same
  read. `delete_task` on a parent deletes every part and returns their ids. `create_calendar_event` refuses a
  parent (its parts carry the blocks).
- **`update_task`** fan-out order is title → categoryId → parentId → due → notes → estimate → status; the estimate
  (the working one) is editable until the task is done/cancelled — `estimateMin` or `bufferMin` alone keeps the
  other (before 2026-10-06 an estimate-only call zeroed the buffer) — the calibration baseline frozen at start
  never moves, and a failing field's error names which fields already applied.
- **`split_task {id, finish, actualMin?, title?, parentTitle?, estimateMin?, bufferMin?, followUpTitle,
  followUpEstimateMin?, followUpBufferMin?}`** ([tasks/split.md](../tasks/split.md)) — "scope change =
  split" is the product's move, so voice gets it as one call rather than improvising cancel + create.
  `finish: "done"` (a started task only) **requires `actualMin`** — the same posture as `complete_task`;
  `keep` rejects it. A split always yields parent + parts: a standalone task becomes "Part 1" (unless `title`)
  under a new parent titled `parentTitle` or its own title; on a part, `parentTitle` is refused; a parent can't
  be split. Returns `{parent, original, followUp}`. Worth the claude.ai per-tool "ask".
- **Due times** ([tasks/due-dates.md](../tasks/due-dates.md)): `dueTime` (`HH:MM`, 24h, the user's local
  time) rides on `create_task`, `create_tasks` and `update_task`, validated before any dispatch. In
  `update_task`, `dueDay` and `dueTime` go out as **one** `setTaskDue` write: time-only keeps the task's
  day, day-only keeps its time, `dueDay: null` clears both, and a time on an undated task is an execution
  error naming what already applied. A timed task syncs to Google Calendar
  ([calendar → Auto-sync](../calendar/index.md)); a failure comes back as `gcalSyncError` on the task.
  Edits made in Google come back via the app's pull ([calendar → Two-way sync](../calendar/index.md)) —
  `list_tasks` does **not** pull, so it shows what the app last pulled; a task Google changed carries
  `gcalPulled` (`{at, note}` — what changed, or what Google changed that Aperture kept).
- **Notes** ([tasks/notes.md](../tasks/notes.md)) ride on `create_task`, `create_tasks` and `update_task`
  (`notes: null` or `""` clears; an update replaces the whole note). They're checked before any dispatch,
  so an over-cap note (5,000 chars) is a param error that applies nothing — including the fields ahead of
  it in an `update_task`, and every task in a `create_tasks` batch. `list_tasks` / `list_backlog` return
  full notes (up to 5 KB each); trimming them in the list tools is a deferred option if that gets heavy.
- **`update_category`** (rename / reorder / `isWork` / retire) merges `label` + `isWork` over the current
  row, since `upsertCategory` requires both; `order` and `active` are patch-style in the contract (omitted
  keeps the current value), so they're sent only when given. `active:false` **retires** the category —
  the app's pickers hide it, existing tasks keep the label — and `active:true` restores it (the same as
  Settings → Retire / Restore). `isWork` here is forward-only; the app's `setCategoryWork` (backfill past sessions) stays unexposed, as does
  `deleteCategory` (reassign-everything).
- **Stale planned tasks lag.** The stale-planned sweep runs inside `getDay`, which no tool calls — so
  `list_tasks status=planned` / `list_backlog` still show yesterday's leftovers as planned until the app is
  opened that day ([TECH §taskPlans](../../arch/TECH.md)).
- **`delete_task`** is a tombstone (no restore tool) that also tombstones the task's plans + attachments
  and **deletes its linked Google Calendar event**. It checks the id first — the backend's `deleteTask`
  is idempotent, so a typo'd id would otherwise report success. Refused on a recurring occurrence
  (`seriesId` set), matching the UI — `getDay` would respawn it; cancel it instead.
- **Rename** is a new contract method, `setTaskTitle` (allowed at any status; with auto-sync on it also
  renames a linked calendar event). Exposed as `update_task.title`.
- **Calendar** events are created **from a task only** (the schema has nowhere to pin a standalone event).
  Times are ISO 8601 **with an explicit offset** — no timezone inference. `create_calendar_event` is
  refused on a task with a due time while auto-sync is on: that task's block is placed at its deadline
  (the refusal adds "From here: sync_calendar_event … update_task …" on the MCP side only — the shared
  `AUTO_PLACED_ERROR` is also the app picker's). **`sync_calendar_event {taskId}`** is the app's Add to
  calendar / Retry / Send to Google (`syncCalendarEvent`, the `ensure` pass): it puts a removed block
  back at the deadline (re-setting the same time never does), retries a failed sync, sends values kept
  over Google, finishes an owed removal. It runs the shared `calendarSyncPlan` first, so it reports what
  the backend decides — `{ outcome: created | updated | removed | unlinked, task }` (`unlinked`: Google
  had already deleted it; call again to create) — and refuses with the reason when the plan is `none`
  (done/cancelled, auto-sync off, no due time and no event, no write default). A Google failure is an
  error; its text is also the task's `gcalSyncError`.
- **Attachments** — two byte paths: `attach_file` sends content inline (base64, capped **64 KB** — tool
  args are model output tokens, so this is a small-text-artifact path) and the Lambda PUTs it to the
  presigned URL; `create_attachment_upload` returns a presigned URL for a real file (up to 20 MB) that a
  shell PUTs directly. Both reuse the existing size-cap + pending→ready flow — **no new IAM**.
- **Finances are read-only** (`lambdas/src/mcp/financeTools.ts`). Sorting, marking, linking, rules and
  Refresh stay app-only. Money is US dollars as numbers (`…Usd`, summed in cents first): positive = money
  out, negative = money in, after an account's sign flip. Every row in the page's range gets its `kind` /
  resolved `bucket` / `period` from `deriveFinanceView` (shared) over exactly the rows the page loads, so
  those match the page; a `from`/`to` window reaching past that range derives only the outside rows
  separately (over the window padded back 31 days) and never re-derives the page's. Without a window,
  `unsorted: true` is exactly the Sort queue (= the overview's `toSort.count`) and `bucket` is the page's
  bucket chip (hidden-account rows included, flagged; `not_spending` too — sorted, but in none of the
  overview's `buckets` totals). `merchant` is a case-insensitive substring, and
  a linked refund larger than what was left of its charge carries `countedUsd` (the part that counts), and a
  charge's `refundedUsd` never exceeds it. `totalUsd` is the net sum of **every** match (`netCents`; the bucket and merchant filters are the All tab's
  `matchesFinanceFilter` / `matchesFinanceText`, without notes) — the answer to "how much at X", even when the list is
  truncated. Hidden accounts are listed with `hidden: true` and excluded from the overview's totals.
  **`today`** is optional: omitted, the server takes the user's day in `USER_TIME_ZONE`
  (America/Los_Angeles) at their `dayStartHour` (`dayKeyInZone`), and the result says which
  (`todaySource`) — so "how much budget is left?" works as one spoken sentence. Pass `today` when
  travelling. (The finance sync's schedule is the other place Pacific time is fixed — cdk
  `finance-sync.ts`.) The overview omits the Plaid environment (the MCP's gateway is inert, so it would
  always read "sandbox"). Data is as fresh as the last bank sync; voice can't trigger one.

## Dependency note — the MCP protocol is hand-rolled (no SDK)

We did **not** add `@modelcontextprotocol/sdk`. Against the dependency rule: (A) substantial hard-to-own
logic — **no**, the stateless tools-only subset (initialize, tools/list, tools/call, notifications, ping;
no sessions, no SSE, no server-initiated messages) is ~200 lines; (B) security-critical / subtle
correctness — **no** for this subset (the subtle transport parts — sessions, stream resumption, event ids
— are exactly what stateless mode doesn't use; JWT verification stays in `aws-jwt-verify`, already
justified). Footprint that tipped it: v1.30.0 is 4.3 MB unpacked and pulls in two HTTP frameworks
(`express`, `hono`) + `jose` + `ajv` + `zod` for machinery we never run. The one thing lost — free
tracking of future spec revisions — is covered by the dev-stage conformance smoke, needed regardless of
transport. See `lambdas/src/mcp/protocol.ts`.

## How it's wired

- `lambdas/src/mcp/protocol.ts` — pure JSON-RPC core, `handleMcpMessage(msg, ctx)`.
- `lambdas/src/mcp/tools.ts` — the tool table; each `run` dispatches through `ctx.dispatch` (= `handleRpc`).
- `lambdas/src/mcp/financeTools.ts` — the read-only finance tools, over `deriveFinanceView` /
  `financeListRange` (`packages/shared/src/finance.ts`, shared with the page) and `dayKeyInZone`
  (`packages/shared/src/dates.ts`).
- `lambdas/src/mcp/types.ts` — `ToolContext`, `Tool`, `RpcParamError` (→ JSON-RPC -32602; execution errors
  become `isError` results the model self-corrects from).
- `lambdas/src/mcp/index.ts` — the AWS/HTTP + auth edge (origin gate, well-known routes, credential fork,
  dispatch, upload).
- `lambdas/src/mcp/wellKnown.ts` — the phase-2 OAuth metadata façade (pure builders, zero I/O).
- `lambdas/src/auth/verify.ts` — `resolveAgentUserId`, the client-bound `createCognitoVerifier` (the MCP
  bearer path), and `assertClientAllowed` (the BFF's D14 deny).
- `packages/shared/src/rpc.ts` — `AGENT_TOKEN_HEADER`, and `setTaskTitle` in `API_METHODS`.
- `cdk/src/lib/app-stack.ts` — the `aperture-mcp-<stage>` function, its Function URL, the `/mcp` CloudFront
  behavior + origin-request policy (forwards `x-aperture-agent-token`) + the `McpCachePolicy` that forwards
  `authorization`, the three well-known behaviors, the `aperture-claude-<stage>` app client + MCP resource
  server, the shared `grantBackendData` / `ackLambdaIam` helpers (MCP gets SSM read-only), and the `McpUrl`
  / `McpClientId` outputs.
- `cdk/src/config/claudeConnector.ts` — claude.ai's connector callback URLs (committed constants).
- `cdk/src/bin/aperture.ts` — `agentTokenFor(stage)` (cloned from `deviceTokenFor`).
- `scripts/aws/health-check.mjs` — the post-deploy `/mcp` probe (401 without a token, 405 on GET, the
  façade's S256 metadata + the path-suffixed protected-resource doc, and the bearer-→-`"invalid token"`
  R7 check).

## Operator checklist (phase 1)

0. **Before pushing to `dev`:** set GitHub secrets `AGENT_TOKEN_DEV` and `AGENT_TOKEN_PROD`
   (`openssl rand -hex 24`, different values). Unset → every deploy rotates the token and Claude Code stops
   matching (same trap as the recruiting device token).
1. Push the branch to `dev`; read the diff (expect a second Lambda + a `/mcp` behavior); the health check
   must show the two `/mcp` lines green.
2. Register it (user scope, so it's available in every project):
   `claude mcp add --transport http aperture-dev https://dev.aperture.rahuldatta.dev/mcp -H "x-aperture-agent-token: <AGENT_TOKEN_DEV>"`
   (use `${ENV_VAR}` rather than pasting the literal token — Claude Code echoes `--header` values to
   terminal history). Register prod as `aperture` for daily use.

### Header-path smoke (do before relying on it)

Claude Code has a bug history of not sending custom headers on the initial handshake. Verify:

1. **Server proof (no Claude Code):** three `curl -X POST https://dev.aperture.rahuldatta.dev/mcp` calls
   with the agent header — `initialize`, `tools/list`, `tools/call list_categories` — expect 200 each; the
   same `initialize` without the header → 401.
2. **Client proof:** `claude mcp list` shows it connected; in a session ask for the backlog.
3. **If 1 passes and 2 fails:** the CloudWatch `mcp_auth` line on the failing request reads
   `credential:"none"` — Claude Code dropped the header. Fallback: a local stdio shim (a ~50-line
   forwarder that makes the HTTP call itself, so header transmission isn't Claude Code's job), registered
   with `claude mcp add`. The server needs no change.

## What each surface proves

- **Unit tests** (`lambdas/src/mcp/*.test.ts`): the protocol, every tool over an in-memory table + the
  Google fake + a recording uploader, the auth fork, and the contract rename (3× via the shared suite).
- **Only a deployed stage** proves: CloudFront forwarding the custom header, Claude Code actually sending
  it, and `DEVICE_USER_ID` = your `sub` (a wrong value writes tasks under `u#local`).

## claude.ai — the OAuth façade (built)

The same `/mcp` endpoint accepts a **Cognito bearer** for claude.ai's custom connector, alongside the
agent-token path (which is unchanged). Two verified facts shaped it:

- **DCR is not required** — you paste a pre-registered client id into the connector's OAuth settings, so
  Cognito's lack of Dynamic Client Registration is irrelevant.
- **Cognito's `openid-configuration` omits `code_challenge_methods_supported`** (confirmed `null` live),
  and per the MCP auth spec a client MUST refuse PKCE when that field is absent.

So the Lambda serves a thin **metadata façade** (`wellKnown.ts`, pure builders, zero outbound calls) at
three GET routes behind the origin gate, ahead of the POST-only gate:

- `/.well-known/oauth-protected-resource` (+ the RFC 9728 `/mcp`-suffixed form) — points claude.ai at us
  as the resource and at our origin as the authorization server.
- `/.well-known/oauth-authorization-server` (+ `/.well-known/openid-configuration`) — **`issuer` is OUR
  origin** (RFC 8414 §3.3 — the client checks issuer against the metadata URL it fetched, not the token),
  the `authorization`/`token` endpoints point at Cognito's hosted UI, and it **injects
  `code_challenge_methods_supported: ["S256"]`** — the one field Cognito omits. No `registration_endpoint`.

A 401 carries `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp"` —
**but a Lambda Function URL renames that header on every 401** to `x-amzn-remapped-www-authenticate` (AWS
security behavior; verified on dev), so clients never see it under its real name. claude.ai therefore
discovers the metadata by its documented fallback: probing `/.well-known/oauth-protected-resource/mcp`,
then the root form — both served. (If claude.ai ever insists on the header, restore it with a CloudFront
viewer-response Function that copies the remapped header back.) Cognito stays the real authorization server for the login + token
exchange; the façade only publishes correct metadata from our origin.

**Decisions:**

- **Client-bound verifier.** The MCP bearer path verifies against the `aperture-claude-<stage>` app
  client id (`createCognitoVerifier(poolId, clientId)`), so a token minted for the SPA app-client is
  rejected here. Safe from the deploy cycle that keeps the BFF verifier un-bound, because the claude
  client has no CloudFront dependency (its callbacks are constants, its resource identifier is
  domain-literal). An unconfigured stage (no `MCP_CLIENT_ID`) **rejects** a bearer rather than falling
  back to the `local` dev user — a public OAuth endpoint must not treat "unconfigured" as "anyone".
- **D14 — cross-client replay denied.** The BFF verifier is deliberately not client-bound, so a
  claude.ai-minted token would otherwise be a valid full `/api/*` token. The BFF now **denies** tokens
  carrying the claude client id (`assertClientAllowed`), keeping "claude.ai can only do what `/mcp`
  exposes" true by construction.
- **D13 — 30-day refresh token** for the claude client (vs the SPA client's 7). Its refresh token lives
  in claude.ai's server-side store, not a browser, and expiry means re-running the connector OAuth dance
  on web _and_ phone; the localStorage-leak reasoning behind the 7-day SPA ceiling doesn't apply.
- **`Authorization` forwards via a cache policy, not the origin-request policy.** CloudFront strips
  `Authorization` by default, and CDK's L2 origin-request policy _refuses_ it (throws at synth) — so the
  `McpCachePolicy` carries it in the cache key (AWS's documented path; the header in the key means a
  response is never shared across tokens). The origin-request policy still forwards the agent-token + MCP
  headers. **Gotcha (found on the first dev deploy, invisible to synth/cdk-nag):** the cache policy's
  `maxTtl` is **1s, not 0** — an all-zero TTL is "caching disabled", and CloudFront rejects a
  `HeaderBehavior` on a disabled policy with a runtime 400. POST is never cached anyway, so `/mcp` still
  effectively doesn't cache.
- **Resource-server Name is explicit (`aperture-mcp-<stage>`).** CDK defaults Name to the identifier,
  but Cognito validates Name against `[\w\s+=,.@-]+` — a URL identifier (every domain stage) fails at
  deploy time. The identifier itself may be a URL. Found on the second dev deploy; pinned by a test that
  runs against the custom-domain template.

Spec-revision note: the handshake advertises MCP `2025-06-18`, but the PKCE-metadata refusal rule and the
dual well-known probing are from the `2025-11-25` revision, which is what Anthropic documents its client
against — the façade is built to those semantics. `2026-07-28` adds an RFC 9207 `iss`-echo check; whether
claude.ai's live client enforces it yet is unconfirmed (cheap forward-compat, not built).

### Operator checklist (phase 2)

0. No new GitHub secrets (the client id is not a secret). Re-confirm the connector callback URLs in
   `cdk/src/config/claudeConnector.ts` against Anthropic's docs.
1. Deploy; read `McpClientId` from the stack outputs (or Cognito → App clients, region us-west-1).
2. **R7 curl, before any claude.ai UI:** `POST …/mcp` with `Authorization: Bearer x` → expect **401 with
   body `"Unauthorized: invalid token"`** (the verifier ran, so the header reached the Lambda). If it reads
   `"requires a credential"` (CloudWatch `mcp_auth`: `credential:"none"`), the header was dropped → add a CloudFront viewer-request Function that
   copies `authorization` → `x-aperture-authorization` (the Lambda already reads that fallback; no Lambda
   change). The health check automates this probe + the S256-metadata check.
3. claude.ai → Connectors → Add custom connector → URL `…/mcp`, Advanced → **OAuth Client ID =
   `McpClientId`**, secret blank → Connect → hosted-UI login → tools list → `list_categories`, one write.
4. After merge to `main`: repeat for prod with the prod client id. Phone inherits the connector.

## Voice — a live capture surface (no code of its own)

The user captures by voice: iPhone **Action Button → Claude app voice mode → the prod `aperture`
claude.ai connector**, i.e. the phase-2 OAuth path above. No Siri, no Shortcuts, nothing voice-specific
server-side. Observed 2026-09-23: "add get milk to aperture" created the task in one utterance; by 2026-09-26
a fully specified one ("…, errands, 10 minutes, due Friday") also landed with category, estimate and due
day — the model resolved the category label → id via `list_categories` unprompted. Since 2026-10-05 a
clock time is sayable too ("due Friday at 4pm" → `dueDay` + `dueTime: "16:00"`).

**Treat voice as a first-class surface when designing a feature.** It's one spoken sentence, no screen,
the model as the only UI — so:

- **If a feature adds something the user would want to say at capture time, make it sayable** — exposed on
  `create_task` / `update_task`, with a tool description that lets the model map natural speech to it
  (labels → ids, "Friday" → ISO date). A field reachable only from the app UI is invisible to voice.
- **Ids are the friction.** Anything keyed by id (categories today) costs the model an extra lookup call;
  a description that names the lookup tool is the minimum.
- **Nothing is confirmed by eye.** Mishearing lands straight in prod, so destructive or calibration-feeding
  tools (`delete_task`, `complete_task`, `split_task`) are the risky ones — prefer the claude.ai per-tool permission
  "ask" for those. A new destructive tool inherits this concern.
- **Logic that only runs when the app opens doesn't run for voice** (the stale-planned lag above is the
  existing case).
- **Finances by voice are questions, not edits:** "how much budget is left?" → `get_finance_overview` with
  no arguments; "what did I spend at Amazon?" → `list_finance_transactions {merchant: "amazon"}` and its
  `totalUsd`. Nothing finance-related is
  writable from here.

Known limits: online-only (no capture queue); relative dates resolve in the model's idea of "today" and
timezone; each capture is a claude.ai conversation; the D13 refresh token isn't sliding (no rotation
configured), so the connector needs re-auth roughly monthly — the first thing to
check if voice capture suddenly fails.

## Raycast quick-add — a Mac capture surface

`tools/raycast/aperture-add.sh` ([README](../../../tools/raycast/README.md)): a Raycast hotkey → one
line → `parse_task` (**Claude Haiku 5.5**, server-side — the same parse as the app's quick add,
[quick-add](../tasks/quick-add.md)) turns it into `create_task` fields (short title + notes, category id,
due day/time, estimate) → `create_task`. Each Aperture call is a plain `curl` of one stateless `tools/call`
(no `initialize` needed) with the prod agent token from Keychain. Capture only, by decision (2026-10-09):
updates and reorganizing stay in the claude.ai chat and the app. The script checks the HTTP status **and**
the body — MCP returns a param error (`error`) and a tool failure (`result.isError`) inside a 200 — and
trims and rejects a blank title itself, since `createTask` stores the title verbatim.

Decisions (2026-10-12) — the parse moved to the server ([quick-add](../tasks/quick-add.md) D6):

- **The BFF owns the one prompt; the Mac holds no Anthropic key.** `parse_task` runs the shared
  `runQuickParse` against the user's live active categories and real `dayStartHour`, and validates
  server-side, so the script lost its prompt, schema, field re-check and category cache. Of the
  2026-10-09 bullets below, structured outputs and the field re-check now run in the Lambda
  (`lambdas/src/anthropic/`, `validateParsedTask`); the category cache and the hard-coded 4am are
  *superseded* — the enum is the live active list and "today" reads Settings.
- **A failed `parse_task` (an `ok: false` result, an RPC error, a timeout at 12s) still adds the task
  raw**, with the reason in the red toast — unchanged behaviour, new reasons.

Decisions (2026-10-09):

- **Haiku only parses; the script writes.** Rejected: giving Haiku the tools (the API's MCP connector, or
  `claude -p`) — the connector's bearer fails this edge's Cognito path, it adds model turns, it puts prod
  write tools in front of a one-liner, and a timeout no longer says whether the task was saved.
- **Parse via structured outputs**, `categoryId` an `enum` of the cached ids (retired left out; the cache
  is superseded 2026-10-12, above). The ids
  come from `list_categories`, cached a day per stage on the Mac; a failed refresh uses the stale copy.
  The script re-checks each field against the server's rules and drops a bad one, naming it in the toast;
  if the server still rejects the args (`-32602`, raised before any write) it resends the line raw.
- **"Today" uses the 4am day start** (`dayStartHour`'s default — no MCP tool reads Settings), so a
  relative due date means what the app's Today means. *Superseded 2026-10-12:* the server reads the real
  `dayStartHour`.
- **Parse failure still adds the task, raw** (the line as its title), with a loud `Added RAW (couldn't
  parse: …)` toast, red (exit 1) — the user's call over blocking; nothing is quiet.
- **A time with no day means today** (`call dentist 4pm`) — the user's call; a time whose day was
  dropped as invalid is dropped too.

## Deferred

- A **create-only token** for Raycast (scoped to `parse_task` + `create_task`, like the recruiting
  device token's single method) — the Mac's Keychain holds the full agent token until then.
- **`create_task` doesn't check that `categoryId` exists.** A category deleted between Raycast's
  `parse_task` and its `create_task` (seconds, since 2026-10-12; a day while the script cached
  categories) can still be written onto a new task, after `deleteCategory`'s reassign ran. Fix
  server-side (reject an unknown/deleted id), which also covers any other caller.
- No raw `call_rpc` escape hatch (the small typed surface is deliberate; `*` at the auth layer already
  makes adding a tool free).
- Prod CloudWatch alarms on the MCP function (the BFF has them; the MCP function does not yet).
