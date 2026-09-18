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

  it('disconnect prunes the account, its shape refs, and a write-default pointing at it', async () => {
    const api = stub();
    await api.disconnectGoogleAccount('seed-personal');
    const s = await api.getSettings();
    expect(s.googleAccounts.map((a) => a.sub)).toEqual(['seed-school']);
    expect(s.calendarShapeRefs.some((r) => r.accountSub === 'seed-personal')).toBe(false);
    expect(s.calendarWriteDefault?.accountSub).not.toBe('seed-personal');
  });
});
