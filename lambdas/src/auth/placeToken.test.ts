import { describe, expect, it } from 'vitest';
import { dayKey, PLACE_READ_DAILY_CAP, PLACE_TOKEN_PREFIX } from '@aperture/shared';
import { InMemoryDoc } from '../ddb/DocClient';
import { liveWrites } from '../ddb/writes';
import { PlaceTokenPointerError, PlaceTokenStore } from '../ddb/placeTokens';
import type { PlaceTokenRow } from '../ddb/placeTokens';
import { pk, PLACE_TOKEN_SK, placeTokenPk, sk } from '../ddb/keys';
import {
  bearerOf,
  countPlaceRead,
  hashPlaceToken,
  mintPlaceToken,
  PlaceReadCapError,
  readsToday,
  resolvePlaceRead,
} from './placeToken';

const NOW = Date.parse('2026-11-03T18:00:00Z');
const TODAY = dayKey(NOW, 0);
const row = (over: Partial<PlaceTokenRow> = {}): PlaceTokenRow => ({
  userId: 'u1',
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: null,
  readsDay: null,
  readsCount: 0,
  hint: 'abcd',
  ...over,
});
// The user's pointer row, as rotate writes it: naming `hash` as the live token.
const pointTo = (doc: InMemoryDoc, userId: string, hash: string | null, over = {}) =>
  doc.putNow({
    PK: pk(userId),
    SK: sk.ptoken(),
    hash,
    createdAt: 1,
    hint: 'abcd',
    retiring: [],
    updatedAt: 1,
    ...over,
  });
function env() {
  const doc = new InMemoryDoc();
  const store = new PlaceTokenStore(doc, liveWrites(doc));
  const token = mintPlaceToken();
  const hash = hashPlaceToken(token);
  // A live token: its lookup row plus the pointer naming it.
  const seed = async (r: PlaceTokenRow) => {
    await store.create(hash, r);
    pointTo(doc, r.userId, hash);
  };
  return { doc, store, token, hash, seed };
}

