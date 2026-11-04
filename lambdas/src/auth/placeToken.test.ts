import { describe, expect, it } from 'vitest';
import { dayKey, PLACE_READ_DAILY_CAP, PLACE_TOKEN_PREFIX } from '@aperture/shared';
import { InMemoryDoc } from '../ddb/DocClient';
import { liveWrites } from '../ddb/writes';
import { PlaceTokenStore } from '../ddb/placeTokens';
import type { PlaceTokenRow } from '../ddb/placeTokens';
import { PLACE_TOKEN_SK, placeTokenPk } from '../ddb/keys';
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
function env() {
  const doc = new InMemoryDoc();
  const store = new PlaceTokenStore(doc, liveWrites(doc));
  const token = mintPlaceToken();
  return { doc, store, token, hash: hashPlaceToken(token) };
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
  it("resolves a known token to the row's user — one lookup, no write", async () => {
    const { doc, store, token, hash } = env();
    await store.create(hash, row({ userId: 'u7' }));
    const before = doc.snapshot();
    const auth = await resolvePlaceRead(store, `Bearer ${token}`, NOW);
    expect(auth).toMatchObject({ userId: 'u7', hash });
    expect(doc.gets).toHaveLength(1);
    expect(doc.snapshot()).toEqual(before);
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
    const { store, token, hash } = env();
    await store.create(hash, row({ readsDay: TODAY, readsCount: PLACE_READ_DAILY_CAP }));
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
    const { doc, store, token, hash } = env();
    await store.create(hash, row({ readsDay: '2000-01-01', readsCount: 50 }));
    const auth = await resolvePlaceRead(store, `Bearer ${token}`, NOW);
    const next = await countPlaceRead(store, auth, NOW);
    expect(next).toMatchObject({ readsDay: TODAY, readsCount: 1, lastUsedAt: NOW });
    expect(await store.get(hash)).toEqual(next);
    expect(doc.size).toBe(1);
  });

  it('never writes a token revoked mid-read back to life', async () => {
    const { doc, store, token, hash } = env();
    await store.create(hash, row());
    const auth = await resolvePlaceRead(store, `Bearer ${token}`, NOW);
    await store.delete(hash); // the revoke lands between the read and its count
    await expect(countPlaceRead(store, auth, NOW)).rejects.toThrow(
      'Unauthorized: place token revoked',
    );
    expect(doc.size).toBe(0);
  });

  it('retries a lost race on the fresh count, and stops at the cap', async () => {
    const { doc, store, token, hash } = env();
    await store.create(hash, row({ readsDay: TODAY, readsCount: 3 }));
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
