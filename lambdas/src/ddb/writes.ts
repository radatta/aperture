import type { DocClient, Item } from './DocClient';

// Every mutation funnels through here — the single audit point (INFRA §A.9), and the switch that makes
// smoke tests provably write-free: a live request gets `liveWrites` (hits the table); a testMode/smoke
// request gets `noopWrites` (reads + logic run, nothing persists). Route handlers NEVER call
// doc.put/delete directly — they only touch `writes`, so there is exactly one place side effects happen.
export interface Writes {
  put(item: Item): Promise<void>;
  delete(pk: string, sk: string): Promise<void>;
  batchPut(items: Item[]): Promise<void>;
}

export function liveWrites(doc: DocClient): Writes {
  return {
    put: (item) => doc.put(item),
    delete: (pk, sk) => doc.delete(pk, sk),
    batchPut: (items) => doc.batchPut(items),
  };
}

export function noopWrites(): Writes {
  return {
    put: async () => {},
    delete: async () => {},
    batchPut: async () => {},
  };
}
