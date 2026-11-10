// The narrow DynamoDB surface the BFF actually uses. Two implementations satisfy it: an in-memory
// table (below — the stateful test substrate, dep-free) and, later, a real @aws-sdk/lib-dynamodb
// wrapper for deploy. Keeping it this small means the routes never see the SDK, and the whole backend
// runs create→read behavior under test without AWS.

export interface Item {
  PK: string;
  SK: string;
  GSI1PK?: string;
  GSI1SK?: number;
  [attr: string]: unknown;
}

export interface IndexRange {
  from?: number; // inclusive lower bound on GSI1SK
  to?: number; // inclusive upper bound on GSI1SK
}

// A conditional put lost the race: the row changed (or appeared) since it was read.
export class ConditionFailedError extends Error {
  constructor() {
    super('Condition failed');
    this.name = 'ConditionFailedError';
  }
}

export interface DocClient {
  // `consistent`: a strongly consistent read — a conflict retry must see the write that beat it.
  get(pk: string, sk: string, opts?: { consistent?: boolean }): Promise<Item | null>;
  put(item: Item): Promise<void>;
  // Optimistic concurrency: write only if the stored row's `updatedAt` still equals
  // `expectedUpdatedAt`, or — with null — only if no row exists (a tombstone counts as a row).
  // Throws ConditionFailedError otherwise.
  putIf(item: Item, expectedUpdatedAt: number | null): Promise<void>;
  // begins_with(SK, prefix) within a partition, ascending by SK. `consistent`: strongly consistent — a
  // decision taken on the list straight after a write must see that write. `from`/`to` bound the sort
  // key inside the prefix (inclusive; `to` defaults to the end of the prefix) — one range read instead
  // of a whole-history scan, for prefixes that grow forever (plan rows, habit checks).
  query(pk: string, skPrefix: string, opts?: QueryOpts): Promise<Item[]>;
  // GSI1 range read, ascending by GSI1SK (done-task calibration window).
  queryIndex(gsi1pk: string, range?: IndexRange): Promise<Item[]>;
  delete(pk: string, sk: string): Promise<void>;
  // Delete only while the stored row's `updatedAt` still equals `expectedUpdatedAt` — a write since (a
  // tombstone, a revive) wins. Throws ConditionFailedError otherwise, a missing row included.
  deleteIf(pk: string, sk: string, expectedUpdatedAt: number): Promise<void>;
  batchPut(items: Item[]): Promise<void>;
  // Atomically adds `by` to the number `field` (absent → 0) and returns the new value. `init` is written only
  // where absent, so the row a first add creates is a whole one; `set` is written on every add (updatedAt). No
  // condition and no read: concurrent adds all count — a counter beside a row that is rewritten whole (a
  // sitting's head) can't live on that row.
  add(
    pk: string,
    sk: string,
    field: string,
    by: number,
    init: Record<string, unknown>,
    set: Record<string, unknown>,
  ): Promise<number>;
}

export interface QueryOpts {
  consistent?: boolean;
  from?: string;
  to?: string;
}
// Sorts after every key under a prefix (U+FFFF: the last code point, above all ASCII in UTF-8 byte
// order — DynamoDB compares strings as UTF-8 bytes; our keys are ASCII).
export const SK_END = '\uffff';
export const rangeOf = (skPrefix: string, opts?: QueryOpts): { from: string; to: string } => ({
  from: opts?.from ?? skPrefix,
  to: opts?.to ?? skPrefix + SK_END,
});

const keyOf = (pk: string, sk: string) => `${pk}\u0000${sk}`;
const clone = <T>(v: T): T => structuredClone(v);

// Stateful in-memory single table. Models exactly the operations above with real begins_with + GSI
// semantics, so the same contract suite that runs against the stub runs against the Lambda over this.
// What the real marshaller refuses — non-finite and unsafe numbers — refused here too, so a test can't pass on an item DynamoDB would reject
// (a NaN `updatedAt` once broke every sitting delete on dev while every in-memory test passed).
function assertMarshallable(v: unknown, path = 'item'): void {
  if (typeof v === 'number' && !Number.isFinite(v))
    throw new Error(`Special numeric value ${v} is not allowed (${path})`);
  if (typeof v === 'number' && Math.abs(v) > Number.MAX_SAFE_INTEGER)
    throw new Error(`Number ${v} is greater than Number.MAX_SAFE_INTEGER (${path})`);
  if (Array.isArray(v)) v.forEach((x, i) => assertMarshallable(x, `${path}[${i}]`));
  else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v as Record<string, unknown>))
      assertMarshallable(x, `${path}.${k}`);
}

export class InMemoryDoc implements DocClient {
  private items = new Map<string, Item>();
  private intercepts = new Map<string, { fn: () => void; when?: (item: Item) => boolean }>();
  private deleteIntercepts = new Map<string, () => void>();
  private stale = new Map<string, { snapshot: Item | null; left: number }>();
  private staleQueries = new Map<string, { snapshot: Item | null; left: number }>();
  // Test-only: every get, and whether it asked for a strongly consistent read.
  readonly gets: { key: string; consistent: boolean }[] = [];
  // Test-only: every query — its prefix, the bounds it carried (if any) and the read mode.
  readonly queries: { prefix: string; from?: string; to?: string; consistent: boolean }[] = [];

  async get(pk: string, sk: string, opts?: { consistent?: boolean }): Promise<Item | null> {
    const key = keyOf(pk, sk);
    const consistent = opts?.consistent === true;
    this.gets.push({ key: `${pk} ${sk}`, consistent });
    const lag = this.stale.get(key);
    if (lag && !consistent) {
      if (--lag.left <= 0) this.stale.delete(key);
      return lag.snapshot ? clone(lag.snapshot) : null;
    }
    const found = this.items.get(key);
    return found ? clone(found) : null;
  }

