import { describe, expect, it } from 'vitest';
import {
  CAPTURE_DUPLICATE_MS,
  CAPTURE_PARSE_DAILY_CAP,
  CAPTURE_PARSE_DEADLINE_MS,
  CAPTURE_SAY,
  USER_TIME_ZONE,
  zonedEpoch,
} from '@aperture/shared';
import { InMemoryDoc } from './ddb/DocClient';
import { Repo } from './ddb/repo';
import { liveWrites } from './ddb/writes';
import { ScopedTokenStore } from './ddb/scopedTokens';
import { BackendClient } from './backend';
import { FakeAnthropic } from './anthropic/gateway';
import { resolveScopedToken } from './auth/scopedToken';

// Voice capture's server half (capture.md): BackendClient.captureForToken over the gated model seam. The
// edge (status codes, body checks, logging) is index.test.ts's; this is the flow — caps, the duplicate
// guard, the deadline, the voice time rules end to end. No network: FakeAnthropic stands in for Haiku.

const MON_6AM = zonedEpoch('2026-11-16', '06:00', USER_TIME_ZONE);

function setup(start = MON_6AM) {
  const doc = new InMemoryDoc();
  const anthropic = new FakeAnthropic();
  const store = new ScopedTokenStore(doc, liveWrites(doc));
  const clock = { now: start };
  const backend = (userId = 'u1') =>
    new BackendClient(new Repo(doc, liveWrites(doc), userId), {
      userId,
      now: () => clock.now,
      anthropic,
      scopedTokens: store,
    });
  const b = backend();
  const mint = async () => (await b.mintScopedToken('capture', 'iPhone')).token;
  const auth = (token: string) => resolveScopedToken(store, `Bearer ${token}`, 'capture');
  const capture = async (token: string, text: string, voice = true, as = b) =>
    as.captureForToken(text, voice, await auth(token));
  return { doc, anthropic, store, clock, backend, b, mint, auth, capture };
}
const fields = (over: Record<string, unknown> = {}) => ({
  title: 'call mum',
  notes: null,
  categoryId: null,
  dueDay: null,
  dueTime: null,
  estimateMin: null,
  ...over,
});

describe('captureForToken — a spoken line', () => {
  it('parses with the voice prompt and a 5 s deadline, takes the time from the words, and says it', async () => {
    const { anthropic, b, mint, capture } = setup();
    const token = await mint();
    anthropic.next = { ok: true, fields: fields({ dueTime: '05:00' }) };
    const r = await capture(token, 'remind me to call mum at 5');
    expect(r).toMatchObject({
      say: 'Added: call mum, today 5 PM.',
      raw: false,
      duplicate: false,
      due: { day: '2026-11-16', time: '17:00' },
    });
    expect(await b.getTask(r.id!)).toMatchObject({ dueDay: '2026-11-16', dueTime: '17:00' });
    expect(anthropic.calls).toHaveLength(1);
    expect(anthropic.calls[0]).toMatchObject({ voice: true, today: '2026-11-16' });
    expect(anthropic.calls[0]!.timeoutMs).toBeLessThanOrEqual(CAPTURE_PARSE_DEADLINE_MS);
  });

  it('a time already past rolls to tomorrow, and the answer names the day', async () => {
    const { anthropic, clock, mint, capture } = setup();
    clock.now = zonedEpoch('2026-11-16', '15:00', USER_TIME_ZONE);
    const token = await mint();
    anthropic.next = { ok: true, fields: fields() };
    const r = await capture(token, 'call mum at 9 am');
    expect(r.due).toEqual({ day: '2026-11-17', time: '09:00' });
    expect(r.say).toBe('Added: call mum, tomorrow 9 AM.');
  });

  it('"in 20 minutes" is now + 20 from the server clock, never the model’s', async () => {
    const { anthropic, clock, mint, capture } = setup();
    clock.now = zonedEpoch('2026-11-16', '14:10', USER_TIME_ZONE);
    const token = await mint();
    anthropic.next = { ok: true, fields: fields({ dueTime: '20:00', estimateMin: 20 }) };
    const r = await capture(token, 'call mum in 20 minutes');
    expect(r.due).toEqual({ day: '2026-11-16', time: '14:30' });
    expect(r.say).toBe('Added: call mum, today 2:30 PM.');
    expect(r.detail).toContain('dropped estimate');
  });

  it('a typed line (Raycast, no voice flag) keeps the typed rules: a past clock lands today', async () => {
    const { anthropic, clock, mint, capture } = setup();
    clock.now = zonedEpoch('2026-11-16', '15:00', USER_TIME_ZONE);
    const token = await mint();
    anthropic.next = { ok: true, fields: fields({ dueDay: '2026-11-16', dueTime: '09:00' }) };
    const r = await capture(token, 'call mum 9am', false);
    expect(r.due).toEqual({ day: '2026-11-16', time: '09:00' });
    expect(anthropic.calls[0]!.voice).toBe(false);
    expect(r.detail).toBe('Added: call mum · no category · due today 9am');
  });

  it('a failed or timed-out parse saves the line as typed and says so', async () => {
    const { anthropic, b, mint, capture } = setup();
    const token = await mint();
    anthropic.next = { ok: false, reason: 'timeout' };
    const r = await capture(token, 'call mum at five');
    expect(r).toMatchObject({ raw: true, due: null });
    expect(r.say).toBe('Added as typed, with no date or time: call mum at five.');
    expect(r.detail).toBe("Added RAW (couldn't parse: timeout): call mum at five");
    expect(await b.getTask(r.id!)).toMatchObject({ title: 'call mum at five', dueDay: null });
  });
});

