import { describe, expect, it } from 'vitest';
import { InMemoryDoc } from './ddb/DocClient';
import { Repo } from './ddb/repo';
import { liveWrites } from './ddb/writes';
import { BackendClient } from './backend';
import { InMemoryGoogle } from './google/gateway';
import { handleRpc } from './handler';
import { USER_TIME_ZONE, zonedEpoch } from '@aperture/shared';
import type { Task } from '@aperture/shared';

function makeBackend(google: InMemoryGoogle) {
  const doc = new InMemoryDoc();
  return new BackendClient(new Repo(doc, liveWrites(doc), 'local'), {
    userId: 'local',
    now: () => 1_700_000_000_000,
    google,
    stateSecret: 'test-secret',
  });
}

describe('backend Google Calendar (multi-account)', () => {
  it('connect records the account and status reflects it', async () => {
    const g = new InMemoryGoogle();
    const b = makeBackend(g);
    await b.completeGoogleConnect('A');
    expect(await b.getGoogleStatus()).toEqual({
      accounts: [{ sub: 'A', email: 'A@example.com', connected: true, reconnectRequired: false }],
    });
    // connect is idempotent per sub — reconnecting the same account doesn't duplicate it
    await b.completeGoogleConnect('A');
    expect((await b.getSettings()).googleAccounts).toHaveLength(1);
  });

  it('connect defaults the account primary into the shape set and write-default (no manual pick)', async () => {
    const g = new InMemoryGoogle();
    const b = makeBackend(g);
    await b.completeGoogleConnect('A');
    const s = await b.getSettings();
    // primary calendarId is the account email; seeded as a shape ref and the write default, deduped.
    expect(s.calendarShapeRefs).toEqual([{ accountSub: 'A', calendarId: 'A@example.com' }]);
    expect(s.calendarWriteDefault).toEqual({ accountSub: 'A', calendarId: 'A@example.com' });
    await b.completeGoogleConnect('A'); // reconnect doesn't duplicate the ref
    expect((await b.getSettings()).calendarShapeRefs).toHaveLength(1);
  });

  it('listGoogleCalendars returns each account primary without a calendarList call', async () => {
    const g = new InMemoryGoogle();
    const b = makeBackend(g);
    await b.completeGoogleConnect('A');
    await b.completeGoogleConnect('B');
    const cals = await b.listGoogleCalendars();
    expect(cals).toEqual([
      { accountSub: 'A', calendarId: 'A@example.com', summary: 'A@example.com', primary: true },
      { accountSub: 'B', calendarId: 'B@example.com', summary: 'B@example.com', primary: true },
    ]);
  });

  it('getCalendarBusy merges refs across accounts, and one dead token does not sink the read', async () => {
    const g = new InMemoryGoogle();
    const b = makeBackend(g);
    await b.completeGoogleConnect('A');
    await b.completeGoogleConnect('B');
    await b.updateSettings({
      calendarShapeRefs: [
        { accountSub: 'A', calendarId: 'A@example.com' },
        { accountSub: 'B', calendarId: 'B@example.com' },
      ],
    });
    g.seedBusy('A', 'A@example.com', { intervals: [{ startMs: 100, endMs: 200 }], allDayCount: 1 });
    g.seedBusy('B', 'B@example.com', { intervals: [{ startMs: 300, endMs: 400 }], allDayCount: 0 });

    const busy = await b.getCalendarBusy({ day: '2026-01-01', windowStartMs: 0, windowEndMs: 1000 });
    expect(busy.intervals).toHaveLength(2);
    expect(busy.allDayCount).toBe(1);

    g.markDead('B');
    const after = await b.getCalendarBusy({ day: '2026-01-01', windowStartMs: 0, windowEndMs: 1000 });
    expect(after.intervals).toEqual([{ startMs: 100, endMs: 200 }]);
    // and the dead account surfaces as reconnect-required
    const status = await b.getGoogleStatus();
    expect(status.accounts.find((a) => a.sub === 'B')?.reconnectRequired).toBe(true);
  });

  it('insert stores the owning account; a second insert throws; cancel deletes via that account', async () => {
    const g = new InMemoryGoogle();
    const b = makeBackend(g);
    await b.completeGoogleConnect('A');
    const t = await b.createTask({ title: 'Interview' });

    const withEvent = await b.insertCalendarEvent({
      taskId: t.id,
      accountSub: 'A',
      calendarId: 'A@example.com',
      title: 'Interview',
      startMs: 1000,
      endMs: 2000,
    });
    expect(withEvent.gcalAccountId).toBe('A');
    expect(withEvent.gcalEventId).toBeTruthy();
    expect(g.events.size).toBe(1);

    await expect(
      b.insertCalendarEvent({
        taskId: t.id,
        accountSub: 'A',
        calendarId: 'A@example.com',
        title: 'dup',
        startMs: 1,
        endMs: 2,
      }),
    ).rejects.toThrow();

    const cancelled = await b.transitionTask(t.id, 'cancelled');
    expect(cancelled.gcalEventId).toBeNull();
    expect(g.events.size).toBe(0);
  });

  it('delete-on-cancel never touches an event Aperture did not create', async () => {
    const g = new InMemoryGoogle();
    const b = makeBackend(g);
    await b.completeGoogleConnect('A');
    g.events.set('foreign', {
      sub: 'A',
      calendarId: 'A@example.com',
      title: 'real meeting',
      startMs: 0,
      endMs: 1,
    });
    const t = await b.createTask({ title: 'Study block' });
    await b.insertCalendarEvent({
      taskId: t.id,
      accountSub: 'A',
      calendarId: 'A@example.com',
      title: 'Study block',
      startMs: 1000,
      endMs: 2000,
    });
    await b.transitionTask(t.id, 'cancelled');
    expect(g.events.has('foreign')).toBe(true); // untouched
  });

  it('disconnect drops the token, the account, its shape refs, and a write-default pointing at it', async () => {
    const g = new InMemoryGoogle();
    const b = makeBackend(g);
    await b.completeGoogleConnect('A');
    await b.updateSettings({
      calendarShapeRefs: [{ accountSub: 'A', calendarId: 'A@example.com' }],
      calendarWriteDefault: { accountSub: 'A', calendarId: 'A@example.com' },
    });
    await b.disconnectGoogleAccount('A');

    const s = await b.getSettings();
    expect(s.googleAccounts).toEqual([]);
    expect(s.calendarShapeRefs).toEqual([]);
    expect(s.calendarWriteDefault).toBeNull();
    expect((await g.getAccountState('A')).connected).toBe(false);
  });

  it('connect URL carries a signed state', async () => {
    const g = new InMemoryGoogle();
    const { url } = await makeBackend(g).googleConnectUrl();
    expect(url).toContain('state=');
  });
});

