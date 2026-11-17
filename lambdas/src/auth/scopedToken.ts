import { createHash, randomBytes } from 'node:crypto';
import {
  CAPTURE_DAILY_CAP,
  CAPTURE_DUPLICATE_MS,
  CAPTURE_PARSE_DAILY_CAP,
  dayKey,
  SCOPED_TOKEN_PREFIX,
} from '@aperture/shared';
import type { TokenScope } from '@aperture/shared';
import { ConditionFailedError } from '../ddb/DocClient';
import type { ScopedTokenRow, ScopedTokenStore } from '../ddb/scopedTokens';
import { bearerOf } from './placeToken';

// Scoped device tokens (capture.md → Token): a fourth credential class beside the Cognito JWT, the env
// device/agent tokens and the place token. 32 random bytes behind the scope's prefix, shown once; the
// server keeps only its SHA-256, as the key of a lookup row that names the user and the token's row. No
// 'local' fallback: a missing, malformed, unknown or revoked token is 401 on every stage.

const CAS_ATTEMPTS = 4;
const tokenRe = (scope: TokenScope) => new RegExp(`^${SCOPED_TOKEN_PREFIX[scope]}[A-Za-z0-9_-]{43}$`);

export const newScopedToken = (scope: TokenScope): string =>
  `${SCOPED_TOKEN_PREFIX[scope]}${randomBytes(32).toString('base64url')}`;
export const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

export interface ScopedAuth {
  userId: string;
  hash: string;
  row: ScopedTokenRow;
}

// Header → the token's owner and row, or throw `Unauthorized: …` (401). Two consistent GetItems — the
// lookup, then the token's row in its user's partition, the authority: both must exist and agree, so a
// revoke cut short after either delete is already a refusal. None for a missing or malformed token (a JWT
// or a place token sent here never costs a read). Writes nothing.
export async function resolveScopedToken(
  store: ScopedTokenStore,
  header: string | undefined,
  scope: TokenScope,
): Promise<ScopedAuth> {
  const token = bearerOf(header);
  if (!token) throw new Error('Unauthorized: missing token');
  if (!tokenRe(scope).test(token)) throw new Error('Unauthorized: malformed token');
  const hash = sha256Hex(token);
  const lookup = await store.lookup(hash);
  if (!lookup || lookup.scope !== scope) throw new Error('Unauthorized: unknown token');
  const row = await store.row(lookup.userId, lookup.tokenId);
  if (!row || row.hash !== hash || row.scope !== scope)
    throw new Error('Unauthorized: revoked token');
  return { userId: lookup.userId, hash, row };
}

// The counters are guards, not UX, so their day is UTC (dayKey with no offset on the UTC Lambda). A row
// last counted on another day reads as zero.
const today = (now: number) => dayKey(now, 0);
export const usesToday = (row: ScopedTokenRow, now: number): number =>
  row.usesDay === today(now) ? row.uses : 0;
export const parsesToday = (row: ScopedTokenRow, now: number): number =>
  row.usesDay === today(now) ? row.parses : 0;

// The daily capture cap (CAPTURE_DAILY_CAP) → 429 at the edge.
export class CaptureCapError extends Error {
  readonly code = 'CAPTURE_CAP';
  constructor() {
    super('Daily capture cap reached');
    this.name = 'CaptureCapError';
  }
}

// One conditional write on the token's row; on a lost race, re-read it (consistent) and try again. Gone, or
// another token's now → Unauthorized: a revoke mid-request is never written back to life.
async function casRow<T>(
  store: ScopedTokenStore,
  auth: ScopedAuth,
  step: (row: ScopedTokenRow) => { next: ScopedTokenRow | null; out: T },
): Promise<T> {
  let row = auth.row;
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const { next, out } = step(row);
    if (!next) return out;
    try {
      await store.replaceRow(auth.userId, row, next);
      auth.row = next;
      return out;
    } catch (err) {
      if (!(err instanceof ConditionFailedError)) throw err;
      const fresh = await store.row(auth.userId, row.id);
      if (!fresh || fresh.hash !== auth.hash)
        throw new Error('Unauthorized: revoked token', { cause: err });
      row = fresh;
    }
  }
  throw new Error('Conflict — try again');
}
const bump = (row: ScopedTokenRow, now: number): ScopedTokenRow => ({
  ...row,
  usesDay: today(now),
  uses: usesToday(row, now),
  parses: parsesToday(row, now),
  updatedAt: Math.max(now, row.updatedAt + 1),
});

export type CaptureReservation =
  | { kind: 'new' }
  | { kind: 'duplicate'; taskId: string | null }; // null: the first is still in flight

// Count one capture before anything is spent — at the cap it throws (CaptureCapError) and nothing is
// written. The same line within CAPTURE_DUPLICATE_MS of the first is a duplicate: counted (so a replayed
// line still hits the cap), answered with the first's task, and it never moves the window.
export function reserveCapture(
  store: ScopedTokenStore,
  auth: ScopedAuth,
  textHash: string,
  now: number,
  cap: number = CAPTURE_DAILY_CAP,
): Promise<CaptureReservation> {
  return casRow(store, auth, (row) => {
    if (usesToday(row, now) >= cap) throw new CaptureCapError();
    const dup =
      row.lastTextHash === textHash && row.lastAt !== null && now - row.lastAt < CAPTURE_DUPLICATE_MS;
    const next: ScopedTokenRow = {
      ...bump(row, now),
      uses: usesToday(row, now) + 1,
      lastUsedAt: now,
      ...(dup ? {} : { lastTextHash: textHash, lastAt: now, lastTaskId: null }),
    };
    const out: CaptureReservation = dup
      ? { kind: 'duplicate', taskId: row.lastTaskId }
      : { kind: 'new' };
    return { next, out };
  });
}

// Claim one model call: true and counted, or false at CAPTURE_PARSE_DAILY_CAP (nothing written — the
// capture then saves the line as typed). Called only when the model is about to run, so a grammar line
// or an empty one never spends a claim.
export function claimParse(
  store: ScopedTokenStore,
  auth: ScopedAuth,
  now: number,
  cap: number = CAPTURE_PARSE_DAILY_CAP,
): Promise<boolean> {
  return casRow(store, auth, (row) => {
    if (parsesToday(row, now) >= cap) return { next: null, out: false };
    return { next: { ...bump(row, now), parses: parsesToday(row, now) + 1 }, out: true };
  });
}

// Remember the task this line made, for the duplicate guard — only while the row still waits on this very
// line (a newer line since leaves it alone).
export function recordCaptureTask(
  store: ScopedTokenStore,
  auth: ScopedAuth,
  textHash: string,
  taskId: string,
  now: number,
): Promise<void> {
  return casRow(store, auth, (row) => {
    if (row.lastTextHash !== textHash || row.lastTaskId !== null)
      return { next: null, out: undefined };
    return {
      next: { ...row, lastTaskId: taskId, updatedAt: Math.max(now, row.updatedAt + 1) },
      out: undefined,
    };
  });
}
