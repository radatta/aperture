import { describe, expect, it } from 'vitest';
import { InMemoryDoc } from './ddb/DocClient';
import { Repo } from './ddb/repo';
import { liveWrites } from './ddb/writes';
import { BackendClient } from './backend';
import { InMemoryGoogle } from './google/gateway';
import { handleRpc } from './handler';

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
