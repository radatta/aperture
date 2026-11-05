import { describe, expect, it, vi } from 'vitest';
import {
  PLACE_FINISHED_ERROR,
  PLACE_TOKEN_RACE_ERROR,
  USER_TIME_ZONE,
  zonedEpoch,
} from '@aperture/shared';
import { InMemoryDoc } from './ddb/DocClient';
import type { Item } from './ddb/DocClient';
import { Repo } from './ddb/repo';
import { liveWrites } from './ddb/writes';
import type { Writes } from './ddb/writes';
import { PlaceTokenPointerError, PlaceTokenStore } from './ddb/placeTokens';
import { pk, PLACE_TOKEN_SK, placeTokenPk, sk } from './ddb/keys';
import { BackendClient } from './backend';
import { handleRpc } from './handler';
import { FakeAnthropic } from './anthropic/gateway';
import { hashPlaceToken, resolvePlaceRead } from './auth/placeToken';

// The Lambda's half of places (plan §6): the token is stored only as its hash, rotates and revokes
// cleanly, and the Shortcut read is scoped by the lookup row's userId and writes exactly twice.

const NOW = zonedEpoch('2026-11-03', '10:00', USER_TIME_ZONE);

// Every write, by kind — wrapping the live writes so the table still changes.
function countingWrites(doc: InMemoryDoc) {
  const live = liveWrites(doc);
  const log: { kind: keyof Writes; pk: string; sk: string }[] = [];
  // Test-only: a delete of one of these PKs fails once (a crash/throttle cutting a rotate short).
  const failDeleteOnce = new Set<string>();
  const writes: Writes = {
    put: (item) => (log.push({ kind: 'put', pk: item.PK, sk: item.SK }), live.put(item)),
    putIf: (item, e) => (
      log.push({ kind: 'putIf', pk: item.PK, sk: item.SK }),
      live.putIf(item, e)
    ),
    delete: (p, s) => {
      log.push({ kind: 'delete', pk: p, sk: s });
      if (failDeleteOnce.delete(p))
        return Promise.reject(new Error('ProvisionedThroughputExceeded'));
      return live.delete(p, s);
    },
    batchPut: (items) => (
      items.forEach((i: Item) => log.push({ kind: 'batchPut', pk: i.PK, sk: i.SK })),
      live.batchPut(items)
    ),
  };
  return { writes, log, failDeleteOnce };
}

function env(doc = new InMemoryDoc()) {
  const { writes, log, failDeleteOnce } = countingWrites(doc);
  const tokens = new PlaceTokenStore(doc, writes);
  const make = (userId: string, now = () => NOW) =>
    new BackendClient(new Repo(doc, writes, userId), { userId, now, placeTokens: tokens });
  return { doc, log, tokens, make, failDeleteOnce };
}
const tokenRows = (doc: InMemoryDoc) => doc.snapshot().filter((i) => i.SK === PLACE_TOKEN_SK);
const pointer = (doc: InMemoryDoc, userId: string) =>
  doc.snapshot().find((i) => i.PK === pk(userId) && i.SK === sk.ptoken());

