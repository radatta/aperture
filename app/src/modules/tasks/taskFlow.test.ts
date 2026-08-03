import { beforeEach, describe, expect, it } from 'vitest';
import { createStubClient } from '../../data/stubClient';

// Integration through the ApiClient (stub) — exercises the real shared machines + wiring, the way
// the UI does. These are the signature-integrity guarantees of Phase 5.
beforeEach(() => globalThis.localStorage?.clear());

function client() {
  return createStubClient({ seed: false, storageKey: `flow-${Math.random()}` });
}

describe('estimate freeze on start-of-work', () => {
  it('freezes the estimate on first exit from planning and rejects later edits', async () => {
    const api = client();
    const t = await api.createTask({ title: 'ship it' });
    await api.setTaskEstimate(t.id, 60, 15);
    const started = await api.transitionTask(t.id, 'in_progress');
    expect(started.estimateLockedMin).toBe(60); // frozen at the pre-work value
    await expect(api.setTaskEstimate(t.id, 90, null)).rejects.toThrow(); // hindsight can't launder it
  });
});

describe('scope change is a split, not an edit', () => {
  it('finishes the original and spawns a fresh unlocked follow-up', async () => {
    const api = client();
    const t = await api.createTask({ title: 'big thing' });
    await api.setTaskEstimate(t.id, 120, null);
    await api.transitionTask(t.id, 'in_progress');
    const { original, followUp } = await api.splitTask(t.id, 'done', 'big thing (cont.)');
    expect(original.status).toBe('done');
    expect(original.estimateLockedMin).toBe(120); // original keeps its frozen value
    expect(followUp.status).toBe('backlog');
    expect(followUp.estimateLockedMin).toBeNull(); // a new prediction for the remaining work
    expect(followUp.title).toBe('big thing (cont.)');
  });
});

describe('actual capture → calibration', () => {
  it('records the actual and surfaces the done task as a calibration point', async () => {
    const api = client();
    const t = await api.createTask({ title: 'estimate me' });
    await api.setTaskEstimate(t.id, 60, null);
    await api.transitionTask(t.id, 'in_progress');
    await api.setTaskActual(t.id, 45); // came in under
    const done = await api.transitionTask(t.id, 'done');
    const points = await api.getCalibration({ from: '2000-01-01', to: '2999-01-01' });
    const mine = points.find((p) => p.taskId === done.id);
    expect(mine).toBeDefined();
    expect(mine!.estimateLockedMin).toBe(60);
    expect(mine!.actualAccruedMin).toBe(45);
  });

  it('excludes cancelled tasks from calibration', async () => {
    const api = client();
    const t = await api.createTask({ title: 'abandon' });
    await api.setTaskEstimate(t.id, 30, null);
    await api.transitionTask(t.id, 'in_progress');
    await api.transitionTask(t.id, 'cancelled');
    const points = await api.getCalibration({ from: '2000-01-01', to: '2999-01-01' });
    expect(points.find((p) => p.taskId === t.id)).toBeUndefined();
  });
});

describe('recurring series materialize lazily on day load', () => {
  it('creates a planned occurrence (own task + plan row) when a due day loads', async () => {
    const api = client();
    await api.upsertSeries({
      title: 'Standup',
      categoryId: null,
      defaultEstimateMin: 15,
      rule: { kind: 'weekdays' },
      anchorDate: '2026-08-03', // Monday
    });
    // 2026-08-05 is a Wednesday → due. Loading the day materializes it (no cron).
    await api.getDay('2026-08-05');
    const plans = await api.listPlansForDay('2026-08-05');
    expect(plans.length).toBe(1);
    const task = await api.getTask(plans[0]!.taskId);
    expect(task?.title).toBe('Standup');
    expect(task?.seriesId).toBeTruthy(); // its own instance → its own calibration point
    expect(task?.status).toBe('planned');

    // Idempotent — loading again doesn't double-materialize.
    await api.getDay('2026-08-05');
    expect((await api.listPlansForDay('2026-08-05')).length).toBe(1);
  });
});
