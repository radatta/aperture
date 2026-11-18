import { beforeEach, describe, expect, it } from 'vitest';
import { userDueEpoch } from '@aperture/shared';
import type { Task, TaskPlan } from '@aperture/shared';
import { InMemoryDoc } from './DocClient';
import { gsi1, sk } from './keys';
import { Repo } from './repo';
import { liveWrites, noopWrites } from './writes';

const U = 'user-1';
const task = (over: Partial<Task>): Task => ({
  id: 't1',
  userId: U,
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
  title: 'x',
  status: 'backlog',
  categoryId: null,
  dueDay: null,
  dueTime: null,
  notes: null,
  reflection: null,
  seriesId: null,
  rollId: null,
  estimateMin: null,
  bufferMin: null,
  estimateLockedMin: null,
  parentId: null,
  place: null,
  actualAccruedMin: 0,
  startedAt: null,
  completedAt: null,
  cancelledAt: null,
  gcalAccountId: null,
  gcalCalendarId: null,
  gcalEventId: null,
  gcalSyncError: null,
  ...over,
});

function repo() {
  const doc = new InMemoryDoc();
  return { doc, repo: new Repo(doc, liveWrites(doc), U) };
}

describe('Repo persistence', () => {
  let r: Repo;
  beforeEach(() => {
    ({ repo: r } = repo());
  });

  it('round-trips a task and strips key attributes from the domain object', async () => {
    await r.putTask(task({ id: 'a', title: 'hello' }));
    const got = await r.getTask('a');
    expect(got?.title).toBe('hello');
    expect(got as unknown as { PK?: string }).not.toHaveProperty('PK');
    expect(got as unknown as { SK?: string }).not.toHaveProperty('SK');
  });

  it('listSeries reads consistently: a series just put is listed while an eventual query would miss it', async () => {
    const { doc, repo: rr } = repo();
    const s = await rr.putSeries({
      id: 's1',
      userId: U,
      createdAt: 0,
      updatedAt: 0,
      deletedAt: null,
      title: 'water the plants',
      categoryId: null,
      defaultEstimateMin: null,
      rule: { kind: 'daily' },
      active: true,
      anchorDate: '2026-11-17',
    });
    doc.staleNextQueries(`u#${U}`, sk.series(s.id), null, 5); // not visible to an eventual query yet
    expect((await rr.listSeries()).map((x) => x.id)).toEqual(['s1']);
    expect(doc.queries.at(-1)).toMatchObject({ prefix: sk.seriesPrefix(), consistent: true });
  });

  it('list filters soft-deleted rows (alive semantics)', async () => {
    await r.putTask(task({ id: 'a' }));
    await r.putTask(task({ id: 'b', deletedAt: 123 }));
    const live = await r.listTasks();
    expect(live.map((t) => t.id)).toEqual(['a']);
    expect(await r.getTask('b')).toBeNull(); // tombstoned reads as absent
  });

  it('only done tasks land in the calibration window, ordered by completion', async () => {
    await r.putTask(task({ id: 'open', status: 'in_progress' }));
    await r.putTask(task({ id: 'd1', status: 'done', completedAt: 300, estimateLockedMin: 30 }));
    await r.putTask(task({ id: 'd2', status: 'done', completedAt: 100, estimateLockedMin: 30 }));

    const window = await r.doneTasksInWindow(0, 1000);
    expect(window.map((t) => t.id)).toEqual(['d2', 'd1']); // 100 then 300
    const narrow = await r.doneTasksInWindow(200, 1000);
    expect(narrow.map((t) => t.id)).toEqual(['d1']);
  });

  it('re-completing a task that was reopened drops it from the calibration index', async () => {
    await r.putTask(task({ id: 'a', status: 'done', completedAt: 100, estimateLockedMin: 30 }));
    expect((await r.doneTasksInWindow(0, 1000)).map((t) => t.id)).toEqual(['a']);
    await r.putTask(task({ id: 'a', status: 'in_progress', completedAt: null })); // reopened
    expect(await r.doneTasksInWindow(0, 1000)).toEqual([]);
  });

  it('moving a plan to a new order does not leave the old row behind', async () => {
    const base = {
      id: 'p1',
      userId: U,
      createdAt: 0,
      updatedAt: 0,
      deletedAt: null,
      taskId: 't1',
      day: '2026-08-04',
    };
    const atOne = { ...base, plannedMinutes: 30, order: 1 };
    await r.putPlan(atOne);
    await r.putPlan({ ...base, plannedMinutes: 30, order: 5 }, atOne);
    const plans = await r.listPlans('2026-08-04');
    expect(plans).toHaveLength(1);
    expect(plans[0]!.order).toBe(5);
  });

  it('putPlan writes the new key before dropping the old, and dates the new copy past the old', async () => {
    const { doc, repo: r } = repo();
    const row = { id: 'p1', userId: U, createdAt: 0, updatedAt: 7, deletedAt: null, taskId: 't1' };
    const before = { ...row, day: '2026-08-04', plannedMinutes: 30, order: 1 };
    await r.putPlan(before);
    const calls: string[] = [];
    const [put, del] = [doc.put.bind(doc), doc.delete.bind(doc)];
    doc.put = (item) => (calls.push('put'), put(item));
    doc.delete = (pk, key) => (calls.push('delete'), del(pk, key));
    const moved = await r.putPlan({ ...before, order: 5 }, before);
    expect(calls).toEqual(['put', 'delete']);
    expect(moved.updatedAt).toBe(8);
    expect((await r.listPlans('2026-08-04')).map((p) => p.updatedAt)).toEqual([8]);
  });

  it('a plan read collapses two copies of one id to the newest, a tombstone included', async () => {
    const { repo: r } = repo();
    const row = {
      id: 'p1',
      userId: U,
      createdAt: 0,
      deletedAt: null,
      taskId: 't1',
      day: '2026-08-04',
      plannedMinutes: 30,
    };
    await r.putPlan({ ...row, order: 1, updatedAt: 1 });
    await r.putPlan({ ...row, order: 5, updatedAt: 2 });
    expect((await r.listPlans('2026-08-04')).map((p) => p.order)).toEqual([5]);
    expect((await r.listAllPlans()).map((p) => p.order)).toEqual([5]);
    expect((await r.listPlansFrom('2026-08-04')).map((p) => p.order)).toEqual([5]);
    expect((await r.findPlan('p1'))?.order).toBe(5);
    await r.putPlan({ ...row, order: 5, updatedAt: 3, deletedAt: 3 });
    expect(await r.listPlans('2026-08-04')).toEqual([]);
    expect(await r.findPlan('p1')).toMatchObject({ deletedAt: 3 });
  });

  it('listPlansFrom reads rows dated the day or later, alive only, in one bounded query', async () => {
    const { doc, repo: r } = repo();
    const row = (id: string, day: string, deletedAt: number | null = null) => ({
      id,
      userId: U,
      createdAt: 0,
      updatedAt: 0,
      deletedAt,
      taskId: 't1',
      day,
      plannedMinutes: 30,
      order: 0,
    });
    for (const p of [row('a', '2026-08-01'), row('b', '2026-08-04'), row('c', '2026-08-05')])
      await r.putPlan(p);
    await r.putPlan(row('d', '2026-08-04', 1)); // a tombstone inside the range
    expect((await r.listPlansFrom('2026-08-04', { consistent: true })).map((p) => p.id)).toEqual([
      'b',
      'c',
    ]);
    expect(doc.queries.at(-1)).toMatchObject({
      prefix: 'plan#',
      from: 'plan#2026-08-04#',
      consistent: true,
    });
  });

  it('noopWrites makes writes a no-op (the smoke-test guarantee)', async () => {
    const doc2 = new InMemoryDoc();
    const smoke = new Repo(doc2, noopWrites(), U);
    await smoke.putTask(task({ id: 'a' }));
    expect(await smoke.listTasks()).toEqual([]);
    expect(doc2.size).toBe(0);
  });

  it('habit checks read by composite (date, habitId); an uncheck tombstones; listChecks bounds by date', async () => {
    const { doc, repo: r } = repo();
    const check = (id: string, date: string) => ({
      id,
      userId: U,
      createdAt: 0,
      updatedAt: 0,
      deletedAt: null,
      habitId: 'h1',
      date,
    });
    await r.putCheck(check('c1', '2026-08-04'), '2026-08-04', 'h1');
    await r.putCheck(check('c0', '2026-08-01'), '2026-08-01', 'h1');
    expect((await r.getCheck('2026-08-04', 'h1'))?.id).toBe('c1');
    // The tombstone sits at the same key: gone from getCheck and the lists, kept in the table.
    await r.putCheck(
      { ...check('c1', '2026-08-04'), deletedAt: 5, updatedAt: 5 },
      '2026-08-04',
      'h1',
    );
    expect(await r.getCheck('2026-08-04', 'h1')).toBeNull();
    expect((await doc.get(`u#${U}`, 'hcheck#2026-08-04#h1'))?.deletedAt).toBe(5);
    expect((await r.listChecks('2026-08-01', '2026-08-07')).map((c) => c.id)).toEqual(['c0']);
    expect(await r.listChecks('2026-08-02', '2026-08-07')).toEqual([]); // c0 is outside the range
    expect(doc.queries.at(-1)).toMatchObject({
      prefix: 'hcheck#',
      from: 'hcheck#2026-08-02#',
      to: 'hcheck#2026-08-07#\uffff',
    });
  });

  it('listLogRange bounds the sort key to log#<from>#..log#<to># (one range read)', async () => {
    const { doc, repo: r } = repo();
    const entry = (id: string, day: string) => ({
      id,
      userId: U,
      createdAt: 0,
      updatedAt: 0,
      deletedAt: null,
      day,
      text: id,
    });
    await r.putLog(entry('l1', '2026-08-01'));
    await r.putLog(entry('l2', '2026-08-04'));
    await r.putLog({ ...entry('l3', '2026-08-04'), deletedAt: 9 });
    await r.putLog(entry('l4', '2026-08-09'));
    expect((await r.listLogRange('2026-08-02', '2026-08-04')).map((e) => e.id)).toEqual(['l2']);
    expect(doc.queries.at(-1)).toMatchObject({
      prefix: 'log#',
      from: 'log#2026-08-02#',
      to: 'log#2026-08-04#\uffff',
    });
    // No bounds → the whole log prefix, still one query on the user's partition.
    expect((await r.listLogRange()).map((e) => e.id)).toEqual(['l1', 'l2', 'l4']);
    expect(doc.queries.at(-1)).toMatchObject({ prefix: 'log#', from: undefined, to: undefined });
    await r.listLogRange(undefined, undefined, { consistent: true });
    expect(doc.queries.at(-1)).toMatchObject({ consistent: true });
  });
});