describe('place token storage', () => {
  it('stores the token only as its sha256: a lookup row naming the user, and a pointer', async () => {
    const { doc, make } = env();
    const b = make('u1');
    const { token, status } = await b.rotatePlaceToken();
    const hash = hashPlaceToken(token);
    expect(JSON.stringify(doc.snapshot())).not.toContain(token);
    expect(JSON.stringify(doc.snapshot())).not.toContain(token.slice(4)); // nor its random part
    expect(tokenRows(doc)).toEqual([
      expect.objectContaining({ PK: placeTokenPk(hash), userId: 'u1', readsCount: 0 }),
    ]);
    expect(pointer(doc, 'u1')).toMatchObject({ hash, hint: token.slice(-4) });
    // Status, the RPC result and the export never carry the hash.
    expect(JSON.stringify(status)).not.toContain(hash);
    expect(JSON.stringify(await b.getPlaceTokenStatus())).not.toContain(hash);
    const exported = JSON.stringify(await b.exportData());
    expect(exported).not.toContain(hash);
    expect(exported).not.toContain(token);
  });

  it('rotation writes new lookup → pointer (conditional) → deletes the old → clears retiring', async () => {
    const { doc, log, tokens, make } = env();
    const b = make('u1');
    const first = (await b.rotatePlaceToken()).token;
    log.length = 0;
    const second = (await b.rotatePlaceToken()).token;
    const [h1, h2] = [hashPlaceToken(first), hashPlaceToken(second)];
    expect(log).toEqual([
      { kind: 'putIf', pk: placeTokenPk(h2), sk: PLACE_TOKEN_SK },
      { kind: 'putIf', pk: pk('u1'), sk: sk.ptoken() },
      { kind: 'delete', pk: placeTokenPk(h1), sk: PLACE_TOKEN_SK },
      { kind: 'putIf', pk: pk('u1'), sk: sk.ptoken() },
    ]);
    expect(pointer(doc, 'u1')).toMatchObject({ hash: h2, retiring: [] });
    expect(tokenRows(doc).map((r) => r.PK)).toEqual([placeTokenPk(h2)]);
    await expect(resolvePlaceRead(tokens, `Bearer ${first}`, NOW)).rejects.toThrow(/^Unauthorized/);
    await expect(resolvePlaceRead(tokens, `Bearer ${second}`, NOW)).resolves.toMatchObject({
      userId: 'u1',
    });
  });

  it('a pointer with no numeric updatedAt is refused by name — status, rotate and revoke write nothing', async () => {
    const { doc, log, make } = env();
    const b = make('u1');
    doc.putNow({ PK: pk('u1'), SK: sk.ptoken(), hash: null, retiring: [] });
    const before = doc.snapshot();
    for (const call of [
      () => b.getPlaceTokenStatus(),
      () => b.rotatePlaceToken(),
      () => b.revokePlaceToken(),
    ])
      await expect(call()).rejects.toThrow(
        new PlaceTokenPointerError('Corrupt place-token pointer: no updatedAt'),
      );
    expect(log).toEqual([]);
    expect(doc.snapshot()).toEqual(before);
  });

  it('revoke empties the pointer (conditional), deletes the lookup row, and reads inactive after', async () => {
    const { doc, log, tokens, make } = env();
    const b = make('u1');
    const { token } = await b.rotatePlaceToken();
    log.length = 0;
    await b.revokePlaceToken();
    expect(log.map((w) => [w.kind, w.sk])).toEqual([
      ['putIf', sk.ptoken()],
      ['delete', PLACE_TOKEN_SK],
      ['putIf', sk.ptoken()],
    ]);
    expect(tokenRows(doc)).toEqual([]);
    expect(pointer(doc, 'u1')).toMatchObject({ hash: null, hint: null, retiring: [] });
    expect((await b.getPlaceTokenStatus()).active).toBe(false);
    await expect(resolvePlaceRead(tokens, `Bearer ${token}`, NOW)).rejects.toThrow(/^Unauthorized/);
    log.length = 0;
    await b.revokePlaceToken(); // idempotent: nothing left to retire, nothing written
    expect(log).toEqual([]);
    const again = await b.rotatePlaceToken(); // and a revoked user can mint again
    await expect(resolvePlaceRead(tokens, `Bearer ${again.token}`, NOW)).resolves.toMatchObject({
      userId: 'u1',
    });
  });

  it('a pointer whose lookup row is gone (a revoke cut short) reads inactive', async () => {
    const { doc, make } = env();
    const b = make('u1');
    const { token } = await b.rotatePlaceToken();
    await doc.delete(placeTokenPk(hashPlaceToken(token)), PLACE_TOKEN_SK);
    expect((await b.getPlaceTokenStatus()).active).toBe(false);
  });

  it('a delete cut short mid-rotate fails the rotate, the old token is dead at once, and the next rotate or revoke deletes its row', async () => {
    for (const next of ['rotate', 'revoke'] as const) {
      const { doc, tokens, make, failDeleteOnce } = env();
      const b = make('u1');
      const first = (await b.rotatePlaceToken()).token;
      const h1 = hashPlaceToken(first);
      failDeleteOnce.add(placeTokenPk(h1));
      await expect(b.rotatePlaceToken()).rejects.toThrow('ProvisionedThroughputExceeded');
      // The pointer moved on but still owes the old row's delete. The row survives, yet the old token is
      // already dead: the pointer no longer names it (resolvePlaceRead) — retiring is cleanup only.
      const ptr = pointer(doc, 'u1')!;
      expect(ptr.retiring).toEqual([h1]);
      const unseen = ptr.hash as string; // the cut-short rotate's token, never shown to anyone
      expect(await tokens.get(h1)).not.toBeNull();
      await expect(resolvePlaceRead(tokens, `Bearer ${first}`, NOW)).rejects.toThrow(
        'Unauthorized: place token revoked',
      );

      if (next === 'rotate') {
        const third = (await b.rotatePlaceToken()).token;
        await expect(resolvePlaceRead(tokens, `Bearer ${third}`, NOW)).resolves.toBeDefined();
        expect(tokenRows(doc).map((r) => r.PK)).toEqual([placeTokenPk(hashPlaceToken(third))]);
      } else {
        await b.revokePlaceToken();
        expect(tokenRows(doc)).toEqual([]);
        expect((await b.getPlaceTokenStatus()).active).toBe(false);
      }
      await expect(resolvePlaceRead(tokens, `Bearer ${first}`, NOW)).rejects.toThrow(
        /^Unauthorized/,
      );
      expect(await tokens.get(unseen)).toBeNull();
      expect(pointer(doc, 'u1')!.retiring).toEqual([]);
    }
  });

  it('status and export never carry a live or a retiring hash', async () => {
    const { doc, make, failDeleteOnce } = env();
    const b = make('u1');
    const first = (await b.rotatePlaceToken()).token;
    failDeleteOnce.add(placeTokenPk(hashPlaceToken(first)));
    await expect(b.rotatePlaceToken()).rejects.toThrow();
    const ptr = pointer(doc, 'u1')!;
    const hashes = [ptr.hash as string, ...(ptr.retiring as string[])];
    expect(hashes).toHaveLength(2);
    const out = JSON.stringify([await b.getPlaceTokenStatus(), await b.exportData()]);
    for (const h of hashes) expect(out).not.toContain(h);
    expect(out).not.toContain(first);
  });

  it('rotate racing a revoke: the rotate loses, deletes its own row, and no token works', async () => {
    const { doc, tokens, make } = env();
    const b = make('u1');
    const first = (await b.rotatePlaceToken()).token;
    const h1 = hashPlaceToken(first);
    const before = pointer(doc, 'u1')!;
    // Another device's revoke lands between this rotate's pointer read and its pointer write.
    doc.interceptNextPutIf(pk('u1'), sk.ptoken(), () => {
      doc.putNow({
        ...before,
        hash: null,
        createdAt: null,
        hint: null,
        retiring: [],
        updatedAt: (before.updatedAt as number) + 7,
      });
      void doc.delete(placeTokenPk(h1), PLACE_TOKEN_SK);
    });
    await expect(b.rotatePlaceToken()).rejects.toThrow(PLACE_TOKEN_RACE_ERROR);
    expect(tokenRows(doc)).toEqual([]); // the loser's new row is gone too — no orphan token
    expect(pointer(doc, 'u1')).toMatchObject({ hash: null });
    expect((await b.getPlaceTokenStatus()).active).toBe(false);
    await expect(resolvePlaceRead(tokens, `Bearer ${first}`, NOW)).rejects.toThrow(/^Unauthorized/);
  });

  it('revoke racing a rotate: the revoke loses and says so; only the winner’s token works', async () => {
    const { doc, tokens, make } = env();
    const b = make('u1');
    const first = (await b.rotatePlaceToken()).token;
    const h1 = hashPlaceToken(first);
    const before = pointer(doc, 'u1')!;
    const winnerToken = 'apl_' + 'R'.repeat(43);
    const hw = hashPlaceToken(winnerToken);
    // Another device's whole rotate lands between this revoke's pointer read and its pointer write.
    doc.interceptNextPutIf(pk('u1'), sk.ptoken(), () => {
      doc.putNow({
        PK: placeTokenPk(hw),
        SK: PLACE_TOKEN_SK,
        userId: 'u1',
        createdAt: NOW,
        updatedAt: NOW,
        lastUsedAt: null,
        readsDay: null,
        readsCount: 0,
        hint: 'RRRR',
      });
      doc.putNow({
        ...before,
        hash: hw,
        retiring: [],
        updatedAt: (before.updatedAt as number) + 3,
      });
      void doc.delete(placeTokenPk(h1), PLACE_TOKEN_SK);
    });
    await expect(b.revokePlaceToken()).rejects.toThrow(PLACE_TOKEN_RACE_ERROR);
    expect(pointer(doc, 'u1')).toMatchObject({ hash: hw, retiring: [] });
    expect(tokenRows(doc).map((r) => r.PK)).toEqual([placeTokenPk(hw)]);
    await expect(resolvePlaceRead(tokens, `Bearer ${winnerToken}`, NOW)).resolves.toBeDefined();
    await expect(resolvePlaceRead(tokens, `Bearer ${first}`, NOW)).rejects.toThrow(/^Unauthorized/);
    await b.revokePlaceToken(); // the retry wins
    expect(tokenRows(doc)).toEqual([]);
  });

  it('rotate racing a rotate: one wins, the loser deletes its own row and throws', async () => {
    const { doc, tokens, make } = env();
    const b = make('u1');
    const first = (await b.rotatePlaceToken()).token;
    const before = pointer(doc, 'u1')!;
    const winnerToken = 'apl_' + 'W'.repeat(43);
    const hw = hashPlaceToken(winnerToken);
    doc.interceptNextPutIf(
      pk('u1'),
      sk.ptoken(),
      () => {
        doc.putNow({
          PK: placeTokenPk(hw),
          SK: PLACE_TOKEN_SK,
          userId: 'u1',
          createdAt: NOW,
          updatedAt: NOW,
          lastUsedAt: null,
          readsDay: null,
          readsCount: 0,
          hint: 'WWWW',
        });
        doc.putNow({
          ...before,
          hash: hw,
          retiring: [before.hash as string],
          updatedAt: (before.updatedAt as number) + 3,
        });
      },
      (item) => item.hash !== hw,
    );
    await expect(b.rotatePlaceToken()).rejects.toThrow(PLACE_TOKEN_RACE_ERROR);
    expect(pointer(doc, 'u1')).toMatchObject({ hash: hw });
    // The loser's row is gone; the winner's works; the winner's retiring list still names the first,
    // which the next rotate/revoke deletes.
    expect(
      tokenRows(doc)
        .map((r) => r.PK)
        .sort(),
    ).toEqual([placeTokenPk(hw), placeTokenPk(hashPlaceToken(first))].sort());
    await expect(resolvePlaceRead(tokens, `Bearer ${winnerToken}`, NOW)).resolves.toBeDefined();
    await b.revokePlaceToken();
    expect(tokenRows(doc)).toEqual([]);
  });

  it('a smoke (testMode) rotate through handleRpc mints a token but stores nothing', async () => {
    const doc = new InMemoryDoc();
    const out = (await handleRpc(doc, {
      userId: 'smoke-test',
      method: 'rotatePlaceToken',
      args: [],
      testMode: true,
    })) as { token: string };
    expect(out.token).toMatch(/^apl_/);
    expect(doc.size).toBe(0);
  });
});

