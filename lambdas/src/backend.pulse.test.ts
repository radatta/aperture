import { describe, expect, it, vi } from 'vitest';
import { PULSE_GRACE_MIN, PULSE_STATE_ID } from '@aperture/shared';
import type { OpenPulse, PulseState, Task } from '@aperture/shared';
import { InMemoryDoc } from './ddb/DocClient';
import type { Item } from './ddb/DocClient';
import { Repo } from './ddb/repo';
import { liveWrites, noopWrites } from './ddb/writes';
import { taskItem } from './ddb/mapping';
import { pk, sk } from './ddb/keys';
import { BackendClient } from './backend';

// What the shared contract can't see: the table rows, and the races. A pulse writes the state row under a
// condition (a rival pulse landing first is re-read and planned on), and a task's minutes under one too (an
// app write landing meanwhile is kept, never flattened).
const T0 = 1_700_000_000_000; // 2023-11-14, 14:13 in the user's zone
const MIN = 60_000;
const U = 'u1';
function setup(writes: 'live' | 'noop' = 'live') {
  const doc = new InMemoryDoc();
  const now = { t: T0 };
  const repo = new Repo(doc, writes === 'live' ? liveWrites(doc, 'prod') : noopWrites(), U);
  const backend = new BackendClient(repo, { userId: U, now: () => now.t });
  return { doc, backend, now };
}
const keys = (doc: InMemoryDoc) => doc.snapshot().map((i: Item) => i.SK);

