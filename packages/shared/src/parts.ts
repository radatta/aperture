// Parent + parts (docs/areas/tasks/parts.md). The ONE place the rules live, so the stub, the Lambda and MCP
// can't drift. A parent is the deliverable — it holds the deadline, category and notes; its parts hold the
// work (plans, sessions, estimates, actuals). One level only. Parenthood is derived: a task is a parent
// while some alive task's parentId points at it — nothing stored can disagree with the parts themselves.
//
// The parent's numbers: estimateMin/bufferMin stay null (shown as Σ parts, live); estimateLockedMin is
// frozen once, when the first part leaves planning (freezeParentLock); actualAccruedMin is stamped with
// Σ done parts when it's marked done (completeParent). So a done parent is an ordinary calibration row.

import { contributesCalibration, taskTransition } from './machines';
import type { Task } from './types';

export const PARENT_NO_PLAN_ERROR = 'A task with parts isn’t planned itself — plan its parts.';
export const PARENT_NO_START_ERROR = 'A task with parts isn’t started itself — start a part.';
export const PARENT_NO_ESTIMATE_ERROR =
  'A task with parts has no estimate of its own — it’s the sum of its parts.';
export const PARENT_NO_ACTUAL_ERROR =
  'A task with parts has no actual of its own — it’s the sum of its parts.';
export const PARENT_NO_SPLIT_ERROR = 'A task with parts isn’t split — add a part instead.';
export const PARENT_NO_EVENT_ERROR =
  'A task with parts has no calendar block of its own — its parts do. Add the event to a part instead.';

const finished = (t: Pick<Task, 'status'>) => t.status === 'done' || t.status === 'cancelled';

export const isPart = (t: Pick<Task, 'parentId'>): boolean => !!t.parentId;

// One rep of a repeating thing (a roll pick or a series occurrence): it takes no parts and isn't split.
export const isRep = (t: Pick<Task, 'rollId' | 'seriesId'>): boolean => !!t.rollId || !!t.seriesId;

