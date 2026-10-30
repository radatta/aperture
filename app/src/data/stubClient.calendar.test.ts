import { describe, expect, it } from 'vitest';
import { DEFAULT_EVENT_MIN, localEpochFromDayTime, MARKER_MIN } from '@aperture/shared';
import { createStubClient, STUB_GCAL_EDITS_KEY, type StubGcalEdit } from './stubClient';

// Parity for the gated calendar methods. These can't live in the shared ApiClient contract suite: their
// behavior depends on external gateway state (connected accounts) that can't be established through the
// ApiClient interface — connect is a browser OAuth redirect, not a method. So the stub is held to the
// SAME behavior the backend asserts in lambdas/src/backend.calendar.test.ts, via this parallel test. The
// seeded store provides two connected accounts (seed-personal, seed-school).
function stub() {
  return createStubClient({
    seed: true,
    storageKey: `cal-${Math.random()}`,
    now: () => 1_700_000_000_000,
  });
}

describe('stub Google Calendar parity', () => {
  it('reports the seeded accounts as connected', async () => {
    const status = await stub().getGoogleStatus();
    expect(status.accounts.map((a) => a.sub).sort()).toEqual(['seed-personal', 'seed-school']);
    expect(status.accounts.every((a) => a.connected && !a.reconnectRequired)).toBe(true);
  });

  it('lists calendars per connected account', async () => {
    const cals = await stub().listGoogleCalendars();
    expect(cals.some((c) => c.accountSub === 'seed-personal')).toBe(true);
    expect(cals.some((c) => c.accountSub === 'seed-school')).toBe(true);
  });

  it('returns busy intervals for the shape read', async () => {
    const busy = await stub().getCalendarBusy({
      day: '2026-01-01',
      windowStartMs: 0,
      windowEndMs: 50_000_000,
    });
    expect(busy.intervals.length).toBeGreaterThan(0);
    expect(busy.allDayCount).toBe(1);
  });

  it('insert stores pointers; a second insert throws; an unconnected account throws', async () => {
    const api = stub();
    const t = await api.createTask({ title: 'Interview' });
    const withEvent = await api.insertCalendarEvent({
      taskId: t.id,
      accountSub: 'seed-personal',
      calendarId: 'you@gmail.com',
      title: 'Interview',
      startMs: 1000,
      endMs: 2000,
    });
    expect(withEvent.gcalAccountId).toBe('seed-personal');
    expect(withEvent.gcalEventId).toBeTruthy();

    await expect(
      api.insertCalendarEvent({
        taskId: t.id,
        accountSub: 'seed-personal',
        calendarId: 'you@gmail.com',
        title: 'dup',
        startMs: 1,
        endMs: 2,
      }),
    ).rejects.toThrow();

    const t2 = await api.createTask({ title: 'Other' });
    await expect(
      api.insertCalendarEvent({
        taskId: t2.id,
        accountSub: 'not-connected',
        calendarId: 'x',
        title: 'x',
        startMs: 1,
        endMs: 2,
      }),
    ).rejects.toThrow();
  });

  it('delete clears the pointers, and cancel deletes on-cancel', async () => {
    const api = stub();
    const t = await api.createTask({ title: 'Study block' });
    await api.insertCalendarEvent({
      taskId: t.id,
      accountSub: 'seed-personal',
      calendarId: 'you@gmail.com',
      title: 'Study block',
      startMs: 1000,
      endMs: 2000,
    });
    const cleared = await api.deleteCalendarEvent(t.id);
    expect(cleared.gcalEventId).toBeNull();

    // re-add, then drop the task → delete-on-cancel clears it again
    await api.insertCalendarEvent({
      taskId: t.id,
      accountSub: 'seed-personal',
      calendarId: 'you@gmail.com',
      title: 'Study block',
      startMs: 1000,
      endMs: 2000,
    });
    const cancelled = await api.transitionTask(t.id, 'cancelled');
    expect(cancelled.gcalEventId).toBeNull();
  });

  it('deleteTask hard-deletes the calendar event (parity with cancel)', async () => {
    const api = stub();
    const t = await api.createTask({ title: 'doomed' });
    await api.insertCalendarEvent({
      taskId: t.id,
      accountSub: 'seed-personal',
      calendarId: 'you@gmail.com',
      title: 'doomed',
      startMs: 1000,
      endMs: 2000,
    });
    await api.deleteTask(t.id);
    expect(await api.getTask(t.id)).toBeNull(); // task gone
    await expect(api.deleteCalendarEvent(t.id)).rejects.toThrow(); // event pointers cleared → mustFind 404s
  });

  it('disconnect prunes the account, its shape refs, and a write-default pointing at it', async () => {
    const api = stub();
    await api.disconnectGoogleAccount('seed-personal');
    const s = await api.getSettings();
    expect(s.googleAccounts.map((a) => a.sub)).toEqual(['seed-school']);
    expect(s.calendarShapeRefs.some((r) => r.accountSub === 'seed-personal')).toBe(false);
    expect(s.calendarWriteDefault?.accountSub).not.toBe('seed-personal');
  });
});