describe('pulses on the table', () => {
  it('a gap past the window opens a new session; the old row keeps its last pulse plus the grace', async () => {
    const { backend, now } = setup();
    const t = await backend.createTask({ title: 'Read', estimateMin: 30 });
    await backend.pulseTask({ taskId: t.id });
    now.t += 4 * MIN;
    await backend.pulseTask({ taskId: t.id });
    now.t += 16 * MIN; // past the personal window of 15
    const r = await backend.pulseTask({ taskId: t.id });
    expect(r).toMatchObject({ opened: true, pulses: 1, sessionMin: 0 });
    const rows = (await backend.listSessionsForDay('2023-11-14')).sort(
      (a, b) => a.startedAt - b.startedAt,
    );
    expect(rows.map((s) => [s.activeMinutes, s.endedAt])).toEqual([
      [4 + PULSE_GRACE_MIN, T0 + (4 + PULSE_GRACE_MIN) * MIN],
      [0, T0 + 20 * MIN],
    ]);
    expect((await backend.getTask(t.id))!.actualAccruedMin).toBe(4 + PULSE_GRACE_MIN);
  });

  it("another user's task id is Not found, and nothing is written", async () => {
    const { doc, backend } = setup();
    const t = await backend.createTask({ title: 'Mine', estimateMin: 30 });
    const other = new BackendClient(new Repo(doc, liveWrites(doc, 'prod'), 'u2'), {
      userId: 'u2',
      now: () => T0,
    });
    const before = doc.snapshot();
    await expect(other.pulseTask({ taskId: t.id })).rejects.toThrow('Not found');
    expect(doc.snapshot()).toEqual(before);
  });

  it('two first pulses at once: the one that loses the create re-reads and plans on the winner', async () => {
    const { doc, backend } = setup();
    const a = await backend.createTask({ title: 'A', estimateMin: 30 });
    const b = await backend.createTask({ title: 'B', estimateMin: 30 });
    const rival: PulseState = {
      id: PULSE_STATE_ID,
      userId: U,
      createdAt: T0,
      updatedAt: T0,
      deletedAt: null,
      open: {
        sessionId: 'rival',
        taskId: b.id,
        categoryId: null,
        wasWork: false,
        day: '2023-11-14',
        startedAt: T0,
        lastPulseAt: T0,
        endedAt: T0,
        pulses: 1,
        notes: [],
      },
    };
    doc.interceptNextPutIf(pk(U), sk.pulseState(), () =>
      doc.putNow({ ...rival, PK: pk(U), SK: sk.pulseState() } as unknown as Item),
    );
    const r = await backend.pulseTask({ taskId: a.id });
    expect(r).toMatchObject({ opened: true, closed: { taskId: b.id } });
  });

  it('writes the state row and a day-bucket session, never a running timer row', async () => {
    const { doc, backend } = setup();
    const t = await backend.createTask({ title: 'Prep', estimateMin: 30 });
    const r = await backend.pulseTask({ taskId: t.id, note: 'outline' });
    const rows = keys(doc);
    expect(rows).toContain(sk.pulseState());
    expect(rows.filter((k) => k.startsWith(sk.sessionDayPrefix('2023-11-14')))).toHaveLength(1);
    expect(rows.some((k) => k.startsWith(sk.sessionRunningPrefix()))).toBe(false);
    expect(r.sessionMin).toBe(0); // nothing credited before it has passed
  });

  it('a rival pulse landing first is re-read: this pulse plans on it (a switch), not on what it read', async () => {
    const { doc, backend } = setup();
    const a = await backend.createTask({ title: 'A', estimateMin: 30 });
    const b = await backend.createTask({ title: 'B', estimateMin: 30 });
    await backend.pulseTask({ taskId: a.id }); // the state row exists: A open
    const before = doc.snapshot().find((i) => i.SK === sk.pulseState())!;
    const rivalOpen: OpenPulse = {
      ...(before.open as OpenPulse),
      sessionId: 'rival',
      taskId: b.id,
      startedAt: T0,
      lastPulseAt: T0,
      endedAt: T0,
    };
    // Just before this pulse's conditional write, a rival's pulse for B lands.
    doc.interceptNextPutIf(pk(U), sk.pulseState(), () =>
      doc.putNow({ ...before, open: rivalOpen, updatedAt: (before.updatedAt as number) + 1 }),
    );
    const r = await backend.pulseTask({ taskId: a.id });
    // Re-planned on B's open session: A's pulse is a switch from B, so a new A session opens.
    expect(r).toMatchObject({ opened: true, closed: { taskId: b.id } });
    const state = doc.snapshot().find((i) => i.SK === sk.pulseState()) as unknown as PulseState;
    expect(state.open!.taskId).toBe(a.id);
    expect(state.id).toBe(PULSE_STATE_ID);
  });

  it("a task write landing during the credit is kept: an app Done meanwhile isn't flattened or credited", async () => {
    const { doc, backend, now } = setup();
    const t = await backend.createTask({ title: 'Essay', estimateMin: 30 });
    await backend.pulseTask({ taskId: t.id });
    now.t += 10 * MIN;
    const stored = (await backend.getTask(t.id))!;
    const doneInApp: Task = {
      ...stored,
      status: 'done',
      actualAccruedMin: 25,
      completedAt: now.t,
      updatedAt: stored.updatedAt + 1,
    };
    doc.interceptNextPutIf(pk(U), sk.task(t.id), () => doc.putNow(taskItem(U, doneInApp)));
    await backend.pulseTask({ taskId: t.id });
    expect(await backend.getTask(t.id)).toMatchObject({ status: 'done', actualAccruedMin: 25 });
  });

  it('a run with no-op writes reads and plans but stores nothing', async () => {
    const { doc, backend } = setup();
    const t = await backend.createTask({ title: 'Seeded', estimateMin: 30 });
    const quiet = new BackendClient(new Repo(doc, noopWrites(), U), { userId: U, now: () => T0 });
    const before = doc.snapshot();
    await quiet.pulseTask({ taskId: t.id });
    expect(doc.snapshot()).toEqual(before);
  });

  it('a timer started on another task leaves the open pulse session alone, with no extra write', async () => {
    const { doc, backend } = setup();
    const a = await backend.createTask({ title: 'A', estimateMin: 30 });
    const other = await backend.createTask({ title: 'Other', estimateMin: 30 });
    await backend.pulseTask({ taskId: a.id });
    const state = () => doc.snapshot().find((i) => i.SK === sk.pulseState());
    const before = state();
    await backend.startSession({
      taskId: other.id,
      categoryId: null,
      kind: 'work',
      day: '2023-11-14',
    });
    expect(state()).toEqual(before);
  });

  it('reads the window from the life area of the task category', async () => {
    const { backend, now } = setup();
    const cat = await backend.upsertCategory({ label: 'Mocks', isWork: false, area: 'recruiting' });
    const t = await backend.createTask({ title: 'Mock', estimateMin: 45, categoryId: cat.id });
    await backend.pulseTask({ taskId: t.id });
    now.t += 18 * MIN; // past the personal 15, inside recruiting's 20
    expect((await backend.pulseTask({ taskId: t.id })).opened).toBe(false);
  });

  it('reads running timers strongly consistent, and a blocked pulse skips the parts read', async () => {
    const { doc, backend } = setup();
    const parent = await backend.createTask({ title: 'Lab', estimateMin: 60 });
    const part = await backend.createTask({ title: 'Prelab', estimateMin: 20 });
    await backend.setTaskParent(part.id, parent.id);
    await backend.startSession({
      taskId: parent.id,
      categoryId: null,
      kind: 'work',
      day: '2023-11-14',
    });
    doc.queries.length = 0;
    const r = await backend.pulseTask({ taskId: parent.id });
    expect(r).toMatchObject({ counted: false, reason: 'timer' }); // the timer answers before the parent refusal
    expect(doc.queries).toContainEqual(
      expect.objectContaining({ prefix: sk.sessionRunningPrefix(), consistent: true }),
    );
    expect(doc.queries.some((q) => q.prefix.startsWith('task#'))).toBe(false);
  });

  it('a timer start whose pulse settle fails still lands, and says so in the log', async () => {
    const { doc, backend } = setup();
    const t = await backend.createTask({ title: 'Timed', estimateMin: 30 });
    await backend.pulseTask({ taskId: t.id });
    doc.interceptNextPutIf(pk(U), sk.pulseState(), () => {
      throw new Error('throttled');
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const timer = await backend.startSession({
        taskId: t.id,
        categoryId: null,
        kind: 'work',
        day: '2023-11-14',
      });
      expect((await backend.listRunningSessions()).map((s) => s.id)).toEqual([timer.id]);
      expect(
        log.mock.calls.map((c) => String(c[0])).some((l) => l.includes('pulse_yield_deferred')),
      ).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  it("a category's work flag, backfilled, reaches the open pulse session too", async () => {
    const { backend, now } = setup();
    const cat = await backend.upsertCategory({ label: 'Study', isWork: false, area: 'school' });
    const t = await backend.createTask({ title: 'Read', estimateMin: 30, categoryId: cat.id });
    await backend.pulseTask({ taskId: t.id });
    await backend.setCategoryWork(cat.id, true, true);
    now.t += 2 * MIN;
    await backend.pulseTask({ taskId: t.id }); // rewrites the row from the state row
    const rows = (await backend.listSessionsForDay('2023-11-14')).filter(
      (s) => s.source === 'pulse',
    );
    expect(rows.map((s) => s.wasWork)).toEqual([true]);
  });
});
