import { describe, expect, it } from 'vitest';
import {
  PUSH_ENDPOINT_ERROR,
  PUSH_NO_DEVICE_ERROR,
  PUSH_UNCONFIGURED_ERROR,
  userDueEpoch,
} from '@aperture/shared';
import type { SubscribePushInput, Task } from '@aperture/shared';
import { InMemoryDoc } from './ddb/DocClient';
import { gsi1, pk, PUSH_PK, pushSk, sk } from './ddb/keys';
import { entityItem } from './ddb/mapping';
import { PushRegistry } from './ddb/pushRegistry';
import { Repo } from './ddb/repo';
import { liveWrites } from './ddb/writes';
import { BackendClient } from './backend';
import { handleRpc } from './handler';
import { runPushTick } from './push/dispatch';
import { InMemoryPush } from './push/gateway';

// The BFF's half of reminders (reminders.md): devices in, keys never out, the registry kept in step,
// Send test queued for the poller — and the poller's real tick over what the BFF wrote.

const NOW = userDueEpoch('2026-11-04', '10:00');
const PUB =
  'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';
const P256DH =
  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
const AUTH = 'BTBZMqHH6r4Tts7J_aSIgg';
const input = (endpoint = 'https://web.push.apple.com/dev-secret-1'): SubscribePushInput => ({
  endpoint,
  keys: { p256dh: P256DH, auth: AUTH },
  label: 'iPhone · Safari',
});

function env(opts: { key?: string | null } = {}) {
  const doc = new InMemoryDoc();
  const writes = liveWrites(doc);
  const registry = new PushRegistry(doc, writes);
  let clock = NOW;
  const key = opts.key === undefined ? PUB : opts.key;
  const make = (userId = 'u1') =>
    new BackendClient(new Repo(doc, writes, userId), {
      userId,
      now: () => clock,
      pushRegistry: registry,
      pushPublicKey: async () => key,
    });
  return { doc, registry, make, advance: (ms: number) => void (clock += ms), now: () => clock };
}

