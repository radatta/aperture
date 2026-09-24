import { timingSafeEqual } from 'node:crypto';
import { CognitoJwtVerifier } from 'aws-jwt-verify';

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
// no cycle. `rejectClientIds` is the inverse: deny listed clients (D14, used by the BFF).
export function createCognitoVerifier(
  userPoolId: string,
  clientId: string | null = null,
  opts: { rejectClientIds?: string[] } = {},
): Verifier {
  const { rejectClientIds } = opts;
  const verifier = CognitoJwtVerifier.create({
    userPoolId,
    tokenUse: 'access',
    clientId,
    ...(rejectClientIds?.length
      ? { customJwtCheck: ({ payload }) => assertClientAllowed(payload.client_id, rejectClientIds) }
      : {}),
  });
  return {
    async verify(token: string) {
      const payload = await verifier.verify(token);
      return { sub: String(payload.sub) };
    },
  };
}

function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]! : null;
}

// Resolve the request's userId from the Authorization header.
//   - Verifier configured (deployed): a valid Bearer ACCESS token is REQUIRED. Missing/invalid → throw
//     an "Unauthorized" error the edge turns into a 401. The `sub` becomes the userId scoping every item.
//   - No verifier (local dev, no pool wired): fall back to a fixed dev user so the app runs sans Cognito.
export async function resolveUserId(
  authHeader: string | undefined,
  verifier: Verifier | null,
): Promise<string> {
  if (!verifier) return 'local';
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
// by the caller to ONLY the ingest method. Dev (no token configured) falls back to the 'local' user,
// mirroring resolveUserId's no-verifier path.
export function resolveDeviceUserId(
  authHeader: string | undefined,
  expectedToken: string | undefined,
  deviceUserId: string | undefined,
): string {
  if (!expectedToken) return 'local'; // dev: no device token wired → same 'local' user as JWT-less dev
  const token = bearer(authHeader);
  if (!token) throw new Error('Unauthorized: missing device token');
  const a = Buffer.from(token);
  const b = Buffer.from(expectedToken);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('Unauthorized: invalid device token');
  }
  return deviceUserId ?? 'local';
}

// The MCP server's static AGENT TOKEN — the same class of credential as the device token, but for the
// /mcp surface and unscoped by method (the agent token is a full app session). It arrives as the RAW
// value of AGENT_TOKEN_HEADER (no "Bearer" prefix — the MCP client sends the token verbatim), compared
// with timingSafeEqual against the env-configured secret. Distinct from resolveDeviceUserId so the two
// tokens revoke independently and the recruiting one stays method-scoped. Dev (no token configured)
// falls back to the 'local' user, mirroring resolveUserId / resolveDeviceUserId. The caller only invokes
// this when the header is PRESENT, so an unconfigured server still rejects a stray header (see the edge).
export function resolveAgentUserId(
  headerValue: string | undefined,
  expectedToken: string | undefined,
  agentUserId: string | undefined,
): string {
  if (!expectedToken) return 'local'; // dev: no agent token wired → same 'local' user as JWT-less dev
  const token = headerValue?.trim();
  if (!token) throw new Error('Unauthorized: missing agent token');
  const a = Buffer.from(token);
  const b = Buffer.from(expectedToken);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('Unauthorized: invalid agent token');
  }
  return agentUserId ?? 'local';
}
