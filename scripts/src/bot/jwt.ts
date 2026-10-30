// The GitHub App JWT (RS256), signed with node:crypto — no JWT library for one fixed header and three claims.
// GitHub's rules: iss = the Client ID, exp at most 10 min out, iat backdated for clock drift.
import { createSign } from 'node:crypto';

const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

export function appJwt(clientId: string, privateKey: string, nowMs = Date.now()): string {
  const now = Math.floor(nowMs / 1000);
  const body = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({ iat: now - 60, exp: now + 540, iss: clientId })}`;
  return `${body}.${createSign('RSA-SHA256').update(body).sign(privateKey).toString('base64url')}`;
}
