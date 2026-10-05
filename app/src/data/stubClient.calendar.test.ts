import { describe, expect, it } from 'vitest';
import { createStubClient } from './stubClient';

// Parity for the gated calendar methods. These can't live in the shared ApiClient contract suite: their
// behavior depends on external gateway state (connected accounts) that can't be established through the
// ApiClient interface — connect is a browser OAuth redirect, not a method. So the stub is held to the
// SAME behavior the backend asserts in lambdas/src/backend.calendar.test.ts, via this parallel test. The
// seeded store provides two connected accounts (seed-personal, seed-school).
function stub() {
  return createStubClient({ seed: true, storageKey: `cal-${Math.random()}`, now: () => 1_700_000_000_000 });
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
    const busy = await stub().getCalendarBusy({ day: '2026-01-01', windowStartMs: 0, windowEndMs: 50_000_000 });
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
    expect((await api.setTaskDue(t.id, { dueDay: '2026-10-10', dueTime: null })).gcalEventId).toBeNull();
  });
  it('toggle off: no create, and an existing link is left alone', async () => {
    const api = stub();
    const t = await api.createTask({ title: 't', dueDay: '2026-10-09', dueTime: '16:00' });
    await api.updateSettings({ autoCalendar: false });
    expect((await api.createTask({ title: 'n', dueDay: '2026-10-09', dueTime: '12:00' })).gcalEventId).toBeNull();
    expect((await api.setTaskDue(t.id, { dueDay: '2026-10-09', dueTime: null })).gcalEventId).toBe(t.gcalEventId);
  });
  it('createTasks links only the timed rows; split-cancel moves the link to the timed follow-up', async () => {
    const api = stub();
    const made = await api.createTasks([
      { title: 'a', dueDay: '2026-10-09', dueTime: '10:00' },
      { title: 'b', dueDay: '2026-10-09' },
    ]);
    expect(made.map((t) => !!t.gcalEventId)).toEqual([true, false]);
    const { original, followUp } = await api.splitTask(made[0]!.id, 'cancelled', 'a, part 2');
    expect(original.gcalEventId).toBeNull();
    expect(followUp.gcalEventId).toBeTruthy();
    expect(followUp.gcalEventId).not.toBe(made[0]!.gcalEventId);
  });
});