describe('subscribePush', () => {
  it('refuses an endpoint off the allowlist, keys that are missing, or a stage with no key — writing nothing', async () => {
    const e = env();
    const api = e.make();
    for (const endpoint of [
      'https://evil.example/x',
      'https://169.254.169.254/latest',
      'http://web.push.apple.com/x',
      `https://web.push.apple.com/${'x'.repeat(2048)}`,
      42 as unknown as string,
    ])
      await expect(api.subscribePush(input(endpoint))).rejects.toThrow(PUSH_ENDPOINT_ERROR);
    await expect(api.subscribePush(null as unknown as SubscribePushInput)).rejects.toThrow(
      PUSH_ENDPOINT_ERROR,
    );
    for (const keys of [
      undefined,
      { p256dh: P256DH },
      { p256dh: P256DH, auth: 'has spaces' },
      { p256dh: 'x'.repeat(300), auth: AUTH },
    ])
      await expect(
        api.subscribePush({ ...input(), keys } as unknown as SubscribePushInput),
      ).rejects.toThrow(/missing its keys/);
    await expect(env({ key: null }).make().subscribePush(input())).rejects.toThrow(
      PUSH_UNCONFIGURED_ERROR,
    );
    expect(e.doc.size).toBe(0);
  });

  it('the first device registers the user with the poller; the last one out removes them', async () => {
    const e = env();
    const api = e.make();
    const a = await api.subscribePush(input());
    expect(await e.registry.hasUser('u1')).toBe(true);
    expect(a.id).toMatch(/^[0-9a-f]{16}$/);
    const b = await api.subscribePush(input('https://fcm.googleapis.com/fcm/send/2'));
    expect((await e.registry.listUsers()).map((u) => u.userId)).toEqual(['u1']);
    await api.unsubscribePush(a.id);
    expect(await e.registry.hasUser('u1')).toBe(true);
    await api.unsubscribePush(b.id);
    expect(await e.registry.hasUser('u1')).toBe(false);
  });

  it('a re-subscribe is an upsert: same id, createdAt and lastOkAt kept; the error clears only on new keys', async () => {
    const e = env();
    const api = e.make();
    const a = await api.subscribePush(input());
    const repo = new Repo(e.doc, liveWrites(e.doc), 'u1');
    const stored = (await repo.getPushSub(a.id))!;
    await repo.putPushSub({
      ...stored,
      lastOkAt: NOW + 1,
      lastError: 'boom',
      lastErrorAt: NOW + 1,
      updatedAt: NOW + 1,
    });
    e.advance(5000);
    const again = await api.subscribePush({ ...input(), label: '  iPhone\n  (again) ' });
    // The same keys re-sent can't have fixed what the poller saw: the error stands.
    expect(again).toEqual({
      id: a.id,
      label: 'iPhone (again)',
      createdAt: NOW,
      lastOkAt: NOW + 1,
      lastError: 'boom',
      lastErrorAt: NOW + 1,
    });
    expect((await repo.getPushSub(a.id))?.updatedAt).toBe(NOW + 5000);
    expect((await api.subscribePush({ ...input(), label: '' })).label).toBe('This device');
    // New keys are a new subscription: the old error goes.
    const rekeyed = await api.subscribePush({
      ...input(),
      keys: { p256dh: P256DH, auth: 'AAAAAAAAAAAAAAAAAAAAAA' },
    });
    expect(rekeyed).toMatchObject({
      id: a.id,
      lastOkAt: NOW + 1,
      lastError: null,
      lastErrorAt: null,
    });
  });

  it('removal sticks: a tombstone with no endpoint or keys, listed as removed, revived by a re-subscribe', async () => {
    const e = env();
    const api = e.make();
    const a = await api.subscribePush(input());
    e.advance(1000);
    await api.unsubscribePush(a.id);
    const repo = new Repo(e.doc, liveWrites(e.doc), 'u1');
    expect(await repo.getPushSub(a.id)).toMatchObject({
      endpoint: '',
      p256dh: '',
      auth: '',
      deletedAt: NOW + 1000,
    });
    expect(JSON.stringify(e.doc.snapshot())).not.toMatch(/dev-secret-1|BCVxsr7N|BTBZMqHH/);
    expect(await api.getPushStatus()).toMatchObject({ devices: [], removedDeviceIds: [a.id] });
    expect(await e.registry.hasUser('u1')).toBe(false);
    await expect(api.sendTestPush()).rejects.toThrow(PUSH_NO_DEVICE_ERROR);
    // Removing again, or an unknown id, writes nothing.
    const before = e.doc.snapshot();
    await api.unsubscribePush(a.id);
    await api.unsubscribePush('0000000000000000');
    expect(e.doc.snapshot()).toEqual(before);
    // Enable again on that device: same id, alive, keys back, registered.
    e.advance(1000);
    const back = await api.subscribePush(input());
    expect(back).toMatchObject({ id: a.id, createdAt: NOW });
    expect(await repo.getPushSub(a.id)).toMatchObject({
      endpoint: 'https://web.push.apple.com/dev-secret-1',
      p256dh: P256DH,
      deletedAt: null,
    });
    expect(await api.getPushStatus()).toMatchObject({
      removedDeviceIds: [],
      devices: [expect.objectContaining({ id: a.id })],
    });
    expect(await e.registry.hasUser('u1')).toBe(true);
  });

  it('a removed device is never sent to; a device the push service expired is gone, not listed as removed', async () => {
    const e = env();
    const api = e.make();
    const a = await api.subscribePush(input());
    const b = await api.subscribePush(input('https://fcm.googleapis.com/fcm/send/2'));
    await api.unsubscribePush(a.id);
    await api.sendTestPush();
    const push = new InMemoryPush();
    push.status = 410;
    e.advance(30_000);
    await runPushTick({
      doc: e.doc,
      writes: liveWrites(e.doc),
      push,
      now: e.now,
      appUrl: 'https://dev.example',
      log: () => {},
    });
    expect(push.sends.map((s) => s.target.endpoint)).toEqual([
      'https://fcm.googleapis.com/fcm/send/2',
    ]);
    const status = await api.getPushStatus();
    expect(status.devices).toEqual([]);
    expect(status.removedDeviceIds).toEqual([a.id]); // b was hard-deleted: its launch resync heals it
    expect(status.removedDeviceIds).not.toContain(b.id);
    expect(await e.registry.hasUser('u1')).toBe(false);
  });

  it("unsubscribe touches only the caller's own partition", async () => {
    const e = env();
    const mine = await e.make('u1').subscribePush(input());
    const theirs = await e.make('u2').subscribePush(input()); // the same endpoint → the same id
    expect(theirs.id).toBe(mine.id);
    await e.make('u2').unsubscribePush(mine.id);
    expect((await e.make('u1').getPushStatus()).devices.map((d) => d.id)).toEqual([mine.id]);
    expect(await e.registry.hasUser('u1')).toBe(true);
    expect(await e.registry.hasUser('u2')).toBe(false);
  });

  it("the first device puts the user's live deadlines and plans written before the index on it", async () => {
    const e = env();
    const task = (id: string, over: Partial<Task>): Task =>
      ({
        id,
        userId: 'u1',
        createdAt: 0,
        updatedAt: 3,
        deletedAt: null,
        title: id,
        status: 'backlog',
        dueDay: null,
        dueTime: null,
        ...over,
      }) as Task;
    const raw = (skStr: string, row: object) => e.doc.put(entityItem('u1', skStr, row)); // no GSI keys
    await raw(sk.task('later'), task('later', { dueDay: '2026-11-05', dueTime: '09:00' }));
    await raw(sk.task('past'), task('past', { dueDay: '2026-11-01' }));
    await raw(sk.task('done'), task('done', { dueDay: '2026-11-05', status: 'done' }));
    const plan = {
      id: 'P',
      userId: 'u1',
      createdAt: 0,
      updatedAt: 4,
      deletedAt: null,
      taskId: 'past',
      day: '2026-11-06',
      plannedMinutes: 30,
      order: 0,
    };
    await raw(sk.plan('2026-11-06', 0, 'P'), plan);
    await e.make().subscribePush(input());
    const repo = new Repo(e.doc, liveWrites(e.doc), 'u1');
    const rows = await repo.remindRowsInWindow(0, Number.MAX_SAFE_INTEGER);
    expect(
      rows.map((r) => [
        r.kind,
        r.kind === 'task' ? r.task.id : r.kind === 'plan' ? r.plan.id : r.id,
      ]),
    ).toEqual([
      ['task', 'later'],
      ['plan', 'P'],
    ]);
    // Re-keyed as read: the body and its version are untouched.
    expect((await repo.getTask('later'))?.updatedAt).toBe(3);
  });
});