describe('place token', () => {
  it('mints 32 random bytes as prefixed base64url, and hashes to sha256 hex', () => {
    const a = mintPlaceToken();
    expect(a.startsWith(PLACE_TOKEN_PREFIX)).toBe(true);
    expect(a.slice(PLACE_TOKEN_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(a.slice(PLACE_TOKEN_PREFIX.length), 'base64url')).toHaveLength(32);
    expect(mintPlaceToken()).not.toBe(a);
    expect(hashPlaceToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashPlaceToken(a)).toBe(hashPlaceToken(a));
    expect(hashPlaceToken(a)).not.toContain(a.slice(PLACE_TOKEN_PREFIX.length));
  });

  it('parses a Bearer header only', () => {
    expect(bearerOf('Bearer apl_x')).toBe('apl_x');
    expect(bearerOf('  bearer   apl_x ')).toBe('apl_x');
    expect(bearerOf('apl_x')).toBeNull();
    expect(bearerOf('Basic apl_x')).toBeNull();
    expect(bearerOf('Bearer a b')).toBeNull();
    expect(bearerOf(undefined)).toBeNull();
    expect(bearerOf('')).toBeNull();
  });

  it('counts reads per UTC day: another day reads as 0', () => {
    expect(readsToday(row({ readsDay: TODAY, readsCount: 7 }), NOW)).toBe(7);
    expect(readsToday(row({ readsDay: '2000-01-01', readsCount: 7 }), NOW)).toBe(0);
    expect(readsToday(row(), NOW)).toBe(0);
  });
});

describe('resolvePlaceRead', () => {
  it("resolves a known token to the row's user — the lookup and the pointer, both consistent, no write", async () => {
    const { doc, store, token, hash, seed } = env();
    await seed(row({ userId: 'u7' }));
    const before = doc.snapshot();
    const auth = await resolvePlaceRead(store, `Bearer ${token}`, NOW);
    expect(auth).toMatchObject({ userId: 'u7', hash });
    expect(doc.gets).toEqual([
      { key: `${placeTokenPk(hash)} ${PLACE_TOKEN_SK}`, consistent: true },
      { key: `${pk('u7')} ${sk.ptoken()}`, consistent: true },
    ]);
    expect(doc.snapshot()).toEqual(before);
  });

  it('the pointer is the authority: a lookup row it does not name is refused, even at the cap', async () => {
    const { doc, store, token, hash } = env();
    await store.create(hash, row());
    // No pointer at all (a rotate that never landed its pointer write).
    await expect(resolvePlaceRead(store, `Bearer ${token}`, NOW)).rejects.toThrow(
      'Unauthorized: place token revoked',
    );
    // Revoked (hash null) or rotated past, with the old lookup row's delete cut short.
    pointTo(doc, 'u1', null, { retiring: [hash] });
    await expect(resolvePlaceRead(store, `Bearer ${token}`, NOW)).rejects.toThrow(
      'Unauthorized: place token revoked',
    );
    pointTo(doc, 'u1', 'f'.repeat(64), { retiring: [hash] });
    await expect(resolvePlaceRead(store, `Bearer ${token}`, NOW)).rejects.toThrow(
      'Unauthorized: place token revoked',
    );
    // Another user's pointer naming this hash doesn't vouch for u1's row.
    pointTo(doc, 'u2', hash);
    await expect(resolvePlaceRead(store, `Bearer ${token}`, NOW)).rejects.toThrow(/revoked/);
    // 401 before 429: a dead token at its cap is still a dead token.
    doc.putNow({
      PK: placeTokenPk(hash),
      SK: PLACE_TOKEN_SK,
      ...row({ readsDay: TODAY, readsCount: PLACE_READ_DAILY_CAP }),
    });
    await expect(resolvePlaceRead(store, `Bearer ${token}`, NOW)).rejects.toThrow(/revoked/);
  });

  it('a pointer with no numeric updatedAt is refused by name, never compared as NaN', async () => {
    const { doc, store, token, hash } = env();
    await store.create(hash, row());
    pointTo(doc, 'u1', hash, { updatedAt: undefined });
    await expect(resolvePlaceRead(store, `Bearer ${token}`, NOW)).rejects.toThrow(
      new PlaceTokenPointerError('Corrupt place-token pointer: no updatedAt'),
    );
    await expect(store.pointer('u1')).rejects.toBeInstanceOf(PlaceTokenPointerError);
    pointTo(doc, 'u1', hash, { updatedAt: '5' });
    await expect(store.pointer('u1')).rejects.toThrow('Corrupt place-token pointer: no updatedAt');
  });

  it('refuses a missing or malformed token before any lookup — never a local fallback', async () => {
    const { doc, store } = env();
    await expect(resolvePlaceRead(store, undefined, NOW)).rejects.toThrow(
      'Unauthorized: missing place token',
    );
    await expect(resolvePlaceRead(store, 'Bearer eyJhbGciOi.jwt.sig', NOW)).rejects.toThrow(
      'Unauthorized: not a place token',
    );
    await expect(resolvePlaceRead(store, `Bearer apl_${'a'.repeat(42)}`, NOW)).rejects.toThrow(
      /^Unauthorized/,
    );
    expect(doc.gets).toHaveLength(0);
  });

  it('refuses an unknown token after its one lookup', async () => {
    const { doc, store, token } = env();
    await expect(resolvePlaceRead(store, `Bearer ${token}`, NOW)).rejects.toThrow(
      'Unauthorized: unknown place token',
    );
    expect(doc.gets).toHaveLength(1);
  });

  it('refuses at the daily cap (429), and a new day starts the count over', async () => {
    const { store, token, seed } = env();
    await seed(row({ readsDay: TODAY, readsCount: PLACE_READ_DAILY_CAP }));
    await expect(resolvePlaceRead(store, `Bearer ${token}`, NOW)).rejects.toBeInstanceOf(
      PlaceReadCapError,
    );
    const tomorrow = NOW + 24 * 3600_000;
    await expect(resolvePlaceRead(store, `Bearer ${token}`, tomorrow)).resolves.toMatchObject({
      userId: 'u1',
    });
    // Under the cap by one read still passes.
    await expect(
      resolvePlaceRead(store, `Bearer ${token}`, NOW, PLACE_READ_DAILY_CAP + 1),
    ).resolves.toMatchObject({ userId: 'u1' });
  });
});

describe('countPlaceRead', () => {
  it('bumps the count, the day and lastUsedAt in one conditional write', async () => {
    const { doc, store, token, hash, seed } = env();
    await seed(row({ readsDay: '2000-01-01', readsCount: 50 }));
    const auth = await resolvePlaceRead(store, `Bearer ${token}`, NOW);
    const next = await countPlaceRead(store, auth, NOW);
    expect(next).toMatchObject({ readsDay: TODAY, readsCount: 1, lastUsedAt: NOW });
    expect(await store.get(hash)).toEqual(next);
    expect(doc.size).toBe(2); // the lookup row and the pointer
  });

  it('never writes a token revoked mid-read back to life', async () => {
    const { store, token, hash, seed } = env();
    await seed(row());
    const auth = await resolvePlaceRead(store, `Bearer ${token}`, NOW);
    await store.delete(hash); // the revoke lands between the read and its count
    await expect(countPlaceRead(store, auth, NOW)).rejects.toThrow(
      'Unauthorized: place token revoked',
    );
    expect(await store.get(hash, { consistent: true })).toBeNull();
  });

  it('retries a lost race on the fresh count, and stops at the cap', async () => {
    const { doc, store, token, hash, seed } = env();
    await seed(row({ readsDay: TODAY, readsCount: 3 }));
    const auth = await resolvePlaceRead(store, `Bearer ${token}`, NOW);
    // A concurrent read counted first.
    doc.putNow({
      PK: placeTokenPk(hash),
      SK: PLACE_TOKEN_SK,
      ...row({ updatedAt: 5, readsDay: TODAY, readsCount: 4 }),
    });
    expect((await countPlaceRead(store, auth, NOW)).readsCount).toBe(5);

    const capped = await resolvePlaceRead(store, `Bearer ${token}`, NOW);
    doc.putNow({
      PK: placeTokenPk(hash),
      SK: PLACE_TOKEN_SK,
      ...row({ updatedAt: NOW + 10, readsDay: TODAY, readsCount: PLACE_READ_DAILY_CAP }),
    });
    await expect(countPlaceRead(store, capped, NOW)).rejects.toBeInstanceOf(PlaceReadCapError);
  });
});
