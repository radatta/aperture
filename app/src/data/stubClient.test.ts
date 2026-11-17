import { beforeEach, describe, expect, it } from 'vitest';
import { dayKey } from '@aperture/shared';
import { createStubClient, STUB_VAPID_PUBLIC_KEY } from './stubClient';

const FIXED = new Date(2026, 5, 15, 10, 0, 0).getTime(); // June 15 2026, 10am local
const today = dayKey(FIXED, 4);

function client() {
  return createStubClient({ now: () => FIXED, storageKey: `test.${FIXED}` });
}

beforeEach(() => {
  globalThis.localStorage?.clear();
});

describe('stub — seed', () => {
  it('provides categories, settings, and calibration history', async () => {
    const api = client();
    expect((await api.listCategories()).length).toBe(5);
    expect((await api.getSettings()).dayStartHour).toBe(4);
    const cal = await api.getCalibration({ from: '2026-01-01', to: today });
    expect(cal.length).toBeGreaterThan(0);
    // seeded actuals skew above estimate — the honest under-scoping signal
    const overs = cal.filter((p) => p.actualAccruedMin > p.estimateLockedMin).length;
    expect(overs).toBeGreaterThan(0);
  });
});

describe('stub — capture', () => {
  it('log entries land on today and read back', async () => {
    const api = client();
    const entry = await api.createLogEntry('first real entry', today);
    expect(entry.day).toBe(today);
    const list = await api.listLogEntries(today);
    expect(list.some((e) => e.id === entry.id)).toBe(true);
  });
});

describe('stub — task lifecycle freezes the calibration baseline', () => {
  it('locks the estimate on start; later edits move the working estimate, never the lock', async () => {
    const api = client();
    const task = await api.createTask({ title: 'write the thing' });
    await api.setTaskEstimate(task.id, 60, 15);
    const started = await api.transitionTask(task.id, 'in_progress');
    expect(started.estimateLockedMin).toBe(60);
    const rescoped = await api.setTaskEstimate(task.id, 120, 0);
    expect(rescoped).toMatchObject({ estimateMin: 120, estimateLockedMin: 60 });
  });
});

describe('stub — lazy recurrence', () => {
  it('materializes a due series once per day on getDay', async () => {
    // seed:false isolates recurrence from the seeded today-plan (the Right-Now hero seed).
    const api = createStubClient({ now: () => FIXED, storageKey: `rec.${FIXED}`, seed: false });
    await api.upsertSeries({
      title: 'daily standup',
      categoryId: null,
      defaultEstimateMin: 15,
      rule: { kind: 'daily' },
      anchorDate: today,
    });
    await api.getDay(today);
    await api.getDay(today); // second read must not duplicate
    const plans = await api.listPlansForDay(today);
    expect(plans.length).toBe(1); // seed creates no plans for today → only the materialized one
    const task = await api.getTask(plans[0]!.taskId);
    expect(task?.seriesId).toBeTruthy();
  });
});

describe('stub — places', () => {
  it('seeds sample places with errands for offline use', async () => {
    const api = client();
    const places = await api.listPlaces();
    expect(places.length).toBeGreaterThan(0);
    expect((await api.listPlaceTasks(places[0]!.slug)).count).toBeGreaterThan(0);
  });

  it('a store persisted before areas lists its categories with area null (reads as Personal)', async () => {
    const key = `legacy-areas.${FIXED}`;
    const legacy = createStubClient({ now: () => FIXED, storageKey: key, seed: false });
    const c = await legacy.upsertCategory({ label: 'old cat', isWork: true });
    const raw = JSON.parse(localStorage.getItem(key)!) as Record<string, unknown>;
    for (const cat of raw.categories as Record<string, unknown>[]) delete cat.area;
    localStorage.setItem(key, JSON.stringify(raw));
    const api = createStubClient({ now: () => FIXED, storageKey: key });
    expect((await api.listCategories()).find((x) => x.id === c.id)?.area).toBeNull();
    expect(
      (await api.upsertCategory({ id: c.id, label: 'old cat', isWork: false })).area,
    ).toBeNull();
    expect((await api.setCategoryWork(c.id, true, false)).category.area).toBeNull();
  });

  it('a store persisted before places loads with no places and its tasks off every list', async () => {
    const key = `legacy.${FIXED}`;
    const legacy = createStubClient({ now: () => FIXED, storageKey: key, seed: false });
    const t = await legacy.createTask({ title: 'old task' });
    const raw = JSON.parse(localStorage.getItem(key)!) as Record<string, unknown>;
    delete raw.places;
    delete raw.placeToken;
    for (const task of raw.tasks as Record<string, unknown>[]) delete task.place;
    localStorage.setItem(key, JSON.stringify(raw));
    const api = createStubClient({ now: () => FIXED, storageKey: key });
    expect(await api.listPlaces()).toEqual([]);
    expect((await api.getTask(t.id))!.place).toBeNull();
    expect((await api.getPlaceTokenStatus()).active).toBe(false);
  });
});

