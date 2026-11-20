import { beforeEach, describe, expect, it } from 'vitest';
import type { FinanceTransaction } from '@aperture/shared';
import { InMemoryDoc } from './DocClient';
import { gsi1, pk, sk } from './keys';
import { financeTxnItem } from './mapping';
import { CAS_ATTEMPTS, ConflictError, Repo } from './repo';
import { liveWrites } from './writes';

const U = 'u1';

function txn(id: string, date: string, over: Partial<FinanceTransaction> = {}): FinanceTransaction {
  return {
    id,
    userId: U,
    createdAt: 1,
    updatedAt: 10,
    deletedAt: null,
    itemId: 'item',
    accountId: 'card',
    date,
    authorizedDate: null,
    name: id,
    merchantName: null,
    rawAmountCents: 100,
    isoCurrency: 'USD',
    pending: false,
    pendingTransactionId: null,
    pfcPrimary: null,
    pfcDetailed: null,
    paymentChannel: null,
    source: 'plaid',
    bucket: null,
    bucketSetBy: null,
    periodOverride: null,
    note: null,
    refundOfId: null,
    startsPeriod: false,
    splits: null,
    refundParts: null,
    ...over,
  };
}

describe('finance keys', () => {
  it('date sort keys are UTC midnight, parsed from the string', () => {
    expect(gsi1.finTxnSk('2026-01-05')).toBe(Date.UTC(2026, 0, 5));
    expect(gsi1.finTxnSk('2026-12-31')).toBeLessThan(gsi1.finTxnSk('2027-01-01'));
    expect(sk.finTxn('abc')).toBe('fin#txn#abc');
    expect(sk.finTxn('abc').startsWith(sk.finTxnPrefix())).toBe(true);
    expect(sk.finItem('x').startsWith(sk.finTxnPrefix())).toBe(false);
  });
});

