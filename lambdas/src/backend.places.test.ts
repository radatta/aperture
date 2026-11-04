import { describe, expect, it } from 'vitest';
import { USER_TIME_ZONE, zonedEpoch } from '@aperture/shared';
import { InMemoryDoc } from './ddb/DocClient';
import type { Item } from './ddb/DocClient';
import { Repo } from './ddb/repo';
import { liveWrites } from './ddb/writes';
import type { Writes } from './ddb/writes';
import { PlaceTokenStore } from './ddb/placeTokens';
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
  const writes: Writes = {
    put: (item) => (log.push({ kind: 'put', pk: item.PK, sk: item.SK }), live.put(item)),
    putIf: (item, e) => (
      log.push({ kind: 'putIf', pk: item.PK, sk: item.SK }),
      live.putIf(item, e)
    ),
    delete: (p, s) => (log.push({ kind: 'delete', pk: p, sk: s }), live.delete(p, s)),
    batchPut: (items) => (
      items.forEach((i: Item) => log.push({ kind: 'batchPut', pk: i.PK, sk: i.SK })),
      live.batchPut(items)
    ),
  };
  return { writes, log };
}

function env(doc = new InMemoryDoc()) {
  const { writes, log } = countingWrites(doc);
  const tokens = new PlaceTokenStore(doc, writes);
  const make = (userId: string, now = () => NOW) =>
    new BackendClient(new Repo(doc, writes, userId), { userId, now, placeTokens: tokens });
  return { doc, log, tokens, make };
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

  it('rotation writes new lookup → pointer → deletes the old; the old token stops resolving', async () => {
    const { doc, log, tokens, make } = env();
    const b = make('u1');
    const first = (await b.rotatePlaceToken()).token;
    log.length = 0;
    const second = (await b.rotatePlaceToken()).token;
    const [h1, h2] = [hashPlaceToken(first), hashPlaceToken(second)];
    expect(log).toEqual([
      { kind: 'putIf', pk: placeTokenPk(h2), sk: PLACE_TOKEN_SK },
      { kind: 'put', pk: pk('u1'), sk: sk.ptoken() },
      { kind: 'delete', pk: placeTokenPk(h1), sk: PLACE_TOKEN_SK },
    ]);
    expect(tokenRows(doc).map((r) => r.PK)).toEqual([placeTokenPk(h2)]);
    await expect(resolvePlaceRead(tokens, `Bearer ${first}`, NOW)).rejects.toThrow(/^Unauthorized/);
    await expect(resolvePlaceRead(tokens, `Bearer ${second}`, NOW)).resolves.toMatchObject({
      userId: 'u1',
    });
  });

  it('revoke deletes both rows (lookup first) and reads inactive after', async () => {
    const { doc, log, tokens, make } = env();
    const b = make('u1');
    const { token } = await b.rotatePlaceToken();
    log.length = 0;
    await b.revokePlaceToken();
    expect(log.map((w) => [w.kind, w.sk])).toEqual([
      ['delete', PLACE_TOKEN_SK],
      ['delete', sk.ptoken()],
    ]);
    expect(tokenRows(doc)).toEqual([]);
    expect(pointer(doc, 'u1')).toBeUndefined();
    expect((await b.getPlaceTokenStatus()).active).toBe(false);
    await expect(resolvePlaceRead(tokens, `Bearer ${token}`, NOW)).rejects.toThrow(/^Unauthorized/);
    await b.revokePlaceToken(); // idempotent
  });

  it('a pointer whose lookup row is gone (a revoke cut short) reads inactive', async () => {
    const { doc, make } = env();
    const b = make('u1');
    const { token } = await b.rotatePlaceToken();
    await doc.delete(placeTokenPk(hashPlaceToken(token)), PLACE_TOKEN_SK);
    expect((await b.getPlaceTokenStatus()).active).toBe(false);
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

  it('a slug change rewrites only that place’s tasks; delete moves them, done ones included', async () => {
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
    expect((await b.getTask(a.id))!.place).toBeNull();
    await expect(b.deletePlace(sw.id, null)).rejects.toThrow('Not found');
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