describe('stub — reminders', () => {
  const sub = (endpoint = 'https://web.push.apple.com/QGstub') => ({
    endpoint,
    keys: { p256dh: 'p256dh-secret', auth: 'auth-secret' },
    label: 'iPhone · Safari',
  });

  it('a settings row from before the toggles reads them on, persisted or in memory', async () => {
    const key = `legacy-remind.${FIXED}`;
    const legacy = createStubClient({ now: () => FIXED, storageKey: key, seed: false });
    await legacy.getSettings();
    const raw = JSON.parse(localStorage.getItem(key)!) as { settings: Record<string, unknown> };
    for (const k of ['remindTimed', 'remindDueDay', 'remindPlanned']) delete raw.settings[k];
    delete (raw as Record<string, unknown>).pushSubs;
    delete (raw as Record<string, unknown>).pushHealth;
    localStorage.setItem(key, JSON.stringify(raw));
    const api = createStubClient({ now: () => FIXED, storageKey: key });
    expect(await api.getSettings()).toMatchObject({
      remindTimed: true,
      remindDueDay: true,
      remindPlanned: true,
    });
    expect((await api.getPushStatus()).devices).toEqual([]);
  });

  it('serves a real 65-byte uncompressed P-256 key', async () => {
    const { vapidPublicKey } = await client().getPushStatus();
    expect(vapidPublicKey).toBe(STUB_VAPID_PUBLIC_KEY);
    const bytes = atob(vapidPublicKey!.replace(/-/g, '+').replace(/_/g, '/'));
    expect(bytes.length).toBe(65);
    expect(bytes.charCodeAt(0)).toBe(4);
  });

  it('devices survive a reload, keep their first createdAt on re-subscribe, and never export', async () => {
    let t = FIXED;
    const key = `push.${FIXED}`;
    const api = createStubClient({ now: () => t, storageKey: key, seed: false });
    const a = await api.subscribePush(sub());
    t += 60_000;
    const again = await api.subscribePush({ ...sub(), label: 'Mac · Safari' });
    expect(again).toMatchObject({ id: a.id, createdAt: FIXED, label: 'Mac · Safari' });
    const reloaded = createStubClient({ now: () => t, storageKey: key });
    expect((await reloaded.getPushStatus()).devices.map((d) => d.id)).toEqual([a.id]);
    const exported = JSON.stringify(await reloaded.exportData());
    for (const leak of ['p256dh-secret', 'auth-secret', 'QGstub', 'pushHealth'])
      expect(exported).not.toContain(leak);
  });

  it('a removal is a tombstone without its keys, listed until the same endpoint subscribes again', async () => {
    const key = `push-removed.${FIXED}`;
    const api = createStubClient({ now: () => FIXED, storageKey: key, seed: false });
    const a = await api.subscribePush(sub());
    await api.unsubscribePush(a.id);
    const stored = localStorage.getItem(key)!;
    for (const leak of ['p256dh-secret', 'auth-secret', 'QGstub'])
      expect(stored).not.toContain(leak);
    const reloaded = createStubClient({ now: () => FIXED, storageKey: key });
    expect((await reloaded.getPushStatus()).removedDeviceIds).toEqual([a.id]);
    expect((await reloaded.subscribePush(sub())).id).toBe(a.id);
    expect(await reloaded.getPushStatus()).toMatchObject({
      devices: [expect.objectContaining({ id: a.id })],
      removedDeviceIds: [],
    });
  });

  it("re-sending the same keys keeps the poller's error; new keys or a revive clear it", async () => {
    let t = FIXED;
    const key = `push-err.${FIXED}`;
    const api = createStubClient({ now: () => t, storageKey: key, seed: false });
    const a = await api.subscribePush(sub());
    // Only the poller sets an error: write one the way it would land in the store.
    const raw = JSON.parse(localStorage.getItem(key)!) as { pushSubs: Record<string, unknown>[] };
    Object.assign(raw.pushSubs[0]!, { lastError: '403 Forbidden', lastErrorAt: FIXED });
    localStorage.setItem(key, JSON.stringify(raw));
    const stub = createStubClient({ now: () => t, storageKey: key });
    t += 1000;
    expect(await stub.subscribePush(sub())).toMatchObject({
      lastError: '403 Forbidden',
      lastErrorAt: FIXED,
    });
    const rekeyed = { ...sub(), keys: { p256dh: 'p256dh-new', auth: 'auth-secret' } };
    expect(await stub.subscribePush(rekeyed)).toMatchObject({ lastError: null, lastErrorAt: null });
    await stub.unsubscribePush(a.id);
    t += 1000;
    expect(await stub.subscribePush(sub())).toMatchObject({
      id: a.id,
      createdAt: FIXED,
      lastError: null,
    });
  });

  it('Send test stamps the heartbeat and each device, so the health line moves', async () => {
    let t = FIXED;
    const api = createStubClient({ now: () => t, storageKey: `push-test.${FIXED}`, seed: false });
    expect((await api.getPushStatus()).poller).toEqual({
      lastRunAt: null,
      lastSentAt: null,
      lastError: null,
      lastErrorAt: null,
    });
    const d = await api.subscribePush(sub());
    t += 5000;
    await api.sendTestPush();
    const status = await api.getPushStatus();
    expect(status.poller).toMatchObject({ lastRunAt: t, lastSentAt: t });
    expect(status.devices).toEqual([expect.objectContaining({ id: d.id, lastOkAt: t })]);
  });
});

