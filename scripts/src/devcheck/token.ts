// The signed-in session, read from the page's localStorage where oidc-client-ts keeps it
// (app/src/auth/userStore.ts → key `oidc.user:<authority>:<clientId>`). The identity guard runs on it before
// the harness makes any write: the email and `sub` must be the test user's, in the ID claims and the access
// token alike. No signature check — the server verifies; this only stops a write going to the wrong partition.
// A session near expiry is renewed at the dev pool's token endpoint (tokenGrant).
import type { FetchLike } from './api';
import { assertDevCognitoUrl, TEST_USER_EMAIL } from './config';
import { DevcheckError } from './errors';

export interface Session {
  accessToken: string;
  expiresAt: number; // epoch seconds
  email: string;
  sub: string;
}

// Under this much life left, the app session is renewed before a request (pipeline.ts `fresh`) and the MCP
// token, which keeps no refresh token, is refused (mcp-login.ts mcpToken).
export const TOKEN_MARGIN_MS = 60_000;
export const nearExpiry = (s: Session, now: number): boolean =>
  s.expiresAt * 1000 - now < TOKEN_MARGIN_MS;

export const userStoreKey = (authority: string, clientId: string): string =>
  `oidc.user:${authority}:${clientId}`;

export const cognitoAuthority = (poolId: string): string =>
  `https://cognito-idp.${poolId.split('_')[0]}.amazonaws.com/${poolId}`;

export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const part = jwt.split('.')[1];
  if (!part) throw new Error('not a JWT');
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

export function sessionFromStorage(storage: Record<string, string>, key: string): Session | null {
  const raw = storage[key];
  if (!raw) return null;
  const user = JSON.parse(raw) as {
    access_token?: string;
    expires_at?: number;
    profile?: { email?: string; sub?: string };
  };
  if (!user.access_token) return null;
  return {
    accessToken: user.access_token,
    expiresAt: user.expires_at ?? 0,
    email: user.profile?.email ?? '',
    sub: user.profile?.sub ?? '',
  };
}

export function assertTestUser(session: Session, expectedSub: string): void {
  const accessSub = decodeJwtPayload(session.accessToken).sub;
  if (session.email !== TEST_USER_EMAIL || session.sub !== expectedSub || accessSub !== expectedSub)
    throw new DevcheckError(
      'WRONG_USER',
      `signed in as ${session.email || '?'} (sub ${session.sub || '?'}), not the test user — no writes made`,
    );
}

// One grant at the dev pool's token endpoint (a code swap, a refresh). An error names Cognito's `error` field
// only — the body of a success holds the tokens, and nothing here ever prints a body.
export async function tokenGrant(
  fetch: FetchLike,
  host: string,
  params: Record<string, string>,
  now: () => number,
  fail: (msg: string) => Error,
): Promise<Session & { clientId: string }> {
  const url = `https://${host}/oauth2/token`;
  assertDevCognitoUrl(url, host, '/oauth2/token');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    redirect: 'error',
  }).catch(() => {
    throw fail('the token endpoint request failed'); // a refused redirect or the network; never its URL
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // not JSON — reported by status alone
  }
  if (res.status !== 200)
    throw fail(
      `the token endpoint answered HTTP ${res.status}${typeof body.error === 'string' ? ` ${body.error}` : ''}`,
    );
  const { access_token, id_token, expires_in } = body;
  if (typeof access_token !== 'string' || typeof id_token !== 'string')
    throw fail('the token endpoint returned no access or id token');
  const id = decodeJwtPayload(id_token);
  const access = decodeJwtPayload(access_token);
  return {
    accessToken: access_token,
    expiresAt:
      typeof access.exp === 'number'
        ? access.exp
        : Math.floor(now() / 1000) + (typeof expires_in === 'number' ? expires_in : 0),
    email: typeof id.email === 'string' ? id.email : '',
    sub: typeof id.sub === 'string' ? id.sub : '',
    clientId: typeof access.client_id === 'string' ? access.client_id : '',
  };
}
