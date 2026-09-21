# MCP server — Claude Code (and, later, claude.ai) → Aperture

An MCP (Model Context Protocol) server that lets **Claude Code** read and write the user's Aperture data
during coding sessions — tasks, calibration, LeetCode history, calendar events, attachments — so the task
list is always in sync with the assistant helping work it. One hosted endpoint (`/mcp`); **claude.ai
(web + phone)** connects to the same endpoint via OAuth in a later phase.

The operator is Claude, not the user's thumbs, so the tool grammar is strict and concrete (ISO dates,
minutes, category **ids** from `list_categories`) — the same posture as [bulk-add](../tasks/bulk-add.md).

## Shape

```
Claude Code   --x-aperture-agent-token-->  CloudFront /mcp  -->  aperture-mcp Lambda
claude.ai     --OAuth (Cognito), phase 2->                       ├─ MCP JSON-RPC (hand-rolled, stateless)
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
**credential, not method**: the agent header present → validate it, never fall through; else (phase 2) a
Cognito bearer; else 401. This is the reverse of the recruiting seam (which keys on the single ingest
method name), and the reason is the same `*` decision that keeps tool-adds free: a new tool never touches
auth.

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

Revocation is one secret rotation + redeploy + re-register, independent of the recruiting `DEVICE_TOKEN`.
(Rejected alternative: a DynamoDB-only ceiling — the user wanted calendar + attachments too.)

## Tools (v1)

| group | tools |
| --- | --- |
| tasks | `list_tasks {status?}`, `list_backlog`, `create_task`, `create_tasks {tasks[]}`, `update_task`, `complete_task {id, actualMin}` |
| categories | `list_categories`, `create_category` |
| calibration / LC | `get_calibration {from,to}`, `list_leetcode_attempts {from?,to?}` |
| calendar | `list_calendars`, `create_calendar_event`, `delete_calendar_event`, `get_day_busy` |
| attachments | `list_attachments`, `attach_file`, `create_attachment_upload` + `confirm_attachment`, `get_attachment_download_url`, `delete_attachment` |

Notes that matter (carried in the tool descriptions, since the model can't infer them):

- **`complete_task` requires `actualMin`** — completing feeds calibration, and a 0-actual completion would
  pollute the signature metric. It chains `→ in_progress → done` (freezing the estimate) and **replaces**
  any timer-tracked minutes, echoing the previous value so an overwrite is visible.
- **`update_task`** fan-out order is title → categoryId → dueDay → estimate → status; the estimate throws
  if frozen, and the error names which fields already applied.
- **Rename** is a new contract method, `setTaskTitle` (allowed at any status; it does NOT rename a linked
  calendar event — edit-sync is a deferred gap). Exposed as `update_task.title`.
- **Calendar** events are created **from a task only** (the schema has nowhere to pin a standalone event).
  Times are ISO 8601 **with an explicit offset** — no timezone inference.
- **Attachments** — two byte paths: `attach_file` sends content inline (base64, capped **64 KB** — tool
  args are model output tokens, so this is a small-text-artifact path) and the Lambda PUTs it to the
  presigned URL; `create_attachment_upload` returns a presigned URL for a real file (up to 20 MB) that a
  shell PUTs directly. Both reuse the existing size-cap + pending→ready flow — **no new IAM**.

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
- `lambdas/src/mcp/types.ts` — `ToolContext`, `Tool`, `RpcParamError` (→ JSON-RPC -32602; execution errors
  become `isError` results the model self-corrects from).
- `lambdas/src/mcp/index.ts` — the AWS/HTTP + auth edge (origin gate, credential, dispatch, upload).
- `lambdas/src/auth/verify.ts` — `resolveAgentUserId` (beside `resolveDeviceUserId`).
- `packages/shared/src/rpc.ts` — `AGENT_TOKEN_HEADER`, and `setTaskTitle` in `API_METHODS`.
- `cdk/src/lib/app-stack.ts` — the `aperture-mcp-<stage>` function, its Function URL, the `/mcp` CloudFront
  behavior + origin-request policy (forwards `x-aperture-agent-token`), the shared `grantBackendData` /
  `ackLambdaIam` helpers (MCP gets SSM read-only), and the `McpUrl` output.
- `cdk/src/bin/aperture.ts` — `agentTokenFor(stage)` (cloned from `deviceTokenFor`).
- `scripts/aws/health-check.mjs` — the post-deploy `/mcp` probe (401 without a token, 405 on GET).

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

## Phase 2 — claude.ai (deferred, designed)

Same endpoint, adds an OAuth path for claude.ai's custom connector. Verified: DCR is not required (paste a
pre-registered client id); but Cognito's `openid-configuration` omits `code_challenge_methods_supported`
(confirmed live), so the MCP Lambda must serve a thin **metadata façade** — its own
`/.well-known/oauth-protected-resource` + a corrected `/.well-known/oauth-authorization-server` that
proxies Cognito but injects the missing PKCE field — plus a Cognito app client for claude.ai and
audience validation in the Lambda. Full detail lives with the phase-2 work.

## Deferred

- claude.ai OAuth (phase 2, above).
- A rename does not sync to a linked calendar event (edit-sync — a pre-existing calendar gap).
- No raw `call_rpc` escape hatch (the small typed surface is deliberate; `*` at the auth layer already
  makes adding a tool free).
- Prod CloudWatch alarms on the MCP function (the BFF has them; the MCP function does not yet).
