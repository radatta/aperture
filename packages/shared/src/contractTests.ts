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

    it('leetcode: record normalizes verdict, buckets by client tz, and is idempotent on submission id', async () => {
      const base = {
        problemSlug: 'two-sum',
        problemTitle: 'Two Sum',
        submittedAt: 1_700_000_000_000, // 2023-11-14T22:13:20Z
        tzOffsetMinutes: 300, // UTC-5
        lang: 'python3',
      };
      const wrong = await api.recordLeetcodeAttempt({
        ...base,
        leetcodeSubmissionId: 'sub-1',
        statusCode: 11,
        statusMsg: 'Wrong Answer',
        difficulty: 'Easy',
        topicTags: ['array', 'hash-table'],
      });
      expect(wrong.verdict).toBe('wrong_answer');
      expect(wrong.difficulty).toBe('Easy');
      expect(wrong.topicTags).toEqual(['array', 'hash-table']);
      // day = submittedAt shifted by tz offset + dayStartHour(4), via UTC getters → runner-TZ-independent
      expect(wrong.day).toBe('2023-11-14');

      // Same submission id re-fires → same row, original verdict preserved (no overwrite).
      const dup = await api.recordLeetcodeAttempt({
        ...base,
        leetcodeSubmissionId: 'sub-1',
        statusCode: 10,
        statusMsg: 'Accepted',
      });
      expect(dup.id).toBe(wrong.id);
      expect(dup.verdict).toBe('wrong_answer');

      const ac = await api.recordLeetcodeAttempt({
        ...base,
        leetcodeSubmissionId: 'sub-2',
        statusCode: 10,
        statusMsg: 'Accepted',
        submittedAt: base.submittedAt + 60_000,
      });
      const list = await api.listLeetcodeAttempts();
      expect(list).toHaveLength(2); // dup didn't add a row
      expect(list[0]!.id).toBe(ac.id); // reverse-chron: newer first
      expect(list[0]!.difficulty).toBeNull(); // unset → null, not undefined
      expect(list[0]!.verdict).toBe('accepted');
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

    // The export is the "you own your data" snapshot, so EVERY collection belongs in it. The two impls
    // build it differently: the stub spreads its whole store (new entities included for free), the
    // backend enumerates repo reads by hand (new entities silently missing) — which is exactly how
    // leetcodeAttempts went absent from the real export while the stub looked fine.
    //
    // So assert the key set EXACTLY, not just the entities this test happens to create. Adding a
    // collection then fails here until it's listed below AND added to the backend's enumeration, which
    // is the only step that was skippable before.
    it('export: exposes exactly the known collections, with created entities in them', async () => {
      const t = await api.createTask({ title: 'exportable' });
      const lc = await api.recordLeetcodeAttempt({
        leetcodeSubmissionId: 'sub-export',
        problemSlug: 'two-sum',
        problemTitle: 'Two Sum',
        statusCode: 10,
        submittedAt: 1_700_000_000_000,
        tzOffsetMinutes: 300,
        lang: 'python3',
      });
      const data = (await api.exportData()) as Record<string, unknown> & {
        tasks: { id: string }[];
        leetcodeAttempts: { id: string }[];
      };
      expect(Object.keys(data).sort()).toEqual(
        [
          'categories',
          'days',
          'exportedAt',
          'habitChecks',
          'habits',
          'ideas',
          'leetcodeAttempts',
          'logEntries',
          'plans',
          'series',
          'sessions',
          'settings',
          'tasks',
          'userId',
        ].sort(),
      );
      expect(data.tasks.map((x) => x.id)).toContain(t.id);
      expect(data.leetcodeAttempts.map((x) => x.id)).toContain(lc.id);
    });
  });
}