describe('getPushStatus', () => {
  it("never carries a device's endpoint or keys", async () => {
    const e = env();
    const api = e.make();
    await api.subscribePush(input());
    const status = await api.getPushStatus();
    expect(status).toMatchObject({ configured: true, vapidPublicKey: PUB });
    expect(Object.keys(status.devices[0]!).sort()).toEqual([
      'createdAt',
      'id',
      'label',
      'lastError',
      'lastErrorAt',
      'lastOkAt',
    ]);
    const text = JSON.stringify(status) + JSON.stringify(await api.exportData());
    for (const leak of ['dev-secret-1', P256DH, AUTH]) expect(text).not.toContain(leak);
  });

  it('says unconfigured without a key, and reads the poller and the user health apart', async () => {
    expect(await env({ key: null }).make().getPushStatus()).toEqual({
      configured: false,
      vapidPublicKey: null,
      devices: [],
      removedDeviceIds: [],
      poller: { lastRunAt: null, lastSentAt: null, lastError: null, lastErrorAt: null },
    });
    const e = env();
    const repo = new Repo(e.doc, liveWrites(e.doc), 'u1');
    await e.registry.putPoller({ lastRunAt: NOW, lastError: null, lastErrorAt: 5, updatedAt: NOW });
    await repo.putPushUserHealth({
      lastSentAt: 7,
      lastError: 'iPhone gone',
      lastErrorAt: 8,
      updatedAt: 8,
    });
    expect((await e.make().getPushStatus()).poller).toEqual({
      lastRunAt: NOW,
      lastSentAt: 7,
      lastError: 'iPhone gone',
      lastErrorAt: 8,
    });
    // The stage's current error outranks the user's last one.
    await e.registry.putPoller({
      lastRunAt: NOW,
      lastError: 'No key',
      lastErrorAt: 9,
      updatedAt: NOW,
    });
    expect((await e.make().getPushStatus()).poller).toMatchObject({
      lastError: 'No key',
      lastErrorAt: 9,
    });
    // Another user's health is never this one's.
    expect((await e.make('u2').getPushStatus()).poller.lastSentAt).toBeNull();
  });
});

