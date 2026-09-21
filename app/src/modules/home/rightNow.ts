import type { Task, TaskPlan, UpsertPlanInput } from '@aperture/shared';
import type { RunningTimer } from '../pomodoro/pomodoro-context';

// The Big 3 = the first three of today's plan, in the order you pulled them in (taskPlans.order).
// No new field: "focus" is plan position, and the act of choosing is the plan pass (+ "Make it a
// focus", `promote` below).
export const FOCUS_CAP = 3;

export interface RightNowRow {
  plan: TaskPlan | null; // null = an in-progress task that isn't on today's plan
  task: Task;
  unplanned?: boolean;
}

export interface RightNow {
  focus: RightNowRow[]; // ≤ FOCUS_CAP, in plan order
  alsoToday: RightNowRow[]; // the rest of today's plan + any in-progress task not planned today
  hero: Task | null; // what's actually happening now — the in-progress task, focus-preferred
  focusDoneCount: number;
  // The "what's next?" prompt shown only when nothing is in progress. Derived, never stored — this
  // is "return to what's next" WITHOUT auto-advancing to the next task.
  nextPrompt: 'pick' | 'next' | 'all-done' | null;
}

type PlanRow = { plan: TaskPlan; task: Task };

export function rightNow(planRows: PlanRow[], allTasks: Task[]): RightNow {
  // Cancelled drops out of the plane entirely; done STAYS in place (no promotion of #4 into a freed
  // slot — that would be the auto-advance the design forbids, and it keeps "Big 3 done" a real win).
  const live = planRows.filter((r) => r.task.status !== 'cancelled');
  const focus: RightNowRow[] = live.slice(0, FOCUS_CAP).map((r) => ({ plan: r.plan, task: r.task }));
  const alsoPlanned: RightNowRow[] = live.slice(FOCUS_CAP).map((r) => ({ plan: r.plan, task: r.task }));

  // The epic's original trigger: a started task not on today's plan must not be buried. Surface it
  // in Also-today (never a stolen Big-3 slot), tagged so it reads as off-plan.
  const plannedIds = new Set(planRows.map((r) => r.task.id));
  const unplanned: RightNowRow[] = allTasks
    .filter((t) => t.status === 'in_progress' && !plannedIds.has(t.id))
    .map((t) => ({ plan: null, task: t, unplanned: true }));
  const alsoToday = [...alsoPlanned, ...unplanned];

  // Hero = what you're actually working on. Prefer an in-progress Big-3 task; otherwise the first
  // in-progress anywhere, so "Right now" never says "pick one" while a task is genuinely running.
  const hero =
    focus.find((r) => r.task.status === 'in_progress')?.task ??
    alsoToday.find((r) => r.task.status === 'in_progress')?.task ??
    null;

  const focusDoneCount = focus.filter((r) => r.task.status === 'done').length;
  const nextPrompt: RightNow['nextPrompt'] = hero
    ? null
    : focus.length === 0
      ? null // nothing planned → the card's empty state speaks, not a prompt
      : focusDoneCount >= focus.length
        ? 'all-done'
        : focusDoneCount > 0
          ? 'next'
          : 'pick';

  return { focus, alsoToday, hero, focusDoneCount, nextPrompt };
}

// Live elapsed = what's persisted on the task (closed sessions) + the running work timer's active
// seconds, which aren't on the task yet. A count-UP toward the estimate — never a countdown, and the
// caller renders it flat (no bar, no colour flip) so it never becomes a live over-run nudge.
export function liveElapsedMin(task: Task, timers: RunningTimer[]): number {
  const liveSec = timers
    .filter((t) => t.session.kind === 'work' && t.session.taskId === task.id)
    .reduce((s, t) => s + t.activeSec, 0);
  return task.actualAccruedMin + liveSec / 60;
}

// "Make it a focus" — the only way to actually CHOOSE the Big 3, since there is no reorder UI: renumber
// the day so an Also-today row lands in the last focus slot. Pure; returns the plan upserts whose order
// changed (empty when the task is missing or already in focus).
export function promote(planRows: PlanRow[], taskId: string): UpsertPlanInput[] {
  const idx = planRows.findIndex((r) => r.task.id === taskId);
  if (idx < 0 || idx < FOCUS_CAP) return [];
  const reordered = [...planRows];
  const [moved] = reordered.splice(idx, 1);
  reordered.splice(FOCUS_CAP - 1, 0, moved!);
  const out: UpsertPlanInput[] = [];
  reordered.forEach((r, i) => {
    if (r.plan.order !== i)
      out.push({
        id: r.plan.id,
        taskId: r.plan.taskId,
        day: r.plan.day,
        plannedMinutes: r.plan.plannedMinutes,
        order: i,
      });
  });
  return out;
}
