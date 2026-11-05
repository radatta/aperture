import { beforeEach, describe, expect, it } from 'vitest';
import { dayKey } from '@aperture/shared';
import { createStubClient } from './stubClient';

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