// Auto-sync parity with lambdas/src/backend.calendar.test.ts → "calendar auto-sync". The seed sets a
// write default (seed-personal) and leaves auto-sync on.
describe('stub calendar auto-sync parity', () => {
  it('a timed create links an event; untimed does not', async () => {
    const api = stub();
    expect((await api.createTask({ title: 'u', dueDay: '2026-10-09' })).gcalEventId).toBeNull();
    const t = await api.createTask({ title: 't', dueDay: '2026-10-09', dueTime: '16:00' });
    expect(t).toMatchObject({ gcalAccountId: 'seed-personal', gcalSyncError: null });
    expect(t.gcalEventId).toBeTruthy();
  });
  it('edits keep the same event; clearing the time unlinks it', async () => {
    const api = stub();
    const t = await api.createTask({ title: 't', dueDay: '2026-10-09', dueTime: '16:00' });
    const moved = await api.setTaskDue(t.id, { dueDay: '2026-10-10', dueTime: '18:00' });
    expect(moved.gcalEventId).toBe(t.gcalEventId);
    expect((await api.setTaskTitle(t.id, 'renamed')).gcalEventId).toBe(t.gcalEventId);
    expect(
      (await api.setTaskDue(t.id, { dueDay: '2026-10-10', dueTime: null })).gcalEventId,
    ).toBeNull();
  });
  it('toggle off: no create, and an existing link is left alone', async () => {
    const api = stub();
    const t = await api.createTask({ title: 't', dueDay: '2026-10-09', dueTime: '16:00' });
    await api.updateSettings({ autoCalendar: false });
    expect(
      (await api.createTask({ title: 'n', dueDay: '2026-10-09', dueTime: '12:00' })).gcalEventId,
    ).toBeNull();
    expect((await api.setTaskDue(t.id, { dueDay: '2026-10-09', dueTime: null })).gcalEventId).toBe(
      t.gcalEventId,
    );
  });
  it('createTasks links only the timed rows; a done timed split moves the link to the follow-up', async () => {
    const api = stub();
    const made = await api.createTasks([
      { title: 'a', dueDay: '2026-10-09', dueTime: '10:00' },
      { title: 'b', dueDay: '2026-10-09' },
    ]);
    expect(made.map((t) => !!t.gcalEventId)).toEqual([true, false]);
    await api.transitionTask(made[0]!.id, 'in_progress');
    const { original, followUp } = await api.splitTask(made[0]!.id, {
      finish: 'done',
      followUp: { title: 'a, part 2', estimateMin: null },
    });
    expect(original.gcalEventId).toBeNull();
    expect(followUp.gcalEventId).toBe(made[0]!.gcalEventId);
  });
  it('a keep timed split leaves the original its event and links the follow-up to its own', async () => {
    const api = stub();
    const t = await api.createTask({ title: 'a', dueDay: '2026-10-09', dueTime: '10:00' });
    const { original, followUp } = await api.splitTask(t.id, {
      finish: 'keep',
      followUp: { title: 'a, part 2', estimateMin: 30 },
    });
    expect(original.gcalEventId).toBe(t.gcalEventId);
    expect(followUp.gcalEventId).not.toBeNull();
    expect(followUp.gcalEventId).not.toBe(t.gcalEventId);
  });
  it('split keeps a manual event on an untimed original, done or kept going', async () => {
    for (const finish of ['done', 'keep'] as const) {
      const api = stub();
      const t = await api.createTask({ title: 'u', dueDay: '2026-10-09' });
      await api.insertCalendarEvent({
        taskId: t.id,
        accountSub: 'seed-personal',
        calendarId: 'you@gmail.com',
        title: 'u',
        startMs: 1000,
        endMs: 2000,
      });
      await api.transitionTask(t.id, 'in_progress');
      const { original, followUp } = await api.splitTask(t.id, {
        finish,
        followUp: { title: 'u, part 2', estimateMin: null },
      });
      expect(followUp.gcalEventId).toBeNull();
      expect(original.gcalEventId).not.toBeNull();
    }
  });
  it('insert refuses a timed task while auto-sync is on (its block sits at the deadline)', async () => {
    const api = stub();
    await api.updateSettings({ autoCalendar: false });
    const t = await api.createTask({ title: 't', dueDay: '2026-10-09', dueTime: '16:00' });
    await api.updateSettings({ autoCalendar: true });
    const block = () =>
      api.insertCalendarEvent({
        taskId: t.id,
        accountSub: 'seed-personal',
        calendarId: 'you@gmail.com',
        title: 't',
        startMs: 1000,
        endMs: 2000,
      });
    await expect(block()).rejects.toThrow(/Auto-sync places/);
    await api.updateSettings({ autoCalendar: false });
    await expect(block()).resolves.toMatchObject({ gcalEventId: expect.any(String) });
  });
  it('a done split moves a picked block on a timed task to the follow-up', async () => {
    const api = stub();
    await api.updateSettings({ autoCalendar: false });
    const t = await api.createTask({ title: 't', dueDay: '2026-10-09', dueTime: '16:00' });
    const picked = await api.insertCalendarEvent({
      taskId: t.id,
      accountSub: 'seed-personal',
      calendarId: 'you@gmail.com',
      title: 't',
      startMs: 1000,
      endMs: 2000,
    });
    await api.updateSettings({ autoCalendar: true });
    await api.transitionTask(t.id, 'in_progress');
    const { original, followUp } = await api.splitTask(t.id, {
      finish: 'done',
      followUp: { title: 't, part 2', estimateMin: null },
    });
    expect(original.gcalEventId).toBeNull();
    expect(followUp.gcalEventId).toBe(picked.gcalEventId);
  });
});

