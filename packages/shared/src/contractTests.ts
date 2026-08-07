import { beforeEach, describe, expect, it } from 'vitest';
import type { ApiClient } from './api';

// ONE behavior suite, run against every ApiClient implementation — the in-memory stub, the in-process
// Lambda (BackendClient over an in-memory table), and any future transport. If the swap is faithful,
// all pass identically. `makeClient` is handed a clock so time-based behavior (heartbeat accrual) is
// deterministic; each test gets a fresh, empty client.
export function runApiContract(
  label: string,
  makeClient: (now: () => number) => ApiClient | Promise<ApiClient>,
) {
  describe(`ApiClient contract — ${label}`, () => {
    let clock: number;
    let api: ApiClient;
    beforeEach(async () => {
      clock = 1_700_000_000_000;
      api = await makeClient(() => clock);
    });
    const advance = (ms: number) => {
      clock += ms;
    };

    it('logs: create is retrievable by its own day, and updates', async () => {
      const e = await api.createLogEntry('shipped it', '2026-08-04');
      expect(e.day).toBe('2026-08-04'); // bucketed by the client-supplied day, not a server-derived one
      const list = await api.listLogEntries(e.day);
      expect(list.map((x) => x.text)).toContain('shipped it');
      const updated = await api.updateLogEntry(e.id, 'shipped it, finally');
      expect(updated.text).toBe('shipped it, finally');
    });

    it('tasks: estimate freezes on start of work and yields a calibration point when done', async () => {
      const t = await api.createTask({ title: 'Task A', estimateMin: 30, bufferMin: 8 });
      expect((await api.listBacklog()).map((x) => x.id)).toContain(t.id);

      await api.setTaskEstimate(t.id, 30, 8);
      const started = await api.transitionTask(t.id, 'in_progress');
      expect(started.estimateLockedMin).toBe(30); // frozen at start
      expect(started.startedAt).not.toBeNull();

      // Estimate is now frozen — editing it must throw for every impl.
      await expect(api.setTaskEstimate(t.id, 99, 0)).rejects.toThrow();

      await api.setTaskActual(t.id, 45);
      const done = await api.transitionTask(t.id, 'done');
      expect(done.status).toBe('done');
      expect(done.completedAt).not.toBeNull();

      const cal = await api.getCalibration({ from: '2000-01-01', to: '2100-01-01' });
      const point = cal.find((p) => p.taskId === t.id);
      expect(point?.estimateLockedMin).toBe(30);
      expect(point?.actualAccruedMin).toBe(45);
    });

    it('tasks: split finishes the original and spawns a fresh unlocked follow-up', async () => {
      const t = await api.createTask({ title: 'Big thing', estimateMin: 60, bufferMin: 0 });
      await api.transitionTask(t.id, 'in_progress');
      const { original, followUp } = await api.splitTask(t.id, 'done', 'Big thing, part 2');
      expect(original.status).toBe('done');
      expect(followUp.title).toBe('Big thing, part 2');
      expect(followUp.status).toBe('backlog');
      expect(followUp.estimateLockedMin).toBeNull(); // a new prediction, never the frozen value
      expect((await api.listTasks()).map((x) => x.id)).toEqual(
        expect.arrayContaining([original.id, followUp.id]),
      );
    });

    it('sessions: several run at once, a task dedups, and work time accrues to the task', async () => {
      const a = await api.startSession({
        taskId: null,
        categoryId: null,
        kind: 'work',
        label: 'CC: a',
        day: '2026-08-04',
      });
      await api.startSession({
        taskId: null,
        categoryId: null,
        kind: 'work',
        label: 'CC: b',
        day: '2026-08-04',
      });
      expect(await api.listRunningSessions()).toHaveLength(2);

      const task = await api.createTask({ title: 'Focused work' });
      const s1 = await api.startSession({
        taskId: task.id,
        categoryId: null,
        kind: 'work',
        day: '2026-08-04',
      });
      const s2 = await api.startSession({
        taskId: task.id,
        categoryId: null,
        kind: 'work',
        day: '2026-08-04',
      });
      expect(s2.id).toBe(s1.id); // dedup: one live timer per task

      advance(2 * 60_000); // two minutes of work
      await api.heartbeatSession(s1.id);
      await api.stopSession(s1.id, 'completed');
      expect((await api.getTask(task.id))?.actualAccruedMin).toBe(2);

      // Stopping removes it from the running set; the ad-hoc ones stay.
      expect((await api.listRunningSessions()).map((s) => s.label).sort()).toEqual([
        'CC: a',
        'CC: b',
      ]);
      void a;
    });

    it('plans: soft-delete removes them from the day', async () => {
      const task = await api.createTask({ title: 'Planned' });
      const plan = await api.upsertPlan({
        taskId: task.id,
        day: '2026-08-04',
        plannedMinutes: 30,
        order: 1,
      });
      expect((await api.listPlansForDay('2026-08-04')).map((p) => p.id)).toContain(plan.id);
      await api.removePlan(plan.id);
      expect((await api.listPlansForDay('2026-08-04')).map((p) => p.id)).not.toContain(plan.id);
    });

    it('habits: check is idempotent per day and uncheck clears it', async () => {
      const h = await api.upsertHabit({ name: 'Read', categoryId: null, cadencePerWeek: 5 });
      const c1 = await api.checkHabit(h.id, '2026-08-04');
      const c2 = await api.checkHabit(h.id, '2026-08-04');
      expect(c2.id).toBe(c1.id); // one per (habit, day)
      expect(await api.listHabitChecks({ from: '2026-08-01', to: '2026-08-07' })).toHaveLength(1);
      await api.uncheckHabit(h.id, '2026-08-04');
      expect(await api.listHabitChecks({ from: '2026-08-01', to: '2026-08-07' })).toHaveLength(0);
    });

    it('ideas: triage moves an idea between status buckets', async () => {
      const idea = await api.createIdea('a thought');
      expect((await api.listIdeas('open')).map((i) => i.id)).toContain(idea.id);
      await api.triageIdea(idea.id, 'triaged');
      expect((await api.listIdeas('open')).map((i) => i.id)).not.toContain(idea.id);
      expect((await api.listIdeas('triaged')).map((i) => i.id)).toContain(idea.id);
    });

    it('day: getDay materializes due recurrence exactly once', async () => {
      await api.upsertSeries({
        title: 'Daily standup',
        categoryId: null,
        defaultEstimateMin: 15,
        rule: { kind: 'daily' },
        anchorDate: '2026-08-01',
      });
      const day = await api.getDay('2026-08-04');
      expect(day.date).toBe('2026-08-04');

      const plans1 = await api.listPlansForDay('2026-08-04');
      expect(plans1).toHaveLength(1);
      const task = await api.getTask(plans1[0]!.taskId);
      expect(task?.title).toBe('Daily standup');
      expect(task?.status).toBe('planned');

      await api.getDay('2026-08-04'); // again → no duplicate occurrence
      expect(await api.listPlansForDay('2026-08-04')).toHaveLength(1);
    });

    it('day: intent persists on the singleton', async () => {
      const d = await api.setDayIntent('2026-08-04', 'Protect the morning');
      expect(d.intent).toBe('Protect the morning');
      expect((await api.getDay('2026-08-04')).intent).toBe('Protect the morning');
    });

    it('categories: work-flip backfills past sessions only when asked; delete reassigns referrers', async () => {
      const cat = await api.upsertCategory({ label: 'Side', isWork: true });
      const s = await api.startSession({
        taskId: null,
        categoryId: cat.id,
        kind: 'work',
        label: 'x',
        day: '2026-08-04',
      });
      expect(s.wasWork).toBe(true); // snapshot at write

      const noBackfill = await api.setCategoryWork(cat.id, false, false);
      expect(noBackfill.category.isWork).toBe(false);
      expect(noBackfill.backfilled).toBe(0);

      const withBackfill = await api.setCategoryWork(cat.id, false, true);
      expect(withBackfill.backfilled).toBe(1);
      expect((await api.listRunningSessions()).find((x) => x.id === s.id)?.wasWork).toBe(false);

      const target = await api.upsertCategory({ label: 'Other', isWork: true });
      const task = await api.createTask({ title: 't', categoryId: cat.id });
      await expect(api.deleteCategory(cat.id, null)).rejects.toThrow(); // referenced → needs a target
      await api.deleteCategory(cat.id, target.id);
      expect((await api.getTask(task.id))?.categoryId).toBe(target.id);
    });

    it('settings: sensible defaults, and patches persist', async () => {
      const s = await api.getSettings();
      expect(s.dayStartHour).toBe(4);
      expect(s.pomodoroWorkMin).toBe(25);
      const updated = await api.updateSettings({ dayStartHour: 5, pomodoroWorkMin: 50 });
      expect(updated.dayStartHour).toBe(5);
      expect(updated.pomodoroWorkMin).toBe(50);
    });

    it('export: includes created entities', async () => {
      const t = await api.createTask({ title: 'exportable' });
      const data = (await api.exportData()) as { tasks: { id: string }[] };
      expect(data.tasks.map((x) => x.id)).toContain(t.id);
    });
  });
}
