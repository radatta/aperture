import { describe, expect, it, vi } from 'vitest';
import {
  CAPTURE_DUPLICATE_MS,
  CAPTURE_IN_FLIGHT_MS,
  CAPTURE_PARSE_DAILY_CAP,
  CAPTURE_PARSE_DEADLINE_MS,
  CAPTURE_PARSE_TEXT_MAX,
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
import { CaptureBusyError, resolveScopedToken } from './auth/scopedToken';
import { pk, sk } from './ddb/keys';

// Voice capture's server half (capture.md): BackendClient.captureForToken over the gated model seam. The
// edge (status codes, body checks, logging) is index.test.ts's; this is the flow — caps, the duplicate
// guard, the deadline, the voice time rules end to end. No network: FakeAnthropic stands in for the model.

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

  it('a typed line (Raycast, no voice flag) rolls a past clock forward, as a spoken one does', async () => {
    const { anthropic, clock, mint, capture } = setup();
    clock.now = zonedEpoch('2026-11-16', '15:00', USER_TIME_ZONE);
    const token = await mint();
    anthropic.next = { ok: true, fields: fields({ dueDay: '2026-11-16', dueTime: '09:00' }) };
    const r = await capture(token, 'call mum 9am', false);
    expect(r.due).toEqual({ day: '2026-11-17', time: '09:00' });
    expect(anthropic.calls[0]!.voice).toBe(false);
    expect(r.detail).toBe('Added: call mum · no category · due tomorrow 9am');
    expect(r.say).toBe('Added: call mum, tomorrow 9 AM.');
  });

  // Dev, 2026-11-17 02:01: a typed "…at 1 am" came back unchanged, with no day and no time — due null.
  it('an at-clock the model kept in its title still sets the time, and leaves the stored title', async () => {
    const { anthropic, b, clock, mint, capture } = setup();
    clock.now = zonedEpoch('2026-11-17', '02:01', USER_TIME_ZONE);
    const token = await mint();
    anthropic.next = { ok: true, fields: fields({ title: 'call the bank at 1 am' }) };
    const r = await capture(token, 'call the bank at 1 am', false);
    expect(r.due).toEqual({ day: '2026-11-18', time: '01:00' });
    expect(r.say).toBe('Added: call the bank, tomorrow 1 AM.');
    expect(await b.getTask(r.id!)).toMatchObject({ title: 'call the bank', dueTime: '01:00' });
  });

  it('a clock the model missed is filled from the words, typed and spoken, and said back', async () => {
    const { anthropic, clock, mint, capture } = setup();
    clock.now = zonedEpoch('2026-11-16', '19:40', USER_TIME_ZONE);
    const token = await mint();
    // The dev miss: the model gave today and no time for "at 6 pm".
    anthropic.next = { ok: true, fields: fields({ title: 'call the bank', dueDay: '2026-11-16' }) };
    const typed = await capture(token, 'call the bank at 6 pm', false);
    expect(typed.due).toEqual({ day: '2026-11-17', time: '18:00' });
    expect(typed.say).toBe('Added: call the bank, tomorrow 6 PM.');
    // Spoken: the time comes from the words, not the model, so the same miss can't happen there.
    anthropic.next = { ok: true, fields: fields({ title: 'call the vet' }) };
    const spoken = await capture(token, 'call the vet at 6 pm');
    expect(spoken.due).toEqual({ day: '2026-11-17', time: '18:00' });
    expect(spoken.say).toBe('Added: call the vet, tomorrow 6 PM.');
  });

  it("a failed or timed-out parse saves the line as typed, with its own words' time, and says so", async () => {
    const { anthropic, b, mint, capture } = setup();
    const token = await mint();
    anthropic.next = { ok: false, reason: 'timeout' };
    const r = await capture(token, 'call mum at five');
    // 06:00 + a bare "at five": the grammar places it as the voice rules do (rule 1), 5 PM today.
    expect(r).toMatchObject({ raw: true, due: { day: '2026-11-16', time: '17:00' } });
    expect(r.say).toBe('Added without AI, as typed: call mum at five, today 5 PM.');
    expect(r.detail).toContain("Added RAW (couldn't parse: timeout): call mum at five ·");
    expect(await b.getTask(r.id!)).toMatchObject({
      title: 'call mum at five',
      dueDay: '2026-11-16',
      dueTime: '17:00',
    });
    // No time in the words, or a day the grammar can't place: no date or time, said so.
    anthropic.next = { ok: false, reason: 'timeout' };
    const plain = await capture(token, 'call mum');
    expect(plain).toMatchObject({ raw: true, due: null });
    expect(plain.say).toBe('Added as typed, with no date or time: call mum.');
    anthropic.next = { ok: false, reason: 'timeout' };
    expect((await capture(token, 'call dad friday at 5')).due).toBeNull();
    // A typed line (Raycast) keeps the typed fallback: no time from the grammar.
    anthropic.next = { ok: false, reason: 'timeout' };
    expect((await capture(token, 'call nan at five', false)).due).toBeNull();
  });

  it('reports the parse time and why it fell back, for the route log only', async () => {
    const { anthropic, mint, capture } = setup();
    const token = await mint();
    anthropic.next = { ok: false, reason: 'timeout' };
    const r = await capture(token, 'call mum');
    expect(r.timing).toMatchObject({ fallback: 'timeout' });
    expect(r.timing!.parseMs).toBeGreaterThanOrEqual(0);
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
    expect(r.timing!.fallback).toBe('cap');
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

  it('a first still unsaved after 20 s died: the same line again is a new capture', async () => {
    const { store, b, mint, capture, clock } = setup();
    const token = await mint();
    const [info] = await b.listScopedTokens('capture');
    await capture(token, 'milk | ~5');
    const row = (await store.row('u1', info!.id))!;
    await store.replaceRow('u1', row, { ...row, lastTaskId: null, updatedAt: row.updatedAt + 1 });
    clock.now += CAPTURE_IN_FLIGHT_MS;
    const r = await capture(token, 'milk | ~5');
    expect(r).toMatchObject({ duplicate: false, raw: false });
    expect(r.id).toBeTruthy();
  });

  it('every spoken line gets the voice prompt; a typed one the typed; the answer is capped', async () => {
    const { anthropic, mint, capture } = setup();
    const token = await mint();
    anthropic.next = { ok: true, fields: fields() };
    await capture(token, 'call mum at 5');
    await capture(token, 'call mum at quarter past five');
    await capture(token, 'call mum', false);
    expect(anthropic.calls.map((c) => c.voice)).toEqual([true, true, false]);
    expect(anthropic.calls.map((c) => c.maxTokens)).toEqual([512, 512, 512]);
  });

  it(`a line over ${CAPTURE_PARSE_TEXT_MAX} characters saves as typed without the model, and spends no parse`, async () => {
    const { anthropic, store, b, mint, capture } = setup();
    const token = await mint();
    const r = await capture(token, `call mum ${'and '.repeat(CAPTURE_PARSE_TEXT_MAX / 4)}`);
    expect(r.raw).toBe(true);
    expect(r.detail).toContain('too long for the model');
    expect(r.timing!.fallback).toBe('long');
    expect(anthropic.calls).toHaveLength(0);
    const [info] = await b.listScopedTokens('capture');
    expect((await store.row('u1', info!.id))!.parses).toBe(0);
    // Exactly the limit still reaches the model.
    anthropic.next = { ok: true, fields: fields() };
    const at = `call mum ${'x'.repeat(CAPTURE_PARSE_TEXT_MAX - 9)}`;
    expect(at).toHaveLength(CAPTURE_PARSE_TEXT_MAX);
    expect((await capture(token, at)).raw).toBe(false);
    expect(anthropic.calls).toHaveLength(1);
  });

  it(`the parse cap is per user: ${CAPTURE_PARSE_DAILY_CAP} across all their capture tokens`, async () => {
    const { anthropic, store, b, mint, capture } = setup();
    const phone = await mint();
    await b.mintScopedToken('capture', 'Raycast');
    const [a, c] = await b.listScopedTokens('capture');
    const spend = async (id: string, parses: number) => {
      const row = (await store.row('u1', id))!;
      await store.replaceRow('u1', row, {
        ...row,
        usesDay: '2026-11-16',
        uses: parses,
        parses,
        updatedAt: row.updatedAt + 1,
      });
    };
    // The other token made all but one of today's parses: this one gets the last…
    await spend(c!.id, CAPTURE_PARSE_DAILY_CAP - 1);
    anthropic.next = { ok: true, fields: fields() };
    expect((await capture(phone, 'call mum')).raw).toBe(false);
    // …and the next is past the cap, whichever token asks.
    const past = await capture(phone, 'call dad');
    expect(past.raw).toBe(true);
    expect(past.detail).toContain('daily parse limit reached');
    expect(anthropic.calls).toHaveLength(1);
    expect((await store.row('u1', a!.id))!.parses).toBe(1);
  });

  it("another token's parses from an earlier day don't count", async () => {
    const { anthropic, store, b, mint, capture } = setup();
    const phone = await mint();
    await b.mintScopedToken('capture', 'Raycast');
    const [, c] = await b.listScopedTokens('capture');
    const row = (await store.row('u1', c!.id))!;
    await store.replaceRow('u1', row, {
      ...row,
      usesDay: '2026-11-15',
      uses: CAPTURE_PARSE_DAILY_CAP,
      parses: CAPTURE_PARSE_DAILY_CAP,
      updatedAt: row.updatedAt + 1,
    });
    anthropic.next = { ok: true, fields: fields() };
    expect((await capture(phone, 'call mum')).raw).toBe(false);
  });

  it('a parse claim that loses every race is busy, and forgets the line so the retry is new', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { anthropic, doc, store, b, mint, capture } = setup();
    const token = await mint();
    const [info] = await b.listScopedTokens('capture');
    const key = [pk('u1'), sk.stoken(info!.id)] as const;
    // Every one of the claim's tries finds the row moved on; the forget after it lands.
    const lose = (times: number) => {
      let left = times;
      const rival = () => {
        const r = doc.snapshot().find((i) => i.PK === key[0] && i.SK === key[1])!;
        doc.putNow({ ...r, updatedAt: (r.updatedAt as number) + 1 });
        if (--left > 0) doc.interceptNextPutIf(...key, rival);
      };
      doc.interceptNextPutIf(...key, rival);
    };
    const list = store.list.bind(store);
    vi.spyOn(store, 'list').mockImplementationOnce(async (u) => {
      lose(8);
      return list(u);
    });
    const err = await capture(token, 'call mum').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaptureBusyError);
    expect(anthropic.calls).toHaveLength(0);
    anthropic.next = { ok: true, fields: fields() };
    const again = await capture(token, 'call mum');
    expect(again).toMatchObject({ raw: false, duplicate: false });
    vi.restoreAllMocks();
  });

  it('a failed settings read after the count forgets the line, so the retry is new', async () => {
    const { b, mint, capture } = setup();
    const token = await mint();
    const spy = vi
      .spyOn(b as unknown as { ensureSettings: () => Promise<unknown> }, 'ensureSettings')
      .mockRejectedValueOnce(new Error('ddb'));
    await expect(capture(token, 'milk | ~5')).rejects.toThrow('ddb');
    spy.mockRestore();
    expect(await capture(token, 'milk | ~5')).toMatchObject({ duplicate: false });
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
