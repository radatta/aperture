import { describe, expect, it } from 'vitest';
import { ulid, type RecordFluxSetInput } from '@aperture/shared';
import { BackendClient } from '../backend';
import { InMemoryDoc, type Item, type QueryOpts } from './DocClient';
import { sk } from './keys';
import { toEntity } from './mapping';
import { Repo } from './repo';
import { expiresAtOf, liveWrites } from './writes';

const T = 1_700_000_000_500; // ms: TTL wants whole seconds
const row = (SK: string, deletedAt: number | null): Item => ({
  PK: 'u#a',
  SK,
  deletedAt,
  updatedAt: T,
});

describe('expiresAtOf', () => {
  it('a tombstone expires at once, in epoch seconds', () => {
    for (const SK of [
      'task#1',
      'plan#2026-08-04#000001#1',
      'place#1',
      'attach#t#1',
      'series#1',
      'hcheck#d#h',
      'cat#1',
    ])
      expect(expiresAtOf(row(SK, T)), SK).toBe(1_700_000_000);
  });
  it('a flux tombstone stays a week, for an outbox retry', () =>
    expect(expiresAtOf(row('flux#2026-08-04#1', T))).toBe(1_700_000_000 + 7 * 86_400));
  it('a finance tombstone never expires', () => {
    for (const SK of [
      'fin#item#1',
      'fin#sync#1',
      'fin#acct#1',
      'fin#rule#1',
      'fin#txn#2026-08-04#1',
    ])
      expect(expiresAtOf(row(SK, T)), SK).toBeNull();
  });
  it("a removed push device's tombstone never expires: it keeps the device removed", () =>
    expect(expiresAtOf(row('pushsub#ab12', T))).toBeNull());
  it('a live row, or one with no deletedAt, never expires', () => {
    expect(expiresAtOf(row('task#1', null))).toBeNull();
    expect(expiresAtOf({ PK: 'u#a', SK: 'settings' })).toBeNull();
  });
});

describe('liveWrites stamps by stage', () => {
  const dead = row('task#1', T);
  const raw = (doc: InMemoryDoc, SK = 'task#1') => doc.get('u#a', SK);

  it.each(['dev', 'devb'])('%s stamps put, putIf and batchPut', async (stage) => {
    const doc = new InMemoryDoc();
    const writes = liveWrites(doc, stage);
    await writes.put(dead);
    await writes.putIf(row('task#2', T), null);
    await writes.batchPut([row('task#3', T), row('task#4', null)]);
    for (const SK of ['task#1', 'task#2', 'task#3'])
      expect((await raw(doc, SK))?.expiresAt, SK).toBe(1_700_000_000);
    expect(await raw(doc, 'task#4')).not.toHaveProperty('expiresAt');
  });
  it('prod writes the item unchanged, as does a Lambda with no stage', async () => {
    const before = process.env.STAGE;
    delete process.env.STAGE;
    try {
      for (const stage of ['prod', undefined]) {
        const doc = new InMemoryDoc();
        const writes = liveWrites(doc, stage);
        await writes.put(dead);
        await writes.putIf(row('task#2', T), null);
        await writes.batchPut([row('task#3', T)]);
        for (const SK of ['task#1', 'task#2', 'task#3'])
          expect(await raw(doc, SK), `${stage} ${SK}`).not.toHaveProperty('expiresAt');
      }
    } finally {
      if (before !== undefined) process.env.STAGE = before;
    }
  });
  it('reads the stage from the Lambda’s STAGE', async () => {
    const before = process.env.STAGE;
    process.env.STAGE = 'dev';
    try {
      const doc = new InMemoryDoc();
      await liveWrites(doc).put(dead);
      expect((await raw(doc))?.expiresAt).toBe(1_700_000_000);
    } finally {
      if (before === undefined) delete process.env.STAGE;
      else process.env.STAGE = before;
    }
  });
});

describe('expiresAt stays off entities', () => {
  it('toEntity strips it', () =>
    expect(toEntity({ ...row('task#1', T), expiresAt: 1 })).not.toHaveProperty('expiresAt'));
});

