// @aperture/lambdas — the RPC BFF handler. One Lambda, one route: POST /api/<method> → the matching
// ApiClient method over DynamoDB (single-table). Business logic lives in BackendClient (shared
// machines); this file is just the AWS/HTTP edge. Phase 11 replaces the fixed userId with the Cognito
// `sub`; Phase 12 provisions the table + wires TABLE_NAME. Beside the RPC route sit three non-RPC ones:
// /api/health, the Google OAuth callback, and the iPhone Shortcut's GET /api/places/<slug>/tasks.
import {
  APERTURE,
  AUTH_HEADER,
  ORIGIN_SECRET_HEADER,
  PLACE_READ_TEXT,
  placeLensPath,
  placeReadUnknownText,
  placeUnknownError,
} from '@aperture/shared';
import type { PlaceRead, PlaceReadError } from '@aperture/shared';
import { createLiveDoc } from './ddb/LiveDoc';
import { createCognitoVerifier, resolveDeviceUserId, resolveUserId } from './auth/verify';
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

// The one method the browser extension calls, authenticated by a device token instead of a Cognito JWT.
const INGEST_METHOD = 'recordLeetcodeAttempt';

export async function handler(event: HttpEvent): Promise<HttpResult> {
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
      const backend = new BackendClient(new Repo(doc, liveWrites(doc), userId), {
        userId,
        google,
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
  if (path.startsWith('/api/places/')) return placeRead(event, path);

  const body = event.body
    ? (JSON.parse(event.body) as { args?: unknown[]; testMode?: boolean })
    : {};
  // JWT arrives in the custom header (past CloudFront); fall back to Authorization for direct/local calls.
  const authHeader =
    event.headers?.[AUTH_HEADER] ?? event.headers?.authorization ?? event.headers?.Authorization;

  try {
    // Device-token branch is scoped to the ingest method ONLY; every other method takes the untouched
    // JWT path. A device token sent to any other method hits resolveUserId → 401 (not a valid JWT).
    const userId = body.testMode
      ? SMOKE_USER
      : method === INGEST_METHOD
        ? resolveDeviceUserId(authHeader, process.env.DEVICE_TOKEN, process.env.DEVICE_USER_ID)
        : await resolveUserId(authHeader, verifier); // JWT `sub`, or dev user locally
    const result = await handleRpc(
      doc,
      {
        userId,
        method,
        args: body.args ?? [],
        testMode: body.testMode,
        google,
        stateSecret: process.env.ORIGIN_SECRET,
      },
      { presigner, objects, plaid, financeInvoker, anthropic },
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

// 405 non-GET → 401 no/unknown token (no 'local' fallback, any stage) → 429 at the daily cap → 422 a
// malformed path or an unknown slug, only once authenticated (no unauthenticated slug probing) → 200 the
// digest + lens link. Never 404: CloudFront turns an origin 403/404 into the app's index.html (a 200 the
// Shortcut would read as an empty list). Every body carries `text` (the digest's, or PLACE_READ_TEXT), so
// no failure is silent on the phone. Only a 200 writes (the count + the place's heartbeat —
// BackendClient.readPlaceForShortcut). The log line carries the outcome only — never the header, token,
// hash or an error message.
async function placeRead(event: HttpEvent, path: string): Promise<HttpResult> {
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
