// @aperture/lambdas — the RPC BFF handler. One Lambda, one route: POST /api/<method> → the matching
// ApiClient method over DynamoDB (single-table). Business logic lives in BackendClient (shared
// machines); this file is just the AWS/HTTP edge. Phase 11 replaces the fixed userId with the Cognito
// `sub`; Phase 12 provisions the table + wires TABLE_NAME. Beside the RPC route sit three non-RPC ones:
// /api/health, the Google OAuth callback, and the iPhone Shortcut's GET /api/places/<slug>/tasks.
import {
  APERTURE,
  AUTH_HEADER,
  isLcIngestMethod,
  ORIGIN_SECRET_HEADER,
  PLACE_READ_TEXT,
  placeLensPath,
  placeReadUnknownText,
  placeUnknownError,
} from '@aperture/shared';
import type { PlaceRead, PlaceReadError } from '@aperture/shared';
import { createLiveDoc } from './ddb/LiveDoc';
import { createCognitoVerifier, resolveDeviceUserId, resolveUserId } from './auth/verify';
import type { Verifier } from './auth/verify';
import type { DocClient } from './ddb/DocClient';
import type { GoogleGateway } from './google/gateway';
import type { Presigner } from './s3/presigner';
import type { ObjectStore } from './s3/objects';
import type { PlaidGateway } from './plaid/gateway';
import type { FinanceSyncInvoker } from './finance/invoker';
import type { AnthropicGateway } from './anthropic/gateway';
import { handleRpc } from './handler';
import { BackendClient } from './backend';
import { Repo } from './ddb/repo';
import { liveWrites } from './ddb/writes';
import { PlaceTokenStore } from './ddb/placeTokens';
import { PlaceReadCapError, resolvePlaceRead } from './auth/placeToken';
import { createLiveGoogle } from './google/liveGoogle';
import { verifyState } from './google/state';
import { createS3Presigner } from './s3/presigner';
import { createS3ObjectStore } from './s3/objects';
import { createLivePlaid } from './plaid/livePlaid';
import { noopInvoker } from './finance/invoker';
import { liveInvoker } from './finance/liveInvoker';
import { createLiveAnthropic } from './anthropic/liveAnthropic';
import { createPublicKeyReader } from './push/publicKey';
import type { PublicKeyReader } from './push/publicKey';

export const runtime = `${APERTURE}-lambda` as const;

const doc = createLiveDoc(process.env.TABLE_NAME ?? 'aperture');

// Built once at cold start. Construction never touches the network, so an empty FILES_BUCKET (local /
// tests) is fine — only an actual attachment call would then fail.
const presigner = createS3Presigner(process.env.FILES_BUCKET ?? '');
const objects = createS3ObjectStore(process.env.FILES_BUCKET ?? ''); // deletes attachment bytes

// Verifier is wired only when the pool env is present (deployed). Locally it's null → dev userId.
// clientId is left unset (single-client pool, no deploy cycle), but a token minted for the claude.ai MCP
// client is DENIED here (D14) — that client's ceiling is the /mcp tool surface, not the full BFF.
const verifier = process.env.USER_POOL_ID
  ? createCognitoVerifier(process.env.USER_POOL_ID, null, {
      rejectClientIds: process.env.MCP_CLIENT_ID ? [process.env.MCP_CLIENT_ID] : [],
    })
  : null;

// The live calendar gateway (real fetch + SSM). Constructed once; makes no call until a method runs, so
// this is inert in local/test where APP_URL/SSM aren't set. testMode requests never reach it (handleRpc
// swaps in noopGoogle), so a smoke run stays external-call-free.
const STAGE = process.env.STAGE ?? 'dev';
const APP_URL = process.env.APP_URL ?? '';
const google = createLiveGoogle({ stage: STAGE, appUrl: APP_URL });

