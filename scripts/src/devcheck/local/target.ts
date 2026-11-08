// The local check's identity (docs/ops/LOCAL-CHECK.md): a per-run RSA key, the public JWKS the local server
// verifies with, and tokens signed as the test user for the app client and the claude client — standing in
// for dev's Cognito pool. The private key never leaves this process; nothing here is a real credential.
import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { TEST_USER_EMAIL, type DevcheckEnv } from '../config';
import type { McpSession } from '../mcp-login';
import { cognitoAuthority, userStoreKey, type Session } from '../token';

export const LOCAL_POOL_ID = 'us-west-1_LocalDevcheck';
export const LOCAL_APP_CLIENT = 'local-app-client';
export const LOCAL_CLAUDE_CLIENT = 'local-claude-client';
export const LOCAL_SUB = '00000000-0000-4000-8000-00000000c0de';
const KID = 'local-1';
const TTL_S = 12 * 3600; // longer than any run, so the app's renew timer never fires

export interface LocalAuth {
  jwks: { keys: Record<string, unknown>[] };
  env: DevcheckEnv; // the harness's env shape, for the shared identity guards
  originSecret: string;
  mint(clientId: string, tokenUse?: 'access' | 'id'): { token: string; expiresAt: number };
}

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');

export function signJwt(claims: Record<string, unknown>, key: KeyObject): string {
  const data = `${b64({ alg: 'RS256', kid: KID, typ: 'JWT' })}.${b64(claims)}`;
  return `${data}.${sign('sha256', Buffer.from(data), key).toString('base64url')}`;
}

export function makeLocalAuth(now: () => number = Date.now): LocalAuth {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const iss = cognitoAuthority(LOCAL_POOL_ID);
  return {
    jwks: {
      keys: [{ ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' }],
    },
    env: {
      DEVCHECK_EMAIL: TEST_USER_EMAIL,
      DEVCHECK_PASSWORD: 'unused-locally',
      DEVCHECK_SUB: LOCAL_SUB,
      DEVCHECK_COGNITO_HOST: 'unused-locally',
      DEVCHECK_CLIENT_ID: LOCAL_APP_CLIENT,
      DEVCHECK_POOL_ID: LOCAL_POOL_ID,
      DEVCHECK_CLAUDE_CLIENT_ID: LOCAL_CLAUDE_CLIENT,
    },
    originSecret: randomBytes(32).toString('hex'),
    mint(clientId, tokenUse = 'access') {
      const iat = Math.floor(now() / 1000);
      const exp = iat + TTL_S;
      const claims =
        tokenUse === 'access'
          ? {
              sub: LOCAL_SUB,
              iss,
              token_use: 'access',
              client_id: clientId,
              scope: 'openid email',
              iat,
              exp,
            }
          : {
              sub: LOCAL_SUB,
              iss,
              token_use: 'id',
              aud: clientId,
              email: TEST_USER_EMAIL,
              iat,
              exp,
            };
      return { token: signJwt(claims, privateKey), expiresAt: exp };
    },
  };
}

// The app's signed-in user as oidc-client-ts stores it (app/src/auth/userStore.ts → localStorage), as a
// Playwright storageState for the run's origin: the app opens signed in, no Hosted UI.
export function seededState(auth: LocalAuth, origin: string): object {
  const access = auth.mint(LOCAL_APP_CLIENT);
  const user = {
    id_token: auth.mint(LOCAL_APP_CLIENT, 'id').token,
    session_state: null,
    access_token: access.token,
    token_type: 'Bearer',
    scope: 'openid email',
    profile: { sub: LOCAL_SUB, email: TEST_USER_EMAIL, email_verified: true },
    expires_at: access.expiresAt,
  };
  return {
    cookies: [],
    origins: [
      {
        origin,
        localStorage: [
          {
            name: userStoreKey(cognitoAuthority(LOCAL_POOL_ID), LOCAL_APP_CLIENT),
            value: JSON.stringify(user),
          },
        ],
      },
    ],
  };
}

// The claude client's session, as mcp-login.ts would return it after the PKCE sign-in.
export function localMcpSession(auth: LocalAuth): McpSession {
  const { token, expiresAt } = auth.mint(LOCAL_CLAUDE_CLIENT);
  return {
    accessToken: token,
    expiresAt,
    email: TEST_USER_EMAIL,
    sub: LOCAL_SUB,
    clientId: LOCAL_CLAUDE_CLIENT,
  };
}

export type { Session };