// Parent + parts parity with lambdas/src/backend.calendar.test.ts → "parent + parts": a parent never
// owns an event, by any path (parts.ts); its parts carry the blocks.
describe('stub calendar: parent + parts', () => {
  const pick = (api: ReturnType<typeof stub>, taskId: string) =>
    api.insertCalendarEvent({
      taskId,
      accountSub: 'seed-personal',
      calendarId: 'you@gmail.com',
      title: 'x',
      startMs: 1000,
      endMs: 2000,
    });

  // The marker: MARKER_MIN, ending at the deadline (the Lambda also sends it free + graphite).
  const markerOf = (dueDay: string, dueTime: string) => {
    const endMs = localEpochFromDayTime(dueDay, dueTime);
    return { startMs: endMs - MARKER_MIN * 60_000, endMs };
  };

  it('a timed task that takes its first part: its block becomes its due marker', async () => {
    const api = stub();
    const p = await api.createTask({
      title: 'P2',
      dueDay: '2026-10-09',
      dueTime: '23:59',
      estimateMin: 90,
    });
    expect(p.gcalEventId).toBeTruthy();
    await api.createTask({ title: 'read', parentId: p.id });
    const parent = (await api.getTask(p.id))!;
    expect(parent.gcalEventId).toBe(p.gcalEventId); // patched, not replaced
    expect(parent.gcalSeen).toMatchObject({ title: 'P2', ...markerOf('2026-10-09', '23:59') });
  });

  it('an unlinked timed parent gets its marker from Add due marker (the retry); untimed never', async () => {
    const api = stub();
    await api.updateSettings({ autoCalendar: false });
    const p = await api.createTask({ title: 'P2', dueDay: '2026-10-09', dueTime: '17:00' });
    await api.createTask({ title: 'read', parentId: p.id });
    await api.updateSettings({ autoCalendar: true });
    expect((await api.getTask(p.id))!.gcalEventId).toBeNull();
    expect((await api.syncCalendarEvent(p.id)).gcalSeen).toMatchObject(
      markerOf('2026-10-09', '17:00'),
    );
    const u = await api.createTask({ title: 'U', dueDay: '2026-10-09' });
    await api.createTask({ title: 'read', parentId: u.id });
    expect((await api.syncCalendarEvent(u.id)).gcalEventId).toBeNull();
  });

  it('a parent’s due change moves its marker; marking it done leaves it', async () => {
    const api = stub();
    const p = await api.createTask({ title: 'P2', dueDay: '2026-10-09', dueTime: '17:00' });
    const part = await api.createTask({ title: 'read', parentId: p.id, estimateMin: 30 });
    const moved = await api.setTaskDue(p.id, { dueDay: '2026-10-10', dueTime: '12:00' });
    expect(moved.gcalSeen).toMatchObject(markerOf('2026-10-10', '12:00'));
    await api.transitionTask(part.id, 'in_progress');
    await api.transitionTask(part.id, 'done');
    const done = await api.transitionTask(p.id, 'done');
    expect(done.gcalEventId).toBe(p.gcalEventId);
  });

  it('a part’s block is named after its parent; a parent rename renames its open parts’ blocks', async () => {
    const api = stub();
    const p = await api.createTask({ title: 'P2' });
    const at = { dueDay: '2026-10-09', dueTime: '10:00' };
    const a = await api.createTask({ title: 'Part 1', parentId: p.id, ...at });
    const b = await api.createTask({ title: 'Part 2', parentId: p.id, ...at });
    expect(a.gcalSeen?.title).toBe('P2 · Part 1');
    await api.transitionTask(b.id, 'in_progress');
    await api.transitionTask(b.id, 'done');
    await api.setTaskTitle(p.id, 'P2 final');
    expect((await api.getTask(a.id))!.gcalSeen?.title).toBe('P2 final · Part 1');
    expect((await api.getTask(b.id))!.gcalSeen?.title).toBe('P2 · Part 2'); // done: never pushes
  });

  it('the picker refuses a parent; an untimed part can still take a manual block', async () => {
    const api = stub();
    const p = await api.createTask({ title: 'P2', dueDay: '2026-10-09' });
    const part = await api.createTask({ title: 'read', parentId: p.id });
    await expect(pick(api, p.id)).rejects.toThrow(/due marker/);
    await expect(pick(api, part.id)).resolves.toMatchObject({ gcalEventId: expect.any(String) });
  });

  it('moving a part renames its block after the new parent; detaching drops the prefix', async () => {
    const api = stub();
    const a = await api.createTask({ title: 'A' });
    const c = await api.createTask({ title: 'C' });
    const part = await api.createTask({
      title: 'x',
      parentId: a.id,
      dueDay: '2026-10-09',
      dueTime: '10:00',
    });
    expect(part.gcalSeen?.title).toBe('A · x');
    expect((await api.setTaskParent(part.id, c.id)).gcalSeen?.title).toBe('C · x');
    expect((await api.setTaskParent(part.id, null)).gcalSeen?.title).toBe('x');
  });

  it('a timed standalone split: the parent gets a marker; keep → each part its own named block', async () => {
    const api = stub();
    const t = await api.createTask({ title: 'a', dueDay: '2026-10-09', dueTime: '10:00' });
    const { parent, original, followUp } = await api.splitTask(t.id, {
      finish: 'keep',
      followUp: { title: 'a, part 2', estimateMin: 30 },
    });
    expect(parent.gcalEventId).toBeTruthy();
    expect(parent.gcalSeen).toMatchObject({ title: 'a', ...markerOf('2026-10-09', '10:00') });
    expect(original.gcalEventId).toBe(t.gcalEventId); // Part 1 keeps its time and its block
    expect(original.gcalSeen?.title).toBe(`a · ${original.title}`);
    expect(followUp.gcalEventId).toBeTruthy();
    expect(followUp.gcalEventId).not.toBe(t.gcalEventId);
    expect(new Set([parent.gcalEventId, original.gcalEventId, followUp.gcalEventId]).size).toBe(3);
  });

  it('a timed standalone done split moves the event (with its base) to Part 2; the parent its own', async () => {
    const api = stub();
    const t = await api.createTask({ title: 'a', dueDay: '2026-10-09', dueTime: '10:00' });
    await api.transitionTask(t.id, 'in_progress');
    const { parent, original, followUp } = await api.splitTask(t.id, {
      finish: 'done',
      followUp: { title: 'a, part 2', estimateMin: null },
    });
    expect(parent.gcalEventId).toBeTruthy();
    expect(parent.gcalEventId).not.toBe(t.gcalEventId);
    expect(original.gcalEventId).toBeNull();
    expect(followUp.gcalEventId).toBe(t.gcalEventId);
    // The base came with the link, and Part 2's first push renamed the event (so it's not read as new).
    expect(followUp.gcalSeen?.title).toBe('a · a, part 2');
  });

  it('cancelling a parent removes its open parts’ blocks, then its marker', async () => {
    const api = stub();
    const p = await api.createTask({ title: 'P2', dueDay: '2026-10-09', dueTime: '17:00' });
    const part = await api.createTask({
      title: 'read',
      parentId: p.id,
      dueDay: '2026-10-09',
      dueTime: '10:00',
    });
    expect(part.gcalEventId).toBeTruthy();
    expect((await api.getTask(p.id))!.gcalEventId).toBeTruthy();
    const dropped = await api.transitionTask(p.id, 'cancelled');
    expect(dropped).toMatchObject({ status: 'cancelled', gcalEventId: null });
    expect(await api.getTask(part.id)).toMatchObject({ status: 'cancelled', gcalEventId: null });
  });

  it('its last part going turns the marker back into a block; deleting the parent takes it', async () => {
    const api = stub();
    const p = await api.createTask({
      title: 'P2',
      dueDay: '2026-10-09',
      dueTime: '17:00',
      estimateMin: 60,
    });
    const part = await api.createTask({ title: 'read', parentId: p.id });
    await api.deleteTask(part.id);
    const plain = (await api.getTask(p.id))!;
    const endMs = localEpochFromDayTime('2026-10-09', '17:00');
    // becomeParent dropped its estimate, so the block is the default length again.
    expect(plain.gcalSeen).toMatchObject({ startMs: endMs - DEFAULT_EVENT_MIN * 60_000, endMs });

    const q = await api.createTask({ title: 'Q', dueDay: '2026-10-09', dueTime: '17:00' });
    await api.createTask({ title: 'read', parentId: q.id });
    expect((await api.getTask(q.id))!.gcalSeen).toMatchObject(markerOf('2026-10-09', '17:00'));
    await api.deleteTask(q.id);
    expect(await api.getTask(q.id)).toBeNull();
    // (The Lambda's twin asserts no block patch goes out first — the stub has no Google to count.)
  });
});