describe('sendTestPush', () => {
  it('needs a device and a key, then queues a candidate on the remind index at now', async () => {
    const e = env();
    const api = e.make();
    await expect(api.sendTestPush()).rejects.toThrow(PUSH_NO_DEVICE_ERROR);
    await api.subscribePush(input());
    await api.sendTestPush();
    const rows = e.doc.snapshot().filter((i) => i.SK.startsWith(sk.pushTestPrefix()));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ PK: pk('u1'), GSI1PK: gsi1.remindPk('u1'), GSI1SK: NOW });
    // A registry row a race dropped comes back.
    await e.doc.delete(PUSH_PK, pushSk.user('u1'));
    await api.sendTestPush();
    expect(await e.registry.hasUser('u1')).toBe(true);
  });

  it('refuses on a stage whose key went away', async () => {
    const e = env();
    await e.make().subscribePush(input());
    const noKey = new BackendClient(new Repo(e.doc, liveWrites(e.doc), 'u1'), {
      userId: 'u1',
      now: () => NOW,
      pushRegistry: e.registry,
    });
    await expect(noKey.sendTestPush()).rejects.toThrow(PUSH_UNCONFIGURED_ERROR);
  });

  it('end to end: subscribe → Send test → the next tick delivers it → status shows it', async () => {
    const e = env();
    const api = e.make();
    const device = await api.subscribePush(input());
    await api.sendTestPush();
    const push = new InMemoryPush();
    e.advance(40_000);
    await runPushTick({
      doc: e.doc,
      writes: liveWrites(e.doc),
      push,
      now: e.now,
      appUrl: 'https://dev.example',
      log: () => {},
    });
    expect(push.sends.map((s) => s.target.endpoint)).toEqual([
      'https://web.push.apple.com/dev-secret-1',
    ]);
    const status = await api.getPushStatus();
    expect(status.poller).toMatchObject({
      lastRunAt: NOW + 40_000,
      lastSentAt: NOW + 40_000, // the push service accepted it
      lastError: null,
    });
    expect(status.devices).toEqual([{ ...device, lastOkAt: NOW + 40_000 }]);
  });
});

// The poller's real tick over what the BFF wrote, at the env's clock.
const tick = (e: ReturnType<typeof env>, push = new InMemoryPush()) =>
  runPushTick({
    doc: e.doc,
    writes: liveWrites(e.doc),
    push,
    now: e.now,
    appUrl: 'https://dev.example',
    log: () => {},
  }).then(() => push);
const titles = (push: InMemoryPush) =>
  push.sends.map((x) => (x.payload as { notification: { title: string } }).notification.title);

