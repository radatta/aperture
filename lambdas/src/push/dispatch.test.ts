import { beforeEach, describe, expect, it } from 'vitest';
import { PUSH_DAILY_GUARD, userDueEpoch } from '@aperture/shared';
import type { PushSub, Settings, Task, TaskPlan } from '@aperture/shared';
import { InMemoryDoc } from '../ddb/DocClient';
import type { DocClient } from '../ddb/DocClient';
import { gsi1, pk, sk } from '../ddb/keys';
import { entityItem, taskItem } from '../ddb/mapping';
import { PushRegistry } from '../ddb/pushRegistry';
import { Repo } from '../ddb/repo';
import { liveWrites, noopWrites } from '../ddb/writes';
import { InMemoryPush, noopPush } from './gateway';
import type { PushTarget } from './gateway';
import {
  PSENT_KEEP_MS,
  PUSH_BAD_KEY_ERROR,
  PUSH_NO_APP_URL_ERROR,
  PUSH_NO_KEY_ERROR,
  resetColdStart,
  runPushTick,
} from './dispatch';

const U = 'u1';
const APP = 'https://app.example';
const AT = (day: string, hhmm: string) => userDueEpoch(day, hhmm);
const TODAY = '2026-11-04';
const TWO_PM = AT(TODAY, '14:00');
const NINE_AM = AT(TODAY, '09:00');
const MIN = 60_000;

