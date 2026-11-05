import { planFireAt, taskFireAt, userDueEpoch } from '@aperture/shared';
import type { FinanceSyncState, FinanceTransaction, Task, TaskPlan } from '@aperture/shared';
import type { Item } from './DocClient';
import { gsi1, pk, sk } from './keys';

// DDB item ↔ domain entity. Items carry the key attributes (PK/SK, and GSI1 for done tasks, reminders and
// finance transactions) and, on dev, a tombstone's `expiresAt` (writes.ts); the domain entities never see
// them. `toEntity` is the read side; the `*Item` builders are the write side.

// When a task's or plan's current fire time was set (reminders.md → §3, armed before it fires): a table-only
// attribute beside the keys, so no entity, API answer or export ever carries it.
export const REMIND_ARMED_AT = 'remindArmedAt';
const ITEM_ATTRS = ['PK', 'SK', 'GSI1PK', 'GSI1SK', 'expiresAt', REMIND_ARMED_AT];

export function toEntity<T>(item: Item): T {
  const rest: Record<string, unknown> = { ...item };
  for (const k of ITEM_ATTRS) delete rest[k];
  return rest as T;
}

// A generic entity stored at a known SK, no secondary index.
export function entityItem<T extends object>(userId: string, skStr: string, entity: T): Item {
  return { PK: pk(userId), SK: skStr, ...entity };
}

// A fire time the Lambda can't compute (a malformed legacy deadline makes the zone math throw) is no
// reminder, never a failed write.
function fireAt(at: () => number | null): number | null {
  try {
    const ms = at();
    return ms !== null && Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}
export const taskRemindAt = (t: Task): number | null => fireAt(() => taskFireAt(t, userDueEpoch));
export const planRemindAt = (p: TaskPlan): number | null =>
  fireAt(() => planFireAt(p, userDueEpoch));

// The arm time a write keeps: the stored row's, while it was already on the remind index at this same fire
// time (an edit that doesn't move the reminder), else `fallback` — the write's own time: created, re-dated,
// reopened or re-planned now.
export function remindArm(
  prev: Item | null,
  userId: string,
  fire: number,
  fallback: number,
): number {
  const kept = prev?.[REMIND_ARMED_AT];
  return prev?.GSI1PK === gsi1.remindPk(userId) && prev.GSI1SK === fire && typeof kept === 'number'
    ? kept
    : fallback;
}

// A task is on GSI1 in one of two key spaces, written atomically with the task so neither can drift: a
// done task with a completion time in the calibration index; an open one with a deadline in the remind
// index at its fire time (reminders.ts taskFireAt — the user's zone, not the Lambda's UTC). Anything else
// carries no GSI keys, so it shows up in neither window read. `armedAt` (remindArm) defaults to the task's
// updatedAt.
export function taskItem(userId: string, task: Task, armedAt?: number): Item {
  const item: Item = { PK: pk(userId), SK: sk.task(task.id), ...task };
  if (task.status === 'done' && task.completedAt != null) {
    item.GSI1PK = gsi1.donePk(userId);
    item.GSI1SK = gsi1.doneSk(task.completedAt);
    return item;
  }
  const at = taskRemindAt(task);
  if (at !== null) {
    item.GSI1PK = gsi1.remindPk(userId);
    item.GSI1SK = gsi1.remindSk(at);
    item[REMIND_ARMED_AT] = armedAt ?? task.updatedAt;
  }
  return item;
}

// A plan is on the remind index at DAY_REMINDER_TIME on its day; a tombstone drops out. Whether its task
// is still open and untimed is the poller's check at fire time.
export function planItem(userId: string, plan: TaskPlan, armedAt?: number): Item {
  const item: Item = { PK: pk(userId), SK: sk.plan(plan.day, plan.order, plan.id), ...plan };
  const at = planRemindAt(plan);
  if (at !== null) {
    item.GSI1PK = gsi1.remindPk(userId);
    item.GSI1SK = gsi1.remindSk(at);
    item[REMIND_ARMED_AT] = armedAt ?? plan.updatedAt;
  }
  return item;
}

// Finance transactions are on GSI1 by date — tombstones included, so a row never drops out of the index
// mid-life; reads filter them. Coalescing on read is defensive: rows written before a field existed.
export function financeTxnItem(userId: string, t: FinanceTransaction): Item {
  return {
    PK: pk(userId),
    SK: sk.finTxn(t.id),
    GSI1PK: gsi1.finTxnPk(userId),
    GSI1SK: gsi1.finTxnSk(t.date),
    ...t,
  };
}
export function toFinanceTxn(item: Item): FinanceTransaction {
  const t = toEntity<FinanceTransaction>(item);
  return { ...t, refundOfId: t.refundOfId ?? null, startsPeriod: t.startsPeriod ?? false };
}
export function toFinanceSyncState(item: Item): FinanceSyncState {
  const s = toEntity<FinanceSyncState>(item);
  return {
    ...s,
    lastSyncErrorAt: s.lastSyncErrorAt ?? null,
    lastRefreshedAt: s.lastRefreshedAt ?? null,
  };
}