describe('captureForToken — caps and the duplicate guard', () => {
  it(`past ${CAPTURE_PARSE_DAILY_CAP} model calls a day the line saves as typed, and the model isn’t called`, async () => {
    const { anthropic, store, b, mint, capture } = setup();
    const token = await mint();
    const [info] = await b.listScopedTokens('capture');
    const row = (await store.row('u1', info!.id))!;
    await store.replaceRow('u1', row, {
      ...row,
      usesDay: '2026-11-16',
      uses: 10,
      parses: CAPTURE_PARSE_DAILY_CAP,
      updatedAt: row.updatedAt + 1,
    });
    anthropic.next = { ok: true, fields: fields() };
    const r = await capture(token, 'call mum at 5');
    expect(r.raw).toBe(true);
    expect(r.detail).toContain('daily parse limit reached');
    expect(anthropic.calls).toHaveLength(0);
    // A grammar line needs no model, so it still parses.
    expect((await capture(token, 'milk | ~5')).raw).toBe(false);
  });

  it('only a real model call is counted: a grammar line spends no parse', async () => {
    const { anthropic, store, b, mint, capture } = setup();
    const token = await mint();
    await capture(token, 'milk | ~5');
    anthropic.next = { ok: true, fields: fields() };
    await capture(token, 'call mum');
    const [info] = await b.listScopedTokens('capture');
    expect(await store.row('u1', info!.id)).toMatchObject({ uses: 2, parses: 1 });
  });

  it('the counters start over on a new UTC day', async () => {
    const { store, b, mint, capture, clock } = setup();
    const token = await mint();
    await capture(token, 'milk | ~5');
    clock.now += 24 * 3600_000;
    await capture(token, 'eggs | ~5');
    const [info] = await b.listScopedTokens('capture');
    expect(info!.usedToday).toBe(1);
    expect((await store.row('u1', info!.id))!.uses).toBe(1);
  });

  it(`the same line after ${CAPTURE_DUPLICATE_MS / 1000} s is a new task`, async () => {
    const { b, mint, capture, clock } = setup();
    const token = await mint();
    const a = await capture(token, 'milk | ~5');
    clock.now += CAPTURE_DUPLICATE_MS - 1;
    expect((await capture(token, 'milk | ~5')).id).toBe(a.id);
    clock.now += 1;
    // The window runs from the first, not the repeat.
    const c = await capture(token, 'milk | ~5');
    expect(c).toMatchObject({ duplicate: false });
    expect(c.id).not.toBe(a.id);
    expect((await b.listTasks()).filter((t) => t.title === 'milk')).toHaveLength(2);
  });

  it('a repeat while the first is still in flight says so, with no id', async () => {
    const { store, b, mint, capture } = setup();
    const token = await mint();
    const [info] = await b.listScopedTokens('capture');
    // The first capture reserved its line but hasn't saved its task yet.
    const a = await capture(token, 'milk | ~5');
    const row = (await store.row('u1', info!.id))!;
    await store.replaceRow('u1', row, { ...row, lastTaskId: null, updatedAt: row.updatedAt + 1 });
    const r = await capture(token, 'milk | ~5');
    expect(r).toMatchObject({ id: null, duplicate: true, say: CAPTURE_SAY.inFlight });
    expect(a.id).toBeTruthy();
  });

  it('a voiced and a typed line with the same words are different captures', async () => {
    const { anthropic, mint, capture } = setup();
    const token = await mint();
    anthropic.next = { ok: true, fields: fields() };
    const a = await capture(token, 'call mum', true);
    const c = await capture(token, 'call mum', false);
    expect(c.id).not.toBe(a.id);
  });
});

describe('captureForToken — ownership and revocation', () => {
  it('a token answers only for its own user', async () => {
    const { backend, mint, capture } = setup();
    const token = await mint();
    await expect(capture(token, 'milk | ~5', true, backend('u2'))).rejects.toThrow(/Unauthorized/);
    expect(await backend('u2').listTasks()).toEqual([]);
  });

  it('a revoke between the lookup and the count refuses, and nothing is added', async () => {
    const { b, mint, auth } = setup();
    const token = await mint();
    const a = await auth(token);
    await b.revokeScopedToken(a.row.id);
    await expect(b.captureForToken('milk | ~5', true, a)).rejects.toThrow(/Unauthorized/);
    expect(await b.listTasks()).toEqual([]);
    await expect(auth(token)).rejects.toThrow(/Unauthorized/);
  });

  it('a revoke cut short after the lookup delete already refuses; revoking again finishes it', async () => {
    const { b, store, mint, auth } = setup();
    const token = await mint();
    const a = await auth(token);
    await store.deleteLookup(a.hash);
    await expect(auth(token)).rejects.toThrow('Unauthorized: unknown token');
    expect(await b.listScopedTokens('capture')).toHaveLength(1);
    await b.revokeScopedToken(a.row.id);
    expect(await b.listScopedTokens('capture')).toEqual([]);
  });

  it('a lookup whose row is gone (or another token’s) is refused', async () => {
    const { store, mint, auth } = setup();
    const token = await mint();
    const a = await auth(token);
    await store.deleteRow('u1', a.row.id);
    await expect(auth(token)).rejects.toThrow('Unauthorized: revoked token');
  });

  it('a mint whose lookup fails takes its row back out', async () => {
    const { b, store } = setup();
    store.createLookup = async () => {
      throw new Error('boom');
    };
    await expect(b.mintScopedToken('capture', 'iPhone')).rejects.toThrow('boom');
    expect(await b.listScopedTokens('capture')).toEqual([]);
  });
});