  // Test-only: model eventual consistency — the next `n` NON-consistent gets of this key return
  // `snapshot` (an older version, or null for "not visible yet"); consistent gets see the truth.
  staleNextGets(pk: string, sk: string, snapshot: Item | null, n = 1): void {
    this.stale.set(keyOf(pk, sk), { snapshot: snapshot ? clone(snapshot) : null, left: n });
  }

  async put(item: Item): Promise<void> {
    assertMarshallable(item);
    this.items.set(keyOf(item.PK, item.SK), clone(item));
  }

  async putIf(item: Item, expectedUpdatedAt: number | null): Promise<void> {
    assertMarshallable(item);
    const key = keyOf(item.PK, item.SK);
    const hook = this.intercepts.get(key);
    if (hook && (!hook.when || hook.when(item))) {
      this.intercepts.delete(key);
      hook.fn(); // a "concurrent" write lands between this caller's read and its write
    }
    const stored = this.items.get(key);
    const ok = expectedUpdatedAt === null ? !stored : stored?.updatedAt === expectedUpdatedAt;
    if (!ok) throw new ConditionFailedError();
    this.items.set(key, clone(item));
  }

  // Test-only: run `fn` once, just before the next putIf on this key (that `when` accepts, if given)
  // checks its condition.
  interceptNextPutIf(pk: string, sk: string, fn: () => void, when?: (item: Item) => boolean): void {
    this.intercepts.set(keyOf(pk, sk), { fn, when });
  }
  // Test-only: a synchronous write, for use inside an intercept.
  putNow(item: Item): void {
    this.items.set(keyOf(item.PK, item.SK), clone(item));
  }

  async query(pk: string, skPrefix: string, opts?: QueryOpts): Promise<Item[]> {
    this.queries.push({
      prefix: skPrefix,
      from: opts?.from,
      to: opts?.to,
      consistent: opts?.consistent === true,
    });
    const { from, to } = rangeOf(skPrefix, opts);
    const rows: Item[] = [];
    for (const [key, it] of this.items) {
      if (it.PK !== pk || !it.SK.startsWith(skPrefix)) continue;
      if (it.SK < from || it.SK > to) continue;
      const lag = opts?.consistent === true ? undefined : this.staleQueries.get(key);
      if (!lag) rows.push(it);
      else {
        if (--lag.left <= 0) this.staleQueries.delete(key);
        if (lag.snapshot) rows.push(lag.snapshot);
      }
    }
    return rows.sort((a, b) => (a.SK < b.SK ? -1 : a.SK > b.SK ? 1 : 0)).map(clone);
  }

  // Test-only: the next `n` NON-consistent queries that cover this key return `snapshot` for it (an
  // older version, or null for "not visible yet"); consistent queries see the truth.
  staleNextQueries(pk: string, sk: string, snapshot: Item | null, n = 1): void {
    this.staleQueries.set(keyOf(pk, sk), { snapshot: snapshot ? clone(snapshot) : null, left: n });
  }

  async queryIndex(gsi1pk: string, range?: IndexRange): Promise<Item[]> {
    return [...this.items.values()]
      .filter((it) => it.GSI1PK === gsi1pk && typeof it.GSI1SK === 'number')
      .filter((it) => range?.from === undefined || (it.GSI1SK as number) >= range.from)
      .filter((it) => range?.to === undefined || (it.GSI1SK as number) <= range.to)
      .sort((a, b) => (a.GSI1SK as number) - (b.GSI1SK as number))
      .map(clone);
  }

  async delete(pk: string, sk: string): Promise<void> {
    this.items.delete(keyOf(pk, sk));
  }

  async deleteIf(pk: string, sk: string, expectedUpdatedAt: number): Promise<void> {
    // Like LiveDoc: an unknown version can't be matched.
    if (typeof expectedUpdatedAt !== 'number') throw new ConditionFailedError();
    const key = keyOf(pk, sk);
    const hook = this.deleteIntercepts.get(key);
    if (hook) {
      this.deleteIntercepts.delete(key);
      hook(); // a "concurrent" write lands between this caller's read and its delete
    }
    if (this.items.get(key)?.updatedAt !== expectedUpdatedAt) throw new ConditionFailedError();
    this.items.delete(key);
  }
  // Test-only: run `fn` once, just before the next deleteIf on this key checks its condition.
  interceptNextDeleteIf(pk: string, sk: string, fn: () => void): void {
    this.deleteIntercepts.set(keyOf(pk, sk), fn);
  }

  async batchPut(items: Item[]): Promise<void> {
    for (const it of items) await this.put(it);
  }

  async add(
    pk: string,
    sk: string,
    field: string,
    by: number,
    init: Record<string, unknown>,
    set: Record<string, unknown>,
  ): Promise<number> {
    const key = keyOf(pk, sk);
    const cur: Item = this.items.get(key) ?? { PK: pk, SK: sk };
    const was = typeof cur[field] === 'number' ? (cur[field] as number) : 0;
    const next: Item = { ...init, ...cur, ...set, PK: pk, SK: sk, [field]: was + by };
    assertMarshallable(next);
    this.items.set(key, clone(next));
    return was + by;
  }

  // Test-only escape hatch: total row count (asserting no orphan writes, etc.).
  get size(): number {
    return this.items.size;
  }

  // Test-only: every row, in key order — compare two snapshots to prove nothing was written.
  snapshot(): Item[] {
    return [...this.items.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, it]) => clone(it));
  }
}
