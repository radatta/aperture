import type { FinanceSyncState, FinanceTransaction, Task } from '@aperture/shared';
import type { Item } from './DocClient';
import { gsi1, pk, sk } from './keys';

// DDB item ↔ domain entity. Items carry the key attributes (PK/SK, and GSI1 for done tasks); the
// domain entities never see them. `toEntity` is the read side; the `*Item` builders are the write side.

const KEY_ATTRS = ['PK', 'SK', 'GSI1PK', 'GSI1SK'];

export function toEntity<T>(item: Item): T {
  const rest: Record<string, unknown> = { ...item };
  for (const k of KEY_ATTRS) delete rest[k];
  return rest as T;
}

// A generic entity stored at a known SK, no secondary index.
export function entityItem<T extends object>(userId: string, skStr: string, entity: T): Item {
  return { PK: pk(userId), SK: skStr, ...entity };
}

// Tasks are the one entity on GSI1: a done task with a completion time is projected into the
// calibration index; anything else carries no GSI keys, so it never shows up in the window read.
export function taskItem(userId: string, task: Task): Item {
  const item: Item = { PK: pk(userId), SK: sk.task(task.id), ...task };
  if (task.status === 'done' && task.completedAt != null) {
    item.GSI1PK = gsi1.donePk(userId);
    item.GSI1SK = gsi1.doneSk(task.completedAt);
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
  return { ...s, lastSyncErrorAt: s.lastSyncErrorAt ?? null };
}