describe('stub — the extension version on a Start', () => {
  it('keeps x.y.z from the first Start, never a resume’s, and reads anything else as null', async () => {
    const api = createStubClient({ seed: false, storageKey: `ext-version-${Math.random()}` });
    const roll = await api.upsertRoll({ name: 'LeetCode', categoryId: null, estimateMin: 45 });
    await api.updateSettings({ leetcodeRollId: roll.id });
    const start = (clientSittingId: string, problemSlug: string, extensionVersion: unknown) =>
      api.lcSittingStart({
        clientSittingId,
        problemSlug,
        problemTitle: problemSlug,
        lang: 'python3',
        startedAt: Date.now(),
        tzOffsetMinutes: new Date().getTimezoneOffset(),
        extensionVersion: extensionVersion as string,
      });
    const first = await start('01HZZZZZZZZZZZZZZZZZZZZZZZ', 'two-sum', '2.2.0');
    expect(first.sitting.extensionVersion).toBe('2.2.0');
    const again = await start('01HZZZZZZZZZZZZZZZZZZZZZZZ', 'two-sum', '9.9.9');
    expect(again.resumed).toBe(true);
    expect(again.sitting.extensionVersion).toBe('2.2.0');
  });
});

describe('stub — the review draft’s cause', () => {
  // The stub's stand-in for the model's pick: a failed first Submit with no Run before it reads as no-trace.
  async function draftAfter(events: { type: 'run' | 'submit'; status: number; msg: string }[]) {
    const api = createStubClient({ seed: false, storageKey: `draft-cause-${Math.random()}` });
    const roll = await api.upsertRoll({ name: 'LeetCode', categoryId: null, estimateMin: 45 });
    await api.updateSettings({ leetcodeRollId: roll.id });
    const { sitting } = await api.lcSittingStart({
      clientSittingId: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
      problemSlug: 'two-sum',
      problemTitle: 'Two Sum',
      difficulty: 'Easy',
      lang: 'python3',
      startedAt: Date.now(),
      tzOffsetMinutes: new Date().getTimezoneOffset(),
    });
    await api.lcSittingEvents({
      sittingId: sitting.id,
      events: events.map((e, i) => ({
        id: `01HZZZZZZZZZZZZZZZZZZZZZ${String(i).padStart(2, '0')}`,
        type: e.type,
        at: sitting.clientStartedAt + (i + 1) * 60_000,
        payload: { result: { status_code: e.status, status_msg: e.msg, correct_answer: false } },
      })),
    });
    return api.draftSittingReview(sitting.id);
  }
  it('a failed first Submit with no Run before it proposes no-trace', async () => {
    expect(await draftAfter([{ type: 'submit', status: 11, msg: 'Wrong Answer' }])).toMatchObject({
      ok: true,
      cause: 'no-trace',
    });
  });
  it('a Run before it, or an accepted first Submit, proposes nothing', async () => {
    expect(
      await draftAfter([
        { type: 'run', status: 10, msg: 'Accepted' },
        { type: 'submit', status: 11, msg: 'Wrong Answer' },
      ]),
    ).toMatchObject({ ok: true, cause: null });
    expect(await draftAfter([{ type: 'submit', status: 10, msg: 'Accepted' }])).toMatchObject({
      ok: true,
      cause: null,
    });
  });
});
