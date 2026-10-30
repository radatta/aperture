// The signed-in session, read from the page's localStorage where oidc-client-ts keeps it
// (app/src/auth/userStore.ts → key `oidc.user:<authority>:<clientId>`). The identity guard runs on it before
// the harness makes any write: the email and `sub` must be the test user's, in the ID claims and the access
// token alike. No signature check — the server verifies; this only stops a write going to the wrong partition.
import { TEST_USER_EMAIL } from './config';
import { DevcheckError } from './errors';

export interface Session {
  accessToken: string;
  expiresAt: number; // epoch seconds
  email: string;
  sub: string;
}

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