// Plaid (raw fetch + SSM) and the finance sync invoker — built once, inert until a finance method runs;
// testMode swaps both for noops in handleRpc. dev → Sandbox, prod → Production (PLAID_ENV, step D). No
// FINANCE_SYNC_FN (local) → syncs are requested but never started.
const plaid = createLivePlaid({
  stage: STAGE,
  env: process.env.PLAID_ENV === 'production' ? 'production' : 'sandbox',
});
const financeInvoker = process.env.FINANCE_SYNC_FN
  ? liveInvoker(process.env.FINANCE_SYNC_FN)
  : noopInvoker();

// Quick add's parse (Claude API: raw fetch + the SSM key) — built once, inert until parseTask runs;
// testMode swaps in noopAnthropic. No key on the stage → every parse says so and the line saves raw.
const anthropic = createLiveAnthropic({ stage: STAGE });

// Reminders: the VAPID public key only (the BFF never sends — the push-dispatch poller does). Read on
// use, held a few minutes; testMode never reads it. No parameter → Settings says reminders aren't set up.
const pushPublicKey = createPublicKeyReader({ stage: STAGE });

// Everything the edge calls out to. The deployed handler is built from the live ones above; the local
// devcheck server (local/serve.ts) builds one over InMemoryDoc and inert gateways (docs/ops/LOCAL-CHECK.md).
export interface BffDeps {
  doc: DocClient;
  verifier: Verifier | null;
  google: GoogleGateway;
  presigner: Presigner;
  objects: ObjectStore;
  plaid: PlaidGateway;
  financeInvoker: FinanceSyncInvoker;
  anthropic: AnthropicGateway;
  pushPublicKey: PublicKeyReader;
}
const live: BffDeps = {
  doc,
  verifier,
  google,
  presigner,
  objects,
  plaid,
  financeInvoker,
  anthropic,
  pushPublicKey,
};

interface HttpEvent {
  rawPath?: string;
  requestContext?: { http?: { path?: string; method?: string } };
  headers?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined> | null;
  body?: string | null;
}
interface HttpResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

const CORS: Record<string, string> = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
  'access-control-allow-headers': `content-type,${AUTH_HEADER}`,
  'access-control-allow-methods': 'POST,OPTIONS',
};

// CI smoke tests reach the handler by DIRECT invoke (aws lambda invoke) with a testMode payload — no
// HTTP request context, no JWT. They run as this throwaway user against an always-empty partition, and
// the writes-object no-ops, so a smoke run touches no real data even against prod.
const SMOKE_USER = 'smoke-test';

// The browser extension's methods (LC_INGEST_METHODS) take its device token — or the user's JWT, which is
// already the whole user (the dev check drives them that way). Their bodies are capped before parsing:
// a leaked device token can't make the Lambda chew on megabytes (sittings.ts caps a call at 256 KB).
const INGEST_BODY_MAX = 300 * 1024;
async function ingestUserId(
  authHeader: string | undefined,
  verifier: Verifier | null,
): Promise<string> {
  const expected = process.env.DEVICE_TOKEN;
  if (expected) {
    try {
      return resolveDeviceUserId(authHeader, expected, process.env.DEVICE_USER_ID);
    } catch {
      // not the device token — it may be a JWT
    }
  }
  return resolveUserId(authHeader, verifier);
}

export const createBffHandler =
  (d: BffDeps) =>
  (event: HttpEvent): Promise<HttpResult> =>
    handle(event, d);
export const handler = createBffHandler(live);