// Two-way sync parity with lambdas/src/backend.calendar.test.ts → "calendar pull". The stub has no
// Google: an edit "made in Google" is queued on STUB_GCAL_EDITS_KEY and applied by the next pull.
describe('stub calendar pull (two-way sync)', () => {
  function setup() {
    let clock = 1_700_000_000_000;
    const api = createStubClient({
      seed: true,
      storageKey: `pull-${Math.random()}`,
      now: () => clock,
    });
    const tick = (ms = 61_000) => {
      clock += ms;
    };
    const queue = (edits: StubGcalEdit[]) =>
      localStorage.setItem(STUB_GCAL_EDITS_KEY, JSON.stringify(edits));
    const timed = () =>
      api.createTask({ title: 'pset', dueDay: '2026-10-09', dueTime: '16:00', estimateMin: 60 });
    return { api, tick, queue, timed };
  }

  it('applies a queued drag + rename through the shared planner, with the note', async () => {
    const { api, queue, timed } = setup();
    const t = await timed();
    queue([{ taskId: t.id, end: '2026-10-10 17:00', durationMin: 45, title: 'pset 3' }]);
    const res = await api.pullCalendar();
    expect(res.changedTaskIds).toEqual([t.id]);
    expect(await api.getTask(t.id)).toMatchObject({
      title: 'pset 3',
      dueDay: '2026-10-10',
      dueTime: '17:00',
      estimateMin: 45,
      gcalPulled: {
        note: 'Moved to Oct 10 5pm · Now 45m · Renamed to “pset 3” in Google Calendar',
      },
    });
    expect(localStorage.getItem(STUB_GCAL_EDITS_KEY)).toBeNull(); // consumed
  });

  it('an unchanged block is a no-op (no estimate → no estimateMin = 30)', async () => {
    const { api, queue } = setup();
    const t = await api.createTask({ title: 'x', dueDay: '2026-10-09', dueTime: '09:00' });
    queue([{ taskId: t.id }]);
    expect((await api.pullCalendar()).changedTaskIds).toEqual([]);
    expect((await api.getTask(t.id))!.estimateMin).toBeNull();
  });

  it('deleted in Google → unlinked with a note; all-day → title only; untimed task → title only', async () => {
    const { api, queue, timed } = setup();
    const del = await timed();
    const allDay = await timed();
    const plain = await api.createTask({ title: 'u', dueDay: '2026-10-09' });
    await api.insertCalendarEvent({
      taskId: plain.id,
      accountSub: 'seed-personal',
      calendarId: 'you@gmail.com',
      title: 'u',
      startMs: 0,
      endMs: 60_000,
    });
    queue([
      { taskId: del.id, cancelled: true },
      { taskId: allDay.id, allDay: true, title: 'ad' },
      { taskId: plain.id, title: 'u2', end: '2026-10-09 11:00' },
    ]);
    await api.pullCalendar();
    expect(await api.getTask(del.id)).toMatchObject({
      gcalEventId: null,
      gcalPulled: { note: 'Removed in Google Calendar' },
    });
    expect(await api.getTask(allDay.id)).toMatchObject({ title: 'ad', dueTime: '16:00' });
    expect(await api.getTask(plain.id)).toMatchObject({ title: 'u2', dueTime: null });
  });

  it('throttles to once a minute unless edits are queued; toggle off pulls nothing', async () => {
    const { api, tick, queue, timed } = setup();
    expect((await api.pullCalendar()).pulled).toBe(true);
    tick(10_000);
    expect((await api.pullCalendar()).pulled).toBe(false);
    const t = await timed();
    queue([{ taskId: t.id, title: 'q' }]);
    expect((await api.pullCalendar()).changedTaskIds).toEqual([t.id]); // the queue bypasses it
    await api.updateSettings({ autoCalendar: false });
    queue([{ taskId: t.id, title: 'off' }]);
    tick();
    expect((await api.pullCalendar()).pulled).toBe(false);
    expect((await api.getTask(t.id))!.title).toBe('q');
    localStorage.removeItem(STUB_GCAL_EDITS_KEY);
  });

  it('a failing account shows on its status; the other still pulls', async () => {
    const { api, queue } = setup();
    queue([{ failAccount: 'seed-school', error: 'timeout' }]);
    const res = await api.pullCalendar();
    expect(res.accounts).toEqual(
      expect.arrayContaining([
        { sub: 'seed-school', ok: false, error: 'timeout' },
        { sub: 'seed-personal', ok: true, error: null },
      ]),
    );
    const status = await api.getGoogleStatus();
    expect(status.accounts.find((a) => a.sub === 'seed-school')).toMatchObject({
      lastPullError: 'timeout',
    });
    expect(status.accounts.find((a) => a.sub === 'seed-personal')!.lastSyncedAt).toBeGreaterThan(0);
  });

  it('a push stamps the base with the clock; a queued edit (stamped at pull time) is newer', async () => {
    const { api, tick, queue, timed } = setup();
    const t = await timed();
    tick(1_000);
    queue([{ taskId: t.id, title: 'google' }]); // the queued edit is stamped at pull time…
    tick(1_000);
    await api.setTaskTitle(t.id, 'aperture'); // …so a later Aperture rename is still older than it
    expect((await api.getTask(t.id))!.gcalSeen!.updatedMs).toBeGreaterThan(0);
    await api.pullCalendar();
    expect((await api.getTask(t.id))!.title).toBe('google');
  });

  it('an unsent change wins over a queued Google edit to the same field, and the row says so', async () => {
    const { api, queue, timed } = setup();
    const t = await timed();
    await api.updateSettings({ autoCalendar: false });
    await api.setTaskDue(t.id, { dueDay: '2026-10-09', dueTime: '18:00' }); // never reaches "Google"
    await api.updateSettings({ autoCalendar: true });
    queue([{ taskId: t.id, end: '2026-10-09 17:00' }]);
    expect((await api.pullCalendar()).changedTaskIds).toEqual([t.id]);
    expect(await api.getTask(t.id)).toMatchObject({
      dueTime: '18:00',
      gcalPulled: { note: 'Kept your time — moved in Google Calendar too' },
    });
  });
});