describe('dev tombstones through the backend', () => {
  const setup = () => {
    const doc = new InMemoryDoc();
    const backend = new BackendClient(new Repo(doc, liveWrites(doc, 'dev'), 'local'), {
      userId: 'local',
      now: () => T,
    });
    return { doc, backend };
  };
  const plan = (taskId: string) => ({ taskId, day: '2026-08-04', plannedMinutes: 30, order: 1 });

  it('a deleted task and its plan are stamped; a live neighbour isn’t', async () => {
    const { doc, backend } = setup();
    const task = await backend.createTask({ title: 'doomed' });
    const p = await backend.upsertPlan(plan(task.id));
    const other = await backend.createTask({ title: 'neighbour' });
    await backend.deleteTask(task.id);
    expect((await doc.get('u#local', sk.task(task.id)))?.expiresAt).toBe(1_700_000_000);
    expect((await doc.get('u#local', sk.plan(p.day, p.order, p.id)))?.expiresAt).toBe(
      1_700_000_000,
    );
    expect(await doc.get('u#local', sk.task(other.id))).not.toHaveProperty('expiresAt');
  });

  it('a re-check over a stamped tombstone is not due', async () => {
    const { doc, backend } = setup();
    const DAY = '2026-08-04';
    const h = await backend.upsertHabit({ name: 'run', categoryId: null, cadencePerWeek: 3 });
    await backend.checkHabit(h.id, DAY);
    await backend.uncheckHabit(h.id, DAY);
    expect((await doc.get('u#local', sk.hcheck(DAY, h.id)))?.expiresAt).toBe(1_700_000_000);
    await backend.checkHabit(h.id, DAY);
    expect(await doc.get('u#local', sk.hcheck(DAY, h.id))).not.toHaveProperty('expiresAt');
  });

  it('a reorder of a plan whose tombstone has expired answers Not found', async () => {
    const { doc, backend } = setup();
    const task = await backend.createTask({ title: 'reordered' });
    const p = await backend.upsertPlan(plan(task.id));
    await backend.removePlan(p.id);
    // While the tombstone stands the stale write lands on it, and the row stays dead.
    const stale = await backend.upsertPlan({ ...plan(task.id), id: p.id, order: 2 });
    expect(stale.deletedAt).not.toBeNull();
    expect(await backend.listPlansForDay(p.day)).toEqual([]);
    await doc.delete('u#local', sk.plan(stale.day, stale.order, stale.id)); // what TTL does
    await expect(backend.upsertPlan({ ...plan(task.id), id: p.id, order: 3 })).rejects.toThrow(
      `Not found: ${p.id}`,
    );
  });

  it('a retried flux set finds its tombstone inside the week, with no expiresAt on the answer', async () => {
    const { doc, backend } = setup();
    const input: RecordFluxSetInput = {
      id: ulid(),
      day: '2026-10-20',
      exerciseId: 'chin-tuck',
      kind: 'holdAtTarget',
      side: null,
      condition: null,
      count: 6,
      avgPeakDeg: null,
      avgErrorDeg: null,
      rom: { pitch: 9, yaw: 2, roll: 2 },
      calibrated: true,
      delegate: 'CPU',
      durationSec: 150,
      completedAt: T,
      repTaskId: null,
      stoppedEarly: false,
      planned: 6,
    };
    const set = await backend.recordFluxSet(input);
    await backend.deleteFluxSet(set.id);
    expect((await doc.get('u#local', sk.flux(set.day, set.id)))?.expiresAt).toBe(
      1_700_000_000 + 7 * 86_400,
    );
    const retry = await backend.recordFluxSet(input);
    expect(retry.deletedAt).toBe(T);
    expect(retry).not.toHaveProperty('expiresAt');
    expect(await backend.listFluxSets({})).toEqual([]);
  });
});

describe('deleteTask reads each list once', () => {
  class CountingDoc extends InMemoryDoc {
    reads: { prefix: string; consistent: boolean }[] = [];
    override query(pk: string, skPrefix: string, opts?: QueryOpts) {
      this.reads.push({ prefix: skPrefix, consistent: opts?.consistent === true });
      return super.query(pk, skPrefix, opts);
    }
  }
  const setup = () => {
    const doc = new CountingDoc();
    const backend = new BackendClient(new Repo(doc, liveWrites(doc), 'local'), {
      userId: 'local',
      now: () => T,
    });
    return { doc, backend };
  };
  const whole = (doc: CountingDoc, prefix: string) => doc.reads.filter((r) => r.prefix === prefix);

  it('a leaf task: one task list, one plan list, both consistent', async () => {
    const { doc, backend } = setup();
    const task = await backend.createTask({ title: 'leaf' });
    doc.reads = [];
    await backend.deleteTask(task.id);
    expect(whole(doc, sk.taskPrefix())).toEqual([{ prefix: sk.taskPrefix(), consistent: true }]);
    expect(whole(doc, sk.planAllPrefix())).toEqual([
      { prefix: sk.planAllPrefix(), consistent: true },
    ]);
  });

  it('a parent with parts: still one of each, and every part and plan goes', async () => {
    const { doc, backend } = setup();
    const parent = await backend.createTask({ title: 'parent' });
    const parts = [
      await backend.createTask({ title: 'one', parentId: parent.id }),
      await backend.createTask({ title: 'two', parentId: parent.id }),
    ];
    const plan = await backend.upsertPlan({
      taskId: parts[0]!.id,
      day: '2026-08-04',
      plannedMinutes: 30,
      order: 1,
    });
    doc.reads = [];
    await backend.deleteTask(parent.id);
    expect(whole(doc, sk.taskPrefix())).toEqual([{ prefix: sk.taskPrefix(), consistent: true }]);
    expect(whole(doc, sk.planAllPrefix())).toEqual([
      { prefix: sk.planAllPrefix(), consistent: true },
    ]);
    for (const t of [parent, ...parts]) expect(await backend.getTask(t.id)).toBeNull();
    expect((await doc.get('u#local', sk.plan(plan.day, plan.order, plan.id)))?.deletedAt).toBe(T);
  });
});