describe('Repo reminders (the remind index + push rows)', () => {
  const AT_2PM = userDueEpoch('2026-11-04', '14:00'); // 22:00Z (PST)
  const AT_9AM = userDueEpoch('2026-11-04', '09:00');
  const plan = (over: Partial<TaskPlan> = {}): TaskPlan => ({
    id: 'p1',
    userId: U,
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    taskId: 't1',
    day: '2026-11-04',
    plannedMinutes: 30,
    order: 0,
    ...over,
  });
  const keysOf = async (doc: InMemoryDoc, skStr: string) => {
    const it = await doc.get(`u#${U}`, skStr);
    return { GSI1PK: it?.GSI1PK, GSI1SK: it?.GSI1SK };
  };

  it('an open task with a deadline is on the remind index at its fire time, in the user zone', async () => {
    const { doc, repo: r } = repo();
    await r.putTask(task({ id: 'timed', dueDay: '2026-11-04', dueTime: '14:00' }));
    await r.putTask(task({ id: 'day', dueDay: '2026-11-04' }));
    expect(await keysOf(doc, sk.task('timed'))).toEqual({
      GSI1PK: `u#${U}#remind`,
      GSI1SK: AT_2PM,
    });
    expect(await keysOf(doc, sk.task('day'))).toEqual({ GSI1PK: `u#${U}#remind`, GSI1SK: AT_9AM });
    expect(new Date(AT_2PM).toISOString()).toBe('2026-11-04T22:00:00.000Z');
  });

  it('done, cancelled, tombstoned, undated or malformed tasks carry no remind keys', async () => {
    const { doc, repo: r } = repo();
    const due = { dueDay: '2026-11-04', dueTime: '14:00' };
    await r.putTask(task({ id: 'done', ...due, status: 'done', completedAt: 5 }));
    await r.putTask(task({ id: 'cx', ...due, status: 'cancelled', cancelledAt: 5 }));
    await r.putTask(task({ id: 'gone', ...due, deletedAt: 5 }));
    await r.putTask(task({ id: 'undated' }));
    await r.putTask(task({ id: 'bad', dueDay: 'not-a-day', dueTime: '14:00' })); // a write still lands
    expect(await keysOf(doc, sk.task('done'))).toEqual({ GSI1PK: `u#${U}#done`, GSI1SK: 5 });
    for (const id of ['cx', 'gone', 'undated', 'bad'])
      expect(await keysOf(doc, sk.task(id))).toEqual({ GSI1PK: undefined, GSI1SK: undefined });
  });

  it('completing a task moves it from the remind index to the done one; reopening moves it back', async () => {
    const { repo: r } = repo();
    const due = { dueDay: '2026-11-04', dueTime: '14:00' };
    await r.putTask(task({ id: 'a', ...due }));
    expect((await r.remindRowsInWindow(0, AT_2PM)).map((x) => x.kind)).toEqual(['task']);
    await r.putTask(task({ id: 'a', ...due, status: 'done', completedAt: 7 }));
    expect(await r.remindRowsInWindow(0, AT_2PM)).toEqual([]);
    expect((await r.doneTasksInWindow(0, 10)).map((t) => t.id)).toEqual(['a']);
    await r.putTask(task({ id: 'a', ...due, status: 'in_progress' }));
    expect((await r.remindRowsInWindow(0, AT_2PM)).map((x) => x.kind)).toEqual(['task']);
  });

  it('plans are on the remind index at 09:00 on their day; a moved plan re-keys, a tombstone drops out', async () => {
    const { doc, repo: r } = repo();
    const p = plan();
    await r.putPlan(p);
    expect(await keysOf(doc, sk.plan(p.day, 0, 'p1'))).toEqual({
      GSI1PK: `u#${U}#remind`,
      GSI1SK: AT_9AM,
    });
    const moved = plan({ day: '2026-11-05', updatedAt: 1 });
    await r.putPlan(moved, p);
    const rows = await r.remindRowsInWindow(0, Number.MAX_SAFE_INTEGER);
    expect(rows).toEqual([
      {
        kind: 'plan',
        fireAt: userDueEpoch('2026-11-05', '09:00'),
        sk: sk.plan('2026-11-05', 0, 'p1'),
        plan: moved,
      },
    ]);
    await r.putPlan({ ...moved, deletedAt: 2, updatedAt: 2 }, moved);
    expect(await r.remindRowsInWindow(0, Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect(await r.getPlanForRemind(sk.plan('2026-11-05', 0, 'p1'))).toBeNull();
  });

  it('reads the window by fire time and tells tasks, plans and Send-test rows apart', async () => {
    const { repo: r } = repo();
    await r.putTask(task({ id: 'timed', dueDay: '2026-11-04', dueTime: '14:00' }));
    await r.putPlan(plan());
    await r.putPushTest({ id: 'x1', createdAt: AT_9AM + 1 });
    const rows = await r.remindRowsInWindow(AT_9AM, AT_2PM);
    expect(rows.map((x) => [x.kind, x.fireAt])).toEqual([
      ['plan', AT_9AM],
      ['test', AT_9AM + 1],
      ['task', AT_2PM],
    ]);
    expect(await r.remindRowsInWindow(AT_9AM + 2, AT_2PM - 1)).toEqual([]);
    await r.deletePushTest('x1');
    expect(await r.listPushTests()).toEqual([]);
  });

  it('a pre-index row re-keys as read, and a write since wins', async () => {
    const { doc, repo: r } = repo();
    const t = task({ id: 'old', dueDay: '2026-11-04', updatedAt: 3 });
    await doc.put({ PK: `u#${U}`, SK: sk.task('old'), ...t }); // written before the index existed
    expect(await r.remindRowsInWindow(0, AT_9AM)).toEqual([]);
    expect(await r.rekeyTask(t, 9)).toBe(true);
    expect((await r.remindRowsInWindow(0, AT_9AM)).map((x) => x.kind)).toEqual(['task']);
    expect(await r.rekeyTask({ ...t, updatedAt: 2 }, 9)).toBe(false); // the row moved on — nothing to do
    expect((await doc.get(`u#${U}`, sk.task('old')))?.updatedAt).toBe(3);
  });

  it('dedup rows land once; the guard counter is conditional on the version read', async () => {
    const { repo: r } = repo();
    const row = { fireAt: AT_2PM, key: 't1', sentAt: AT_2PM };
    expect(await r.putPushSentIf(row)).toBe(true);
    expect(await r.putPushSentIf({ ...row, sentAt: AT_2PM + 60_000 })).toBe(false);
    expect(await r.listPushSent()).toEqual([row]);
    await r.deletePushSent(row);
    expect(await r.listPushSent()).toEqual([]);

    await r.putPushCountIf({ day: '2026-11-04', count: 1, updatedAt: 10 }, null);
    await expect(
      r.putPushCountIf({ day: '2026-11-04', count: 1, updatedAt: 11 }, null),
    ).rejects.toThrow('Condition failed');
    await r.putPushCountIf({ day: '2026-11-04', count: 2, updatedAt: 11 }, 10);
    expect(await r.getPushCount('2026-11-04')).toEqual({
      day: '2026-11-04',
      count: 2,
      updatedAt: 11,
    });
  });

  it('push rows sit outside the done and remind indexes unless they are a Send-test row', async () => {
    const { doc, repo: r } = repo();
    await r.putPushSub({
      id: 's1',
      userId: U,
      createdAt: 0,
      updatedAt: 0,
      deletedAt: null,
      endpoint: 'https://web.push.apple.com/x',
      p256dh: 'k',
      auth: 'a',
      label: 'iPhone',
      lastOkAt: null,
      lastError: null,
      lastErrorAt: null,
    });
    await r.putPushSentIf({ fireAt: 1, key: 't', sentAt: 1 });
    await r.putPushUserHealth({ lastSentAt: 1, lastError: null, lastErrorAt: null, updatedAt: 1 });
    for (const it of doc.snapshot()) expect(it.GSI1PK).toBeUndefined();
    await r.putPushTest({ id: 'x', createdAt: 9 });
    expect(await keysOf(doc, sk.pushTest('x'))).toEqual({ GSI1PK: gsi1.remindPk(U), GSI1SK: 9 });
  });

  it('the arm stamp stays in the table: kept by an edit that keeps the fire time, renewed by one that moves it', async () => {
    const { doc, repo: r } = repo();
    const armOf = async (id: string) => (await doc.get(`u#${U}`, sk.task(id)))?.remindArmedAt;
    await r.putTask(task({ id: 'a', dueDay: '2026-11-04', dueTime: '14:00', updatedAt: 5 }));
    expect(await armOf('a')).toBe(5);
    await r.putTask(
      task({ id: 'a', dueDay: '2026-11-04', dueTime: '14:00', title: 'renamed', updatedAt: 6 }),
    );
    expect(await armOf('a')).toBe(5);
    await r.putTask(task({ id: 'a', dueDay: '2026-11-04', dueTime: '15:00', updatedAt: 7 }));
    expect(await armOf('a')).toBe(7);
    await r.putTask(
      task({
        id: 'a',
        dueDay: '2026-11-04',
        dueTime: '15:00',
        status: 'done',
        completedAt: 8,
        updatedAt: 8,
      }),
    );
    expect(await armOf('a')).toBeUndefined();
    await r.putTasks([task({ id: 'a', dueDay: '2026-11-04', dueTime: '15:00', updatedAt: 9 })]); // reopened
    expect(await armOf('a')).toBe(9);
    // Never part of the entity: not on a read, a list or the window's rows.
    expect(await r.getTask('a')).not.toHaveProperty('remindArmedAt');
    expect((await r.listTasks())[0]).not.toHaveProperty('remindArmedAt');
    const [row] = await r.remindRowsInWindow(0, Number.MAX_SAFE_INTEGER);
    expect(row?.kind === 'task' && row.task).not.toHaveProperty('remindArmedAt');
    expect(await r.getTaskForRemind('a')).toMatchObject({ armedAt: 9 });
  });
});