describe('stub calendar pull: markers and named blocks', () => {
  function setup() {
    let clock = 1_700_000_000_000;
    const api = createStubClient({
      seed: true,
      storageKey: `pm-${Math.random()}`,
      now: () => clock,
    });
    const queue = (edits: StubGcalEdit[]) => {
      clock += 61_000;
      localStorage.setItem(STUB_GCAL_EDITS_KEY, JSON.stringify(edits));
    };
    return { api, queue };
  }

  it('dragging the marker’s end moves the deadline; stretching it maps to nothing', async () => {
    const { api, queue } = setup();
    const p = await api.createTask({ title: 'P2', dueDay: '2026-10-09', dueTime: '17:00' });
    await api.createTask({ title: 'read', parentId: p.id, estimateMin: 30 });
    queue([{ taskId: p.id, end: '2026-10-10 12:00' }]);
    expect((await api.pullCalendar()).changedTaskIds).toEqual([p.id]);
    expect(await api.getTask(p.id)).toMatchObject({
      dueDay: '2026-10-10',
      dueTime: '12:00',
      estimateMin: null,
    });
    queue([{ taskId: p.id, durationMin: 90 }]);
    expect((await api.pullCalendar()).changedTaskIds).toEqual([]);
    expect((await api.getTask(p.id))!.estimateMin).toBeNull();
  });

  it('a part block renamed in Google loses the parent prefix', async () => {
    const { api, queue } = setup();
    const p = await api.createTask({ title: 'P2' });
    const part = await api.createTask({
      title: 'Part 1',
      parentId: p.id,
      dueDay: '2026-10-09',
      dueTime: '10:00',
    });
    queue([{ taskId: part.id, title: 'P2 · Part 1 reading' }]);
    await api.pullCalendar();
    expect((await api.getTask(part.id))!.title).toBe('Part 1 reading');
    queue([{ taskId: part.id, title: 'Reading' }]);
    await api.pullCalendar();
    expect((await api.getTask(part.id))!.title).toBe('Reading');
  });
});
