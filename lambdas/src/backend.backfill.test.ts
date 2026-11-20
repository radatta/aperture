import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dayKeyInZone, USER_TIME_ZONE, zonedEpoch } from '@aperture/shared';
import { InMemoryDoc } from './ddb/DocClient';
import type { Item } from './ddb/DocClient';
import { Repo } from './ddb/repo';
import { liveWrites } from './ddb/writes';
import type { Writes } from './ddb/writes';
import { sk } from './ddb/keys';
import { BackendClient } from './backend';

// The Lambda's half of the backfill (docs/areas/calibration/dev-lane.md) — what the contract suite can't
// reach: the process in UTC, two users in one table, a raw row from before the field, and a batch write
// that dies part-way.

let savedTz: string | undefined;
beforeAll(() => {
  savedTz = process.env.TZ;
  process.env.TZ = 'UTC';
});
afterAll(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

const NOW = zonedEpoch('2026-11-19', '21:30', USER_TIME_ZONE); // 05:30 UTC on the 20th
const ALL = { from: '2000-01-01', to: '2100-01-01' };

// A batch put that writes only its first item, then throws, the first `failures` times.
function flakyWrites(doc: InMemoryDoc, failures = 1): Writes {
  const live = liveWrites(doc);
  let left = failures;
  return {
    ...live,
    batchPut: async (items: Item[]) => {
      if (left-- <= 0) return live.batchPut(items);
      await live.batchPut(items.slice(0, 1));
      throw new Error('batchPut: 1 items unprocessed after retries');
    },
  };
}

const make = (doc: InMemoryDoc, userId = 'local', writes: Writes = liveWrites(doc)) =>
  new BackendClient(new Repo(doc, writes, userId), { userId, now: () => NOW });

describe('backfillTasks on the Lambda', () => {
  it('reads today and the day in the user’s zone, not UTC', async () => {
    const b = make(new InMemoryDoc());
    const t = await b.createTask({ title: 'shipped', estimateMin: 30 });
    // The 19th is still today for the user (21:30 PST) though UTC is on the 20th; the 20th is refused.
    await expect(
      b.backfillTasks([{ id: t.id, actualMin: 40, completedDay: '2026-11-20' }]),
    ).rejects.toThrow(/after today \(2026-11-19\)/);
    const [r] = await b.backfillTasks([{ id: t.id, actualMin: 40, completedDay: '2026-11-19' }]);
    expect(dayKeyInZone(r!.task.completedAt!, USER_TIME_ZONE, 4)).toBe('2026-11-19');
    expect((await b.getCalibration(ALL))[0]).toMatchObject({ day: '2026-11-19', backfilled: true });
  });

  it('another user’s task reads as not found, and nothing of theirs moves', async () => {
    const doc = new InMemoryDoc();
    const mine = make(doc, 'u1');
    const theirs = make(doc, 'u2');
    const t = await theirs.createTask({ title: 'theirs', estimateMin: 30 });
    await expect(
      mine.backfillTasks([{ id: t.id, actualMin: 40, completedDay: '2026-11-10' }]),
    ).rejects.toThrow(/not found/);
    await expect(mine.setTaskBackfilled(t.id, true)).rejects.toThrow();
    expect((await theirs.getTask(t.id))?.status).toBe('backlog');
  });

  it('a stored row from before the field reads as scored', async () => {
    const doc = new InMemoryDoc();
    const b = make(doc);
    const t = await b.createTask({ title: 'old', estimateMin: 30 });
    await b.transitionTask(t.id, 'in_progress');
    await b.setTaskActual(t.id, 40);
    await b.transitionTask(t.id, 'done');
    const row = doc.snapshot().find((i) => i.SK === sk.task(t.id))!;
    expect('backfilled' in row).toBe(false);
    expect((await b.getCalibration(ALL))[0]).toMatchObject({ backfilled: false, area: 'personal' });
  });

  it('a batch put that dies part-way leaves what landed done; a rerun skips it and finishes the rest', async () => {
    const doc = new InMemoryDoc();
    const flaky = make(doc, 'local', flakyWrites(doc));
    const a = await make(doc).createTask({ title: 'a', estimateMin: 30 });
    const c = await make(doc).createTask({ title: 'c', estimateMin: 30 });
    const batch = [
      { id: a.id, actualMin: 40, completedDay: '2026-11-10' },
      { id: c.id, actualMin: 50, completedDay: '2026-11-11' },
    ];
    await expect(flaky.backfillTasks(batch)).rejects.toThrow(/unprocessed/);
    expect((await flaky.getTask(a.id))?.backfilled).toBe(true);
    expect((await flaky.getTask(c.id))?.status).toBe('backlog');
    const again = await flaky.backfillTasks(batch);
    expect(again.map((r) => [r.id, r.outcome])).toEqual([
      [a.id, 'skipped'],
      [c.id, 'done'],
    ]);
    expect((await flaky.getCalibration(ALL)).map((p) => [p.taskId, p.backfilled])).toEqual([
      [a.id, true],
      [c.id, true],
    ]);
  });
});
