// Seed dataset for the stub — a few backdated weeks so the calibration and night-review surfaces
// have something honest to render. Without this, page-first validation would judge every data view
// against an empty store. Values are index-derived (not random) so the seed is reproducible.

import { dayKey } from '@aperture/shared';
import type { BaseEntity, Category, Habit, PomodoroSession, Task } from '@aperture/shared';
import type { Store } from './stubClient';

const USER_ID = 'local';
const DAY = 86_400_000;
const HOUR = 3_600_000;
const START_HOUR = 4;

export function seedStore(store: Store, nowMs: number, ulid: () => string): void {
  const mk = (createdAt: number): BaseEntity => ({
    id: ulid(),
    userId: USER_ID,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
  });

  // Categories — the starting set (deep work · admin · learning · health · people).
  const catDefs = [
    { label: 'Deep Work', isWork: true },
    { label: 'Admin', isWork: true },
    { label: 'Learning', isWork: true },
    { label: 'Health', isWork: false },
    { label: 'People', isWork: false },
  ];
  const cats: Category[] = catDefs.map((c, i) => ({
    ...mk(nowMs - 30 * DAY),
    label: c.label,
    isWork: c.isWork,
    order: i,
    active: true,
  }));
  store.categories.push(...cats);
  const byLabel = (l: string) => cats.find((c) => c.label === l)!;

  store.settings = {
    ...mk(nowMs - 30 * DAY),
    dayStartHour: START_HOUR,
    pomodoroWorkMin: 25,
    pomodoroBreakMin: 5,
    theme: 'auto',
  };

  const estimates = [30, 45, 60, 90];
  const factors = [0.8, 1.1, 1.3, 1.6]; // mostly > 1 → the honest "I underestimate" bias
  const workCats = ['Deep Work', 'Admin', 'Learning'];
  const snippets = [
    'Shipped the thing I was dreading. Easier than the dread.',
    'Long meeting; low focus after.',
    'Good gym session, cleared my head.',
    'Read a chapter before bed.',
    'Called home — overdue.',
    'Stuck on a bug for an hour, stepped away, fixed it in five.',
    'Planned tomorrow: fewer things, bigger things.',
  ];

  for (let d = 13; d >= 0; d--) {
    const t = nowMs - d * DAY - 3 * HOUR; // roughly the same time of day, d days ago
    const day = dayKey(t, START_HOUR);

    store.logEntries.push({ ...mk(t), day, text: snippets[d % snippets.length]! });
    if (d % 3 === 0) {
      store.logEntries.push({ ...mk(t - 4 * HOUR), day, text: snippets[(d + 2) % snippets.length]! });
    }

    if (d % 2 === 0) {
      const i = (d / 2) % estimates.length;
      const est = estimates[i]!;
      const actual = Math.round(est * factors[i]!);
      const cat = byLabel(workCats[(d / 2) % workCats.length]!);
      const completedAt = t;
      const startedAt = completedAt - actual * 60_000;
      const task: Task = {
        ...mk(startedAt),
        title: `Task from ${day}`,
        status: 'done',
        categoryId: cat.id,
        seriesId: null,
        estimateMin: est,
        bufferMin: Math.round(est * 0.25),
        estimateLockedMin: est,
        actualAccruedMin: actual,
        startedAt,
        completedAt,
        cancelledAt: null,
      };
      store.tasks.push(task);
      const session: PomodoroSession = {
        ...mk(startedAt),
        taskId: task.id,
        categoryId: cat.id,
        wasWork: cat.isWork,
        kind: 'work',
        startedAt,
        endedAt: completedAt,
        day,
        activeMinutes: actual,
        status: 'completed',
        lastHeartbeatAt: completedAt,
      };
      store.sessions.push(session);
    }
  }

  const read: Habit = {
    ...mk(nowMs - 20 * DAY),
    name: 'Read 20 min',
    categoryId: byLabel('Learning').id,
    cadencePerWeek: 5,
    active: true,
  };
  const workout: Habit = {
    ...mk(nowMs - 20 * DAY),
    name: 'Workout',
    categoryId: byLabel('Health').id,
    cadencePerWeek: 3,
    active: true,
  };
  const call: Habit = {
    ...mk(nowMs - 20 * DAY),
    name: 'Call family',
    categoryId: byLabel('People').id,
    cadencePerWeek: 1,
    active: true,
  };
  store.habits.push(read, workout, call);

  const check = (habit: Habit, d: number) => {
    const t = nowMs - d * DAY - 3 * HOUR;
    store.habitChecks.push({ ...mk(t), habitId: habit.id, date: dayKey(t, START_HOUR) });
  };
  [1, 3, 5, 8, 10, 12].forEach((d) => check(read, d));
  [2, 5, 9, 12].forEach((d) => check(workout, d));
  check(call, 6);
}
