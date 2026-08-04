import { CognitoJwtVerifier } from 'aws-jwt-verify';

// A narrow verifier surface so the request path is testable with a fake — the real one wraps
// aws-jwt-verify (JWKS signature + issuer + expiry, keys cached in-process).
export interface Verifier {
  verify(token: string): Promise<{ sub: string }>;
}

export function createCognitoVerifier(userPoolId: string, clientId: string): Verifier {
  const verifier = CognitoJwtVerifier.create({ userPoolId, tokenUse: 'access', clientId });
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