async function handle(event: HttpEvent, d: BffDeps): Promise<HttpResult> {
  const path = event.rawPath ?? event.requestContext?.http?.path ?? '';
  const isHttp = event.requestContext?.http !== undefined; // false for direct (CI-cred'd) invokes
  if (event.requestContext?.http?.method === 'OPTIONS')
    return { statusCode: 204, headers: CORS, body: '' };

  // Origin lockdown for HTTP requests only: the Function URL is public, so only requests through
  // CloudFront (which stamps the shared secret) are honored. Direct invokes are AWS-cred-gated already.
  const originSecret = process.env.ORIGIN_SECRET;
  if (isHttp && originSecret && event.headers?.[ORIGIN_SECRET_HEADER] !== originSecret) {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  const method = path.split('/api/')[1]?.split('/')[0] ?? '';
  // Public health probe for the post-deploy synthetic check: sits BEHIND the origin-secret gate above but
  // AHEAD of any auth/DynamoDB. So a headerless HTTP call still 403s (proves the gate is enforced) while a
  // CloudFront-stamped call gets 200 (proves the edge → Lambda wiring). No JWT, no table access, no writes.
  if (method === 'health') {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ ok: true, service: 'bff', stage: process.env.STAGE ?? null }),
    };
  }

  // Google OAuth callback — a REAL browser GET redirect, OUTSIDE the RPC dispatch. It sits behind the
  // origin-secret gate above (a headerless call still 403s). The state is HMAC-verified for its userId
  // (no JWT on this browser navigation); then exchange the code, store the token, record the account,
  // and 302 back into the app. `?error=` and a bad/expired state are handled distinctly.
  if (path.endsWith('/api/google/callback')) {
    const back = (status: string): HttpResult => ({
      statusCode: 302,
      headers: { location: `${APP_URL}/settings?google=${status}` },
      body: '',
    });
    const q = event.queryStringParameters ?? {};
    if (q.error) return back('error');
    if (!q.code || !q.state) {
      return {
        statusCode: 400,
        headers: CORS,
        body: JSON.stringify({ error: 'Missing code/state' }),
      };
    }
    let userId: string;
    try {
      userId = verifyState(q.state, process.env.ORIGIN_SECRET ?? 'dev-state-secret').userId;
    } catch {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid state' }) };
    }
    try {
      const backend = new BackendClient(new Repo(d.doc, liveWrites(d.doc), userId), {
        userId,
        google: d.google,
        stateSecret: process.env.ORIGIN_SECRET,
      });
      await backend.completeGoogleConnect(q.code);
      return back('connected');
    } catch {
      return back('error');
    }
  }
  // The iPhone Shortcut's read (places.md): GET /api/places/<slug>/tasks with a place token — OUTSIDE the
  // RPC dispatch, and the only thing a place token opens. Behind the origin gate above, ahead of the
  // JWT path: every /api/places/* path ends here, so it never reaches handleRpc and never falls through
  // to JWT. The body (and testMode) is ignored.
  if (path.startsWith('/api/places/')) return placeRead(event, path, d.doc);

  const ingest = isLcIngestMethod(method);
  if (ingest && (event.body?.length ?? 0) > INGEST_BODY_MAX)
    return { statusCode: 413, headers: CORS, body: JSON.stringify({ error: 'Too large' }) };
  const body = event.body
    ? (JSON.parse(event.body) as { args?: unknown[]; testMode?: boolean })
    : {};
  // JWT arrives in the custom header (past CloudFront); fall back to Authorization for direct/local calls.
  const authHeader =
    event.headers?.[AUTH_HEADER] ?? event.headers?.authorization ?? event.headers?.Authorization;

  try {
    // The device token opens the ingest methods ONLY; every other method takes the untouched JWT path, so a
    // device token sent anywhere else hits resolveUserId → 401 (not a valid JWT).
    const userId = body.testMode
      ? SMOKE_USER
      : ingest
        ? await ingestUserId(authHeader, d.verifier)
        : await resolveUserId(authHeader, d.verifier); // JWT `sub`, or dev user locally
    const result = await handleRpc(
      d.doc,
      {
        userId,
        method,
        args: body.args ?? [],
        testMode: body.testMode,
        google: d.google,
        stateSecret: process.env.ORIGIN_SECRET,
      },
      {
        presigner: d.presigner,
        objects: d.objects,
        plaid: d.plaid,
        financeInvoker: d.financeInvoker,
        anthropic: d.anthropic,
        pushPublicKey: d.pushPublicKey,
      },
    );
    return { statusCode: 200, headers: CORS, body: JSON.stringify(result ?? null) };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'error';
    const status = message.startsWith('Unauthorized')
      ? 401
      : message.startsWith('Unknown method')
        ? 404
        : 400;
    return { statusCode: status, headers: CORS, body: JSON.stringify({ error: message }) };
  }
}

