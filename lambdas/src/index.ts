// @aperture/lambdas — the RPC BFF handler. One Lambda, one route: POST /api/<method> → the matching
// ApiClient method over DynamoDB (single-table). Business logic lives in BackendClient (shared
// machines); this file is just the AWS/HTTP edge. Phase 11 replaces the fixed userId with the Cognito
// `sub`; Phase 12 provisions the table + wires TABLE_NAME. Beside the RPC route sit three non-RPC ones:
// /api/health, the Google OAuth callback, the iPhone Shortcut's GET /api/places/<slug>/tasks, and voice
// capture's POST /api/capture.
import {
  APERTURE,
  AUTH_HEADER,
  CAPTURE_BODY_MAX,
  CAPTURE_SAY,
  CAPTURE_TEXT_MAX,
  isLcIngestMethod,
  ORIGIN_SECRET_HEADER,
  PLACE_READ_TEXT,
  placeLensPath,
  placeReadUnknownText,
  placeUnknownError,
} from '@aperture/shared';
import { isApiMethod } from '@aperture/shared';
import type { CaptureError, CaptureResult, PlaceRead, PlaceReadError } from '@aperture/shared';
import { createLiveDoc } from './ddb/LiveDoc';
import {
  bffVerifier,
  createCognitoVerifier,
  resolveDeviceUserId,
  resolveUserId,
} from './auth/verify';
import { logMissingAuthEnv, originPasses, stateKey } from './auth/strict';
import type { Verifier } from './auth/verify';
import type { DocClient } from './ddb/DocClient';
import type { GoogleGateway } from './google/gateway';
import type { Presigner } from './s3/presigner';
import type { ObjectStore } from './s3/objects';
import type { PlaidGateway } from './plaid/gateway';
import type { FinanceSyncInvoker } from './finance/invoker';
import type { AnthropicGateway } from './anthropic/gateway';
import { handleRpc } from './handler';
import { failureStatus, shownMessage } from './rpc/failure';
import { RPC_BODY_MAX } from './rpc/argSpecs';
import { BackendClient } from './backend';
import { Repo } from './ddb/repo';
import { liveWrites } from './ddb/writes';
import { PlaceTokenStore } from './ddb/placeTokens';
import { PlaceReadCapError, resolvePlaceRead } from './auth/placeToken';
import { ScopedTokenStore } from './ddb/scopedTokens';
import { CaptureCapError, resolveScopedToken } from './auth/scopedToken';
import { createLiveGoogle } from './google/liveGoogle';
import { verifyState } from './google/state';
import { createS3Presigner } from './s3/presigner';
import { createS3ObjectStore } from './s3/objects';
import { createLivePlaid } from './plaid/livePlaid';
import { noopInvoker } from './finance/invoker';
import { liveInvoker } from './finance/liveInvoker';
import { noopPickInvoker } from './coach/invoker';
import type { CoachPickInvoker } from './coach/invoker';
import { livePickInvoker } from './coach/liveInvoker';
import { liveCatalogInvoker, noopCatalogInvoker } from './catalog/invoker';
import type { CatalogImportInvoker } from './catalog/invoker';
import { createLiveAnthropic } from './anthropic/liveAnthropic';
import { createPublicKeyReader } from './push/publicKey';
import type { PublicKeyReader } from './push/publicKey';

export const runtime = `${APERTURE}-lambda` as const;

const doc = createLiveDoc(process.env.TABLE_NAME ?? 'aperture');

// Built once at cold start. Construction never touches the network, so an empty FILES_BUCKET (local /
// tests) is fine — only an actual attachment call would then fail.
const presigner = createS3Presigner(process.env.FILES_BUCKET ?? '');
const objects = createS3ObjectStore(process.env.FILES_BUCKET ?? ''); // deletes attachment bytes

// Built once at cold start (bffVerifier: when it's null and why).
const verifier = bffVerifier(process.env, createCognitoVerifier); // passed in: the module's export, which tests mock
logMissingAuthEnv(
  'bff',
  ['USER_POOL_ID', 'MCP_CLIENT_ID', 'ORIGIN_SECRET', 'DEVICE_TOKEN'],
  ['DEVICE_USER_ID'],
);

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
// The coach worker (cdk coach-worker): its AI pick, async. No worker on this stage → disabled: no pick is ever due.
const coachPickInvoker = process.env.COACH_WORKER_FN
  ? livePickInvoker(process.env.COACH_WORKER_FN)
  : noopPickInvoker();
// The full catalog's import runs on the same worker (catalog/import.ts); no worker → the import is refused.
const catalogInvoker = process.env.COACH_WORKER_FN
  ? liveCatalogInvoker(process.env.COACH_WORKER_FN)
  : noopCatalogInvoker();

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
  coachPickInvoker: CoachPickInvoker;
  catalogInvoker: CatalogImportInvoker;
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
  coachPickInvoker,
  catalogInvoker,
  anthropic,
  pushPublicKey,
};

