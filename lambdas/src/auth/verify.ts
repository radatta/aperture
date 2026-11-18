import { createHash, timingSafeEqual } from 'node:crypto';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { SimpleJwksCache } from 'aws-jwt-verify/jwk';
import { strictAuth } from './strict';

export type Jwks = Parameters<ReturnType<typeof CognitoJwtVerifier.create>['cacheJwks']>[0];

// A narrow verifier surface so the request path is testable with a fake — the real one wraps
// aws-jwt-verify (JWKS signature + issuer + expiry, keys cached in-process).
export interface Verifier {
  verify(token: string): Promise<{ sub: string }>;
}

// D14 — the BFF verifier is deliberately NOT client-bound (clientId null), so a token minted for ANY
// app client of the pool verifies here. The MCP claude.ai client is one such client, and its ceiling is
// meant to be the /mcp tool surface — so on the BFF we DENY tokens carrying its client_id, keeping
// "claude.ai can only do what /mcp exposes" true by construction rather than by accident. Pure + tested.
export function assertClientAllowed(clientId: unknown, rejectClientIds?: string[]): void {
  if (!rejectClientIds?.length) return;
  if (typeof clientId === 'string' && rejectClientIds.includes(clientId)) {
    throw new Error('Unauthorized: token minted for a client denied on this endpoint');
  }
}

// clientId is optional: passing null verifies against the pool without binding to a specific app
// client. For a single-client, invite-only pool that's sufficient (signature + issuer + expiry +
// token_use=access are still enforced), and it avoids a Cognito↔CloudFront↔Lambda deploy cycle — the
// Lambda would otherwise depend on the client, which depends on CloudFront, which depends on the Lambda.
// The MCP bearer path DOES bind (passes the claude client id) — that client has no CloudFront edge, so
// no cycle. `rejectClientIds` is the inverse: deny listed clients (D14, used by the BFF). `jwks` pre-loads the
// pool's keys instead of fetching them from Cognito — only the local devcheck server passes it (a per-run
// key it signed its tokens with); the deployed edges never do, so they always fetch the pool's real JWKS. With
// it, the verifier never fetches: a token whose key isn't in the set is rejected, not looked up at Cognito.
export function createCognitoVerifier(
  userPoolId: string,
  clientId: string | null = null,
  opts: { rejectClientIds?: string[]; jwks?: Jwks } = {},
): Verifier {
  const { rejectClientIds, jwks } = opts;
  const offline = jwks
    ? {
        jwksCache: new SimpleJwksCache({
          fetcher: {
            fetch: async (): Promise<ArrayBuffer> => {
              throw new Error('no JWKS fetch — the keys were passed in');
            },
          },
        }),
      }
    : undefined;
  const verifier = CognitoJwtVerifier.create(
    {
      userPoolId,
      tokenUse: 'access',
      clientId,
      ...(rejectClientIds?.length
        ? {
            customJwtCheck: ({ payload }) =>
              assertClientAllowed(payload.client_id, rejectClientIds),
          }
        : {}),
    },
    offline,
  );
  if (jwks) verifier.cacheJwks(jwks);
  return {
    async verify(token: string) {
      const payload = await verifier.verify(token);
      return { sub: String(payload.sub) };
    },
  };
}

// The BFF's verifier, wired only when the pool env is present (deployed); locally it's null → the dev user, and on
// a stage a null verifier refuses (resolveUserId). clientId is left unset (single-client pool, no deploy cycle), but
// a token minted for the claude.ai MCP client is DENIED (D14) — its ceiling is the /mcp tool surface. On a stage
// with no MCP_CLIENT_ID that deny would silently vanish, so there it's null too: every call refuses.
export function bffVerifier(
  env: NodeJS.ProcessEnv,
  make: typeof createCognitoVerifier = createCognitoVerifier,
): Verifier | null {
  const poolId = env.USER_POOL_ID;
  if (!poolId) return null;
  if (!env.MCP_CLIENT_ID)
    return strictAuth(env) ? null : make(poolId, null, { rejectClientIds: [] });
  return make(poolId, null, { rejectClientIds: [env.MCP_CLIENT_ID] });
}

function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]! : null;
}