// A parent's parts, oldest first (the order "Part 2 of 3" counts in). Pass alive tasks.
export function partsOf(tasks: Task[], parentId: string): Task[] {
  return tasks
    .filter((t) => t.parentId === parentId)
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export const hasParts = (tasks: Task[], id: string): boolean =>
  tasks.some((t) => t.parentId === id);

export function parentOf(tasks: Task[], task: Task): Task | undefined {
  return task.parentId ? tasks.find((t) => t.id === task.parentId) : undefined;
}

export interface PartsSummary {
  parts: Task[];
  total: number; // not counting dropped parts — "1/2" after one of three is dropped
  done: number;
  open: Task[]; // not done or dropped
  estimateMin: number | null; // Σ estimates of the non-dropped parts; null when none is scoped
  unscoped: number; // open parts with no estimate — a done one's can't be set any more, so it isn't a nag
  actualMin: number; // Σ logged time of the non-dropped parts
  allDone: boolean; // something to submit and nothing open — the "mark it submitted?" nudge
}

export function partsSummary(parts: Task[]): PartsSummary {
  const kept = parts.filter((p) => p.status !== 'cancelled');
  const scoped = kept.filter((p) => p.estimateMin !== null);
  const open = kept.filter((p) => p.status !== 'done');
  return {
    parts,
    total: kept.length,
    done: kept.length - open.length,
    open,
    estimateMin: scoped.length ? scoped.reduce((s, p) => s + (p.estimateMin ?? 0), 0) : null,
    unscoped: open.filter((p) => p.estimateMin === null).length,
    actualMin: kept.reduce((s, p) => s + p.actualAccruedMin, 0),
    allDone: kept.length > 0 && open.length === 0,
  };
}

// A done parent's rollup covers this many parts — the ones not dropped, as the card's "2/2" counts.
export const rollupParts = (tasks: Task[], parentId: string): number =>
  partsSummary(partsOf(tasks, parentId)).total;

// The hard block on marking a parent done, naming what's still open.
export function partOpenError(open: Pick<Task, 'title'>[]): string {
  const names = open.map((p) => p.title);
  if (names.length === 1) return `${names[0]} isn’t finished — complete, drop or delete it first`;
  const list = `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${list} aren’t finished — complete, drop or delete them first`;
}

export const PARENT_ALL_DROPPED_ERROR =
  'Every part was dropped — there’s nothing to submit, so drop it instead.';

// Something to submit and nothing open. With every part dropped there's no work behind it: marking it done
// would stamp a 0 actual against its lock (a bogus calibration point), so it's dropped instead.
export function assertParentCompletable(parent: Task, parts: Task[]): void {
  if (finished(parent)) throw new Error(`It’s already ${parent.status}`);
  const { open, total } = partsSummary(parts);
  if (open.length) throw new Error(partOpenError(open));
  if (total === 0) throw new Error(PARENT_ALL_DROPPED_ERROR);
}

// backlog → done without passing through in_progress (a parent is never worked on itself). Its actual is
// what its parts took; its lock is whatever freezeParentLock froze.
export function completeParent(parent: Task, parts: Task[], now: number): Task {
  assertParentCompletable(parent, parts);
  const actual = parts
    .filter((p) => p.status === 'done')
    .reduce((s, p) => s + p.actualAccruedMin, 0);
  return { ...parent, status: 'done', completedAt: now, actualAccruedMin: actual, updatedAt: now };
}

// Dropping the deliverable drops its open parts; done parts stay as the history they are. The caller
// removes the dropped parts' calendar events (delete-on-cancel) and writes parts before the parent.
export function cancelParent(
  parent: Task,
  parts: Task[],
  now: number,
): { parent: Task; parts: Task[] } {
  if (finished(parent)) throw new Error(`It’s already ${parent.status}`);
  return {
    parent: { ...parent, status: 'cancelled', cancelledAt: now, updatedAt: now },
    parts: parts.filter((p) => !finished(p)).map((p) => taskTransition(p, 'cancelled', now)),
  };
}

// The rollup's baseline, frozen at ONE moment: when the first part leaves planning (`starting` — just
// started, or a started task just attached). It's the whole job's estimate then — each part's own lock,
// else its working estimate — over the parts not dropped. If that moment already passed (another part
// had started) with no baseline — a started, unscoped task split, say — it stays unset: one written later
// would be hindsight. Null = nothing to write.
export function freezeParentLock(
  parent: Task,
  parts: Task[],
  starting: string,
  now: number,
): Task | null {
  if (parent.estimateLockedMin !== null || finished(parent)) return null;
  const started = parts.filter((p) => p.startedAt !== null || p.estimateLockedMin !== null);
  if (started.length !== 1 || started[0]!.id !== starting) return null;
  const sizes = parts
    .filter((p) => p.status !== 'cancelled')
    .map((p) => p.estimateLockedMin ?? p.estimateMin)
    .filter((m): m is number => m !== null);
  if (!sizes.length) return null;
  return { ...parent, estimateLockedMin: sizes.reduce((s, m) => s + m, 0), updatedAt: now };
}

// A task taking its first part: its own estimate goes (it's the sum now) and it leaves any plan — a parent
// isn't put on a day, its parts are. The caller tombstones its plan rows and syncs its calendar (delete).
export function becomeParent(task: Task, now: number): Task {
  return {
    ...task,
    status: task.status === 'planned' ? 'backlog' : task.status,
    estimateMin: null,
    bufferMin: null,
    updatedAt: now,
  };
}

// Can `parent` take a part? One level; not finished; not a roll rep or a recurring occurrence (each is one
// rep of a repeating thing — the roll would re-plan the parent, the series respawn it); and a task already
// worked on can't turn into a container (its logged time has nowhere to go) — split it instead, which
// keeps that work as Part 1.
export function assertParentEligible(parent: Task, tasks: Task[]): void {
  if (parent.parentId) throw new Error('A part can’t have parts of its own — one level only');
  if (finished(parent)) throw new Error(`Can’t add a part to a ${parent.status} task`);
  if (hasParts(tasks, parent.id) || canBecomeParent(parent)) return;
  throw new Error(
    isRep(parent)
      ? 'A roll rep or a recurring task can’t take parts — it’s one rep of a repeating thing'
      : 'It’s already been worked on — split it instead, which keeps that work as Part 1',
  );
}

// A task without parts that could take its first (the editor's "Break down…" gate) — the same rule.
export function canBecomeParent(task: Task): boolean {
  return (
    !task.parentId &&
    !finished(task) &&
    !isRep(task) &&
    task.status !== 'in_progress' &&
    task.startedAt === null &&
    task.actualAccruedMin === 0
  );
}

// A task whose last part went (detached, moved, deleted) is plain again. Its lock was frozen for its
// parts' work — it never had any of its own (assertParentEligible) — so it goes too, and re-freezes when
// the task is started. Null = nothing to write (still has parts, finished, or no lock).
export function releaseParent(parent: Task, tasks: Task[], now: number): Task | null {
  if (finished(parent) || hasParts(tasks, parent.id) || parent.estimateLockedMin === null)
    return null;
  return { ...parent, estimateLockedMin: null, updatedAt: now };
}

// Can `task` (null = a new one) become a part of `parent`?
export function assertCanBePart(task: Task | null, parent: Task, tasks: Task[]): void {
  if (task?.id === parent.id) throw new Error('A task can’t be a part of itself');
  if (task && hasParts(tasks, task.id))
    throw new Error('A task with parts can’t be a part — one level only');
  assertParentEligible(parent, tasks);
}

// The deadline a task answers to: a part's is its parent's (its own time is when its block ends).
export function deadlineOf(task: Task, tasks: Task[]): Pick<Task, 'dueDay' | 'dueTime' | 'status'> {
  const parent = parentOf(tasks, task);
  return parent
    ? { dueDay: parent.dueDay, dueTime: parent.dueTime ?? null, status: task.status }
    : { dueDay: task.dueDay, dueTime: task.dueTime ?? null, status: task.status };
}

// 1-based position among its parent's parts ("Part 2 of 3"); 0 when it isn't one of them.
export function partIndex(part: Task, parts: Task[]): number {
  return parts.findIndex((p) => p.id === part.id) + 1;
}

// Every calibration point: a done, locked task. Parts are points of their own; a done parent is one too,
// its frozen lock against what its parts took (completeParent stamps it).
export function calibrationTasks(tasks: Task[]): Task[] {
  return tasks.filter(contributesCalibration);
}
