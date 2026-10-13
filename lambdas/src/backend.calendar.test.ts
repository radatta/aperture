import { describe, expect, it, vi } from 'vitest';
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
      accounts: [
        {
          sub: 'A',
          email: 'A@example.com',
          connected: true,
          reconnectRequired: false,
          lastSyncedAt: null, // never pulled yet
          lastPullError: null,
        },
      ],
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

    const busy = await b.getCalendarBusy({
      day: '2026-01-01',
      windowStartMs: 0,
      windowEndMs: 1000,
    });
    expect(busy.intervals).toHaveLength(2);
    expect(busy.allDayCount).toBe(1);

    g.markDead('B');
    const after = await b.getCalendarBusy({
      day: '2026-01-01',
      windowStartMs: 0,
      windowEndMs: 1000,
    });
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

    await handleRpc(doc, {
      userId: 'local',
      method: 'deleteTask',
      args: [t.id],
      now,
      testMode: true,
      google: g,
    });
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
    expect(await call('getCalendarBusy', [{ day: 'x', windowStartMs: 0, windowEndMs: 1 }])).toEqual(
      {
        intervals: [],
        allDayCount: 0,
      },
    );
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
    expect(t.gcalSyncError).toBe('Couldn’t add the calendar event (invalid_grant)');
    expect(t.gcalEventId).toBeNull();
    expect((await b.getTask(t.id))!.gcalSyncError).toBe(t.gcalSyncError); // persisted
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

  it('a done split moves the event to the follow-up — renamed, never duplicated', async () => {
    const { g, b } = await connected();
    const t = await b.createTask({ title: 'x', dueDay: '2026-10-09', dueTime: '16:00' });
    await b.transitionTask(t.id, 'in_progress');
    const { original, followUp } = await b.splitTask(t.id, {
      finish: 'done',
      followUp: { title: 'x, part 2', estimateMin: null },
    });
    expect(original.gcalEventId).toBeNull();
    expect(followUp.gcalEventId).toBe(t.gcalEventId);
    expect(g.events.size).toBe(1);
    expect(only(g)[1].title).toBe('x, part 2');
  });

  it('a done split clears the original’s two-way state and gives the follow-up the event’s', async () => {
    const { b } = await connected();
    const t = await b.createTask({ title: 'x', dueDay: '2026-10-09', dueTime: '16:00' });
    await b.transitionTask(t.id, 'in_progress');
    const { original, followUp } = await b.splitTask(t.id, {
      finish: 'done',
      followUp: { title: 'x, part 2', estimateMin: null },
    });
    expect(original.gcalSeen ?? null).toBeNull();
    expect(followUp).toMatchObject({
      gcalSeen: {
        title: 'x, part 2',
        endMs: at('2026-10-09', '16:00'),
        updatedMs: expect.any(Number),
      },
    });
  });

  it('a done split moves a picked block on a timed task to the follow-up, re-timed to the deadline', async () => {
    const { g, b } = await connected();
    await b.updateSettings({ autoCalendar: false }); // the picker is offered with sync off
    const t = await b.createTask({ title: 'x', dueDay: '2026-10-09', dueTime: '16:00' });
    const manual = await b.insertCalendarEvent({
      taskId: t.id,
      accountSub: 'A',
      calendarId: 'A@example.com',
      title: 'x',
      startMs: at('2026-10-09', '09:00'),
      endMs: at('2026-10-09', '10:00'),
    });
    await b.updateSettings({ autoCalendar: true });
    await b.transitionTask(t.id, 'in_progress');
    const { original, followUp } = await b.splitTask(t.id, {
      finish: 'done',
      followUp: { title: 'x, part 2', estimateMin: null },
    });
    // A timed task's one block is its auto block, whatever placed it.
    expect(original.gcalEventId).toBeNull();
    expect(followUp.gcalEventId).toBe(manual.gcalEventId);
    expect(g.events.size).toBe(1);
    expect(g.events.get(manual.gcalEventId!)).toMatchObject({
      title: 'x, part 2',
      endMs: at('2026-10-09', '16:00'),
    });
  });

  it('a done split re-times the moved event to the follow-up’s estimate', async () => {
    const { g, b } = await connected();
    const t = await b.createTask({
      title: 'x',
      estimateMin: 30,
      dueDay: '2026-10-09',
      dueTime: '16:00',
    });
    await b.transitionTask(t.id, 'in_progress');
    await b.splitTask(t.id, {
      finish: 'done',
      actualMin: 20,
      followUp: { title: 'x, part 2', estimateMin: 90 },
    });
    expect(only(g)[1].startMs).toBe(at('2026-10-09', '14:30'));
  });

  it('a keep split with an owed removal carries it out', async () => {
    const { g, b } = await connected();
    const t = await b.createTask({ title: 'x', dueDay: '2026-10-09', dueTime: '16:00' });
    g.markDead('A');
    await b.setTaskDue(t.id, { dueDay: '2026-10-09', dueTime: null }); // remove fails → owed
    await b.completeGoogleConnect('A');
    const { original } = await b.splitTask(t.id, {
      finish: 'keep',
      followUp: { title: 'x, part 2', estimateMin: null },
    });
    expect(original).toMatchObject({ gcalEventId: null, gcalSyncError: null });
    expect(g.events.size).toBe(0);
  });

  it('a keep split leaves the original its event and gives the follow-up its own block', async () => {
    const { g, b } = await connected();
    const t = await b.createTask({ title: 'x', dueDay: '2026-10-09', dueTime: '16:00' });
    const { original, followUp } = await b.splitTask(t.id, {
      finish: 'keep',
      followUp: { title: 'x, part 2', estimateMin: 30 },
    });
    expect(original.gcalEventId).toBe(t.gcalEventId);
    expect(followUp.gcalEventId).not.toBeNull();
    expect(followUp.gcalEventId).not.toBe(t.gcalEventId);
    // Two blocks, one per part (Part 1 is the original renamed); the new parent has none.
    expect([...g.events.values()].map((e) => e.title).sort()).toEqual(['Part 1', 'x, part 2']);
  });

  it("a started task's estimate edit re-times its event", async () => {
    const { g, b } = await connected();
    const t = await b.createTask({
      title: 'x',
      estimateMin: 30,
      dueDay: '2026-10-09',
      dueTime: '16:00',
    });
    await b.transitionTask(t.id, 'in_progress');
    await b.setTaskEstimate(t.id, 90, null);
    expect(only(g)[1].startMs).toBe(at('2026-10-09', '14:30'));
  });

  it('a failed remove keeps the event linked and says so; the retry finishes the removal', async () => {
    const { g, b } = await connected();
    const t = await b.createTask({ title: 'x', dueDay: '2026-10-09', dueTime: '16:00' });
    g.markDead('A');
    const failed = await b.setTaskDue(t.id, { dueDay: '2026-10-09', dueTime: null });
    expect(failed.gcalEventId).toBe(t.gcalEventId); // still linked — nothing silently orphaned
    expect(failed.gcalSyncError).toMatch(/^Couldn’t remove the calendar event/);
    expect(g.events.size).toBe(1);
    await b.completeGoogleConnect('A');
    const retried = await b.syncCalendarEvent(t.id);
    expect(retried).toMatchObject({ gcalEventId: null, gcalSyncError: null });
    expect(g.events.size).toBe(0);
  });

  it('a pending removal survives an ordinary edit — the next sync removes it, never adopts it', async () => {
    const { g, b } = await connected();
    const t = await b.createTask({ title: 'x', dueDay: '2026-10-09', dueTime: '16:00' });
    g.markDead('A');
    await b.setTaskDue(t.id, { dueDay: '2026-10-09', dueTime: null });
    await b.completeGoogleConnect('A');
    const renamed = await b.setTaskTitle(t.id, 'renamed'); // not a retry
    expect(renamed).toMatchObject({ gcalEventId: null, gcalSyncError: null });
    expect(g.events.size).toBe(0);
  });

  it('split keeps a manual event on an untimed original, done or kept going', async () => {
    for (const finish of ['done', 'keep'] as const) {
      const { g, b } = await connected();
      const t = await b.createTask({ title: 'x', dueDay: '2026-10-09' });
      await b.insertCalendarEvent({
        taskId: t.id,
        accountSub: 'A',
        calendarId: 'A@example.com',
        title: 'x',
        startMs: at('2026-10-08', '14:00'),
        endMs: at('2026-10-08', '15:00'),
      });
      await b.transitionTask(t.id, 'in_progress');
      const { original, followUp } = await b.splitTask(t.id, {
        finish,
        title: 'x', // keeps its title, so the manual block isn't renamed
        followUp: { title: 'x, part 2', estimateMin: null },
      });
      expect(followUp.gcalEventId).toBeNull();
      expect(original.gcalEventId).not.toBeNull();
      expect(g.events.size).toBe(1);
      expect(only(g)[1].title).toBe('x'); // the record of the work done, untouched
    }
  });

  // Parent + parts (parts.ts): a parent never owns an event, by any path. Parity: the stub's
  // "stub calendar: parent + parts".
  describe('parent + parts', () => {
    const pick = (b: Awaited<ReturnType<typeof connected>>['b'], taskId: string) =>
      b.insertCalendarEvent({
        taskId,
        accountSub: 'A',
        calendarId: 'A@example.com',
        title: 'x',
        startMs: at('2026-10-08', '14:00'),
        endMs: at('2026-10-08', '15:00'),
      });

    it('a timed task that takes its first part loses its block; a retry on it never makes one', async () => {
      const { g, b } = await connected();
      const p = await b.createTask({ title: 'P2', dueDay: '2026-10-09', dueTime: '23:59' });
      expect(g.events.size).toBe(1);
      await b.createTask({ title: 'read', parentId: p.id });
      expect(g.events.size).toBe(0);
      expect((await b.getTask(p.id))?.gcalEventId).toBeNull();
      expect((await b.syncCalendarEvent(p.id)).gcalEventId).toBeNull();
      await b.setTaskDue(p.id, { dueDay: '2026-10-10', dueTime: '12:00' });
      expect(g.events.size).toBe(0);
    });

    it('the picker refuses a parent before any other check; an untimed part can take one', async () => {
      const { g, b } = await connected();
      const p = await b.createTask({ title: 'P2', dueDay: '2026-10-09', dueTime: '23:59' });
      const part = await b.createTask({ title: 'read', parentId: p.id });
      await expect(pick(b, p.id)).rejects.toThrow(/its parts do/);
      expect(g.events.size).toBe(0);
      await expect(pick(b, part.id)).resolves.toMatchObject({ gcalEventId: expect.any(String) });
    });

    it('a timed standalone done split moves the event and its base to Part 2; the parent never inserts', async () => {
      const { g, b } = await connected();
      const t = await b.createTask({ title: 'x', dueDay: '2026-10-09', dueTime: '16:00' });
      await b.transitionTask(t.id, 'in_progress');
      const insert = vi.spyOn(g, 'insertEvent');
      const { parent, original, followUp } = await b.splitTask(t.id, {
        finish: 'done',
        followUp: { title: 'x, part 2', estimateMin: null },
      });
      expect(insert).not.toHaveBeenCalled();
      expect(parent.gcalEventId).toBeNull();
      expect(original.gcalEventId).toBeNull();
      expect(followUp.gcalEventId).toBe(t.gcalEventId);
      expect(followUp.gcalSeen?.title).toBe('x, part 2'); // the base came along; its push renamed it
      expect(g.events.size).toBe(1);
    });

    it('cancelling a parent removes its open parts’ blocks; deleting it removes them all', async () => {
      const { g, b } = await connected();
      const p = await b.createTask({ title: 'P2' });
      await b.createTask({ title: 'a', parentId: p.id, dueDay: '2026-10-09', dueTime: '10:00' });
      await b.createTask({ title: 'b', parentId: p.id, dueDay: '2026-10-09', dueTime: '12:00' });
      expect(g.events.size).toBe(2);
      await b.transitionTask(p.id, 'cancelled');
      expect(g.events.size).toBe(0);
      const q = await b.createTask({ title: 'Q' });
      await b.createTask({ title: 'c', parentId: q.id, dueDay: '2026-10-09', dueTime: '10:00' });
      expect(g.events.size).toBe(1);
      await b.deleteTask(q.id);
      expect(g.events.size).toBe(0);
    });
  });

  it('bulk create: once Google fails, the rest are marked for Retry without being attempted', async () => {
    const { g, b } = await connected();
    g.markDead('A');
    const insert = vi.spyOn(g, 'insertEvent');
    const rows = Array.from({ length: 10 }, (_, i) => ({
      title: `t${i}`,
      dueDay: '2026-10-09',
      dueTime: '16:00',
    }));
    const made = await b.createTasks([...rows, { title: 'untimed' }]);
    expect(made).toHaveLength(11);
    expect(made.slice(0, 10).every((t) => t.gcalSyncError)).toBe(true);
    expect(made[10]!.gcalSyncError).toBeNull();
    expect(insert.mock.calls.length).toBeLessThanOrEqual(4); // the first wave only
    expect(made.some((t) => /not attempted/.test(t.gcalSyncError ?? ''))).toBe(true);
  });

  it('finishing a task with an owed removal carries it out; if Google still fails the note stays', async () => {
    const { g, b } = await connected();
    const t = await b.createTask({ title: 'x', dueDay: '2026-10-09', dueTime: '16:00' });
    g.markDead('A');
    await b.setTaskDue(t.id, { dueDay: '2026-10-09', dueTime: null }); // remove fails → owed
    await b.transitionTask(t.id, 'in_progress');
    const stillDown = await b.transitionTask(t.id, 'done');
    expect(stillDown.gcalEventId).toBe(t.gcalEventId);
    expect(stillDown.gcalSyncError).toMatch(/^Couldn’t remove/); // not silently dropped
    await b.completeGoogleConnect('A');
    expect(await b.syncCalendarEvent(t.id)).toMatchObject({
      gcalEventId: null,
      gcalSyncError: null,
    });
    expect(g.events.size).toBe(0);
  });

  it('a split with an owed removal reports a failure instead of orphaning the event', async () => {
    const { g, b } = await connected();
    const t = await b.createTask({ title: 'x', dueDay: '2026-10-09', dueTime: '16:00' });
    g.markDead('A');
    await b.setTaskDue(t.id, { dueDay: '2026-10-09', dueTime: null });
    await b.transitionTask(t.id, 'in_progress');
    const { original } = await b.splitTask(t.id, {
      finish: 'done',
      followUp: { title: 'x, part 2', estimateMin: null },
    });
    expect(original.gcalEventId).toBe(t.gcalEventId);
    expect(original.gcalSyncError).toMatch(/^Couldn’t remove/);
    expect(g.events.size).toBe(1);
  });

  it('an owed removal is still carried out on cancel after sync was turned off', async () => {
    const { g, b } = await connected();
    const t = await b.createTask({ title: 'x', dueDay: '2026-10-09', dueTime: '16:00' });
    g.markDead('A');
    await b.setTaskDue(t.id, { dueDay: '2026-10-09', dueTime: null });
    await b.completeGoogleConnect('A');
    await b.updateSettings({ autoCalendar: false });
    const cancelled = await b.transitionTask(t.id, 'cancelled');
    expect(cancelled).toMatchObject({ gcalEventId: null, gcalSyncError: null });
    expect(g.events.size).toBe(0);
  });

  it('finishing a task clears its failure note', async () => {
    const { g, b } = await connected();
    g.markDead('A');
    const t = await b.createTask({ title: 'x', dueDay: '2026-10-09', dueTime: '16:00' });
    await b.transitionTask(t.id, 'in_progress');
    expect((await b.transitionTask(t.id, 'done')).gcalSyncError).toBeNull();
  });

  it('a failure note with nothing left to retry clears (toggle off, or the task finished)', async () => {
    const { g, b } = await connected();
    g.markDead('A');
    const t = await b.createTask({ title: 'x', dueDay: '2026-10-09', dueTime: '16:00' });
    expect(t.gcalSyncError).not.toBeNull();
    await b.updateSettings({ autoCalendar: false });
    expect((await b.syncCalendarEvent(t.id)).gcalSyncError).toBeNull();
  });

  it('the sync writes only calendar fields onto a fresh read (a concurrent write survives)', async () => {
    const { g, b } = await connected();
    const t = await b.createTask({ title: 'x', dueDay: '2026-10-09', dueTime: '16:00' });
    const realPatch = g.patchEvent.bind(g);
    g.patchEvent = async (input) => {
      await b.setTaskActual(t.id, 42); // lands while Google is in flight
      return realPatch(input);
    };
    await b.setTaskTitle(t.id, 'y');
    g.markDead('A'); // force the failure path's write too
    await b.setTaskTitle(t.id, 'z');
    expect((await b.getTask(t.id))!.actualAccruedMin).toBe(42);
  });

  it('an estimate of 0 gets the default block', async () => {
    const { g, b } = await connected();
    await b.createTask({ title: 'x', dueDay: '2026-10-09', dueTime: '09:00', estimateMin: 0 });
    expect(only(g)[1].startMs).toBe(at('2026-10-09', '08:30'));
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

// Two-way sync, Google → task (calendarPull.ts plans; docs/areas/calendar → Two-way sync). Parity
// scenarios: app/src/data/stubClient.calendar.test.ts.
describe('calendar pull (two-way sync)', () => {
  const at = (day: string, hhmm: string) => zonedEpoch(day, hhmm, USER_TIME_ZONE);
  const MIN = 60_000;
  async function setup() {
    let clock = 1_700_000_000_000;
    const g = new InMemoryGoogle();
    g.clock = () => clock;
    const doc = new InMemoryDoc();
    const repo = new Repo(doc, liveWrites(doc), 'local');
    const b = new BackendClient(repo, {
      userId: 'local',
      now: () => clock,
      google: g,
      stateSecret: 'test-secret',
    });
    await b.completeGoogleConnect('A');
    const tick = (ms = 61_000) => {
      clock += ms;
    };
    // Every test starts past a first pull, a minute later.
    const baseline = async () => {
      await b.pullCalendar();
      tick();
    };
    const timed = (over: Record<string, unknown> = {}) =>
      b.createTask({
        title: 'pset',
        dueDay: '2026-10-09',
        dueTime: '16:00',
        estimateMin: 60,
        ...over,
      });
    return { g, b, doc, repo, tick, baseline, timed };
  }

  it('a drag of the end moves the deadline; the start sets the estimate; a rename renames', async () => {
    const { g, b, tick, baseline, timed } = await setup();
    const t = await timed();
    await baseline();
    const patchesBefore = g.patches.length;
    g.editEvent(t.gcalEventId!, {
      title: 'pset 3',
      startMs: at('2026-10-10', '16:15'),
      endMs: at('2026-10-10', '17:00'),
    });
    tick();
    const res = await b.pullCalendar();
    expect(res).toEqual({
      pulled: true,
      changedTaskIds: [t.id],
      accounts: [{ sub: 'A', ok: true, error: null }],
    });
    expect(await b.getTask(t.id)).toMatchObject({
      title: 'pset 3',
      dueDay: '2026-10-10',
      dueTime: '17:00',
      estimateMin: 45,
      gcalEventId: t.gcalEventId,
      gcalPulled: {
        at: expect.any(Number),
        note: 'Moved to Oct 10 5pm · Now 45m · Renamed to “pset 3” in Google Calendar',
      },
    });
    expect(g.patches.length).toBe(patchesBefore); // a pull never writes to Google
  });

  it('our own push coming back is a no-op — including a no-estimate task’s 30-minute block', async () => {
    const { g, b, tick, baseline, timed } = await setup();
    await baseline();
    const t = await timed({ estimateMin: undefined });
    await b.setTaskTitle(t.id, 'renamed'); // a push that comes back in the next delta
    tick();
    expect((await b.pullCalendar()).changedTaskIds).toEqual([]);
    const after = (await b.getTask(t.id))!;
    expect(after.estimateMin).toBeNull();
    expect(after.gcalPulled ?? null).toBeNull();
    expect(g.events.get(t.gcalEventId!)!.title).toBe('renamed');
  });

  it('an Aperture rename patches the title only, so it cannot undo an unpulled Google drag', async () => {
    const { g, b, timed } = await setup();
    const t = await timed();
    g.editEvent(t.gcalEventId!, {
      startMs: at('2026-10-09', '17:00'),
      endMs: at('2026-10-09', '18:00'),
    });
    await b.setTaskTitle(t.id, 'renamed');
    expect(g.patches.at(-1)).toEqual({
      sub: 'A',
      calendarId: 'A@example.com',
      eventId: t.gcalEventId,
      title: 'renamed',
    });
    expect(g.events.get(t.gcalEventId!)!.endMs).toBe(at('2026-10-09', '18:00'));
  });

  it('an event linked before two-way sync (no gcalSeen) is only remembered on first sight', async () => {
    const { g, b, repo, tick, timed } = await setup();
    const legacy = await timed();
    const deleted = await timed({ title: 'gone' });
    await repo.putTask({ ...(await b.getTask(legacy.id))!, gcalSeen: undefined });
    await repo.putTask({ ...(await b.getTask(deleted.id))!, gcalSeen: undefined });
    g.editEvent(legacy.gcalEventId!, { title: 'old google edit' });
    g.deleteEventInGoogle(deleted.gcalEventId!);
    tick();
    expect((await b.pullCalendar()).changedTaskIds).toEqual([deleted.id]); // deletions always apply
    expect(await b.getTask(legacy.id)).toMatchObject({
      title: 'pset',
      gcalSeen: { title: 'old google edit' }, // remembered as Google has it
    });
    expect(await b.getTask(deleted.id)).toMatchObject({
      gcalEventId: null,
      gcalPulled: { note: 'Removed in Google Calendar' },
    });
    // Known now. The title differed before two-way sync, so the task's is Aperture's unsent one: a new
    // Google rename is kept out, and the next push sends the task's. A field in step still applies.
    tick();
    g.editEvent(legacy.gcalEventId!, {
      title: 'new google edit',
      startMs: at('2026-10-09', '16:00'),
      endMs: at('2026-10-09', '17:00'),
    });
    tick();
    await b.pullCalendar();
    expect(await b.getTask(legacy.id)).toMatchObject({
      title: 'pset',
      dueTime: '17:00',
      gcalPulled: { note: 'Moved to Oct 9 5pm in Google Calendar · Kept your title' },
    });
    await b.syncCalendarEvent(legacy.id);
    expect(g.events.get(legacy.gcalEventId!)!.title).toBe('pset');
  });

  it('an event linked before two-way sync first seen after the first sync: Google’s drag applies, never reverted', async () => {
    const { g, b, repo, tick, baseline, timed } = await setup();
    const old = await timed();
    await baseline(); // the account's first sync is done
    // Not in that sync (ended before its lookback): still no base when Google drags it.
    await repo.putTask({ ...(await b.getTask(old.id))!, gcalSeen: undefined });
    tick();
    g.editEvent(old.gcalEventId!, {
      startMs: at('2026-10-09', '16:00'),
      endMs: at('2026-10-09', '17:00'),
    });
    tick();
    expect((await b.pullCalendar()).changedTaskIds).toEqual([old.id]);
    expect(await b.getTask(old.id)).toMatchObject({
      dueDay: '2026-10-09',
      dueTime: '17:00',
      gcalPulled: { note: 'Moved to Oct 9 5pm in Google Calendar' },
    });
    await b.setTaskTitle(old.id, 'renamed');
    expect(g.events.get(old.gcalEventId!)).toMatchObject({
      title: 'renamed',
      endMs: at('2026-10-09', '17:00'),
    });
  });

  it('a time change that failed to reach Google is sent by the next rename — never reverted by the echo', async () => {
    const { g, b, tick, baseline, timed } = await setup();
    const t = await timed();
    await baseline();
    const realPatch = g.patchEvent.bind(g);
    g.patchEvent = async () => {
      g.patchEvent = realPatch;
      throw new Error('timeout');
    };
    await b.setTaskDue(t.id, { dueDay: '2026-10-09', dueTime: '18:00' });
    expect((await b.getTask(t.id))!.gcalSyncError).toMatch(/Couldn’t update/);
    await b.setTaskTitle(t.id, 'renamed');
    expect(g.events.get(t.gcalEventId!)).toMatchObject({
      title: 'renamed',
      endMs: at('2026-10-09', '18:00'),
    });
    tick();
    await b.pullCalendar();
    expect(await b.getTask(t.id)).toMatchObject({ dueTime: '18:00', title: 'renamed' });
    expect((await b.getTask(t.id))!.gcalPulled ?? null).toBeNull();
  });

  it('a change made with sync off reaches Google on the next change after it is back on', async () => {
    const { g, b, tick, baseline, timed } = await setup();
    const t = await timed();
    await baseline();
    await b.updateSettings({ autoCalendar: false });
    await b.setTaskDue(t.id, { dueDay: '2026-10-09', dueTime: '18:00' });
    expect(g.events.get(t.gcalEventId!)!.endMs).toBe(at('2026-10-09', '16:00')); // stays put while off
    await b.updateSettings({ autoCalendar: true });
    await b.setTaskTitle(t.id, 'back on');
    expect(g.events.get(t.gcalEventId!)!.endMs).toBe(at('2026-10-09', '18:00'));
    tick();
    await b.pullCalendar();
    expect((await b.getTask(t.id))!.dueTime).toBe('18:00');
  });

  it('a done task renamed in Aperture keeps its name when Google later moves its block', async () => {
    const { g, b, tick, baseline, timed } = await setup();
    const t = await timed();
    await b.transitionTask(t.id, 'in_progress');
    await b.transitionTask(t.id, 'done');
    await baseline();
    await b.setTaskTitle(t.id, 'done and renamed'); // done tasks don't push
    g.editEvent(t.gcalEventId!, {
      startMs: at('2026-10-09', '16:00'),
      endMs: at('2026-10-09', '17:00'),
    });
    tick();
    await b.pullCalendar();
    expect(await b.getTask(t.id)).toMatchObject({ title: 'done and renamed', dueTime: '17:00' });
  });

  it('an unpulled Google drag, then an Aperture rename: the rename’s echo brings the drag in (never reverted)', async () => {
    const { g, b, tick, baseline, timed } = await setup();
    const t = await timed();
    await baseline();
    g.editEvent(t.gcalEventId!, {
      startMs: at('2026-10-09', '16:00'),
      endMs: at('2026-10-09', '17:00'),
    });
    tick(1_000);
    await b.setTaskTitle(t.id, 'renamed'); // title-only patch; Google keeps the drag
    expect(g.events.get(t.gcalEventId!)!.endMs).toBe(at('2026-10-09', '17:00'));
    tick();
    await b.pullCalendar();
    expect(await b.getTask(t.id)).toMatchObject({ title: 'renamed', dueTime: '17:00' });
    // A later estimate edit moves the block from 5pm, not back to 4pm.
    await b.setTaskEstimate(t.id, 90, 0);
    expect(g.events.get(t.gcalEventId!)).toMatchObject({
      startMs: at('2026-10-09', '15:30'),
      endMs: at('2026-10-09', '17:00'),
    });
  });

  it('a failed move of a picked block still lets Retry move it to the deadline', async () => {
    const { g, b } = await setup();
    const t = await b.createTask({ title: 'u', dueDay: '2026-10-09' });
    await b.insertCalendarEvent({
      taskId: t.id,
      accountSub: 'A',
      calendarId: 'A@example.com',
      title: 'u',
      startMs: at('2026-10-09', '09:00'),
      endMs: at('2026-10-09', '10:00'),
    });
    const realPatch = g.patchEvent.bind(g);
    g.patchEvent = async () => {
      g.patchEvent = realPatch;
      throw new Error('timeout');
    };
    const failed = await b.setTaskDue(t.id, { dueDay: '2026-10-09', dueTime: '16:00' });
    expect(failed.gcalSyncError).toMatch(/Couldn’t update/);
    await b.syncCalendarEvent(t.id);
    expect(g.events.get(t.gcalEventId ?? failed.gcalEventId!)!.endMs).toBe(
      at('2026-10-09', '16:00'),
    );
  });

  it('a manual insert clears a "Removed in Google Calendar" mark', async () => {
    const { g, b, tick, baseline } = await setup();
    const t = await b.createTask({ title: 'u', dueDay: '2026-10-09' });
    const linked = await b.insertCalendarEvent({
      taskId: t.id,
      accountSub: 'A',
      calendarId: 'A@example.com',
      title: 'u',
      startMs: at('2026-10-09', '09:00'),
      endMs: at('2026-10-09', '10:00'),
    });
    await baseline();
    g.deleteEventInGoogle(linked.gcalEventId!);
    tick();
    await b.pullCalendar();
    expect((await b.getTask(t.id))!.gcalPulled?.note).toBe('Removed in Google Calendar');
    const again = await b.insertCalendarEvent({
      taskId: t.id,
      accountSub: 'A',
      calendarId: 'A@example.com',
      title: 'u',
      startMs: at('2026-10-09', '11:00'),
      endMs: at('2026-10-09', '12:00'),
    });
    expect(again.gcalPulled ?? null).toBeNull();
  });

  it('the user’s own edit retires the "updated from Google" note it supersedes', async () => {
    const { g, b, tick, baseline, timed } = await setup();
    const t = await timed();
    await baseline();
    g.editEvent(t.gcalEventId!, {
      startMs: at('2026-10-09', '16:00'),
      endMs: at('2026-10-09', '17:00'),
    });
    tick();
    await b.pullCalendar();
    expect((await b.getTask(t.id))!.gcalPulled?.note).toMatch(/Moved to/);
    const moved = await b.setTaskDue(t.id, { dueDay: '2026-10-10', dueTime: '17:00' });
    expect(moved.gcalPulled ?? null).toBeNull();
  });

  it('an unpulled Google rename, then a failed Aperture rename, then a Google drag: Aperture’s name stays', async () => {
    const { g, b, tick, baseline, timed } = await setup();
    const t = await timed();
    await baseline();
    g.editEvent(t.gcalEventId!, { title: 'google' });
    tick(1_000);
    const realPatch = g.patchEvent.bind(g);
    g.patchEvent = async () => {
      g.patchEvent = realPatch;
      throw new Error('timeout');
    };
    await b.setTaskTitle(t.id, 'aperture');
    tick();
    await b.pullCalendar(); // both renamed: Aperture's unsent name stays; the base takes Google's
    expect(await b.getTask(t.id)).toMatchObject({
      title: 'aperture',
      gcalPulled: { note: 'Kept your title — renamed in Google Calendar too' },
    });
    g.editEvent(t.gcalEventId!, {
      startMs: at('2026-10-09', '16:00'),
      endMs: at('2026-10-09', '17:00'),
    });
    tick();
    await b.pullCalendar();
    expect(await b.getTask(t.id)).toMatchObject({ title: 'aperture', dueTime: '17:00' });
    // …and Aperture's name still reaches Google with the next push.
    await b.syncCalendarEvent(t.id);
    expect(g.events.get(t.gcalEventId!)!.title).toBe('aperture');
  });

  it('a done task renamed after an unpulled Google rename keeps its (unsent) Aperture name', async () => {
    const { g, b, tick, baseline, timed } = await setup();
    const t = await timed();
    await b.transitionTask(t.id, 'in_progress');
    await b.transitionTask(t.id, 'done');
    await baseline();
    g.editEvent(t.gcalEventId!, { title: 'G' });
    tick(1_000);
    await b.setTaskTitle(t.id, 'A'); // done: no push — Aperture's unsent edit wins the conflict
    tick();
    await b.pullCalendar();
    expect((await b.getTask(t.id))!.title).toBe('A');
  });

  it('a split moves the link with its known event, so a later Google drag still applies to the follow-up', async () => {
    const { g, b, tick, baseline, timed } = await setup();
    const t = await timed();
    await b.transitionTask(t.id, 'in_progress');
    await baseline();
    const realPatch = g.patchEvent.bind(g);
    g.patchEvent = async () => {
      g.patchEvent = realPatch;
      throw new Error('timeout'); // the follow-up's rename fails
    };
    const { followUp } = await b.splitTask(t.id, {
      finish: 'done',
      followUp: { title: 'pset part 2', estimateMin: 60 },
    });
    expect(followUp).toMatchObject({ gcalEventId: t.gcalEventId, gcalSeen: { title: 'pset' } });
    tick(1_000);
    g.editEvent(t.gcalEventId!, {
      startMs: at('2026-10-09', '17:00'),
      endMs: at('2026-10-09', '18:00'),
    });
    tick();
    await b.pullCalendar();
    expect(await b.getTask(followUp.id)).toMatchObject({ dueTime: '18:00', title: 'pset part 2' });
  });

  it('re-creating an event after a Google delete clears the "Removed" mark', async () => {
    const { g, b, tick, baseline, timed } = await setup();
    const t = await timed();
    await baseline();
    g.deleteEventInGoogle(t.gcalEventId!);
    tick();
    await b.pullCalendar();
    expect((await b.getTask(t.id))!.gcalPulled?.note).toBe('Removed in Google Calendar');
    const again = await b.syncCalendarEvent(t.id);
    expect(again.gcalEventId).toBeTruthy();
    expect(again.gcalPulled ?? null).toBeNull();
  });

  it('a pull plans on a fresh read: a task deleted or edited meanwhile is not overwritten', async () => {
    const { g, b, tick, baseline, timed } = await setup();
    const del = await timed();
    const edited = await timed({ title: 'edited' });
    await baseline();
    g.deleteEventInGoogle(del.gcalEventId!);
    g.editEvent(edited.gcalEventId!, { title: 'google' });
    tick();
    const real = g.listEventChanges.bind(g);
    g.listEventChanges = async (input) => {
      const delta = await real(input);
      // While the delta is in flight: the task is deleted, and the other renamed in Aperture.
      await b.deleteTask(del.id);
      tick(1_000);
      await b.setTaskTitle(edited.id, 'mine');
      return delta;
    };
    const res = await b.pullCalendar();
    expect(await b.getTask(del.id)).toBeNull(); // the tombstone stands
    expect(res.changedTaskIds).not.toContain(del.id);
    expect((await b.getTask(edited.id))!.title).toBe('mine'); // the later Aperture rename wins
  });

  it('deleted or moved away in Google → unlinked, never re-created by the pull', async () => {
    const { g, b, tick, baseline, timed } = await setup();
    const del = await timed();
    const moved = await timed({ title: 'moved' });
    await baseline();
    g.deleteEventInGoogle(del.gcalEventId!);
    g.moveEventAway(moved.gcalEventId!);
    tick();
    const res = await b.pullCalendar();
    expect(res.changedTaskIds.sort()).toEqual([del.id, moved.id].sort());
    for (const id of [del.id, moved.id])
      expect(await b.getTask(id)).toMatchObject({
        gcalEventId: null,
        gcalAccountId: null,
        gcalCalendarId: null,
        gcalPulled: { note: 'Removed in Google Calendar' },
        dueTime: '16:00',
      });
  });

  it('done: the end and a rename apply; a start drag does not touch the estimate', async () => {
    const { g, b, tick, baseline, timed } = await setup();
    const t = await timed();
    await b.transitionTask(t.id, 'in_progress');
    await b.transitionTask(t.id, 'done');
    await baseline();
    g.editEvent(t.gcalEventId!, { startMs: at('2026-10-09', '13:00') });
    tick();
    expect((await b.pullCalendar()).changedTaskIds).toEqual([]);
    g.editEvent(t.gcalEventId!, {
      title: 'x',
      startMs: at('2026-10-10', '08:00'),
      endMs: at('2026-10-10', '09:00'),
    });
    tick();
    await b.pullCalendar();
    expect(await b.getTask(t.id)).toMatchObject({
      title: 'x',
      dueDay: '2026-10-10',
      dueTime: '09:00',
      estimateMin: 60,
    });
  });

  it('an in-progress task takes a start drag as its working estimate; the lock stays', async () => {
    const { g, b, tick, baseline, timed } = await setup();
    const t = await timed();
    await b.transitionTask(t.id, 'in_progress');
    await baseline();
    g.editEvent(t.gcalEventId!, { startMs: at('2026-10-09', '14:30') });
    tick();
    await b.pullCalendar();
    expect(await b.getTask(t.id)).toMatchObject({ estimateMin: 90, estimateLockedMin: 60 });
  });

  it('an all-day conversion keeps the link and the time; a later Aperture time change re-times it', async () => {
    const { g, b, tick, baseline, timed } = await setup();
    const t = await timed();
    await baseline();
    g.editEvent(t.gcalEventId!, { allDay: true, title: 'all day now' });
    tick();
    await b.pullCalendar();
    expect(await b.getTask(t.id)).toMatchObject({
      title: 'all day now',
      dueTime: '16:00',
      gcalEventId: t.gcalEventId,
    });
    await b.setTaskDue(t.id, { dueDay: '2026-10-09', dueTime: '18:00' });
    expect(g.events.get(t.gcalEventId!)).toMatchObject({
      allDay: false,
      endMs: at('2026-10-09', '18:00'),
    });
  });

  it('a block picked while sync was off snaps to the deadline once it is back on; a Google drag before that is kept out', async () => {
    const { g, b, tick, baseline } = await setup();
    await b.updateSettings({ autoCalendar: false }); // the picker is offered when auto-sync is off
    const t = await b.createTask({ title: 'study', dueDay: '2026-10-09', dueTime: '16:00' });
    const linked = await b.insertCalendarEvent({
      taskId: t.id,
      accountSub: 'A',
      calendarId: 'A@example.com',
      title: 'study',
      startMs: at('2026-10-09', '09:00'),
      endMs: at('2026-10-09', '10:00'),
    });
    await b.updateSettings({ autoCalendar: true });
    await baseline();
    g.editEvent(linked.gcalEventId!, {
      title: 'study ch 3',
      startMs: at('2026-10-09', '10:00'),
      endMs: at('2026-10-09', '11:30'),
    });
    tick();
    await b.pullCalendar();
    expect(await b.getTask(t.id)).toMatchObject({
      title: 'study ch 3',
      dueTime: '16:00',
      estimateMin: null,
      gcalPulled: { note: 'Renamed to “study ch 3” in Google Calendar · Kept your time' },
    });
    await b.syncCalendarEvent(t.id);
    expect(g.events.get(linked.gcalEventId!)).toMatchObject({
      title: 'study ch 3',
      startMs: at('2026-10-09', '15:30'),
      endMs: at('2026-10-09', '16:00'),
    });
  });

  it('a block placed off the deadline before two-way sync moves to the deadline — never the reverse', async () => {
    const { g, b, repo, tick, timed } = await setup();
    await b.updateSettings({ autoCalendar: false }); // the picker was allowed then (or MCP)
    const t = await timed({ estimateMin: 30, dueTime: '17:00' });
    const placed = await b.insertCalendarEvent({
      taskId: t.id,
      accountSub: 'A',
      calendarId: 'A@example.com',
      title: 'pset',
      startMs: at('2026-10-09', '14:00'),
      endMs: at('2026-10-09', '15:00'),
    });
    await b.updateSettings({ autoCalendar: true });
    await repo.putTask({ ...(await b.getTask(t.id))!, gcalSeen: undefined }); // linked before ship
    tick();
    await b.pullCalendar(); // first sight
    await b.setTaskTitle(t.id, 'renamed');
    tick();
    await b.pullCalendar(); // the push's echo
    expect(await b.getTask(t.id)).toMatchObject({ dueTime: '17:00', estimateMin: 30 });
    expect(g.events.get(placed.gcalEventId!)).toMatchObject({
      title: 'renamed',
      startMs: at('2026-10-09', '16:30'),
      endMs: at('2026-10-09', '17:00'),
    });
  });

  it('a push records Google’s `updated` in the base', async () => {
    const { g, b, timed } = await setup();
    const t = await timed();
    expect(t.gcalSeen!.updatedMs).toBe(g.events.get(t.gcalEventId!)!.updatedMs);
    const renamed = await b.setTaskTitle(t.id, 'renamed');
    expect(renamed.gcalSeen!.updatedMs).toBe(g.events.get(t.gcalEventId!)!.updatedMs);
  });

  it('insertCalendarEvent refuses a timed task while auto-sync is on; allowed otherwise', async () => {
    const { b } = await setup();
    const block = (taskId: string) =>
      b.insertCalendarEvent({
        taskId,
        accountSub: 'A',
        calendarId: 'A@example.com',
        title: 'x',
        startMs: at('2026-10-09', '09:00'),
        endMs: at('2026-10-09', '10:00'),
      });
    await b.updateSettings({ autoCalendar: false });
    const timedTask = await b.createTask({ title: 'x', dueDay: '2026-10-09', dueTime: '16:00' });
    await b.updateSettings({ autoCalendar: true });
    await expect(block(timedTask.id)).rejects.toThrow(/Auto-sync places/);
    const untimed = await b.createTask({ title: 'x', dueDay: '2026-10-09' });
    await expect(block(untimed.id)).resolves.toMatchObject({ gcalEventId: expect.any(String) });
    await b.updateSettings({ autoCalendar: false });
    await expect(block(timedTask.id)).resolves.toMatchObject({ gcalEventId: expect.any(String) });
    // Sync on but no calendar to write to: auto-sync can't place it, so a picked time is allowed.
    await b.updateSettings({ autoCalendar: true, calendarWriteDefault: null });
    const other = await b.createTask({ title: 'y', dueDay: '2026-10-09', dueTime: '16:00' });
    await expect(block(other.id)).resolves.toMatchObject({ gcalEventId: expect.any(String) });
  });

  it('Aperture wins a field both sides changed, in either order — and the row says so', async () => {
    const { g, b, tick, baseline, timed } = await setup();
    const t = await timed();
    await baseline();
    const realPatch = g.patchEvent.bind(g);
    const failNext = () => {
      g.patchEvent = async () => {
        g.patchEvent = realPatch;
        throw new Error('timeout');
      };
    };
    // Google edit, THEN an Aperture rename whose push fails.
    g.editEvent(t.gcalEventId!, { title: 'google' });
    tick(1_000);
    failNext();
    await b.setTaskTitle(t.id, 'aperture');
    tick();
    await b.pullCalendar();
    expect(await b.getTask(t.id)).toMatchObject({ title: 'aperture' });
    expect((await b.getTask(t.id))!.gcalSyncError).toMatch(/Couldn’t update/);
    // A failed Aperture push, THEN a Google edit: still Aperture's.
    failNext();
    await b.setTaskTitle(t.id, 'aperture 2');
    tick(1_000);
    g.editEvent(t.gcalEventId!, { title: 'google 2' });
    tick();
    await b.pullCalendar();
    expect(await b.getTask(t.id)).toMatchObject({
      title: 'aperture 2',
      gcalSeen: { title: 'google 2' },
      gcalPulled: { note: 'Kept your title — renamed in Google Calendar too' },
    });
    await b.syncCalendarEvent(t.id); // Retry sends Aperture's
    expect(g.events.get(t.gcalEventId!)!.title).toBe('aperture 2');
  });

  it('at most once a minute; toggle off or no account → no pull at all', async () => {
    const { g, b, tick, baseline, timed } = await setup();
    const t = await timed();
    await baseline();
    g.editEvent(t.gcalEventId!, { title: 'g' });
    tick(1_000);
    expect((await b.pullCalendar()).pulled).toBe(true);
    tick(30_000);
    expect((await b.pullCalendar()).pulled).toBe(false);
    tick(31_000);
    await b.updateSettings({ autoCalendar: false });
    expect(await b.pullCalendar()).toEqual({ pulled: false, changedTaskIds: [], accounts: [] });
    await b.updateSettings({ autoCalendar: true });
    expect((await b.pullCalendar()).pulled).toBe(true);
  });

  it('an expired sync token (410) falls back to a full sync and still applies edits', async () => {
    const { g, b, tick, baseline, timed } = await setup();
    const t = await timed();
    await baseline();
    g.editEvent(t.gcalEventId!, { title: 'after 410' });
    g.expireSyncTokens();
    tick();
    await b.pullCalendar();
    expect((await b.getTask(t.id))!.title).toBe('after 410');
  });

  it('a failing account is reported on its status, not thrown; tasks untouched', async () => {
    const { g, b, tick, baseline, timed } = await setup();
    const t = await timed();
    await baseline();
    const synced = (await b.getGoogleStatus()).accounts[0]!.lastSyncedAt;
    expect(synced).toBeGreaterThan(0);
    g.markDead('A');
    tick();
    expect(await b.pullCalendar()).toMatchObject({
      pulled: true,
      accounts: [{ sub: 'A', ok: false, error: 'invalid_grant' }],
    });
    expect((await b.getGoogleStatus()).accounts[0]).toMatchObject({
      lastPullError: 'invalid_grant',
      lastSyncedAt: synced,
    });
    expect((await b.getTask(t.id))!.title).toBe('pset');
  });

  it('disconnect drops the cursor, so a reconnect baselines afresh', async () => {
    const { b, baseline } = await setup();
    await baseline();
    expect((await b.exportData()).gcalSyncStates).toHaveLength(1);
    await b.disconnectGoogleAccount('A');
    expect((await b.exportData()).gcalSyncStates).toEqual([]);
  });

  it('events Aperture did not create are never touched', async () => {
    const { g, b, tick, baseline } = await setup();
    await baseline();
    const { eventId } = await g.insertEvent({
      sub: 'A',
      calendarId: 'A@example.com',
      title: 'meeting',
      startMs: 0,
      endMs: MIN,
    });
    g.editEvent(eventId, { title: 'moved meeting' });
    tick();
    expect((await b.pullCalendar()).changedTaskIds).toEqual([]);
  });

  it('testMode: a pull makes no Google call and persists nothing', async () => {
    const { b, doc } = await setup();
    const res = await handleRpc(doc, {
      userId: 'local',
      method: 'pullCalendar',
      args: [],
      testMode: true,
    });
    expect(res).toMatchObject({ pulled: true, changedTaskIds: [] });
    expect((await b.exportData()).gcalSyncStates).toEqual([]);
  });
});