// Resolve the request's userId from the Authorization header.
//   - Verifier configured (deployed): a valid Bearer ACCESS token is REQUIRED. Missing/invalid → throw
//     an "Unauthorized" error the edge turns into a 401. The `sub` becomes the userId scoping every item.
//   - No verifier (local dev, no pool wired): fall back to a fixed dev user so the app runs sans Cognito —
//     off a stage only. On a stage (strictAuth) a missing verifier refuses: never 'local'.
export async function resolveUserId(
  authHeader: string | undefined,
  verifier: Verifier | null,
  strict: boolean = strictAuth(),
): Promise<string> {
  if (!verifier) {
    if (strict) throw new Error('Unauthorized: invalid token'); // as a bad token: the config gap isn't the caller's to learn
    return 'local';
  }
  const token = bearer(authHeader);
  if (!token) throw new Error('Unauthorized: missing bearer token');
  try {
    const { sub } = await verifier.verify(token);
    if (!sub) throw new Error('no sub');
    return sub;
  } catch {
    throw new Error('Unauthorized: invalid token');
  }
}

// The browser extension authenticates the ingest endpoint with a static DEVICE TOKEN, not a Cognito JWT
// (a long-lived personal key for a single-user, minimal-power write; credential class: INFRA §10). Scoped
// by the caller to ONLY the ingest methods (LC_INGEST_METHODS). Off a stage, no token configured falls back to the
// 'local' user, mirroring resolveUserId's no-verifier path; on a stage (strictAuth) an unset token or owner refuses.
export function resolveDeviceUserId(
  authHeader: string | undefined,
  expectedToken: string | undefined,
  deviceUserId: string | undefined,
  strict: boolean = strictAuth(),
): string {
  if (!expectedToken) {
    if (strict) throw new Error('Unauthorized: invalid device token'); // as a wrong token, so a caller can't tell
    return 'local'; // dev: no device token wired → same 'local' user as JWT-less dev
  }
  const token = bearer(authHeader);
  if (!token) throw new Error('Unauthorized: missing device token');
  // Compared as SHA-256 digests: equal lengths always, so the comparison leaks nothing, not even the length.
  const digest = (v: string) => createHash('sha256').update(v).digest();
  if (!timingSafeEqual(digest(token), digest(expectedToken))) {
    throw new Error('Unauthorized: invalid device token');
  }
  return ownerOf(deviceUserId, strict);
}

// The MCP server's static AGENT TOKEN — the same class of credential as the device token, but for the
// /mcp surface and unscoped by method (the agent token is a full app session). It arrives as the RAW
// value of AGENT_TOKEN_HEADER (no "Bearer" prefix — the MCP client sends the token verbatim), compared
// with timingSafeEqual against the env-configured secret. Distinct from resolveDeviceUserId so the two
// tokens revoke independently and the recruiting one stays method-scoped. Off a stage, no token configured
// falls back to the 'local' user, mirroring resolveUserId / resolveDeviceUserId; on a stage (strictAuth) an
// unset token or owner refuses. The caller only invokes this when the header is PRESENT.
export function resolveAgentUserId(
  headerValue: string | undefined,
  expectedToken: string | undefined,
  agentUserId: string | undefined,
  strict: boolean = strictAuth(),
): string {
  if (!expectedToken) {
    if (strict) throw new Error('Unauthorized: invalid agent token'); // as a wrong token, so a caller can't tell
    return 'local'; // dev: no agent token wired → same 'local' user as JWT-less dev
  }
  const token = headerValue?.trim();
  if (!token) throw new Error('Unauthorized: missing agent token');
  const a = Buffer.from(token);
  const b = Buffer.from(expectedToken);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('Unauthorized: invalid agent token');
  }
  return ownerOf(agentUserId, strict);
}

// The user a valid static token writes as (DEVICE_USER_ID). Unset: 'local' off a stage; on a stage a refusal,
// so a token can't silently write under u#local (devb binds none, so its token paths refuse). The refusal reads
// like any bad credential; the cold-start log says why (strict.ts).
function ownerOf(userId: string | undefined, strict: boolean): string {
  if (userId) return userId;
  if (strict) throw new Error('Unauthorized: invalid token');
  return 'local';
}