describe('armed before it fires, through the BFF', () => {
  it('a timed task created now for a minute already past never pings; one ahead does', async () => {
    const e = env();
    const api = e.make();
    await api.subscribePush(input());
    await api.createTask({ title: 'Late', dueDay: '2026-11-04', dueTime: '09:55' }); // 5 min ago
    await api.createTask({ title: 'Ahead', dueDay: '2026-11-04', dueTime: '10:01' });
    e.advance(61_000);
    expect(titles(await tick(e))).toEqual(['Ahead']);
  });

  it('a task re-dated into the past window never pings; renaming one that was armed in time keeps it', async () => {
    const e = env();
    const api = e.make();
    await api.subscribePush(input());
    const kept = await api.createTask({ title: 'Kept', dueDay: '2026-11-04', dueTime: '10:02' });
    const moved = await api.createTask({ title: 'Moved', dueDay: '2026-11-04', dueTime: '18:00' });
    e.advance(3 * 60_000); // 10:03 — the 10:02 tick never ran
    await api.setTaskTitle(kept.id, 'Kept, renamed');
    await api.setTaskDue(moved.id, { dueDay: '2026-11-04', dueTime: '10:01' });
    expect(titles(await tick(e))).toEqual(['Kept, renamed']);
  });

  it("a toggle switched back on doesn't fire the last 30 minutes", async () => {
    const e = env();
    const api = e.make();
    await api.subscribePush(input());
    await api.createTask({ title: 'While off', dueDay: '2026-11-04', dueTime: '10:05' });
    await api.createTask({ title: 'After', dueDay: '2026-11-04', dueTime: '10:20' });
    await api.updateSettings({ remindTimed: false });
    e.advance(10 * 60_000); // 10:10, past While off
    await api.updateSettings({ remindTimed: true });
    expect(await tick(e).then(titles)).toEqual([]);
    e.advance(10 * 60_000); // 10:20
    expect(await tick(e).then(titles)).toEqual(['After']);
    // Turning it on again when it's already on isn't a switch-on.
    await api.updateSettings({ remindTimed: true, remindDueDay: true });
    await expect(new Repo(e.doc, liveWrites(e.doc), 'u1').getPushArm()).resolves.toMatchObject({
      remindTimed: NOW + 10 * 60_000,
    });
  });

  it("the first device's backfill doesn't fire the last 30 minutes; what's ahead pings", async () => {
    const e = env();
    const raw = (id: string, dueTime: string) =>
      e.doc.put(
        entityItem('u1', sk.task(id), {
          id,
          userId: 'u1',
          createdAt: 0,
          updatedAt: 1,
          deletedAt: null,
          title: id,
          status: 'backlog',
          dueDay: '2026-11-04',
          dueTime,
        }),
      ); // written before the index: no GSI keys, no arm
    await raw('Behind', '09:50');
    await raw('Ahead', '10:01');
    await e.make().subscribePush(input()); // backfill at 10:00
    expect(await tick(e).then(titles)).toEqual([]);
    e.advance(60_000);
    expect(await tick(e).then(titles)).toEqual(['Ahead']);
  });
});

describe('Send test rows never go stale', () => {
  it('a newer Send test replaces an unsent one, and a re-enable starts with none queued', async () => {
    const e = env();
    const api = e.make();
    const a = await api.subscribePush(input());
    const tests = () =>
      new Repo(e.doc, liveWrites(e.doc), 'u1').listPushTests({ consistent: true });
    await api.sendTestPush();
    e.advance(1000);
    await api.sendTestPush();
    expect((await tests()).map((t) => t.createdAt)).toEqual([NOW + 1000]);
    // Removed before any tick: the test never went, and the poller no longer ticks this user.
    await api.unsubscribePush(a.id);
    e.advance(5 * 60_000);
    await api.subscribePush(input()); // Enable again
    expect(await tests()).toEqual([]);
    expect(await tick(e).then(titles)).toEqual([]);
  });
});

describe('the device id the dev check derives', () => {
  // scripts/src/devcheck/api/core.ts harnessPushId pins the same value: the two derivations can't drift apart.
  it('is a sha256(endpoint) hex prefix — devcheck-e2e is 54c270db2e586463', async () => {
    const d = await env().make().subscribePush(input('https://web.push.apple.com/devcheck-e2e'));
    expect(d.id).toBe('54c270db2e586463');
  });
});

describe('a reopen stays quiet', () => {
  // Done and cancelled are terminal (machines.ts), so no BFF path reopens a task — a plan can't re-fire that
  // way. Pinned here so a reopen path added later meets this test (and re-arms the task's plans).
  it('a finished task can’t be reopened through the BFF', async () => {
    const e = env();
    const api = e.make();
    const t = await api.createTask({ title: 'Finished' });
    await api.transitionTask(t.id, 'cancelled');
    for (const to of ['backlog', 'planned', 'in_progress'] as const)
      await expect(api.transitionTask(t.id, to)).rejects.toThrow(/Invalid task transition/);
  });
});

