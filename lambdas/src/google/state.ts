import { createHmac, timingSafeEqual } from 'node:crypto';

// OAuth `state`: ties the consent round-trip to the app user (login-CSRF defense) and is HMAC-signed
// with a key derived from ORIGIN_SECRET. It carries the Cognito userId (so the browser-driven callback
// knows whose settings to write, without a JWT) plus an issued-at, so a stale or forged state is
// rejected. Pure — no external calls — so it's unit-testable and safe outside the gated gateway.

const STATE_TTL_MS = 10 * 60_000;

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const unb64url = (s: string) => Buffer.from(s, 'base64url').toString('utf8');
const sign = (payload: string, secret: string) =>
  createHmac('sha256', secret).update(payload).digest('base64url');

export function signState(userId: string, secret: string, now: number = Date.now()): string {
  const payload = b64url(`${userId}:${now}`);
  return `${payload}.${sign(payload, secret)}`;
}

export function verifyState(
  state: string,
  secret: string,
  now: number = Date.now(),
): { userId: string } {
  const [payload, mac] = state.split('.');
  if (!payload || !mac) throw new Error('Bad state');
  const expected = sign(payload, secret);
  const got = Buffer.from(mac);
  const want = Buffer.from(expected);
  if (got.length !== want.length || !timingSafeEqual(got, want)) {
    throw new Error('Bad state signature');
  }
  const [userId, issued] = unb64url(payload).split(':');
  if (!userId || !issued) throw new Error('Bad state payload');
  if (now - Number(issued) > STATE_TTL_MS) throw new Error('Expired state');
  return { userId };
}
