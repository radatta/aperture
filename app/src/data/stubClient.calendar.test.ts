import { describe, expect, it } from 'vitest';
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
      gcalPulledNote: 'Moved to Oct 10 5pm · Now 45m · Renamed to “pset 3” in Google Calendar',
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

  it('deleted in Google → unlinked with a note; all-day → title only; manual block → title only', async () => {
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
      gcalPulledNote: 'Removed in Google Calendar',
    });
    expect(await api.getTask(allDay.id)).toMatchObject({ title: 'ad', dueTime: '16:00' });
    expect(await api.getTask(plain.id)).toMatchObject({
      title: 'u2',
      dueTime: null,
      gcalManual: true,
    });
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

  it('a rename stamps the latest-wins clock; a queued edit (stamped at pull time) is newer', async () => {
    const { api, tick, queue, timed } = setup();
    const t = await timed();
    tick(1_000);
    queue([{ taskId: t.id, title: 'google' }]); // the queued edit is stamped at pull time…
    tick(1_000);
    await api.setTaskTitle(t.id, 'aperture'); // …so a later Aperture rename is still older than it
    expect((await api.getTask(t.id))!.gcalTouchedAt).toBeGreaterThan(0);
    await api.pullCalendar();
    expect((await api.getTask(t.id))!.title).toBe('google');
  });
});