describe('the push registry under races', () => {
  it('status reads devices strongly: a device a moment old is listed and keeps its user registered', async () => {
    const e = env();
    const api = e.make();
    const a = await api.subscribePush(input());
    await e.registry.removeUser('u1');
    // An eventually consistent list wouldn't have it yet.
    e.doc.staleNextQueries(pk('u1'), sk.pushSub(a.id), null, 5);
    expect((await api.getPushStatus()).devices.map((d) => d.id)).toEqual([a.id]);
    expect(await e.registry.hasUser('u1')).toBe(true);
  });

  it("status puts a user with a live device back on the registry (a race's self-heal)", async () => {
    const e = env();
    const api = e.make();
    await api.subscribePush(input());
    await e.registry.removeUser('u1'); // as a lost race would leave it
    await api.getPushStatus();
    expect(await e.registry.hasUser('u1')).toBe(true);
    // No device, no row.
    await api.unsubscribePush((await api.getPushStatus()).devices[0]!.id);
    await api.getPushStatus();
    expect(await e.registry.hasUser('u1')).toBe(false);
  });

  it('a device subscribed while the last one is removed keeps the user registered', async () => {
    const e = env();
    const a = await e.make().subscribePush(input());
    // The other device's subscribe lands between the remove's alive check and its registry delete: it wrote
    // its device and saw the row still there, so it didn't add one.
    let raced = false;
    const original = e.registry.removeUser.bind(e.registry);
    e.registry.removeUser = async (userId: string) => {
      if (!raced) {
        raced = true;
        await e.doc.put(
          entityItem('u1', sk.pushSub('other'), {
            id: 'other',
            userId: 'u1',
            createdAt: NOW,
            updatedAt: NOW,
            deletedAt: null,
            endpoint: 'https://fcm.googleapis.com/fcm/send/x',
            p256dh: P256DH,
            auth: AUTH,
            label: 'Mac',
            lastOkAt: null,
            lastError: null,
            lastErrorAt: null,
          }),
        );
      }
      return original(userId);
    };
    await e.make().unsubscribePush(a.id);
    expect(raced).toBe(true);
    expect(await e.registry.getUser('u1')).toEqual({ userId: 'u1', createdAt: NOW }); // createdAt kept
  });

  it('a revive puts the user back on the registry', async () => {
    const e = env();
    const api = e.make();
    const a = await api.subscribePush(input());
    await api.unsubscribePush(a.id);
    expect(await e.registry.hasUser('u1')).toBe(false);
    e.advance(1000);
    await api.subscribePush(input());
    expect(await e.registry.getUser('u1')).toEqual({ userId: 'u1', createdAt: NOW + 1000 });
  });
});

describe('reminder settings', () => {
  it('default on, a row from before reads on, and a toggle must be a boolean', async () => {
    const e = env();
    const fresh = await e.make().getSettings();
    expect(fresh).toMatchObject({ remindTimed: true, remindDueDay: true, remindPlanned: true });
    await e.doc.put(
      entityItem('u2', sk.settings(), {
        id: 's',
        userId: 'u2',
        createdAt: 0,
        updatedAt: 0,
        deletedAt: null,
        dayStartHour: 5,
      }),
    );
    expect(await e.make('u2').getSettings()).toMatchObject({
      dayStartHour: 5,
      remindTimed: true,
      remindDueDay: true,
      remindPlanned: true,
    });
    await expect(
      e.make().updateSettings({ remindTimed: 'false' as unknown as boolean }),
    ).rejects.toThrow(/remindTimed must be true or false/);
    expect((await e.make().getSettings()).remindTimed).toBe(true);
    expect(await e.make().updateSettings({ remindDueDay: false })).toMatchObject({
      remindDueDay: false,
    });
  });
});

describe('through handleRpc', () => {
  it('a smoke (testMode) subscribe writes nothing and reads no key', async () => {
    const doc = new InMemoryDoc();
    let reads = 0;
    const deps = { pushPublicKey: async () => (reads++, PUB) };
    await expect(
      handleRpc(
        doc,
        { userId: 'smoke', method: 'subscribePush', args: [input()], testMode: true },
        deps,
      ),
    ).rejects.toThrow(PUSH_UNCONFIGURED_ERROR);
    expect(
      await handleRpc(
        doc,
        { userId: 'smoke', method: 'getPushStatus', args: [], testMode: true },
        deps,
      ),
    ).toMatchObject({
      configured: false,
    });
    expect(reads).toBe(0);
    expect(doc.size).toBe(0);
    // Live: the key is read and the device lands.
    await handleRpc(doc, { userId: 'u1', method: 'subscribePush', args: [input()] }, deps);
    expect(reads).toBe(1);
    expect(doc.snapshot().some((i) => i.SK.startsWith(sk.pushSubPrefix()))).toBe(true);
  });
});
