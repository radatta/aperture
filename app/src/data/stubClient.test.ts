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
    const entry = await api.createLogEntry('first real entry');
    expect(entry.day).toBe(today);
    const list = await api.listLogEntries(today);
    expect(list.some((e) => e.id === entry.id)).toBe(true);
  });
});

describe('stub — task lifecycle enforces the estimate freeze', () => {
  it('locks the estimate on start and blocks later edits', async () => {
    const api = client();
    const task = await api.createTask({ title: 'write the thing' });
    await api.setTaskEstimate(task.id, 60, 15);
    const started = await api.transitionTask(task.id, 'in_progress');
    expect(started.estimateLockedMin).toBe(60);
    await expect(api.setTaskEstimate(task.id, 120, 0)).rejects.toThrow();
  });
});

describe('stub — lazy recurrence', () => {
  it('materializes a due series once per day on getDay', async () => {
    const api = client();
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
