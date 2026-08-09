// @aperture/lambdas — the RPC BFF handler. One Lambda, one route: POST /api/<method> → the matching
// ApiClient method over DynamoDB (single-table). Business logic lives in BackendClient (shared
// machines); this file is just the AWS/HTTP edge. Phase 11 replaces the fixed userId with the Cognito
// `sub`; Phase 12 provisions the table + wires TABLE_NAME.
import { APERTURE, AUTH_HEADER, ORIGIN_SECRET_HEADER } from '@aperture/shared';
import { createLiveDoc } from './ddb/LiveDoc';
import { createCognitoVerifier, resolveDeviceUserId, resolveUserId } from './auth/verify';
import { handleRpc } from './handler';

export const runtime = `${APERTURE}-lambda` as const;

const doc = createLiveDoc(process.env.TABLE_NAME ?? 'aperture');

// Verifier is wired only when the pool env is present (deployed). Locally it's null → dev userId.
// clientId is optional (single-client pool) and left unset to avoid a deploy dependency cycle.
const verifier = process.env.USER_POOL_ID ? createCognitoVerifier(process.env.USER_POOL_ID) : null;

interface HttpEvent {
  rawPath?: string;
  requestContext?: { http?: { path?: string; method?: string } };
  headers?: Record<string, string | undefined>;
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

  const body = event.body
    ? (JSON.parse(event.body) as { args?: unknown[]; testMode?: boolean })
    : {};

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
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, stage: process.env.STAGE ?? null }) };
  }
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
    const result = await handleRpc(doc, {
      userId,
      method,
      args: body.args ?? [],
      testMode: body.testMode,
    });
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
