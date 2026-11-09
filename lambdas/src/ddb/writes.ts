import type { DocClient, Item } from './DocClient';
import { isDevSlot } from '@aperture/shared';

// Every mutation funnels through here — the single audit point (INFRA §A.9), and the switch that makes
// smoke tests provably write-free: a live request gets `liveWrites` (hits the table); a testMode/smoke
// request gets `noopWrites` (reads + logic run, nothing persists). Route handlers NEVER call
// doc.put/delete directly — they only touch `writes`, so there is exactly one place side effects happen.
export interface Writes {
  put(item: Item): Promise<void>;
  putIf(item: Item, expectedUpdatedAt: number | null): Promise<void>; // see DocClient.putIf
  delete(pk: string, sk: string): Promise<void>;
  deleteIf(pk: string, sk: string, expectedUpdatedAt: number): Promise<void>; // see DocClient.deleteIf
  batchPut(items: Item[]): Promise<void>;
}

// Dev's table expires tombstones (TECH §2.3): dev checks leave dead rows, and
// reads that list them run dev into its read cap (CI-BOT.md → Compute). Epoch seconds, as DynamoDB TTL wants: due at
// deletion, and AWS deletes some time after. A flux tombstone is due a week on, because an outbox retry of a deleted
// set must still find it. Finance tombstones are never due: a returning account revives from its row, and a posted
// row inherits from a removed pending one. Nor is a removed push device's: its tombstone is what keeps it removed
// (reminders.md §4), and a launch would re-subscribe the device once it expired.
// Prod's table has TTL too, but this stamping is dev-only: on prod the one row kind that carries expiresAt is a
// LeetCode sitting's raw bulk, stamped by the repo itself at write (putSittingEventIfAbsent), and kept here as is.
const FLUX_KEEP_S = 7 * 24 * 3600;
export function expiresAtOf(item: Item): number | null {
  const { deletedAt, SK } = item;
  if (typeof deletedAt !== 'number' || SK.startsWith('fin#') || SK.startsWith('pushsub#'))
    return null;
  return Math.floor(deletedAt / 1000) + (SK.startsWith('flux#') ? FLUX_KEEP_S : 0);
}
const stamped = (item: Item): Item => {
  const expiresAt = expiresAtOf(item);
  return expiresAt === null ? item : { ...item, expiresAt };
};

export function liveWrites(doc: DocClient, stage = process.env.STAGE): Writes {
  const out = isDevSlot(stage) ? stamped : (item: Item) => item;
  return {
    put: (item) => doc.put(out(item)),
    putIf: (item, expected) => doc.putIf(out(item), expected),
    delete: (pk, sk) => doc.delete(pk, sk),
    deleteIf: (pk, sk, expected) => doc.deleteIf(pk, sk, expected),
    batchPut: (items) => doc.batchPut(items.map(out)),
  };
}

export function noopWrites(): Writes {
  return {
    put: async () => {},
    putIf: async () => {},
    delete: async () => {},
    deleteIf: async () => {},
    batchPut: async () => {},
  };
}