describe('deleteTask hard-deletes the calendar event (via the cancel path)', () => {
  it('removes the event through its owning account, and leaves foreign events alone', async () => {
    const g = new InMemoryGoogle();
    const b = makeBackend(g);
    await b.completeGoogleConnect('A');
    g.events.set('foreign', {
      sub: 'A',
      calendarId: 'A@example.com',
      title: 'real meeting',
      startMs: 0,
      endMs: 1,
    });
    const t = await b.createTask({ title: 'Interview' });
    await b.insertCalendarEvent({
      taskId: t.id,
      accountSub: 'A',
      calendarId: 'A@example.com',
      title: 'Interview',
      startMs: 1000,
      endMs: 2000,
    });
    expect(g.events.size).toBe(2); // foreign + ours

    await b.deleteTask(t.id);
    expect(await b.getTask(t.id)).toBeNull(); // task tombstoned
    expect(g.events.size).toBe(1); // only ours removed
    expect(g.events.has('foreign')).toBe(true); // never touched
  });

  it('still tombstones the task when the calendar delete fails (the inherited silent orphan)', async () => {
    const g = new InMemoryGoogle();
    const b = makeBackend(g);
    await b.completeGoogleConnect('A');
    const t = await b.createTask({ title: 'doomed' });
    await b.insertCalendarEvent({
      taskId: t.id,
      accountSub: 'A',
      calendarId: 'A@example.com',
      title: 'doomed',
      startMs: 1000,
      endMs: 2000,
    });
    g.markDead('A'); // expired token → deleteEvent throws, swallowed by deleteCalendarEvent

    await b.deleteTask(t.id);
    expect(await b.getTask(t.id)).toBeNull(); // local delete still succeeds…
    expect(g.events.size).toBe(1); // …but the event is orphaned (parity with cancel; pinned, not fixed)
  });

  it('testMode routes deleteTask through both no-op seams — no Google call, nothing persisted', async () => {
    const g = new InMemoryGoogle();
    const doc = new InMemoryDoc();
    const now = () => 1_700_000_000_000;
    const b = new BackendClient(new Repo(doc, liveWrites(doc), 'local'), {
      userId: 'local',
      now,
      google: g,
    });
    await b.completeGoogleConnect('A');
    const t = await b.createTask({ title: 'kept' });
    await b.insertCalendarEvent({
      taskId: t.id,
      accountSub: 'A',
      calendarId: 'A@example.com',
      title: 'kept',
      startMs: 1000,
      endMs: 2000,
    });

    await handleRpc(doc, { userId: 'local', method: 'deleteTask', args: [t.id], now, testMode: true, google: g });
    expect(await b.getTask(t.id)).not.toBeNull(); // noopWrites → nothing tombstoned
    expect(g.events.size).toBe(1); // noopGoogle → event untouched
  });
});