const task = (over: Partial<Task>): Task => ({
  id: 'T1',
  userId: U,
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
  title: 'Renew passport',
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
const plan = (over: Partial<TaskPlan> = {}): TaskPlan => ({
  id: 'P1',
  userId: U,
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
  taskId: 'T1',
  day: TODAY,
  plannedMinutes: 30,
  order: 0,
  ...over,
});
const P256DH =
  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
const AUTH = 'BTBZMqHH6r4Tts7J_aSIgg';
const sub = (id: string, over: Partial<PushSub> = {}): PushSub => ({
  id,
  userId: U,
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
  endpoint: `https://web.push.apple.com/secret-${id}`,
  p256dh: P256DH,
  auth: AUTH,
  label: `iPhone ${id}`,
  lastOkAt: null,
  lastError: null,
  lastErrorAt: null,
  ...over,
});

function world(doc: DocClient = new InMemoryDoc()) {
  const writes = liveWrites(doc);
  const repo = (userId = U) => new Repo(doc, writes, userId);
  const registry = new PushRegistry(doc, writes);
  const push = new InMemoryPush();
  const logs: string[] = [];
  let clock = TWO_PM;
  const w = {
    doc,
    mem: doc as InMemoryDoc, // the in-memory table's test hooks (every world but the broken one)
    push,
    logs,
    registry,
    repo,
    set: (ms: number) => void (clock = ms),
    now: () => clock,
    tick: (over: { deadline?: number } = {}) =>
      runPushTick({
        doc,
        writes,
        push,
        now: () => clock,
        appUrl: APP,
        log: (l) => logs.push(l),
        ...over,
      }),
    // A device for the user, and the user in the registry (what subscribePush does).
    async device(id = 'S1', userId = U, over: Partial<PushSub> = {}) {
      await repo(userId).putPushSub(sub(id, { userId, ...over }));
      await registry.addUser(userId, 0);
    },
    events: () => logs.map((l) => (JSON.parse(l) as { event: string }).event),
    notes: () =>
      w.push.sends.map((s) => (s.payload as { notification: Record<string, string> }).notification),
  };
  return w;
}

beforeEach(() => resetColdStart());

describe('push dispatch — what fires', () => {
  it('a timed task pings at its minute, not before, with the declarative payload and D14 headers', async () => {
    const w = world();
    await w.device();
    await w.repo().putTask(task({ dueDay: TODAY, dueTime: '14:00' }));
    w.set(TWO_PM - MIN);
    expect((await w.tick()).notifications).toBe(0);
    w.set(TWO_PM);
    const report = await w.tick();
    expect(report).toMatchObject({ users: 1, notifications: 1, delivered: 1, failed: 0 });
    expect(w.push.sends).toHaveLength(1);
    const [s] = w.push.sends;
    expect(s!.target.endpoint).toBe('https://web.push.apple.com/secret-S1');
    expect(s!.payload).toEqual({
      web_push: 8030,
      notification: {
        title: 'Renew passport',
        body: 'Due now · 2pm',
        navigate: `${APP}/tasks?lens=today&task=T1&n=T1`,
        tag: 'T1',
        silent: false,
        lang: 'en-US',
      },
    });
    expect(s!.opts).toEqual({ topic: 'T1', ttlSeconds: 3600, urgency: 'high' });
    // The device and the user's health line record the delivery.
    expect((await w.repo().getPushSub('S1'))?.lastOkAt).toBe(TWO_PM);
    expect(await w.repo().getPushUserHealth()).toMatchObject({
      lastSentAt: TWO_PM,
      lastError: null,
    });
  });

  it('a day-only deadline and a planned day ping at 09:00 in the user zone', async () => {
    const w = world();
    await w.device();
    await w.repo().putTask(task({ id: 'D', title: 'Day-only', dueDay: TODAY }));
    await w.repo().putTask(task({ id: 'P', title: 'Planned' }));
    await w.repo().putPlan(plan({ taskId: 'P' }));
    w.set(NINE_AM - MIN);
    await w.tick();
    expect(w.push.sends).toHaveLength(0);
    w.set(NINE_AM);
    await w.tick();
    // Same minute → one notification (D4).
    expect(w.notes()).toEqual([
      expect.objectContaining({
        title: '2 reminders',
        body: 'Day-only · Planned',
        tag: `b${NINE_AM / MIN}`,
      }),
    ]);
    expect(new Date(NINE_AM).toISOString()).toBe('2026-11-04T17:00:00.000Z'); // 09:00 PST
  });

  it('alone, each kind has its own copy', async () => {
    for (const [setup, body] of [
      [(w: ReturnType<typeof world>) => w.repo().putTask(task({ dueDay: TODAY })), 'Due today'],
      [
        async (w: ReturnType<typeof world>) => {
          await w.repo().putTask(task({}));
          await w.repo().putPlan(plan());
        },
        'Planned for today',
      ],
    ] as const) {
      const w = world();
      await w.device();
      await setup(w);
      w.set(NINE_AM);
      await w.tick();
      expect(w.notes()).toEqual([expect.objectContaining({ title: 'Renew passport', body })]);
    }
  });

  it('a task due today AND planned today pings once, as its deadline', async () => {
    const w = world();
    await w.device();
    await w.repo().putTask(task({ dueDay: TODAY }));
    await w.repo().putPlan(plan());
    w.set(NINE_AM);
    await w.tick();
    expect(w.notes()).toEqual([
      expect.objectContaining({ title: 'Renew passport', body: 'Due today' }),
    ]);
  });

  it('never a done, cancelled or deleted task — the stale index row is re-read', async () => {
    const w = world();
    await w.device();
    const open = task({ dueDay: TODAY, dueTime: '14:00' });
    for (const [id, over] of [
      ['done', { status: 'done', completedAt: 1 }],
      ['cx', { status: 'cancelled', cancelledAt: 1 }],
      ['gone', { deletedAt: 1 }],
    ] as const) {
      // The index still carries the open row (a GSI lags); the table already has the finished one.
      const keyed = taskItem(U, { ...open, id });
      await w.doc.put({ ...keyed, ...over });
    }
    await w.tick();
    expect(w.push.sends).toHaveLength(0);
  });

  it('a plan whose task finished, or got a clock time, does not ping', async () => {
    const w = world();
    await w.device();
    await w.repo().putTask(task({ id: 'A', status: 'done', completedAt: 1 }));
    await w.repo().putPlan(plan({ id: 'P1', taskId: 'A' }));
    await w.repo().putTask(task({ id: 'B', dueDay: '2026-11-09', dueTime: '10:00' }));
    await w.repo().putPlan(plan({ id: 'P2', taskId: 'B', order: 1 }));
    w.set(NINE_AM);
    await w.tick();
    expect(w.push.sends).toHaveLength(0);
  });

  it('a row whose fire time has moved since is stale and skipped', async () => {
    const w = world();
    await w.device();
    const moved = task({ dueDay: TODAY, dueTime: '15:00' });
    // Index entry from the old 14:00 deadline; the task now says 15:00.
    await w.doc.put({ ...taskItem(U, moved), GSI1SK: TWO_PM });
    await w.tick();
    expect(w.push.sends).toHaveLength(0);
    w.set(AT(TODAY, '15:00'));
    await w.doc.put(taskItem(U, moved));
    await w.tick();
    expect(w.push.sends).toHaveLength(1);
  });

  it('a toggle that is off silences its kind only', async () => {
    const w = world();
    await w.device();
    await w.repo().putSettings({ remindTimed: false } as Settings);
    await w.repo().putTask(task({ id: 'T', dueDay: TODAY, dueTime: '09:00' }));
    await w.repo().putTask(task({ id: 'D', title: 'Day-only', dueDay: TODAY }));
    w.set(NINE_AM);
    await w.tick();
    expect(w.notes()).toEqual([expect.objectContaining({ title: 'Day-only', body: 'Due today' })]);
    // remindPlanned off: the plan source finds nothing.
    const w2 = world();
    await w2.device();
    await w2.repo().putSettings({ remindPlanned: false } as Settings);
    await w2.repo().putTask(task({}));
    await w2.repo().putPlan(plan());
    w2.set(NINE_AM);
    await w2.tick();
    expect(w2.push.sends).toHaveLength(0);
  });

  it('a settings row from before the toggles reads as all on', async () => {
    const w = world();
    await w.device();
    await w.repo().putSettings({ dayStartHour: 4 } as Settings);
    await w.repo().putTask(task({ dueDay: TODAY, dueTime: '14:00' }));
    await w.tick();
    expect(w.push.sends).toHaveLength(1);
  });

  it('catches up within the window, never past it', async () => {
    const w = world();
    await w.device();
    await w.repo().putTask(task({ dueDay: TODAY, dueTime: '14:00' }));
    w.set(TWO_PM + 31 * MIN);
    await w.tick();
    expect(w.push.sends).toHaveLength(0);
    w.set(TWO_PM + 29 * MIN);
    await w.tick();
    expect(w.push.sends).toHaveLength(1);
  });

  it('Send test: the next tick sends it, then the candidate row is gone', async () => {
    const w = world();
    await w.device();
    await w.repo().putPushTest({ id: 'X1', createdAt: TWO_PM - 20_000 });
    await w.tick();
    expect(w.notes()).toEqual([
      expect.objectContaining({
        title: 'Aperture test',
        body: 'Reminders reach this device',
        tag: 'test',
      }),
    ]);
    expect(w.push.sends[0]!.opts.topic).toBe('test');
    expect(await w.repo().listPushTests()).toEqual([]);
    await w.tick();
    expect(w.push.sends).toHaveLength(1);
  });
});

describe('push dispatch — fail-closed sending', () => {
  it('never pings twice: the dedup row is written before the send', async () => {
    const w = world();
    await w.device();
    await w.repo().putTask(task({ dueDay: TODAY, dueTime: '14:00' }));
    let dedupBeforeSend = false;
    w.push.status = () => {
      dedupBeforeSend = w.mem.snapshot().some((i) => i.SK === sk.pushSent(TWO_PM, 'T1'));
      return 201;
    };
    await w.tick();
    w.set(TWO_PM + MIN);
    await w.tick();
    w.set(TWO_PM + 2 * MIN);
    await w.tick();
    expect(w.push.sends).toHaveLength(1);
    expect(dedupBeforeSend).toBe(true);
  });

  it('one notification per device: a batch goes to each of them once', async () => {
    const w = world();
    await w.device('S1');
    await w.device('S2');
    await w.repo().putTask(task({ id: 'A', title: 'A', dueDay: TODAY, dueTime: '14:00' }));
    await w.repo().putTask(task({ id: 'B', title: 'B', dueDay: TODAY, dueTime: '14:00' }));
    const report = await w.tick();
    expect(report).toMatchObject({ notifications: 1, delivered: 2 });
    expect(w.push.sends.map((s) => s.target.endpoint).sort()).toEqual([
      'https://web.push.apple.com/secret-S1',
      'https://web.push.apple.com/secret-S2',
    ]);
    expect(w.notes()[0]).toEqual(
      expect.objectContaining({
        title: '2 reminders',
        body: 'A · B',
        navigate: `${APP}/tasks?lens=today&n=b${TWO_PM / MIN}`,
      }),
    );
  });

  it('the hidden guard refuses past 50 a day and says so', async () => {
    expect(PUSH_DAILY_GUARD).toBe(50); // the title names it (the dev check's matrix reads it verbatim)
    const w = world();
    await w.device();
    await w.repo().putPushCountIf({ day: TODAY, count: PUSH_DAILY_GUARD - 1, updatedAt: 1 }, null);
    await w.repo().putTask(task({ id: 'A', dueDay: TODAY, dueTime: '14:00' }));
    await w.tick();
    expect(w.push.sends).toHaveLength(1);
    expect((await w.repo().getPushCount(TODAY))?.count).toBe(PUSH_DAILY_GUARD);
    await w.repo().putTask(task({ id: 'B', dueDay: TODAY, dueTime: '14:01' }));
    w.set(TWO_PM + MIN);
    const report = await w.tick();
    expect(report.guardTripped).toBe(1);
    expect(w.push.sends).toHaveLength(1);
    expect(w.events()).toContain('push_guard_tripped');
    expect((await w.repo().getPushUserHealth())?.lastError).toMatch(/Daily reminder limit \(50\)/);
    // Fail-closed: the held-back reminder stays consumed — it doesn't fire later either.
    w.set(TWO_PM + 2 * MIN);
    await w
      .repo()
      .putPushCountIf(
        { day: TODAY, count: 0, updatedAt: 99 },
        (await w.repo().getPushCount(TODAY))!.updatedAt,
      );
    await w.tick();
    expect(w.push.sends).toHaveLength(1);
  });

  it('the guard counts per LA day', async () => {
    const w = world();
    await w.device();
    await w
      .repo()
      .putPushCountIf({ day: '2026-11-03', count: PUSH_DAILY_GUARD, updatedAt: 1 }, null);
    await w.repo().putTask(task({ dueDay: TODAY, dueTime: '00:30' }));
    w.set(AT(TODAY, '00:30')); // 08:30Z — still the 4th in LA
    await w.tick();
    expect(w.push.sends).toHaveLength(1);
    expect((await w.repo().getPushCount(TODAY))?.count).toBe(1);
  });

  it('404/410 drops the device and stamps the error; the last device out leaves the registry', async () => {
    for (const status of [404, 410]) {
      const w = world();
      await w.device('S1');
      await w.repo().putTask(task({ dueDay: TODAY, dueTime: '14:00' }));
      w.push.status = status;
      const report = await w.tick();
      expect(report).toMatchObject({ failed: 1, delivered: 0 });
      expect(await w.repo().listPushSubs()).toEqual([]);
      const health = await w.repo().getPushUserHealth();
      expect(health?.lastError).toBe(
        `iPhone S1 stopped accepting reminders (push service answered ${status}) — turn them on again on that device`,
      );
      expect(health?.lastErrorAt).toBe(TWO_PM);
      expect(health?.lastSentAt).toBeNull(); // a refusal is an error, never a send
      expect(await w.registry.hasUser(U)).toBe(false);
    }
  });

  it('a device whose keys can never work is dropped like a 410', async () => {
    const w = world();
    await w.device('S1');
    await w.device('S2');
    await w.repo().putTask(task({ dueDay: TODAY, dueTime: '14:00' }));
    w.push.status = (t: PushTarget) =>
      t.endpoint.endsWith('S1') ? { status: 0, reason: 'keys' } : 201;
    await w.tick();
    expect((await w.repo().listPushSubs()).map((s) => s.id)).toEqual(['S2']);
    expect(await w.registry.hasUser(U)).toBe(true);
  });

  it('a 5xx or a timeout stamps the error and is not retried — this tick or the next', async () => {
    for (const [status, why] of [
      [503, 'push service answered 503'],
      [{ status: 0, reason: 'timeout' as const }, 'timed out'],
      [{ status: 0, reason: 'network' as const }, 'network error'],
    ] as const) {
      const w = world();
      await w.device('S1');
      await w.repo().putTask(task({ dueDay: TODAY, dueTime: '14:00' }));
      w.push.status = () => status;
      await w.tick();
      w.set(TWO_PM + MIN);
      await w.tick();
      expect(w.push.sends).toHaveLength(1);
      const s1 = await w.repo().getPushSub('S1');
      expect(s1).toMatchObject({
        lastError: `Last reminder didn't reach this device (${why})`,
        lastErrorAt: TWO_PM,
      });
      expect((await w.repo().getPushUserHealth())?.lastError).toBe(
        `iPhone S1: Last reminder didn't reach this device (${why})`,
      );
    }
  });

  it('a later delivery clears the device error, but the user keeps their last error', async () => {
    const w = world();
    await w.device('S1');
    await w.repo().putTask(task({ id: 'A', dueDay: TODAY, dueTime: '14:00' }));
    await w.repo().putTask(task({ id: 'B', dueDay: TODAY, dueTime: '14:05' }));
    w.push.status = 500;
    await w.tick();
    w.push.status = 201;
    w.set(TWO_PM + 5 * MIN);
    await w.tick();
    expect(await w.repo().getPushSub('S1')).toMatchObject({
      lastOkAt: TWO_PM + 5 * MIN,
      lastError: null,
    });
    expect(await w.repo().getPushUserHealth()).toMatchObject({
      lastSentAt: TWO_PM + 5 * MIN,
      lastErrorAt: TWO_PM,
    });
  });

  it('a re-subscribe during the send is never flattened by the stamp', async () => {
    const w = world();
    await w.device('S1');
    await w.repo().putTask(task({ dueDay: TODAY, dueTime: '14:00' }));
    w.push.status = () => {
      w.mem.putNow(entityItem(U, sk.pushSub('S1'), sub('S1', { label: 'renamed', updatedAt: 5 })));
      return 201;
    };
    await w.tick();
    expect(await w.repo().getPushSub('S1')).toMatchObject({ label: 'renamed', lastOkAt: null });
  });
});

describe('push dispatch — the tick', () => {
  it('writes the heartbeat on every tick, even with nobody to ping', async () => {
    const w = world();
    const report = await w.tick();
    expect(report).toMatchObject({ users: 0, notifications: 0, error: null });
    expect(await w.registry.getPoller()).toEqual({
      lastRunAt: TWO_PM,
      lastError: null,
      lastErrorAt: null,
      updatedAt: TWO_PM,
    });
    w.set(TWO_PM + MIN);
    await w.tick();
    expect((await w.registry.getPoller())?.lastRunAt).toBe(TWO_PM + MIN);
  });

  it('drops a user with no devices from the registry', async () => {
    const w = world();
    await w.registry.addUser(U, 0);
    await w.tick();
    expect(await w.registry.hasUser(U)).toBe(false);
    expect(w.events()).toEqual(['push_user_dropped']);
  });

  it('ticks every registered user, each in their own partition', async () => {
    const w = world();
    await w.device('S1', 'u1');
    await w.device('S9', 'u2');
    await w
      .repo('u1')
      .putTask(task({ id: 'A', userId: 'u1', title: 'mine', dueDay: TODAY, dueTime: '14:00' }));
    await w.tick();
    expect(w.push.sends.map((s) => s.target.endpoint)).toEqual([
      'https://web.push.apple.com/secret-S1',
    ]);
  });

  it('sweeps dedup rows past 48 h, old guard counters and unsent stale test rows', async () => {
    const w = world();
    await w.device();
    const r = w.repo();
    await r.putPushSentIf({ fireAt: TWO_PM - PSENT_KEEP_MS - 1, key: 'old', sentAt: 0 });
    await r.putPushSentIf({ fireAt: TWO_PM - PSENT_KEEP_MS + MIN, key: 'kept', sentAt: 0 });
    await r.putPushCountIf({ day: '2026-11-01', count: 3, updatedAt: 1 }, null);
    await r.putPushCountIf({ day: '2026-11-02', count: 3, updatedAt: 1 }, null);
    await r.putPushTest({ id: 'stale', createdAt: TWO_PM - 31 * MIN });
    await w.tick();
    expect((await r.listPushSent()).map((x) => x.key)).toEqual(['kept']);
    expect((await r.listPushCounts()).map((x) => x.day)).toEqual(['2026-11-02']);
    expect(await r.listPushTests()).toEqual([]);
    expect(w.push.sends).toHaveLength(0); // out of the window: never sent
  });

  it('no VAPID key: nothing is consumed or sent, the stage error is shown, logged once per container', async () => {
    const w = world();
    await w.device();
    await w.repo().putTask(task({ dueDay: TODAY, dueTime: '14:00' }));
    w.push.readyAs = 'no-key';
    const report = await w.tick();
    expect(report.error).toBe(PUSH_NO_KEY_ERROR);
    w.set(TWO_PM + MIN);
    await w.tick();
    expect(w.push.sends).toHaveLength(0);
    expect(await w.repo().listPushSent()).toEqual([]);
    expect(w.events()).toEqual(['push_no_key']);
    expect(await w.registry.getPoller()).toMatchObject({
      lastError: PUSH_NO_KEY_ERROR,
      lastErrorAt: TWO_PM + MIN,
    });
    // The key arrives: the reminder (still in the window) goes, and the stage error clears.
    w.push.readyAs = 'ok';
    w.set(TWO_PM + 2 * MIN);
    await w.tick();
    expect(w.push.sends).toHaveLength(1);
    expect(await w.registry.getPoller()).toMatchObject({
      lastError: null,
      lastErrorAt: TWO_PM + MIN,
    });
  });

  it('honours the deadline: no user and no send starts past it', async () => {
    const w = world();
    await w.device('S1');
    await w.repo().putTask(task({ dueDay: TODAY, dueTime: '14:00' }));
    const report = await w.tick({ deadline: TWO_PM });
    expect(report.deadline).toBe(true);
    expect(w.push.sends).toHaveLength(0);
    expect(await w.repo().listPushSent()).toEqual([]);
    expect((await w.registry.getPoller())?.lastRunAt).toBe(TWO_PM); // the heartbeat still lands

    const w2 = world();
    await w2.device('S1');
    await w2.device('S2');
    await w2.repo().putTask(task({ dueDay: TODAY, dueTime: '14:00' }));
    w2.push.status = () => {
      w2.set(TWO_PM + 10_000); // the first send ate the budget
      return 201;
    };
    const r2 = await w2.tick({ deadline: TWO_PM + 5_000 });
    expect(r2).toMatchObject({ deadline: true, delivered: 1 });
    expect(w2.push.sends).toHaveLength(1);
    expect((await w2.repo().getPushUserHealth())?.lastError).toMatch(/ran out of time/);
  });

  it("one user's fault doesn't starve the next; the tick still fails, after its heartbeat", async () => {
    const inner = new InMemoryDoc();
    const broken: DocClient = {
      ...inner,
      get: inner.get.bind(inner),
      put: inner.put.bind(inner),
      putIf: inner.putIf.bind(inner),
      delete: inner.delete.bind(inner),
      deleteIf: inner.deleteIf.bind(inner),
      batchPut: inner.batchPut.bind(inner),
      queryIndex: inner.queryIndex.bind(inner),
      query: async (p, prefix, opts) => {
        if (p === pk('bad'))
          throw Object.assign(new Error('throttled'), {
            name: 'ProvisionedThroughputExceededException',
          });
        return inner.query(p, prefix, opts);
      },
    };
    const w = world(broken);
    await w.device('S0', 'bad');
    await w.device('S1', 'u1');
    await w.repo('u1').putTask(task({ id: 'A', userId: 'u1', dueDay: TODAY, dueTime: '14:00' }));
    await expect(w.tick()).rejects.toThrow('throttled');
    expect(w.push.sends).toHaveLength(1);
    expect(await w.registry.getPoller()).toMatchObject({
      lastRunAt: TWO_PM,
      lastError: 'The reminder check failed (ProvisionedThroughputExceededException)',
    });
  });

  it('logs one JSON line per send or failure — never the endpoint, the keys or a title', async () => {
    const w = world();
    await w.device('S1');
    await w.device('S2');
    await w.repo().putTask(task({ title: 'Secret title', dueDay: TODAY, dueTime: '14:00' }));
    w.push.status = (t: PushTarget) => (t.endpoint.endsWith('S1') ? 201 : 410);
    await w.tick();
    expect(w.events()).toEqual(['push_sent', 'push_failed']);
    expect(JSON.parse(w.logs[0]!)).toEqual({
      event: 'push_sent',
      status: 201,
      sub: 'S1',
      tasks: ['T1'],
    });
    for (const line of w.logs)
      for (const leak of ['secret-', P256DH, AUTH, 'Secret title', 'web.push.apple.com', 'iPhone'])
        expect(line).not.toContain(leak);
  });
});

describe('push dispatch — armed before it fires', () => {
  // A task's arm time is its remindArmedAt: the updatedAt of the write that set its current fire time.
  it('a task created after its fire time never pings, even inside the window', async () => {
    const w = world();
    await w.device();
    await w.repo().putTask(task({ dueDay: TODAY, dueTime: '14:00', updatedAt: TWO_PM + 20_000 }));
    w.set(TWO_PM + MIN);
    await w.tick();
    expect(w.push.sends).toHaveLength(0);
  });

  it('a task re-dated into the past window never pings', async () => {
    const w = world();
    await w.device();
    await w.repo().putTask(task({ dueDay: TODAY, dueTime: '18:00', updatedAt: 0 })); // armed early, for 18:00
    await w.repo().putTask(task({ dueDay: TODAY, dueTime: '14:00', updatedAt: TWO_PM + 5 * MIN }));
    w.set(TWO_PM + 6 * MIN);
    await w.tick();
    expect(w.push.sends).toHaveLength(0);
  });

  it('a task reopened after its fire time never pings', async () => {
    const w = world();
    await w.device();
    const due = { dueDay: TODAY, dueTime: '14:00' };
    await w.repo().putTask(task({ ...due, updatedAt: 0 }));
    await w.repo().putTask(task({ ...due, status: 'done', completedAt: 1, updatedAt: 1 }));
    await w.repo().putTask(task({ ...due, updatedAt: TWO_PM + MIN })); // reopened at 14:01
    w.set(TWO_PM + 2 * MIN);
    await w.tick();
    expect(w.push.sends).toHaveLength(0);
  });

  it('a task that existed before its fire time and was missed by a failed tick still pings', async () => {
    const w = world();
    await w.device();
    await w.repo().putTask(task({ dueDay: TODAY, dueTime: '14:00', updatedAt: TWO_PM - 3600_000 }));
    // An edit that doesn't move the fire time keeps the arm: renamed at 14:05, the 14:00 tick never ran.
    await w
      .repo()
      .putTask(
        task({ dueDay: TODAY, dueTime: '14:00', title: 'Renamed', updatedAt: TWO_PM + 5 * MIN }),
      );
    w.set(TWO_PM + 10 * MIN);
    await w.tick();
    expect(w.notes()).toEqual([expect.objectContaining({ title: 'Renamed' })]);
  });

  it('a plan made after 9:00 for today never pings; one made before, missed by a tick, does', async () => {
    const w = world();
    await w.device();
    await w.repo().putTask(task({ id: 'A', title: 'Early' }));
    await w.repo().putTask(task({ id: 'B', title: 'Late' }));
    await w.repo().putPlan(plan({ id: 'P1', taskId: 'A', updatedAt: NINE_AM - 3600_000 }));
    await w
      .repo()
      .putPlan(plan({ id: 'P2', taskId: 'B', order: 1, updatedAt: NINE_AM + 10 * MIN }));
    w.set(NINE_AM + 15 * MIN);
    await w.tick();
    expect(w.notes()).toEqual([
      expect.objectContaining({ title: 'Early', body: 'Planned for today' }),
    ]);
  });

  it('a plan reordered within its day keeps its arm; moved to another day it re-arms', async () => {
    const w = world();
    await w.device();
    await w.repo().putTask(task({ id: 'A', title: 'Kept' }));
    const p = plan({ id: 'P1', taskId: 'A', updatedAt: 0 });
    await w.repo().putPlan(p);
    const reordered = { ...p, order: 3, updatedAt: NINE_AM + 5 * MIN };
    await w.repo().putPlan(reordered, p);
    w.set(NINE_AM + 6 * MIN);
    await w.tick();
    expect(w.push.sends).toHaveLength(1);
    // Off to tomorrow and back to today at 9:20: re-planned after 9:00, so quiet.
    const w2 = world();
    await w2.device();
    await w2.repo().putTask(task({ id: 'A', title: 'Moved' }));
    const q = plan({ id: 'P1', taskId: 'A', updatedAt: 0 });
    await w2.repo().putPlan(q);
    const tomorrow = { ...q, day: '2026-11-05', updatedAt: NINE_AM + 10 * MIN };
    await w2.repo().putPlan(tomorrow, q);
    await w2.repo().putPlan({ ...tomorrow, day: TODAY, updatedAt: NINE_AM + 20 * MIN }, tomorrow);
    w2.set(NINE_AM + 21 * MIN);
    await w2.tick();
    expect(w2.push.sends).toHaveLength(0);
  });

  it('nothing due before the user had reminders on pings (the registry row is when they went live)', async () => {
    const w = world();
    await w.repo().putPushSub(sub('S1'));
    await w.registry.addUser(U, TWO_PM + 5 * MIN); // first device at 14:05
    await w.repo().putTask(task({ dueDay: TODAY, dueTime: '14:00', updatedAt: 0 }));
    await w
      .repo()
      .putTask(task({ id: 'T2', title: 'Later', dueDay: TODAY, dueTime: '14:06', updatedAt: 0 }));
    w.set(TWO_PM + 6 * MIN);
    await w.tick();
    expect(w.notes()).toEqual([expect.objectContaining({ title: 'Later' })]);
  });

  it("a kind switched back on doesn't fire what fell due while it was off", async () => {
    const w = world();
    await w.device();
    await w.repo().putPushArm({ remindTimed: TWO_PM + 5 * MIN, updatedAt: 1 }); // back on at 14:05
    await w.repo().putTask(task({ dueDay: TODAY, dueTime: '14:00', updatedAt: 0 }));
    await w.repo().putTask(task({ id: 'D', title: 'Day-only', dueDay: TODAY, updatedAt: 0 }));
    w.set(TWO_PM + 6 * MIN);
    await w.tick();
    expect(w.push.sends).toHaveLength(0); // 14:00 fell due while Timed was off
    w.set(NINE_AM + MIN);
    await w.tick(); // the day-only kind was never off: its 9:00 pings
    expect(w.notes()).toEqual([expect.objectContaining({ title: 'Day-only' })]);
  });

  it('Send test is exempt: it pings even when the user just went live', async () => {
    const w = world();
    await w.repo().putPushSub(sub('S1'));
    await w.registry.addUser(U, TWO_PM);
    await w.repo().putPushTest({ id: 'X', createdAt: TWO_PM });
    w.set(TWO_PM + 30_000);
    await w.tick();
    expect(w.notes()).toEqual([expect.objectContaining({ title: 'Aperture test' })]);
  });
});

describe('push dispatch — races with the BFF', () => {
  it('a removal (tombstone) that lands during the send survives the 410', async () => {
    const w = world();
    await w.device('S1');
    await w.repo().putTask(task({ dueDay: TODAY, dueTime: '14:00' }));
    w.push.status = () => {
      // Settings › Remove, mid-send: the row becomes a keyless tombstone with a newer updatedAt.
      w.mem.putNow(
        entityItem(
          U,
          sk.pushSub('S1'),
          sub('S1', { endpoint: '', p256dh: '', auth: '', deletedAt: 9, updatedAt: 9 }),
        ),
      );
      return 410;
    };
    await w.tick();
    expect(await w.repo().getPushSub('S1')).toMatchObject({ deletedAt: 9 }); // removal sticks
    expect(w.events()).toEqual(['push_failed']);
    expect(JSON.parse(w.logs[0]!)).toMatchObject({ status: 410, changed: true });
    // The removal's own unsubscribe settles the registry; failing that, the next tick finds no alive device.
    w.set(TWO_PM + MIN);
    await w.tick();
    expect(await w.registry.hasUser(U)).toBe(false);
    expect(await w.repo().getPushSub('S1')).toMatchObject({ deletedAt: 9 });
  });

  it('a revive (re-subscribe) that lands during the send survives the 410, and keeps the user registered', async () => {
    const w = world();
    await w.device('S1');
    await w.repo().putTask(task({ dueDay: TODAY, dueTime: '14:00' }));
    w.push.status = () => {
      w.mem.putNow(
        entityItem(U, sk.pushSub('S1'), sub('S1', { auth: 'fresh-auth', updatedAt: 9 })),
      );
      return 410;
    };
    await w.tick();
    expect(await w.repo().getPushSub('S1')).toMatchObject({ auth: 'fresh-auth', deletedAt: null });
    expect(await w.registry.hasUser(U)).toBe(true);
  });

  it('a subscribe that lands as the last device goes keeps the user registered, createdAt kept', async () => {
    // The poller's first list misses the new device (it was written a moment later); the re-read after the
    // registry delete sees it, and the row comes back as it was.
    const inner = new InMemoryDoc();
    let missNext = 1;
    const racing: DocClient = Object.assign(Object.create(inner) as InMemoryDoc, {
      query: async (p: string, prefix: string, opts?: { consistent?: boolean }) => {
        if (prefix === sk.pushSubPrefix() && missNext-- > 0) {
          await inner.put(entityItem(U, sk.pushSub('S2'), sub('S2')));
          return [];
        }
        return inner.query(p, prefix, opts);
      },
    });
    const w = world(racing);
    await w.registry.addUser(U, 1234);
    await w.tick();
    expect(await w.registry.getUser(U)).toEqual({ userId: U, createdAt: 1234 });
    expect(w.events()).not.toContain('push_user_dropped');
  });
});

describe('push dispatch — what the health line says', () => {
  it('lastSentAt is the last time a push service accepted one; a refusal moves only the error', async () => {
    const w = world();
    await w.device('S1');
    await w.repo().putTask(task({ id: 'A', dueDay: TODAY, dueTime: '14:00' }));
    await w.tick();
    expect((await w.repo().getPushUserHealth())?.lastSentAt).toBe(TWO_PM);
    await w.repo().putTask(task({ id: 'B', dueDay: TODAY, dueTime: '14:05' }));
    w.push.status = 503;
    w.set(TWO_PM + 5 * MIN);
    await w.tick();
    expect(await w.repo().getPushUserHealth()).toMatchObject({
      lastSentAt: TWO_PM,
      lastErrorAt: TWO_PM + 5 * MIN,
    });
  });

  it('every device that refused this tick is named', async () => {
    const w = world();
    await w.device('S1');
    await w.device('S2');
    await w.repo().putTask(task({ dueDay: TODAY, dueTime: '14:00' }));
    w.push.status = (t: PushTarget) =>
      t.endpoint.endsWith('S1') ? 410 : { status: 0, reason: 'keys' };
    await w.tick();
    expect((await w.repo().getPushUserHealth())?.lastError).toBe(
      'iPhone S1 stopped accepting reminders (push service answered 410) — turn them on again on that device · ' +
        'iPhone S2 stopped accepting reminders (its keys are invalid) — turn them on again on that device',
    );
  });

  it("a send that throws says it couldn't send, by the error's name", async () => {
    const w = world();
    await w.device('S1');
    await w.repo().putTask(task({ dueDay: TODAY, dueTime: '14:00' }));
    w.push.status = () => {
      throw new RangeError('bad');
    };
    await w.tick();
    expect((await w.repo().getPushSub('S1'))?.lastError).toBe(
      "Last reminder didn't reach this device (couldn't send: RangeError)",
    );
  });

  it('a stage with no APP_URL says so, not "no key"', async () => {
    const w = world();
    await w.device();
    w.push.readyAs = 'no-app-url';
    expect((await w.tick()).error).toBe(PUSH_NO_APP_URL_ERROR);
    expect(w.events()).toEqual(['push_no_app_url']);
  });

  it('a malformed VAPID key is a stage fault: nothing consumed or sent, shown, logged once', async () => {
    const w = world();
    await w.device();
    await w.repo().putTask(task({ dueDay: TODAY, dueTime: '14:00' }));
    w.push.readyAs = 'bad-key';
    expect((await w.tick()).error).toBe(PUSH_BAD_KEY_ERROR);
    w.set(TWO_PM + MIN);
    await w.tick();
    expect(w.push.sends).toHaveLength(0);
    expect(await w.repo().listPushSent()).toEqual([]);
    expect(w.events()).toEqual(['push_bad_key']);
    expect(await w.registry.getPoller()).toMatchObject({ lastError: PUSH_BAD_KEY_ERROR });
  });
});

describe('push dispatch — testMode', () => {
  it('noopWrites + noopPush: the selection runs, nothing persists, nothing is sent', async () => {
    const w = world();
    await w.device();
    await w.repo().putTask(task({ dueDay: TODAY, dueTime: '14:00' }));
    await w.repo().putPushTest({ id: 'X', createdAt: TWO_PM });
    await w.repo().putPushSentIf({ fireAt: 1, key: 'ancient', sentAt: 0 });
    const before = w.mem.snapshot();
    const report = await runPushTick({
      doc: w.doc,
      writes: noopWrites(),
      push: noopPush(),
      now: () => TWO_PM,
      appUrl: APP,
      log: () => {},
    });
    expect(report).toMatchObject({ users: 1, notifications: 1, delivered: 0, failed: 1 });
    expect(w.mem.snapshot()).toEqual(before);
  });

  it('the remind index key spaces stay apart from the done index', () => {
    expect(gsi1.remindPk(U)).not.toBe(gsi1.donePk(U));
  });
});
