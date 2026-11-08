import { beforeEach, describe, expect, it } from 'vitest';
import { ConditionFailedError, InMemoryDoc } from './DocClient';
import type { Item } from './DocClient';

const item = (over: Partial<Item> & Pick<Item, 'PK' | 'SK'>): Item => ({ ...over });

describe('InMemoryDoc', () => {
  let db: InMemoryDoc;
  beforeEach(() => {
    db = new InMemoryDoc();
  });

  it('round-trips a put/get and clones (no aliasing into the store)', async () => {
    const it0 = item({ PK: 'u#1', SK: 'task#a', title: 'x' });
    await db.put(it0);
    const got = await db.get('u#1', 'task#a');
    expect(got?.title).toBe('x');
    got!.title = 'mutated';
    expect((await db.get('u#1', 'task#a'))?.title).toBe('x'); // store unaffected
  });

  it('deleteIf deletes only the version read: a write since, or a missing row, wins', async () => {
    await db.put(item({ PK: 'u#1', SK: 'pushsub#a', updatedAt: 5 }));
    await expect(db.deleteIf('u#1', 'pushsub#a', 4)).rejects.toBeInstanceOf(ConditionFailedError);
    expect(await db.get('u#1', 'pushsub#a')).not.toBeNull();
    db.interceptNextDeleteIf('u#1', 'pushsub#a', () =>
      db.putNow(item({ PK: 'u#1', SK: 'pushsub#a', updatedAt: 6 })),
    );
    await expect(db.deleteIf('u#1', 'pushsub#a', 5)).rejects.toBeInstanceOf(ConditionFailedError);
    expect((await db.get('u#1', 'pushsub#a'))?.updatedAt).toBe(6);
    await db.deleteIf('u#1', 'pushsub#a', 6);
    expect(await db.get('u#1', 'pushsub#a')).toBeNull();
    await expect(db.deleteIf('u#1', 'pushsub#a', 6)).rejects.toBeInstanceOf(ConditionFailedError);
    // No version to match (a row without updatedAt, or none passed): never a delete.
    await db.put(item({ PK: 'u#1', SK: 'pushsub#b' }));
    await expect(
      db.deleteIf('u#1', 'pushsub#b', undefined as unknown as number),
    ).rejects.toBeInstanceOf(ConditionFailedError);
    expect(await db.get('u#1', 'pushsub#b')).not.toBeNull();
  });

  it('get misses return null', async () => {
    expect(await db.get('u#1', 'nope')).toBeNull();
  });

  it('query is begins_with within the partition, ascending by SK', async () => {
    await db.put(item({ PK: 'u#1', SK: 'plan#2026-08-04#000010#b' }));
    await db.put(item({ PK: 'u#1', SK: 'plan#2026-08-04#000002#a' }));
    await db.put(item({ PK: 'u#1', SK: 'task#zzz' })); // different prefix
    await db.put(item({ PK: 'u#2', SK: 'plan#2026-08-04#000001#other' })); // different user

    const plans = await db.query('u#1', 'plan#2026-08-04#');
    expect(plans.map((p) => p.SK)).toEqual([
      'plan#2026-08-04#000002#a',
      'plan#2026-08-04#000010#b',
    ]);
  });

  it('query with from/to reads one sort-key range inside the prefix, ascending, and logs the bounds', async () => {
    for (const day of ['2026-08-01', '2026-08-03', '2026-08-04', '2026-08-05'])
      await db.put(item({ PK: 'u#1', SK: `plan#${day}#000000#x` }));
    await db.put(item({ PK: 'u#1', SK: 'plan#2026-08-04#000001#y' }));
    await db.put(item({ PK: 'u#1', SK: 'task#a' })); // another prefix never matches a plan range
    const from = 'plan#2026-08-04#';
    expect((await db.query('u#1', 'plan#', { from })).map((p) => p.SK)).toEqual([
      'plan#2026-08-04#000000#x',
      'plan#2026-08-04#000001#y',
      'plan#2026-08-05#000000#x',
    ]);
    expect(
      (
        await db.query('u#1', 'plan#', { from: 'plan#2026-08-03#', to: 'plan#2026-08-04#\uffff' })
      ).map((p) => p.SK),
    ).toEqual(['plan#2026-08-03#000000#x', 'plan#2026-08-04#000000#x', 'plan#2026-08-04#000001#y']);
    expect(db.queries.at(-2)).toEqual({ prefix: 'plan#', from, to: undefined, consistent: false });
    // A lag inside the range is still a lag; a row outside it never shows, lag or not.
    db.staleNextQueries('u#1', 'plan#2026-08-05#000000#x', null, 1);
    expect((await db.query('u#1', 'plan#', { from })).map((p) => p.SK)).toEqual([
      'plan#2026-08-04#000000#x',
      'plan#2026-08-04#000001#y',
    ]);
    expect((await db.query('u#1', 'plan#', { from, consistent: true })).length).toBe(3);
  });

  it('queryIndex ranges over GSI1SK ascending and respects from/to', async () => {
    await db.put(item({ PK: 'u#1', SK: 'task#a', GSI1PK: 'u#1#done', GSI1SK: 300 }));
    await db.put(item({ PK: 'u#1', SK: 'task#b', GSI1PK: 'u#1#done', GSI1SK: 100 }));
    await db.put(item({ PK: 'u#1', SK: 'task#c', GSI1PK: 'u#1#done', GSI1SK: 200 }));
    await db.put(item({ PK: 'u#1', SK: 'task#d' })); // not on the index

    const all = await db.queryIndex('u#1#done');
    expect(all.map((t) => t.SK)).toEqual(['task#b', 'task#c', 'task#a']); // 100,200,300

    const windowed = await db.queryIndex('u#1#done', { from: 150, to: 250 });
    expect(windowed.map((t) => t.SK)).toEqual(['task#c']);
  });

  it('delete removes a single item', async () => {
    await db.put(item({ PK: 'u#1', SK: 'task#a' }));
    await db.delete('u#1', 'task#a');
    expect(await db.get('u#1', 'task#a')).toBeNull();
  });

  it('batchPut writes all', async () => {
    await db.batchPut([item({ PK: 'u#1', SK: 'cat#a' }), item({ PK: 'u#1', SK: 'cat#b' })]);
    expect((await db.query('u#1', 'cat#')).length).toBe(2);
  });

  describe('putIf', () => {
    it('null expects no row — a tombstone counts as a row', async () => {
      await db.putIf(item({ PK: 'u#1', SK: 'fin#txn#a', updatedAt: 1 }), null);
      await expect(
        db.putIf(item({ PK: 'u#1', SK: 'fin#txn#a', updatedAt: 2 }), null),
      ).rejects.toThrow(ConditionFailedError);
      await db.put(item({ PK: 'u#1', SK: 'fin#txn#b', updatedAt: 1, deletedAt: 5 }));
      await expect(db.putIf(item({ PK: 'u#1', SK: 'fin#txn#b' }), null)).rejects.toThrow(
        ConditionFailedError,
      );
    });

    it('writes only when the stored updatedAt still matches', async () => {
      await db.put(item({ PK: 'u#1', SK: 'fin#txn#a', updatedAt: 10, v: 'old' }));
      await expect(
        db.putIf(item({ PK: 'u#1', SK: 'fin#txn#a', updatedAt: 12, v: 'stale' }), 9),
      ).rejects.toThrow(ConditionFailedError);
      expect((await db.get('u#1', 'fin#txn#a'))?.v).toBe('old');
      await db.putIf(item({ PK: 'u#1', SK: 'fin#txn#a', updatedAt: 11, v: 'new' }), 10);
      expect((await db.get('u#1', 'fin#txn#a'))?.v).toBe('new');
    });

    it('an intercept lands a concurrent write between the read and the write, once', async () => {
      await db.put(item({ PK: 'u#1', SK: 'fin#txn#a', updatedAt: 10 }));
      db.interceptNextPutIf('u#1', 'fin#txn#a', () =>
        db.putNow(item({ PK: 'u#1', SK: 'fin#txn#a', updatedAt: 11, v: 'theirs' })),
      );
      await expect(
        db.putIf(item({ PK: 'u#1', SK: 'fin#txn#a', updatedAt: 11, v: 'mine' }), 10),
      ).rejects.toThrow(ConditionFailedError);
      await db.putIf(item({ PK: 'u#1', SK: 'fin#txn#a', updatedAt: 12, v: 'mine' }), 11);
      expect((await db.get('u#1', 'fin#txn#a'))?.v).toBe('mine');
    });
  });

  it('staleNextGets serves an old version to non-consistent reads only, then expires', async () => {
    await db.put(item({ PK: 'u#1', SK: 'fin#sync#a', v: 'new' }));
    db.staleNextGets('u#1', 'fin#sync#a', item({ PK: 'u#1', SK: 'fin#sync#a', v: 'old' }), 1);
    expect((await db.get('u#1', 'fin#sync#a', { consistent: true }))?.v).toBe('new');
    expect((await db.get('u#1', 'fin#sync#a'))?.v).toBe('old');
    expect((await db.get('u#1', 'fin#sync#a'))?.v).toBe('new');
    expect(db.gets.map((g) => g.consistent)).toEqual([true, false, false]);
  });

  it('staleNextQueries serves an old version (or hides the row) to non-consistent queries only', async () => {
    await db.put(item({ PK: 'u#1', SK: 'task#a', v: 'new' }));
    await db.put(item({ PK: 'u#1', SK: 'task#b', v: 'new' }));
    db.staleNextQueries('u#1', 'task#a', item({ PK: 'u#1', SK: 'task#a', v: 'old' }), 1);
    db.staleNextQueries('u#1', 'task#b', null, 1);
    const read = async (consistent?: boolean) =>
      (await db.query('u#1', 'task#', { consistent })).map((i) => `${i.SK}:${i.v}`);
    expect(await read(true)).toEqual(['task#a:new', 'task#b:new']);
    expect(await read()).toEqual(['task#a:old']);
    expect(await read()).toEqual(['task#a:new', 'task#b:new']);
  });

  it('an intercept with `when` waits for the matching write', async () => {
    await db.put(item({ PK: 'u#1', SK: 'k', updatedAt: 1 }));
    let fired = 0;
    db.interceptNextPutIf(
      'u#1',
      'k',
      () => void fired++,
      (it) => it.v === 'target',
    );
    await db.putIf(item({ PK: 'u#1', SK: 'k', updatedAt: 2, v: 'other' }), 1);
    expect(fired).toBe(0);
    await db.putIf(item({ PK: 'u#1', SK: 'k', updatedAt: 3, v: 'target' }), 2);
    expect(fired).toBe(1);
  });
});