describe('the Shortcut read (readPlaceForShortcut)', () => {
  async function seeded() {
    const e = env();
    const b = e.make('u1');
    await b.upsertPlace({ name: 'Safeway' });
    await b.createTask({ title: 'shampoo', place: 'safeway' });
    const { token } = await b.rotatePlaceToken();
    const auth = await resolvePlaceRead(e.tokens, `Bearer ${token}`, NOW);
    e.log.length = 0;
    return { ...e, b, token, auth };
  }

  it('performs exactly two writes on success: the token count, then the place heartbeat', async () => {
    const { b, auth, log, tokens } = await seeded();
    const digest = await b.readPlaceForShortcut('safeway', auth);
    expect(digest).toMatchObject({ count: 1, titles: ['shampoo'] });
    expect(log).toEqual([
      { kind: 'putIf', pk: placeTokenPk(auth.hash), sk: PLACE_TOKEN_SK },
      { kind: 'putIf', pk: pk('u1'), sk: expect.stringMatching(/^place#/) },
    ]);
    expect((await tokens.get(auth.hash))!.readsCount).toBe(1);
    expect((await b.listPlaces())[0]!.lastReadAt).toBe(NOW);
  });

  it('an unknown slug writes nothing', async () => {
    const { b, auth, log } = await seeded();
    await expect(b.readPlaceForShortcut('target', auth)).rejects.toThrow('No place "target"');
    expect(log).toEqual([]);
  });

  it("the lookup row's userId is the only partition read: two users, one token", async () => {
    const { b, make, tokens, auth } = await seeded();
    const other = make('u2');
    await other.upsertPlace({ name: 'Safeway' });
    await other.createTask({ title: "u2's secret errand", place: 'safeway' });
    expect(auth.userId).toBe('u1');
    // The edge builds the backend for auth.userId — u1's list, never u2's.
    const digest = await make(auth.userId).readPlaceForShortcut('safeway', auth);
    expect(digest.titles).toEqual(['shampoo']);
    // A backend for any other user refuses the token outright.
    await expect(other.readPlaceForShortcut('safeway', auth)).rejects.toThrow(/^Unauthorized/);
    expect((await tokens.get(auth.hash))!.readsCount).toBe(1);
    expect((await b.listPlaces())[0]!.lastReadAt).toBe(NOW);
    expect((await other.listPlaces())[0]!.lastReadAt).toBeNull();
  });

  it('a revoke that lands mid-read fails it closed, with the place untouched', async () => {
    const { b, auth, doc, log } = await seeded();
    await doc.delete(placeTokenPk(auth.hash), PLACE_TOKEN_SK);
    log.length = 0;
    await expect(b.readPlaceForShortcut('safeway', auth)).rejects.toThrow(/^Unauthorized/);
    expect(tokenRows(doc)).toEqual([]); // not written back to life
    expect(log.filter((w) => w.sk.startsWith('place#'))).toEqual([]);
  });

  it('the heartbeat never flattens a rename that landed during the read', async () => {
    const { b, auth, doc } = await seeded();
    const [place] = await b.listPlaces();
    const key = sk.place(place!.id);
    doc.interceptNextPutIf(pk('u1'), key, () =>
      doc.putNow({
        PK: pk('u1'),
        SK: key,
        ...place!,
        name: 'Safeway Main St',
        updatedAt: place!.updatedAt + 5,
      }),
    );
    await b.readPlaceForShortcut('safeway', auth);
    expect((await b.listPlaces())[0]).toMatchObject({ name: 'Safeway Main St', lastReadAt: NOW });
  });

  it('a failed heartbeat after the count still returns the digest, logging only the error name', async () => {
    const { b, auth, tokens } = await seeded();
    const boom = Object.assign(new Error('secret detail apl_x'), { name: 'ThrottlingException' });
    const touch = vi.spyOn(Repo.prototype, 'touchPlace').mockRejectedValueOnce(boom);
    const logs: string[] = [];
    const log = vi
      .spyOn(console, 'log')
      .mockImplementation((l: unknown) => void logs.push(String(l)));
    try {
      const digest = await b.readPlaceForShortcut('safeway', auth);
      expect(digest).toMatchObject({ count: 1, titles: ['shampoo'] });
      expect((await tokens.get(auth.hash))!.readsCount).toBe(1); // the read was counted
      expect(logs.map((l) => JSON.parse(l))).toEqual([
        { event: 'place_heartbeat_failed', name: 'ThrottlingException' },
      ]);
      expect(logs.join()).not.toContain('secret');
    } finally {
      touch.mockRestore();
      log.mockRestore();
    }
  });

  it('is not an RPC method — the dispatch refuses it', async () => {
    const doc = new InMemoryDoc();
    await expect(
      handleRpc(doc, { userId: 'u1', method: 'readPlaceForShortcut', args: ['safeway', {}] }),
    ).rejects.toThrow('Unknown method');
  });
});

describe('places on tasks (lambda specifics beyond the contract)', () => {
  it('refuses a non-string place or slug from the wire', async () => {
    const { make } = env();
    const b = make('u1');
    await b.upsertPlace({ name: 'Safeway' });
    await expect(b.createTask({ title: 'x', place: 7 as unknown as string })).rejects.toThrow(
      /No place/,
    );
    await expect(b.upsertPlace({ name: 'Target', slug: 123 as unknown as string })).rejects.toThrow(
      /must be a string/,
    );
    await expect(b.upsertPlace({ name: 5 as unknown as string })).rejects.toThrow(/needs a name/);
  });

  it('a slug change rewrites only that place’s tasks, done ones included; delete to none keeps done', async () => {
    const { make } = env();
    const b = make('u1');
    const sw = await b.upsertPlace({ name: 'Safeway' });
    await b.upsertPlace({ name: 'Target' });
    const a = await b.createTask({ title: 'a', place: 'safeway' });
    const t = await b.createTask({ title: 't', place: 'target' });
    await b.transitionTask(a.id, 'in_progress');
    await b.transitionTask(a.id, 'done');
    await b.upsertPlace({ id: sw.id, name: 'Safeway', slug: 'sw' });
    expect((await b.getTask(a.id))!.place).toBe('sw');
    expect((await b.getTask(t.id))!.place).toBe('target');
    await b.deletePlace(sw.id, null);
    expect((await b.getTask(a.id))!.place).toBe('sw'); // done: its place is history
    await expect(b.deletePlace(sw.id, null)).rejects.toThrow('Not found');
  });

  it('upsertPlace reads the place consistently: a stale read never reverts a slug just changed', async () => {
    const { doc, make } = env();
    const b = make('u1');
    const sw = await b.upsertPlace({ name: 'Safeway' });
    const t = await b.createTask({ title: 'a', place: 'safeway' });
    const old = doc.snapshot().find((i) => i.SK === sk.place(sw.id))!;
    await b.upsertPlace({ id: sw.id, name: 'Safeway', slug: 'sw' });
    doc.staleNextGets(pk('u1'), sk.place(sw.id), old, 5); // an eventual read would still see 'safeway'
    const renamed = await b.upsertPlace({ id: sw.id, name: 'Safeway Main St' }); // slug omitted: kept
    expect(renamed).toMatchObject({ name: 'Safeway Main St', slug: 'sw' });
    expect((await b.getTask(t.id))!.place).toBe('sw');
    const reads = doc.gets.filter((g) => g.key === `${pk('u1')} ${sk.place(sw.id)}`);
    expect(reads.every((g) => g.consistent)).toBe(true);
  });

  it('a task naming a place added a moment ago finds it (consistent slug list)', async () => {
    const { doc, make } = env();
    const b = make('u1');
    const sw = await b.upsertPlace({ name: 'Safeway' });
    doc.staleNextQueries(pk('u1'), sk.place(sw.id), null, 5); // not visible to an eventual query yet
    expect((await b.createTask({ title: 'a', place: 'safeway' })).place).toBe('safeway');
    expect((await b.createTasks([{ title: 'b', place: 'safeway' }]))[0]!.place).toBe('safeway');
  });

  it('setTaskPlace refuses a finished task, before any write', async () => {
    const { log, make } = env();
    const b = make('u1');
    await b.upsertPlace({ name: 'Safeway' });
    const t = await b.createTask({ title: 'a' });
    await b.transitionTask(t.id, 'cancelled');
    log.length = 0;
    await expect(b.setTaskPlace(t.id, 'safeway')).rejects.toThrow(PLACE_FINISHED_ERROR);
    expect(log).toEqual([]);
  });

  it('parseTask takes a known @slug before the model and returns it as input.place', async () => {
    const doc = new InMemoryDoc();
    const anthropic = new FakeAnthropic();
    const b = new BackendClient(new Repo(doc, liveWrites(doc), 'local'), {
      userId: 'local',
      now: () => NOW,
      anthropic,
    });
    await b.upsertPlace({ name: 'Safeway' });
    anthropic.next = {
      ok: true,
      fields: {
        title: 'shampoo',
        notes: null,
        categoryId: null,
        dueDay: null,
        dueTime: null,
        estimateMin: null,
      },
    };
    const out = await b.parseTask('shampoo @safeway');
    expect(out).toMatchObject({ ok: true, placeName: 'Safeway', input: { place: 'safeway' } });
    expect(anthropic.calls.map((c) => c.text)).toEqual(['shampoo']);
  });
});