describe('Repo finances', () => {
  let doc: InMemoryDoc;
  let repo: Repo;
  beforeEach(() => {
    doc = new InMemoryDoc();
    repo = new Repo(doc, liveWrites(doc), U);
  });
  const seed = (t: FinanceTransaction) => doc.put(financeTxnItem(U, t));

  it('reads a date range inclusive on both ends, alive only, and coalesces old rows', async () => {
    await seed(txn('a', '2026-09-01'));
    await seed(txn('b', '2026-09-10'));
    await seed(txn('c', '2026-09-11'));
    await seed(txn('gone', '2026-09-05', { deletedAt: 5 }));
    const legacy = financeTxnItem(U, txn('old', '2026-09-02'));
    delete legacy.startsPeriod;
    delete legacy.refundOfId;
    delete legacy.splits;
    delete legacy.refundParts;
    await doc.put(legacy);
    const got = await repo.listFinanceTxnsInRange('2026-09-01', '2026-09-10');
    expect(got.map((t) => t.id).sort()).toEqual(['a', 'b', 'old']);
    const old = got.find((t) => t.id === 'old')!;
    expect([old.startsPeriod, old.refundOfId, old.splits, old.refundParts]).toEqual([
      false,
      null,
      null,
      null,
    ]);
    expect((await repo.listFinanceTxnsInRange('2026-09-10')).map((t) => t.id).sort()).toEqual([
      'b',
      'c',
    ]);
  });

  it('getFinanceTxns returns tombstones too', async () => {
    await seed(txn('gone', '2026-09-05', { deletedAt: 5 }));
    expect((await repo.getFinanceTxns(['gone', 'missing'])).get('gone')?.deletedAt).toBe(5);
  });

  describe('casUpdate', () => {
    const shape = () => repo.finTxnShape('a');

    it('writes the change and bumps updatedAt strictly past the read, even with a frozen clock', async () => {
      await seed(txn('a', '2026-09-01', { updatedAt: 10 }));
      const one = await repo.casUpdate(shape(), 'a', (t) => ({ ...t, note: 'x' }), 5);
      expect([one.note, one.updatedAt]).toEqual(['x', 11]);
      const two = await repo.casUpdate(shape(), 'a', (t) => ({ ...t, note: 'y' }), 5);
      expect(two.updatedAt).toBe(12);
      const three = await repo.casUpdate(shape(), 'a', (t) => ({ ...t, note: 'z' }), 99);
      expect(three.updatedAt).toBe(99);
    });

    it('retries on a lost race, re-running fn against the fresh row', async () => {
      await seed(txn('a', '2026-09-01', { updatedAt: 10 }));
      doc.interceptNextPutIf(pk(U), sk.finTxn('a'), () =>
        doc.putNow(financeTxnItem(U, txn('a', '2026-09-01', { updatedAt: 11, bucket: 'budget' }))),
      );
      const seen: (string | null)[] = [];
      const out = await repo.casUpdate(
        shape(),
        'a',
        (t) => {
          seen.push(t.bucket);
          return { ...t, note: 'mine' };
        },
        5,
      );
      expect(seen).toEqual([null, 'budget']);
      expect([out.bucket, out.note]).toEqual(['budget', 'mine']); // their bucket survived
    });

    it('gives up with ConflictError after the attempt cap', async () => {
      await seed(txn('a', '2026-09-01', { updatedAt: 10 }));
      let n = 10;
      const clash = () => {
        doc.putNow(financeTxnItem(U, txn('a', '2026-09-01', { updatedAt: ++n })));
        if (n < 10 + CAS_ATTEMPTS) doc.interceptNextPutIf(pk(U), sk.finTxn('a'), clash);
      };
      doc.interceptNextPutIf(pk(U), sk.finTxn('a'), clash);
      await expect(repo.casUpdate(shape(), 'a', (t) => ({ ...t }), 5)).rejects.toThrow(
        ConflictError,
      );
    });

    it('fn → null writes nothing; missing throws; a tombstone throws unless allowDeleted', async () => {
      await seed(txn('a', '2026-09-01', { updatedAt: 10, deletedAt: 3 }));
      await expect(repo.casUpdate(shape(), 'a', (t) => t, 5)).rejects.toThrow('Not found: a');
      const kept = await repo.casUpdate(shape(), 'a', () => null, 5, { allowDeleted: true });
      expect(kept.updatedAt).toBe(10);
      await expect(repo.casUpdate(repo.finTxnShape('nope'), 'nope', (t) => t, 5)).rejects.toThrow(
        'Not found: nope',
      );
    });

    it('creates a missing row with create(), conditionally', async () => {
      const made = await repo.casUpdate(repo.finTxnShape('new'), 'new', (t) => t, 5, {
        create: () => txn('new', '2026-09-03', { updatedAt: 5 }),
      });
      expect(made.id).toBe('new');
      expect((await repo.getFinanceTxn('new'))?.date).toBe('2026-09-03');
      expect(await repo.listFinanceTxnsInRange('2026-09-03', '2026-09-03')).toHaveLength(1);
    });
  });

  it('casUpdate {consistent} decides on the real row even when a stale read would say otherwise', async () => {
    await seed(txn('a', '2026-09-01', { updatedAt: 10, note: 'real' }));
    doc.staleNextGets(
      pk(U),
      sk.finTxn('a'),
      financeTxnItem(U, txn('a', '2026-09-01', { note: 'stale' })),
    );
    let seen: string | null = null;
    await repo.casUpdate(repo.finTxnShape('a'), 'a', (t) => ((seen = t.note), null), 5, {
      consistent: true,
    });
    expect(seen).toBe('real');
  });

  it('insertFinanceTxn writes a new row, and merges into one that already exists', async () => {
    const made = await repo.insertFinanceTxn(txn('n', '2026-09-02', { updatedAt: 5 }), (f) => f);
    expect(made.id).toBe('n');
    await seed(txn('e', '2026-09-02', { updatedAt: 10, bucket: 'budget', rawAmountCents: 1 }));
    const merged = await repo.insertFinanceTxn(
      txn('e', '2026-09-02', { updatedAt: 5, rawAmountCents: 999 }),
      (fresh) => ({ ...txn('e', '2026-09-02', { rawAmountCents: 999 }), bucket: fresh.bucket }),
    );
    expect([merged.bucket, merged.rawAmountCents]).toEqual(['budget', 999]);
    expect((await repo.getFinanceTxn('e'))!.bucket).toBe('budget');
  });
});

describe('Repo finance rules', () => {
  it('a rule stored before split rules reads as a one-bucket rule', async () => {
    const doc = new InMemoryDoc();
    const repo = new Repo(doc, liveWrites(doc), U);
    const base = { id: 'r1', userId: U, createdAt: 1, updatedAt: 1, deletedAt: null };
    await doc.put({
      PK: pk(U),
      SK: sk.finRule('r1'),
      ...base,
      pattern: 'store a',
      bucket: 'budget',
      active: true,
    });
    expect((await repo.listFinanceRules())[0]!.split).toBeNull();
    expect((await repo.getFinanceRule('r1'))!.split).toBeNull();
  });
});
