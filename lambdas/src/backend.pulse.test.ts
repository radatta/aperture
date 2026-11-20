import { describe, expect, it } from 'vitest';
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
    expect(r).toMatchObject({ opened: true, pulses: 1, sessionMin: PULSE_GRACE_MIN });
    const rows = (await backend.listSessionsForDay('2023-11-14')).sort(
      (a, b) => a.startedAt - b.startedAt,
    );
    expect(rows.map((s) => [s.activeMinutes, s.endedAt])).toEqual([
      [4 + PULSE_GRACE_MIN, T0 + (4 + PULSE_GRACE_MIN) * MIN],
      [PULSE_GRACE_MIN, T0 + (20 + PULSE_GRACE_MIN) * MIN],
    ]);
    expect((await backend.getTask(t.id))!.actualAccruedMin).toBe(4 + 2 * PULSE_GRACE_MIN);
  });

  it('writes the state row and a day-bucket session, never a running timer row', async () => {
    const { doc, backend } = setup();
    const t = await backend.createTask({ title: 'Prep', estimateMin: 30 });
    const r = await backend.pulseTask({ taskId: t.id, note: 'outline' });
    const rows = keys(doc);
    expect(rows).toContain(sk.pulseState());
    expect(rows.filter((k) => k.startsWith(sk.sessionDayPrefix('2023-11-14')))).toHaveLength(1);
    expect(rows.some((k) => k.startsWith(sk.sessionRunningPrefix()))).toBe(false);
    expect(r.sessionMin).toBe(PULSE_GRACE_MIN);
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
      endedAt: T0 + PULSE_GRACE_MIN * MIN,
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
});
