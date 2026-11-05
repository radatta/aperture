import { createHash, randomBytes } from 'node:crypto';
import { dayKey, PLACE_READ_DAILY_CAP, PLACE_TOKEN_PREFIX } from '@aperture/shared';
import { ConditionFailedError } from '../ddb/DocClient';
import type { PlaceTokenRow, PlaceTokenStore } from '../ddb/placeTokens';

// The Shortcut's place token (places.md → Token): a third credential class beside the Cognito JWT and the
// env device/agent tokens. 32 random bytes, shown to the user once; the server keeps only its SHA-256, as
// the key of a lookup row that names the user. Unlike resolveDeviceUserId there is no 'local' fallback —
// nothing is "unconfigured": a missing or unknown token is 401 on every stage.

// The prefix + 43 base64url chars (32 bytes, unpadded). Anything else is refused before any lookup — a
// JWT sent here never costs a read.
const TOKEN_RE = new RegExp(`^${PLACE_TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`);
const CAS_ATTEMPTS = 4;

export const mintPlaceToken = (): string =>
  `${PLACE_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
export const hashPlaceToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

export function bearerOf(header: string | undefined): string | null {
  const m = header ? /^Bearer\s+(\S+)$/i.exec(header.trim()) : null;
  return m ? m[1]! : null;
}

// The hidden daily guard (D7) → 429 at the edge.
export class PlaceReadCapError extends Error {
  readonly code = 'PLACE_READ_CAP';
  constructor() {
    super('Daily read cap reached');
    this.name = 'PlaceReadCapError';
  }
}

// The cap is a guard, not UX, so its day is UTC (dayKey with no offset on the UTC Lambda).
export const readsToday = (row: PlaceTokenRow, now: number): number =>
  row.readsDay === dayKey(now, 0) ? row.readsCount : 0;

export interface PlaceReadAuth {
  userId: string;
  hash: string;
  row: PlaceTokenRow;
}

// Header → the token's owner, or throw: `Unauthorized: …` (401) or PlaceReadCapError (429). Two consistent
// GetItems — the lookup row (consistent: a token minted a moment ago reads at once), then its user's
// pointer, the authority: a lookup row the pointer doesn't name is a retiring token whose delete was cut
// short (mid-rotate, mid-revoke) and is refused. None for a missing or malformed token. Writes nothing.
// The pointer comes before the cap, so a revoked token at its cap still answers 401, not 429.
export async function resolvePlaceRead(
  store: PlaceTokenStore,
  header: string | undefined,
  now: number,
  cap: number = PLACE_READ_DAILY_CAP,
): Promise<PlaceReadAuth> {
  const token = bearerOf(header);
  if (!token) throw new Error('Unauthorized: missing place token');
  if (!TOKEN_RE.test(token)) throw new Error('Unauthorized: not a place token');
  const hash = hashPlaceToken(token);
  const row = await store.get(hash, { consistent: true });
  if (!row) throw new Error('Unauthorized: unknown place token');
  const ptr = await store.pointer(row.userId);
  if (ptr?.hash !== hash) throw new Error('Unauthorized: place token revoked');
  if (readsToday(row, now) >= cap) throw new PlaceReadCapError();
  return { userId: row.userId, hash, row };
}

// Count one read: a conditional write on the row as resolved, so a revoke or rotate that deleted it
// mid-read is never undone. A lost race re-reads (consistent): gone → Unauthorized, at cap → the cap.
export async function countPlaceRead(
  store: PlaceTokenStore,
  auth: PlaceReadAuth,
  now: number,
  cap: number = PLACE_READ_DAILY_CAP,
): Promise<PlaceTokenRow> {
  let row = auth.row;
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    if (readsToday(row, now) >= cap) throw new PlaceReadCapError();
    const next: PlaceTokenRow = {
      ...row,
      readsDay: dayKey(now, 0),
      readsCount: readsToday(row, now) + 1,
      lastUsedAt: now,
      updatedAt: Math.max(now, row.updatedAt + 1),
    };
    try {
      await store.replace(auth.hash, row, next);
      return next;
    } catch (err) {
      if (!(err instanceof ConditionFailedError)) throw err;
      const fresh = await store.get(auth.hash, { consistent: true });
      if (!fresh || fresh.userId !== auth.userId)
        throw new Error('Unauthorized: place token revoked', { cause: err });
      row = fresh;
    }
  }
  throw new Error('Conflict — try again');
}