// The gate: a testMode run of every calendar method uses noopGoogle — no SSM token read, no Google
// fetch, no burned refresh token. Reads return empty; the connect URL is the disabled placeholder.
describe('testMode makes zero external Google calls', () => {
  it('routes calendar methods through noopGoogle', async () => {
    const doc = new InMemoryDoc();
    const call = (method: string, args: unknown[] = []) =>
      handleRpc(doc, { userId: 'smoke', method, args, testMode: true });

    expect(await call('getGoogleStatus')).toEqual({ accounts: [] });
    expect(await call('getCalendarBusy', [{ day: 'x', windowStartMs: 0, windowEndMs: 1 }])).toEqual({
      intervals: [],
      allDayCount: 0,
    });
    expect(await call('listGoogleCalendars')).toEqual([]);
    expect(await call('googleConnectUrl')).toEqual({ url: '#google-connect-disabled-in-testmode' });
  });
});

// Auto-sync for timed tasks (shared calendarSyncPlan; docs/areas/calendar → Auto-sync). The event ENDS
// at the deadline in the user's zone, as long as the estimate (30 min without one). Parity scenarios:
// app/src/data/stubClient.calendar.test.ts.
describe('calendar auto-sync (timed tasks)', () => {
  const at = (day: string, hhmm: string) => zonedEpoch(day, hhmm, USER_TIME_ZONE);
  async function connected() {
    const g = new InMemoryGoogle();
    const b = makeBackend(g);
    await b.completeGoogleConnect('A'); // primary becomes the write default; auto-sync defaults on
    return { g, b };
  }
  const only = (g: InMemoryGoogle) => [...g.events.entries()][0]!;

  it('a timed create makes one event ending at the deadline; untimed makes none', async () => {
    const { g, b } = await connected();
    await b.createTask({ title: 'untimed', dueDay: '2026-10-09' });
    expect(g.events.size).toBe(0);
    const t = await b.createTask({
      title: 'pset',
      dueDay: '2026-10-09',
      dueTime: '16:00',
      estimateMin: 45,
    });
    expect(g.events.size).toBe(1);
    const [id, evt] = only(g);
    expect(evt).toMatchObject({
      sub: 'A',
      calendarId: 'A@example.com',
      title: 'pset',
      startMs: at('2026-10-09', '15:15'),
      endMs: at('2026-10-09', '16:00'),
    });
    expect(t).toMatchObject({ gcalEventId: id, gcalAccountId: 'A', gcalSyncError: null });
  });

  it('no estimate → a 30-minute block', async () => {
    const { g, b } = await connected();
    await b.createTask({ title: 'x', dueDay: '2026-10-09', dueTime: '09:00' });
    expect(only(g)[1].startMs).toBe(at('2026-10-09', '08:30'));
  });

  it('day, time, estimate and title edits move/rename the SAME event', async () => {
    const { g, b } = await connected();
    const t = await b.createTask({
      title: 'pset',
      dueDay: '2026-10-09',
      dueTime: '16:00',
      estimateMin: 60,
    });
    const id = t.gcalEventId;
    await b.setTaskDue(t.id, { dueDay: '2026-10-10' });
    expect(only(g)[1].endMs).toBe(at('2026-10-10', '16:00'));
    await b.setTaskDue(t.id, { dueDay: '2026-10-10', dueTime: '18:30' });
    expect(only(g)[1].endMs).toBe(at('2026-10-10', '18:30'));
    await b.setTaskEstimate(t.id, 90, 0);
    expect(only(g)[1].startMs).toBe(at('2026-10-10', '17:00'));
    await b.setTaskTitle(t.id, 'pset 3');
    expect(only(g)[1].title).toBe('pset 3');
    expect(g.events.size).toBe(1);
    expect((await b.getTask(t.id))!.gcalEventId).toBe(id);
  });

  it('clearing the time (or the day) removes the event and the pointers', async () => {
    const { g, b } = await connected();
    const t = await b.createTask({ title: 'x', dueDay: '2026-10-09', dueTime: '16:00' });
    const cleared = await b.setTaskDue(t.id, { dueDay: '2026-10-09', dueTime: null });
    expect(g.events.size).toBe(0);
    expect(cleared).toMatchObject({ gcalEventId: null, gcalAccountId: null, gcalCalendarId: null });
    const t2 = await b.createTask({ title: 'y', dueDay: '2026-10-09', dueTime: '16:00' });
    await b.setTaskDueDay(t2.id, null);
    expect(g.events.size).toBe(0);
  });

  it('a manually added event moves to end at the deadline when the task gains a time — no duplicate', async () => {
    const { g, b } = await connected();
    const t = await b.createTask({ title: 'x', dueDay: '2026-10-09', estimateMin: 60 });
    await b.insertCalendarEvent({
      taskId: t.id,
      accountSub: 'A',
      calendarId: 'A@example.com',
      title: 'x',
      startMs: at('2026-10-09', '09:00'),
      endMs: at('2026-10-09', '10:00'),
    });
    await b.setTaskDue(t.id, { dueDay: '2026-10-09', dueTime: '17:00' });
    expect(g.events.size).toBe(1);
    expect(only(g)[1]).toMatchObject({
      startMs: at('2026-10-09', '16:00'),
      endMs: at('2026-10-09', '17:00'),
    });
  });

  it('done leaves the event; cancel removes it (pre-existing delete-on-cancel)', async () => {
    const { g, b } = await connected();
    const t = await b.createTask({ title: 'x', dueDay: '2026-10-09', dueTime: '16:00' });
    await b.transitionTask(t.id, 'in_progress');
    await b.transitionTask(t.id, 'done');
    expect(g.events.size).toBe(1);
    const t2 = await b.createTask({ title: 'y', dueDay: '2026-10-09', dueTime: '16:00' });
    await b.transitionTask(t2.id, 'cancelled');
    expect(g.events.size).toBe(1);
  });

  it('toggle off: no create, and existing events stay put (no patch, no delete)', async () => {
    const { g, b } = await connected();
    const t = await b.createTask({ title: 'x', dueDay: '2026-10-09', dueTime: '16:00' });
    await b.updateSettings({ autoCalendar: false });
    await b.createTask({ title: 'new', dueDay: '2026-10-09', dueTime: '12:00' });
    await b.setTaskTitle(t.id, 'renamed');
    await b.setTaskDue(t.id, { dueDay: '2026-10-09', dueTime: null });
    expect(g.events.size).toBe(1);
    expect(only(g)[1]).toMatchObject({ title: 'x', endMs: at('2026-10-09', '16:00') });
  });

  it('createTasks makes events for the timed rows only', async () => {
    const { g, b } = await connected();
    const made = await b.createTasks([
      { title: 'a', dueDay: '2026-10-09', dueTime: '10:00' },
      { title: 'b', dueDay: '2026-10-09' },
      { title: 'c' },
      { title: 'd', dueDay: '2026-10-10', dueTime: '23:59' },
    ]);
    expect(g.events.size).toBe(2);
    expect(made.map((t) => !!t.gcalEventId)).toEqual([true, false, false, true]);
  });

  it('a Google failure never fails the write: it lands as gcalSyncError, and the retry clears it', async () => {
    const { g, b } = await connected();
    g.markDead('A');
    const t = await b.createTask({ title: 'x', dueDay: '2026-10-09', dueTime: '16:00' });
    expect(t.gcalSyncError).toBe('invalid_grant');
    expect(t.gcalEventId).toBeNull();
    expect((await b.getTask(t.id))!.gcalSyncError).toBe('invalid_grant'); // persisted
    await b.completeGoogleConnect('A'); // reconnect revives the token
    const retried = await b.syncCalendarEvent(t.id);
    expect(retried).toMatchObject({ gcalSyncError: null });
    expect(retried.gcalEventId).not.toBeNull();
    expect(g.events.size).toBe(1);
  });

  it('a stale failure note clears once there is nothing left to sync', async () => {
    const { g, b } = await connected();
    g.markDead('A');
    const t = await b.createTask({ title: 'x', dueDay: '2026-10-09', dueTime: '16:00' });
    expect(t.gcalSyncError).not.toBeNull();
    expect(
      (await b.setTaskDue(t.id, { dueDay: '2026-10-09', dueTime: null })).gcalSyncError,
    ).toBeNull();
  });

  it('an event deleted in Google is unlinked, not resurrected; a later time change makes a new one', async () => {
    const { g, b } = await connected();
    const t = await b.createTask({ title: 'x', dueDay: '2026-10-09', dueTime: '16:00' });
    g.events.clear(); // the user deleted it in Google
    const renamed = await b.setTaskTitle(t.id, 'y');
    expect(renamed).toMatchObject({ gcalEventId: null, gcalSyncError: null });
    expect(g.events.size).toBe(0);
    await b.setTaskDue(t.id, { dueDay: '2026-10-09', dueTime: '17:00' });
    expect(g.events.size).toBe(1);
  });

  it('split: a cancelled original drops its event; a timed follow-up gets its own', async () => {
    const { g, b } = await connected();
    const t = await b.createTask({ title: 'x', dueDay: '2026-10-09', dueTime: '16:00' });
    const first = t.gcalEventId!;
    const { original, followUp } = await b.splitTask(t.id, 'cancelled', 'x, part 2');
    expect(original.gcalEventId).toBeNull();
    expect(followUp.gcalEventId).not.toBeNull();
    expect(g.events.has(first)).toBe(false);
    expect(g.events.size).toBe(1);
  });

  it('testMode: a timed create touches no Google and persists nothing', async () => {
    const g = new InMemoryGoogle();
    const doc = new InMemoryDoc();
    const now = () => 1_700_000_000_000;
    const b = new BackendClient(new Repo(doc, liveWrites(doc), 'local'), {
      userId: 'local',
      now,
      google: g,
    });
    await b.completeGoogleConnect('A');
    const res = (await handleRpc(doc, {
      userId: 'local',
      method: 'createTask',
      args: [{ title: 'smoke', dueDay: '2026-10-09', dueTime: '16:00' }],
      now,
      testMode: true,
      google: g,
    })) as Task;
    expect(g.events.size).toBe(0); // noopGoogle
    expect(await b.getTask(res.id)).toBeNull(); // noopWrites
  });
});