interface HttpEvent {
  rawPath?: string;
  requestContext?: { http?: { path?: string; method?: string } };
  headers?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined> | null;
  body?: string | null;
  isBase64Encoded?: boolean;
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
// the writes-object no-ops, so a smoke run touches no real data even against prod. testMode is honoured
// ONLY on a direct invoke (no requestContext.http, which a Function URL always sets): over HTTP the flag
// opens nothing — the JWT path runs (no JWT → 401), and with a JWT the call is refused (400).
const SMOKE_USER = 'smoke-test';

// The RPC body. Parsed inside handle()'s try, so a malformed one is a 400, never a thrown handler.
function parseBody(raw: string | null | undefined): { args: unknown[]; testMode: boolean } {
  if (!raw) return { args: [], testMode: false };
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    throw new Error('Invalid JSON');
  const { args, testMode } = body as { args?: unknown; testMode?: unknown };
  if (args !== undefined && !Array.isArray(args)) throw new Error('args must be an array');
  return { args: args ?? [], testMode: testMode === true };
}

// The browser extension's methods (LC_INGEST_METHODS) take its device token — or the user's JWT, which is
// already the whole user (the dev check drives them that way). Their bodies are capped before parsing:
// a leaked device token can't make the Lambda chew on megabytes (sittings.ts caps a call at 256 KB). Every
// other method is capped too, looser (RPC_BODY_MAX, 1 MiB: ~5× the largest legal single-row body).
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
  // On a stage an unset secret refuses every HTTP call rather than skipping the gate (strict.ts).
  const originSecret = process.env.ORIGIN_SECRET;
  if (isHttp && !originPasses(event.headers?.[ORIGIN_SECRET_HEADER], originSecret, 'bff')) {
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
      userId = verifyState(q.state, stateKey(process.env.ORIGIN_SECRET)).userId;
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
  // Voice capture (capture.md): POST /api/capture with a capture token — likewise outside the RPC dispatch
  // and the only thing a capture token opens; /api/capture and every path under it end here, never at the
  // JWT path.
  if (method === 'capture') return capture(event, path, d);

  const ingest = isLcIngestMethod(method);
  if ((event.body?.length ?? 0) > (ingest ? INGEST_BODY_MAX : RPC_BODY_MAX))
    return { statusCode: 413, headers: CORS, body: JSON.stringify({ error: 'Too large' }) };
  // JWT arrives in the custom header (past CloudFront); fall back to Authorization for direct/local calls.
  const authHeader =
    event.headers?.[AUTH_HEADER] ?? event.headers?.authorization ?? event.headers?.Authorization;

  try {
    const body = parseBody(event.body);
    // Off HTTP only: a direct invoke is already AWS-cred-gated (the CI smoke); over the Function URL a
    // body flag is anyone's to send.
    const testMode = !isHttp && body.testMode;
    // The device token opens the ingest methods ONLY; every other method takes the untouched JWT path, so a
    // device token sent anywhere else hits resolveUserId → 401 (not a valid JWT).
    const userId = testMode
      ? SMOKE_USER
      : ingest
        ? await ingestUserId(authHeader, d.verifier)
        : await resolveUserId(authHeader, d.verifier); // JWT `sub`, or dev user locally
    // Authenticated, but asked for a dry run HTTP can't give: refuse rather than run it wet.
    if (isHttp && body.testMode) throw new Error('testMode is only honoured on a direct invoke');
    const result = await handleRpc(
      d.doc,
      {
        userId,
        method,
        args: body.args,
        testMode,
        google: d.google,
        stateSecret: process.env.ORIGIN_SECRET,
      },
      {
        presigner: d.presigner,
        objects: d.objects,
        plaid: d.plaid,
        financeInvoker: d.financeInvoker,
        coachPickInvoker: d.coachPickInvoker,
        catalogInvoker: d.catalogInvoker,
        anthropic: d.anthropic,
        pushPublicKey: d.pushPublicKey,
      },
    );
    return { statusCode: 200, headers: CORS, body: JSON.stringify(result ?? null) };
  } catch (err) {
    // One mapping for both paths (rpc/failure.ts): a ShapeError or our own refusal is a 400, a fault a 500.
    const status = failureStatus(err, ingest ? 'ingest' : 'rpc');
    // One line per failure: the outcome only — never the message, body, args or a header. The method is
    // path text anyone can send, so only a known one is logged by name.
    const name = err instanceof Error ? err.name : 'unknown';
    const logged = isApiMethod(method) ? method : 'unknown';
    console.log(JSON.stringify({ event: 'rpc_failed', method: logged, status, name }));
    // A 500's text is internals, and so is any AWS error's: every caller retries on the status alone.
    return {
      statusCode: status,
      headers: CORS,
      body: JSON.stringify({ error: shownMessage(err, status) }),
    };
  }
}

// Case-insensitive, then lowercased: an automation passing `Grocer` finds `grocer`.
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

// 405 non-POST → 413 a body over CAPTURE_BODY_MAX → 401 a missing, malformed, unknown or revoked capture
// token (resolveScopedToken; no 'local' fallback) → 422 any other path, bad JSON, or text empty or over
// CAPTURE_TEXT_MAX — only once authenticated, and never counted → 429 at the daily cap → 200 the task.
// Never 404 (the SPA fallback would answer the Shortcut with a web page). Every body carries `say`, the
// sentence Siri speaks, so no failure is silent. Writes happen in BackendClient.captureForToken (the
// token's counters, the task). The log line carries the outcome only — never the text, header, token,
// hash or an error message.
async function capture(event: HttpEvent, path: string, d: BffDeps): Promise<HttpResult> {
  const started = Date.now();
  const reply = (
    statusCode: number,
    reason: string,
    body: CaptureResult | CaptureError,
    extra: Record<string, string | boolean> = {},
  ): HttpResult => {
    const ms = Date.now() - started;
    console.log(JSON.stringify({ event: 'capture', ok: statusCode === 200, reason, ms, ...extra }));
    return { statusCode, headers: CORS, body: JSON.stringify(body) };
  };
  const refuse = (status: number, reason: string, error: string, say: string) =>
    reply(status, reason, { error, say });
  if (event.requestContext?.http?.method !== 'POST') {
    const res = refuse(405, 'method', 'Method Not Allowed', CAPTURE_SAY.method);
    return { ...res, headers: { ...res.headers, allow: 'POST' } };
  }
  if ((event.body?.length ?? 0) > CAPTURE_BODY_MAX)
    return refuse(413, 'size', 'Too large', CAPTURE_SAY.tooLong);
  const writes = liveWrites(d.doc); // one per request: the token store and the Repo share it
  const store = new ScopedTokenStore(d.doc, writes);
  try {
    const auth = await resolveScopedToken(store, event.headers?.[AUTH_HEADER], 'capture');
    if (path !== '/api/capture')
      return refuse(422, 'path', 'Not the capture route', CAPTURE_SAY.path);
    const body = captureBody(event);
    if (!body) return refuse(422, 'body', 'Invalid body', CAPTURE_SAY.empty);
    const text = body.text.trim();
    if (!text) return refuse(422, 'empty', 'Empty text', CAPTURE_SAY.empty);
    if (text.length > CAPTURE_TEXT_MAX)
      return refuse(422, 'long', 'Text too long', CAPTURE_SAY.tooLong);
    const backend = new BackendClient(new Repo(d.doc, writes, auth.userId), {
      userId: auth.userId,
      google: d.google,
      stateSecret: process.env.ORIGIN_SECRET,
      anthropic: d.anthropic,
      scopedTokens: store,
    });
    const result = await backend.captureForToken(text, body.voice, auth);
    return reply(200, 'ok', result, { raw: result.raw, duplicate: result.duplicate });
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    if (err instanceof CaptureCapError)
      return refuse(429, 'cap', 'Daily capture cap reached', CAPTURE_SAY.cap);
    if (message.startsWith('Unauthorized'))
      return refuse(401, unauthorizedReason(message), 'Unauthorized', CAPTURE_SAY.unauthorized);
    const name = err instanceof Error ? err.name : 'unknown';
    return reply(500, 'error', { error: 'Internal error', say: CAPTURE_SAY.error }, { name });
  }
}
const unauthorizedReason = (message: string): string =>
  /missing/.test(message)
    ? 'missing'
    : /malformed/.test(message)
      ? 'malformed'
      : /revoked/.test(message)
        ? 'revoked'
        : 'unknown';

// The Shortcut's JSON body: {text, voice?}. Null for anything else (bad JSON, a non-object, a non-string
// text, a non-boolean voice). A Function URL base64-encodes a body it doesn't take for text.
function captureBody(event: HttpEvent): { text: string; voice: boolean } | null {
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
      : (event.body ?? '');
    const b: unknown = JSON.parse(raw);
    if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
    const { text, voice } = b as { text?: unknown; voice?: unknown };
    if (typeof text !== 'string') return null;
    // A Shortcut's JSON field typed as Text sends "true" — taken like the Boolean.
    if (
      voice !== undefined &&
      voice !== true &&
      voice !== false &&
      voice !== 'true' &&
      voice !== 'false'
    )
      return null;
    return { text, voice: voice === true || voice === 'true' };
  } catch {
    return null;
  }
}