// Case-insensitive, then lowercased: an automation passing `Safeway` finds `safeway`.
const PLACE_ROUTE = /^\/api\/places\/([A-Za-z0-9-]{1,32})\/tasks$/;
// A fixed code per 401 (so the log line can never echo anything a message might one day carry).
const UNAUTHORIZED_REASON = (message: string): string =>
  /missing/.test(message)
    ? 'missing'
    : /not a place token/.test(message)
      ? 'malformed'
      : /revoked/.test(message)
        ? 'revoked'
        : 'unknown';

// 405 non-GET → 401 no/unknown token, or one its user's pointer no longer names (revoked/rotated out —
// resolvePlaceRead; no 'local' fallback, any stage) → 429 at the daily cap → 422 a
// malformed path or an unknown slug, only once authenticated (no unauthenticated slug probing) → 200 the
// digest + lens link. Never 404: CloudFront turns an origin 403/404 into the app's index.html (a 200 the
// Shortcut would read as an empty list). Every body carries `text` (the digest's, or PLACE_READ_TEXT), so
// no failure is silent on the phone. Only a 200 writes (the count + the place's heartbeat —
// BackendClient.readPlaceForShortcut). The log line carries the outcome only — never the header, token,
// hash or an error message.
async function placeRead(event: HttpEvent, path: string, doc: DocClient): Promise<HttpResult> {
  const reply = (
    statusCode: number,
    reason: string,
    body: PlaceRead | PlaceReadError,
    extra: Record<string, string> = {},
  ): HttpResult => {
    console.log(JSON.stringify({ event: 'place_read', ok: statusCode === 200, reason, ...extra }));
    return { statusCode, headers: CORS, body: JSON.stringify(body) };
  };
  if (event.requestContext?.http?.method !== 'GET') {
    const res = reply(405, 'method', { error: 'Method Not Allowed', text: PLACE_READ_TEXT.method });
    return { ...res, headers: { ...res.headers, allow: 'GET' } };
  }
  const now = Date.now();
  const slug = PLACE_ROUTE.exec(path)?.[1]?.toLowerCase();
  const writes = liveWrites(doc); // one per request: the token store and the Repo share it
  const store = new PlaceTokenStore(doc, writes);
  try {
    const auth = await resolvePlaceRead(store, event.headers?.[AUTH_HEADER], now);
    if (!slug) return reply(422, 'path', { error: 'Not a place list', text: PLACE_READ_TEXT.path });
    const backend = new BackendClient(new Repo(doc, writes, auth.userId), {
      userId: auth.userId,
      placeTokens: store,
    });
    const digest = await backend.readPlaceForShortcut(slug, auth);
    const read: PlaceRead = { ...digest, url: `${APP_URL}${placeLensPath(digest.slug)}` };
    return reply(200, 'ok', read);
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    if (err instanceof PlaceReadCapError)
      return reply(429, 'cap', { error: message, text: PLACE_READ_TEXT.cap });
    if (message.startsWith('Unauthorized'))
      return reply(401, UNAUTHORIZED_REASON(message), {
        error: message,
        text: PLACE_READ_TEXT.unauthorized,
      });
    if (slug && message === placeUnknownError(slug))
      return reply(422, 'place', { error: message, text: placeReadUnknownText(slug) });
    const name = err instanceof Error ? err.name : 'unknown';
    return reply(500, 'error', { error: 'Internal error', text: PLACE_READ_TEXT.error }, { name });
  }
}
