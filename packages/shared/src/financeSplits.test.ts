import { describe, expect, it } from 'vitest';
import {
  allocateProportional,
  allocationSumError,
  bucketsOf,
  capRefunds,
  computeFinancePeriod,
  countedParts,
  deriveFinanceView,
  filterCents,
  financeRuleSplitError,
  financeSplitError,
  isUnsorted,
  matchesFinanceFilter,
  needsSorting,
  periodOfPart,
  reconcileSyncPage,
  refundPartsError,
  refundPartsFrom,
  liveRefundParts,
  normalizeFinanceRule,
  normalizeFinanceTxn,
  resolveRefundClaims,
  resolveRefundLinks,
  resolveRefundPartIds,
  ruleSplitBucket,
  ruleSplitOf,
  splitBroken,
  splitOf,
  suggestRefundSets,
  summarizePeriod,
} from './finance';
import type {
  FinanceAccount,
  FinanceOverview,
  FinanceRule,
  FinanceSplitPart,
  FinanceTransaction,
} from './finance';
import type { PlaidTransaction } from './plaidTypes';

// Synthetic rows only ("Store A", round amounts) — never real data (docs/ops/PUBLIC-CONTENT.md).
const base = { userId: 'u', createdAt: 0, updatedAt: 0, deletedAt: null };

function acct(id: string, type: string, over: Partial<FinanceAccount> = {}): FinanceAccount {
  return {
    ...base,
    id,
    itemId: 'item',
    name: id,
    officialName: null,
    mask: id.slice(-4),
    type,
    subtype: null,
    isoCurrency: 'USD',
    currentCents: null,
    availableCents: null,
    balanceAt: null,
    signOverride: 'auto',
    hidden: false,
    ...over,
  };
}

function tx(
  id: string,
  accountId: string,
  date: string,
  cents: number,
  over: Partial<FinanceTransaction> = {},
): FinanceTransaction {
  return {
    ...base,
    id,
    itemId: 'item',
    accountId,
    date,
    authorizedDate: null,
    name: id.toUpperCase(),
    merchantName: null,
    rawAmountCents: cents,
    isoCurrency: 'USD',
    pending: false,
    pendingTransactionId: null,
    pfcPrimary: null,
    pfcDetailed: null,
    paymentChannel: null,
    source: 'plaid',
    bucket: null,
    bucketSetBy: over.splits ? 'user' : null, // as every newer split write sets it (liveSplits)
    periodOverride: null,
    note: null,
    refundOfId: null,
    startsPeriod: false,
    splits: null,
    refundParts: null,
    ...over,
  };
}

const part = (
  bucket: FinanceSplitPart['bucket'],
  cents: number,
  period: FinanceSplitPart['period'] = null,
): FinanceSplitPart => ({ bucket, cents, period });

const chk = acct('chk', 'depository');
const card = acct('card', 'credit');
const accounts = [chk, card];
const PAY = { pfcPrimary: 'LOAN_PAYMENTS' };
const MARK = { startsPeriod: true };
// Current window 2026-09-18 → 09-26; previous 2026-08-19 → 09-17.
const payments = [
  tx('o1', 'chk', '2026-08-18', 5000, PAY),
  tx('i1', 'card', '2026-08-18', -5000, MARK),
  tx('o2', 'chk', '2026-09-17', 7000, PAY),
  tx('i2', 'card', '2026-09-17', -7000, MARK),
];
const period = computeFinancePeriod({
  today: '2026-09-26',
  accounts,
  txns: payments,
  paymentDay: 20,
});
const sum = (txns: FinanceTransaction[]) =>
  summarizePeriod({ period, txns: [...payments, ...txns], accounts, budgetCents: 60000 });
const identity = (t: FinanceTransaction) => t.rawAmountCents;

describe('allocateProportional', () => {
  it('sums exactly, floors, and gives leftover cents to the largest remainders, ties to the earlier part', () => {
    expect(allocateProportional(4001, [1, 1])).toEqual([2001, 2000]);
    expect(allocateProportional(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocateProportional(1000, [70, 30])).toEqual([700, 300]);
    expect(allocateProportional(1, [50, 50])).toEqual([1, 0]);
    expect(allocateProportional(999, [999])).toEqual([999]);
    expect(allocateProportional(0, [3, 4])).toEqual([0, 0]);
    expect(allocateProportional(5, [0, 0])).toEqual([0, 0]);
  });
  it('never gives a share above its weight while the total is at most the weights’ sum', () => {
    for (const total of [1, 7, 333, 1000, 1499, 1500]) {
      const weights = [700, 501, 299];
      const shares = allocateProportional(total, weights);
      expect(shares.reduce((n, c) => n + c, 0)).toBe(total);
      shares.forEach((s, i) => expect(s).toBeLessThanOrEqual(weights[i]!));
    }
  });
});

describe('allocationSumError', () => {
  it('names how far a split is short or over, and a refund allocation only when over', () => {
    expect(allocationSumError([2000, 2000], 4000, { exact: true })).toBeNull();
    expect(allocationSumError([2000, 1500], 4000, { exact: true })).toBe(
      '$5.00 is left to assign — the parts must add up to $40.00',
    );
    expect(allocationSumError([2000, 2500], 4000, { exact: true })).toBe(
      'The parts add up to $45.00, $5.00 more than the $40.00 charge',
    );
    expect(allocationSumError([1000], 4000, { exact: false })).toBeNull();
    expect(allocationSumError([3000, 2000], 4000, { exact: false })).toBe(
      'The charges take $50.00, $10.00 more than the $40.00 refund',
    );
    expect(allocationSumError([0, 4000], 4000, { exact: true })).toMatch(/above \$0.00/);
    expect(allocationSumError([10.5, 3989.5], 4000, { exact: true })).toMatch(/above \$0.00/);
  });
});

describe('splitOf', () => {
  const split = [part('budget', 2000), part('parents_pay', 2000)];
  it('counts while the parts add up to the amount; a new amount breaks it', () => {
    const t = tx('c', 'card', '2026-09-20', 4000, { splits: split });
    expect(splitOf(t, 4000)).toEqual(split);
    expect(splitOf(t, 4200)).toBeNull();
    expect(splitBroken(t, 4200)).toBe(true);
    expect(splitOf(t, -4000)).toBeNull(); // a flipped account
    expect(splitOf(tx('u', 'card', '2026-09-20', 4000), 4000)).toBeNull();
    expect(splitBroken(tx('u', 'card', '2026-09-20', 4000), 4000)).toBe(false);
  });
  it('a rule-made split recomputes from its percents at any amount', () => {
    const t = tx('c', 'card', '2026-09-20', 4000, {
      splits: [
        { bucket: 'budget', cents: 2000, period: null, percent: 50 },
        { bucket: 'i_pay', cents: 2000, period: null, percent: 50 },
      ],
    });
    expect(splitOf(t, 4201)!.map((p) => p.cents)).toEqual([2101, 2100]);
    expect(splitBroken(t, 4201)).toBe(false);
  });
});

describe('financeSplitError', () => {
  const charge = tx('c', 'card', '2026-09-20', 4000);
  const ok = [part('budget', 2000), part('parents_pay', 2000)];
  const err = (parts: FinanceSplitPart[], t = charge, a: FinanceAccount | undefined = card) =>
    financeSplitError({ txn: t, account: a, moves: new Map(), parts });
  it('accepts parts that add up, with a bucket used twice in different periods', () => {
    expect(err(ok)).toBeNull();
    expect(err([part('budget', 2000), part('budget', 2000, 'next')])).toBeNull();
  });
  it('refuses with a named reason', () => {
    expect(err([part('budget', 4000)])).toBe('A split needs at least two parts');
    expect(err(Array.from({ length: 9 }, () => part('budget', 1)))).toMatch(/at most 8/);
    expect(err([part('budget', 2000), part('budget', 2000)])).toMatch(/Two parts go to Budget/);
    expect(err([part('budget', 2000), part('nope' as never, 2000)])).toMatch(/nope/);
    expect(
      err([part('budget', 2000), { ...part('i_pay', 2000), period: 'later' as never }]),
    ).toMatch(/Unknown period/);
    expect(err([part('budget', 2000), part('i_pay', 1000)])).toMatch(/\$10.00 is left to assign/);
    expect(err(ok, tx('r', 'card', '2026-09-20', -4000))).toMatch(/Only a charge/);
    expect(err(ok, tx('m', 'card', '2026-09-20', 4000, MARK))).toMatch(/Only a charge/);
    expect(err(ok, tx('p', 'chk', '2026-09-20', 4000, PAY), chk)).toMatch(/Only a charge/);
    expect(err(ok, charge, acct('card', 'credit', { hidden: true }))).toMatch(/shown/);
    expect(err(ok, { ...charge, deletedAt: 1 })).toBe('That transaction is gone');
  });
});

describe('periodOfPart', () => {
  const now = tx('c', 'card', '2026-09-20', 4000);
  const last = tx('l', 'card', '2026-09-01', 4000);
  it('a pin wins; null follows the row, override and all', () => {
    expect(periodOfPart(now, { period: null }, period)).toBe('current');
    expect(periodOfPart(now, { period: 'previous' }, period)).toBe('previous');
    expect(periodOfPart(last, { period: 'current' }, period)).toBe('current');
    expect(periodOfPart({ ...now, periodOverride: 'previous' }, { period: null }, period)).toBe(
      'previous',
    );
  });
  it('next waits while the charge’s own period is current, and has landed once it is the previous one', () => {
    expect(periodOfPart(now, { period: 'next' }, period)).toBe('upcoming');
    expect(periodOfPart(last, { period: 'next' }, period)).toBe('current');
    // relative to the charge's own date, not its row override
    expect(periodOfPart({ ...now, periodOverride: 'previous' }, { period: 'next' }, period)).toBe(
      'upcoming',
    );
  });
  it('a charge outside both windows counts nowhere, pin or not', () => {
    const old = tx('o', 'card', '2026-07-01', 4000);
    for (const p of [null, 'current', 'previous', 'next'] as const)
      expect(periodOfPart(old, { period: p }, period)).toBeNull();
  });
});

describe('summarizePeriod with splits', () => {
  it('each part counts in its own bucket; the charge counts once per bucket; it is sorted', () => {
    const s = sum([
      tx('c', 'card', '2026-09-20', 4000, {
        splits: [part('budget', 2500), part('parents_pay', 1500)],
        bucketSetBy: 'user',
      }),
    ]);
    expect(s.buckets.budget).toEqual({ totalCents: 2500, count: 1 });
    expect(s.buckets.parents_pay).toEqual({ totalCents: 1500, count: 1 });
    expect(s.spentCents).toBe(2500);
    expect(s.unsortedCount).toBe(0);
    expect(s.upcoming).toEqual({ totalCents: 0, count: 0 });
  });

  it('an unsplit row reads exactly as before', () => {
    const rows = [
      tx('b', 'card', '2026-09-20', 4000, { bucket: 'budget' }),
      tx('u', 'card', '2026-09-21', 700),
    ];
    const s = sum(rows);
    expect(s.buckets.budget).toEqual({ totalCents: 4000, count: 1 });
    expect([s.unsortedCount, s.unsortedCents]).toEqual([1, 700]);
  });

  it('a Not-spending part is in no total; a pinned-previous part is out of the current one', () => {
    const s = sum([
      tx('c', 'card', '2026-09-20', 4000, {
        splits: [part('budget', 1000), part('not_spending', 2000), part('i_pay', 1000, 'previous')],
      }),
    ]);
    expect(s.buckets.budget.totalCents).toBe(1000);
    expect(s.buckets.i_pay.totalCents).toBe(0);
    expect(s.unsortedCount).toBe(0);
  });

  it('a next-period part waits in upcoming, then lands when a new payment is marked', () => {
    const split = tx('c', 'card', '2026-09-20', 4000, {
      splits: [part('budget', 1000), part('budget', 3000, 'next')],
    });
    const s = sum([split]);
    expect(s.buckets.budget.totalCents).toBe(1000);
    expect(s.upcoming).toEqual({ totalCents: 3000, count: 1 });
    // Mark a payment after the charge: the next period starts; the waiting part lands in it.
    const marked = [
      ...payments,
      tx('o3', 'chk', '2026-09-25', 9000, PAY),
      tx('i3', 'card', '2026-09-25', -9000, MARK),
    ];
    const later = computeFinancePeriod({
      today: '2026-09-27',
      accounts,
      txns: marked,
      paymentDay: 20,
    });
    const s2 = summarizePeriod({
      period: later,
      txns: [...marked, split],
      accounts,
      budgetCents: 60000,
    });
    expect(s2.buckets.budget.totalCents).toBe(3000);
    expect(s2.upcoming).toEqual({ totalCents: 0, count: 0 });
  });

  it('a broken split asks again, at its new amount', () => {
    const s = sum([
      tx('c', 'card', '2026-09-20', 4200, {
        splits: [part('budget', 2000), part('parents_pay', 2000)],
      }),
    ]);
    expect([s.unsortedCount, s.unsortedCents]).toEqual([1, 4200]);
    expect(s.buckets.budget.totalCents).toBe(0);
  });

  it('a refund on a split charge comes off its parts in proportion, never below $0', () => {
    const charge = tx('c', 'card', '2026-09-20', 4000, {
      splits: [part('budget', 3000), part('parents_pay', 1000)],
    });
    const s = sum([charge, tx('r', 'card', '2026-09-22', -1000, { refundOfId: 'c' })]);
    expect(s.buckets.budget.totalCents).toBe(2250);
    expect(s.buckets.parents_pay.totalCents).toBe(750);
    const over = sum([charge, tx('r', 'card', '2026-09-22', -9000, { refundOfId: 'c' })]);
    expect([over.buckets.budget.totalCents, over.buckets.parents_pay.totalCents]).toEqual([0, 0]);
  });
});

describe('refunds across charges', () => {
  const a = tx('a', 'card', '2026-09-19', 3000, { bucket: 'budget', merchantName: 'Store A' });
  const b = tx('b', 'card', '2026-09-20', 2000, { bucket: 'i_pay', merchantName: 'Store B' });
  const dep = (parts: { chargeId: string; cents: number }[], cents = -5000) =>
    tx('d', 'chk', '2026-09-24', cents, { refundParts: parts, pfcPrimary: 'TRANSFER_IN' });

  it('one deposit nets two charges in their own buckets', () => {
    const s = sum([
      a,
      b,
      dep([
        { chargeId: 'a', cents: 3000 },
        { chargeId: 'b', cents: 2000 },
      ]),
    ]);
    expect(s.buckets.budget.totalCents).toBe(0);
    expect(s.buckets.i_pay.totalCents).toBe(0);
    expect(s.buckets.budget.count).toBe(1);
  });

  it('the leftover beyond the allocations stays income outside every total', () => {
    const s = sum([a, b, dep([{ chargeId: 'a', cents: 1000 }], -5000)]);
    expect(s.buckets.budget.totalCents).toBe(2000);
    expect(s.buckets.i_pay.totalCents).toBe(2000);
  });

  it('claims resolve per part; the primary link is the first; a single link reads as before', () => {
    const multi = dep([
      { chargeId: 'a', cents: 3000 },
      { chargeId: 'gone', cents: 1000 },
    ]);
    const claims = resolveRefundClaims([a, b, multi]);
    expect(claims.get('d')!.map((c) => [c.charge.id, c.cents])).toEqual([['a', 3000]]);
    expect(resolveRefundLinks([a, b, multi]).get('d')!.id).toBe('a');
    const single = tx('s', 'card', '2026-09-22', -500, { refundOfId: 'b' });
    expect(resolveRefundClaims([b, single]).get('s')).toEqual([{ charge: b, cents: null }]);
  });

  it('the cap sums every allocation from every refund, so a charge nets to exactly $0', () => {
    const first = tx('r1', 'card', '2026-09-21', -2000, { refundOfId: 'a' });
    const d = dep([
      { chargeId: 'a', cents: 3000 },
      { chargeId: 'b', cents: 2000 },
    ]);
    const rows = [a, b, first, d];
    const got = capRefunds(
      resolveRefundClaims(rows),
      new Map(rows.map((t) => [t.id, t])),
      identity,
    );
    expect(got.byCharge.get('a')).toBe(3000);
    expect(got.byClaim.get('d')!.get('a')).toBe(1000); // only what r1 left
    expect(got.byClaim.get('d')!.get('b')).toBe(2000);
    expect(got.byRefund.get('d')).toBe(3000);
    const s = sum(rows);
    expect(s.buckets.budget.totalCents).toBe(0);
  });

  it('a stale allocation never counts more than the refund itself', () => {
    const d = dep(
      [
        { chargeId: 'a', cents: 3000 },
        { chargeId: 'b', cents: 2000 },
      ],
      -4000,
    );
    const rows = [a, b, d];
    const got = capRefunds(
      resolveRefundClaims(rows),
      new Map(rows.map((t) => [t.id, t])),
      identity,
    );
    expect(got.byRefund.get('d')).toBe(4000);
    expect(got.byClaim.get('d')!.get('b')).toBe(1000);
  });

  it('refundPartsError: each part a valid link with room, the sum within the refund', () => {
    const d = dep([]);
    const err = (parts: { chargeId: string; cents: number }[], extra: FinanceTransaction[] = []) =>
      refundPartsError({ refund: d, parts, txns: [a, b, d, ...extra], accounts, moves: new Map() });
    expect(
      err([
        { chargeId: 'a', cents: 3000 },
        { chargeId: 'b', cents: 2000 },
      ]),
    ).toBeNull();
    expect(err([{ chargeId: 'a', cents: 1000 }])).toBeNull(); // a partial link
    expect(err([])).toBe('Pick at least one charge');
    expect(
      err([
        { chargeId: 'a', cents: 100 },
        { chargeId: 'a', cents: 100 },
      ]),
    ).toBe('That charge is already in the list');
    expect(err([{ chargeId: 'zz', cents: 100 }])).toBe('That charge is gone');
    expect(err([{ chargeId: 'a', cents: 3500 }])).toBe('Only $30.00 is left to refund on Store A');
    // another refund already took part of A
    expect(
      err(
        [{ chargeId: 'a', cents: 3000 }],
        [tx('r1', 'card', '2026-09-21', -2000, { refundOfId: 'a' })],
      ),
    ).toBe('Only $10.00 is left to refund on Store A');
    expect(
      err(
        [
          { chargeId: 'a', cents: 3000 },
          { chargeId: 'b', cents: 2000 },
          { chargeId: 'c', cents: 1000 },
        ],
        [tx('c', 'card', '2026-09-20', 1000)],
      ),
    ).toBe('The charges take $60.00, $10.00 more than the $50.00 refund');
    expect(err([{ chargeId: 'a', cents: 0 }])).toMatch(/above \$0.00/);
    expect(
      err([{ chargeId: 'pay', cents: 100 }], [tx('pay', 'chk', '2026-09-20', 100, PAY)]),
    ).toMatch(/only reverse a charge/);
    // Re-saving its own allocation is fine: its own claims don't eat the room.
    const saved = { ...d, refundParts: [{ chargeId: 'a', cents: 3000 }] };
    expect(
      refundPartsError({
        refund: saved,
        parts: [{ chargeId: 'a', cents: 3000 }],
        txns: [a, b, saved],
        accounts,
        moves: new Map(),
      }),
    ).toBeNull();
  });

  it('refundPartsFrom reaches back for an older charge', () => {
    expect(refundPartsFrom('2026-09-26', [a])).toBe('2026-05-29');
    expect(refundPartsFrom('2026-09-26', [tx('o', 'card', '2026-04-10', 100)])).toBe('2026-04-07');
  });

  it('suggestRefundSets: exact or within 10% over, same merchant first, bounded', () => {
    const d = dep([], -5000);
    const rows = [
      d,
      a,
      b,
      tx('c', 'card', '2026-09-21', 4600), // c + nothing fits; a + c is 7600 > refund
      tx('e', 'card', '2026-09-22', 1600),
      tx('f', 'card', '2026-09-22', 2900),
    ];
    const sets = suggestRefundSets({
      refund: d,
      txns: rows,
      accounts,
      moves: new Map(),
      claims: new Map(),
    });
    expect(sets[0]!.charges.map((c) => c.id).sort()).toEqual(['a', 'b']); // exact
    expect(sets.every((s) => s.cents.reduce((n, c) => n + c, 0) <= 5000)).toBe(true);
    expect(sets.length).toBeLessThanOrEqual(3);
    // nothing sums close: none
    expect(
      suggestRefundSets({
        refund: d,
        txns: [d, tx('x', 'card', '2026-09-20', 100), tx('y', 'card', '2026-09-20', 200)],
        accounts,
        moves: new Map(),
        claims: new Map(),
      }),
    ).toEqual([]);
    // a paycheck with many small charges stays bounded to the pool
    const many = Array.from({ length: 60 }, (_, i) => tx(`m${i}`, 'card', '2026-09-20', 1000 + i));
    const big = tx('pay', 'chk', '2026-09-24', -300000, { pfcPrimary: 'TRANSFER_IN' });
    expect(
      suggestRefundSets({
        refund: big,
        txns: [big, ...many],
        accounts,
        moves: new Map(),
        claims: new Map(),
      }),
    ).toEqual([]);
  });
});

describe('filters and sorting on split rows', () => {
  const overview = { period, accounts } as unknown as FinanceOverview;
  const split = tx('c', 'card', '2026-09-20', 4000, {
    splits: [part('budget', 2500), part('parents_pay', 1500)],
  });
  const broken = tx('k', 'card', '2026-09-21', 4100, {
    splits: [part('budget', 2000), part('i_pay', 2000)],
  });
  const refund = tx('r', 'card', '2026-09-22', -1000, { refundOfId: 'c' });
  const v = deriveFinanceView(overview, [split, broken, refund]);

  it('a bucket chip matches any part; under it the row counts only that bucket’s parts', () => {
    expect(matchesFinanceFilter(split, v, 'budget')).toBe(true);
    expect(matchesFinanceFilter(split, v, 'parents_pay')).toBe(true);
    expect(matchesFinanceFilter(split, v, 'i_pay')).toBe(false);
    expect(matchesFinanceFilter(split, v, 'unsorted')).toBe(false);
    expect(matchesFinanceFilter(refund, v, 'budget')).toBe(true); // rides on the split charge
    expect(bucketsOf(refund, v)).toEqual(['budget', 'parents_pay']);
    expect(filterCents(split, v, 'budget')).toBe(2500);
    expect(filterCents(split, v, 'all')).toBe(4000);
  });

  it('under a bucket chip a linked refund counts only its share in that bucket', () => {
    // $10.00 off a 2500/1500 split: 625 to Budget, 375 to Covered.
    expect(filterCents(refund, v, 'budget')).toBe(-625);
    expect(filterCents(refund, v, 'parents_pay')).toBe(-375);
    expect(filterCents(refund, v, 'all')).toBe(-1000);
    // A deposit across a Budget charge and an I-pay charge: each chip counts its own part only.
    const a = tx('a', 'card', '2026-09-20', 3000, { bucket: 'budget' });
    const b = tx('b', 'card', '2026-09-21', 2000, { bucket: 'i_pay' });
    const dep = tx('d', 'chk', '2026-09-23', -4000, {
      refundParts: [
        { chargeId: 'a', cents: 2500 },
        { chargeId: 'b', cents: 1500 },
      ],
    });
    const w = deriveFinanceView(overview, [a, b, dep]);
    expect(filterCents(dep, w, 'budget')).toBe(-2500);
    expect(filterCents(dep, w, 'i_pay')).toBe(-1500);
    expect(filterCents(dep, w, 'parents_pay')).toBe(0);
  });

  it('a refund across charges is listed while any of its charges is in a window', () => {
    const old = tx('old', 'card', '2026-07-01', 5000, { bucket: 'budget' });
    const cur = tx('cur', 'card', '2026-09-20', 1000, { bucket: 'budget' });
    const dep = tx('d', 'chk', '2026-09-23', -6000, {
      refundParts: [
        { chargeId: 'old', cents: 5000 },
        { chargeId: 'cur', cents: 1000 },
      ],
    });
    const w = deriveFinanceView(overview, [old, cur, dep]);
    expect(w.links.get('d')?.id).toBe('old'); // the primary, outside both windows
    expect(w.txns.map((t) => t.id)).toContain('d');
  });

  it('a broken split is unsorted and in the sort queue', () => {
    expect(isUnsorted(broken, v.links, 4100)).toBe(true);
    expect(needsSorting(broken, v.links, v.refunded, 4100)).toBe(true);
    expect(matchesFinanceFilter(broken, v, 'unsorted')).toBe(true);
    expect(matchesFinanceFilter(broken, v, 'budget')).toBe(false);
    expect(needsSorting(split, v.links, v.refunded, 4000)).toBe(false);
  });

  it('countedParts: an unsplit row is one part; a split spreads its refund', () => {
    expect(countedParts(tx('u', 'card', '2026-09-20', 700), 700, 0, period)).toEqual([
      { bucket: null, cents: 700, refundedCents: 0, window: 'current', pin: null },
    ]);
    expect(countedParts(split, 4000, 1000, period).map((p) => p.refundedCents)).toEqual([625, 375]);
  });
});

describe('an older write wins over a stale stored field', () => {
  // Code from before splits (after a revert) keeps the new fields when it writes a row; on a re-deploy
  // the write it made must win.
  it('a split beside a bucket or a period mark is ignored', () => {
    const parts = [part('budget', 2000), part('i_pay', 2000)];
    expect(splitOf(tx('a', 'card', '2026-09-20', 4000, { splits: parts }), 4000)).toEqual(parts);
    const sorted = tx('a', 'card', '2026-09-20', 4000, { splits: parts, bucket: 'parents_pay' });
    expect(splitOf(sorted, 4000)).toBeNull();
    expect(splitBroken(sorted, 4000)).toBe(false);
    expect(sum([sorted]).buckets.parents_pay.totalCents).toBe(4000);
    expect(
      splitOf(tx('a', 'card', '2026-09-20', 4000, { splits: parts, ...MARK }), 4000),
    ).toBeNull();
  });

  it('an older undo (unsort, unmark, unlink — each nulls bucketSetBy) never brings a split back', () => {
    const parts = [part('budget', 2000), part('i_pay', 2000)];
    const undone = tx('a', 'card', '2026-09-20', 4000, { splits: parts, bucketSetBy: null });
    expect(splitOf(undone, 4000)).toBeNull();
    expect(splitBroken(undone, 4000)).toBe(false);
    for (const by of ['user', 'rule'] as const)
      expect(splitOf({ ...undone, bucketSetBy: by }, 4000)).toEqual(parts);
  });

  it('normalizeFinanceTxn / normalizeFinanceRule drop exactly the stale fields, and twice is once', () => {
    const parts = [part('budget', 2000), part('i_pay', 2000)];
    const stale = tx('a', 'card', '2026-09-20', 4000, { splits: parts, bucket: 'budget' });
    const once = normalizeFinanceTxn(stale);
    expect(once).toEqual({ ...stale, splits: null });
    expect(normalizeFinanceTxn(once)).toEqual(once);
    const live = tx('b', 'card', '2026-09-20', 4000, { splits: parts });
    expect(normalizeFinanceTxn(live)).toEqual(live);
    const rule: FinanceRule = {
      ...base,
      id: 'r',
      pattern: 'store a',
      bucket: 'parents_pay',
      active: true,
      split: [
        { bucket: 'budget', percent: 70 },
        { bucket: 'i_pay', percent: 30 },
      ],
    };
    expect(normalizeFinanceRule(rule).split).toBeNull();
    expect(normalizeFinanceRule({ ...rule, bucket: 'budget' }).split).toEqual(rule.split);
  });

  it('refund parts beside a single link, a bucket or a period pin are ignored', () => {
    const a = tx('a', 'card', '2026-09-20', 3000, { bucket: 'budget' });
    const b = tx('b', 'card', '2026-09-21', 2000, { bucket: 'i_pay' });
    const parts = [
      { chargeId: 'a', cents: 1500 },
      { chargeId: 'b', cents: 1500 },
    ];
    const claimsOf = (over: Partial<FinanceTransaction>) =>
      resolveRefundClaims([
        a,
        b,
        tx('d', 'chk', '2026-09-23', -3000, { refundParts: parts, ...over }),
      ])
        .get('d')
        ?.map((c) => c.charge.id);
    expect(claimsOf({})).toEqual(['a', 'b']);
    expect(claimsOf({ refundOfId: 'b' })).toEqual(['b']);
    expect(claimsOf({ bucket: 'budget' })).toBeUndefined();
    expect(claimsOf({ periodOverride: 'current' })).toBeUndefined();
  });

  it('a rule split whose bucket an older write retargeted is ignored', () => {
    const split = [
      { bucket: 'budget' as const, percent: 70 },
      { bucket: 'i_pay' as const, percent: 30 },
    ];
    const rule = (bucket: FinanceRule['bucket']): FinanceRule => ({
      ...base,
      id: 'rule',
      pattern: 'store a',
      bucket,
      active: true,
      split,
    });
    expect(ruleSplitOf(rule('budget'))).toEqual(split);
    expect(ruleSplitOf(rule('parents_pay'))).toBeNull();
  });

  it('a row from an older server, with no keys at all, reads unsplit and unlinked', () => {
    const bare = tx('a', 'card', '2026-09-20', 4000) as Partial<FinanceTransaction>;
    delete bare.splits;
    delete bare.refundParts;
    expect(splitBroken(bare as FinanceTransaction, 4000)).toBe(false);
    expect(liveRefundParts(bare as FinanceTransaction)).toBeNull();
  });
});

describe('a refund part on a pending charge, once it posts', () => {
  const pending = tx('p', 'card', '2026-09-20', 2000, { pending: true, deletedAt: 5 });
  const posted = tx('q', 'card', '2026-09-21', 2000, {
    pendingTransactionId: 'p',
    bucket: 'budget',
  });
  const other = tx('o', 'card', '2026-09-20', 1000, { bucket: 'budget' });
  const dep = tx('d', 'chk', '2026-09-23', -3000, {
    refundParts: [
      { chargeId: 'p', cents: 2000 },
      { chargeId: 'o', cents: 1000 },
    ],
  });
  const rows = [...payments, pending, posted, other, dep];

  it('names the posted row, so re-saving the allocation is still accepted', () => {
    expect(resolveRefundPartIds(dep.refundParts!, rows)).toEqual([
      { chargeId: 'q', cents: 2000 },
      { chargeId: 'o', cents: 1000 },
    ]);
    expect(
      refundPartsError({ refund: dep, parts: dep.refundParts!, txns: rows, accounts }),
    ).toBeNull();
    // Unlinking the other charge leaves the posted one, under either id.
    expect(
      refundPartsError({
        refund: dep,
        parts: [{ chargeId: 'q', cents: 2000 }],
        txns: rows,
        accounts,
      }),
    ).toBeNull();
    // The same charge twice, once by each id, is still one charge.
    expect(
      refundPartsError({
        refund: dep,
        parts: [
          { chargeId: 'p', cents: 1000 },
          { chargeId: 'q', cents: 1000 },
        ],
        txns: rows,
        accounts,
      }),
    ).toBe('That charge is already in the list');
  });
});

describe('split rules', () => {
  it('financeRuleSplitError: 2–4 distinct buckets, whole percents that sum to 100', () => {
    const ok = [
      { bucket: 'budget' as const, percent: 60 },
      { bucket: 'parents_pay' as const, percent: 40 },
    ];
    expect(financeRuleSplitError(ok)).toBeNull();
    expect(ruleSplitBucket(ok)).toBe('budget');
    expect(financeRuleSplitError([ok[0]!])).toMatch(/at least two/);
    expect(financeRuleSplitError([{ ...ok[0]!, percent: 50 }, ok[1]!])).toBe(
      'The parts add up to 90%, not 100%',
    );
    expect(financeRuleSplitError([ok[0]!, { ...ok[1]!, bucket: 'budget' }])).toMatch(/twice/);
    expect(
      financeRuleSplitError([
        { ...ok[0]!, percent: 60.5 },
        { ...ok[1]!, percent: 39.5 },
      ]),
    ).toMatch(/whole percent/);
  });

  const rule = (over: Partial<FinanceRule>): FinanceRule => ({
    ...base,
    id: 'rule',
    pattern: 'store a',
    bucket: 'budget',
    active: true,
    split: null,
    ...over,
  });
  const plaid = (
    id: string,
    amount: number,
    over: Partial<PlaidTransaction> = {},
  ): PlaidTransaction =>
    ({
      transaction_id: id,
      account_id: 'card',
      date: '2026-09-20',
      authorized_date: null,
      name: 'STORE A 0042',
      merchant_name: 'Store A',
      amount,
      iso_currency_code: 'USD',
      pending: false,
      pending_transaction_id: null,
      personal_finance_category: null,
      payment_channel: 'in store',
      ...over,
    }) as PlaidTransaction;
  const run = (
    existing: Map<string, FinanceTransaction>,
    p: PlaidTransaction,
    rules: FinanceRule[],
  ) =>
    reconcileSyncPage({
      existing,
      page: { added: [p], modified: [], removed: [] },
      rules,
      now: 1,
      itemId: 'item',
      userId: 'u',
    })[0]!;
  const half = rule({
    split: [
      { bucket: 'budget', percent: 50 },
      { bucket: 'parents_pay', percent: 50 },
    ],
  });

  it('a new matching charge arrives split by the rule’s percents; a card credit takes its bucket', () => {
    const row = run(new Map(), plaid('n', 40.01), [half]);
    expect(row.bucket).toBeNull();
    expect(row.bucketSetBy).toBe('rule');
    expect(row.splits).toEqual([
      { bucket: 'budget', cents: 2001, period: null, percent: 50 },
      { bucket: 'parents_pay', cents: 2000, period: null, percent: 50 },
    ]);
    const credit = run(new Map(), plaid('cr', -10), [half]);
    expect([credit.bucket, credit.splits]).toEqual(['budget', null]);
  });

  it('a one-bucket rule is unchanged', () => {
    const row = run(new Map(), plaid('n', 40), [rule({})]);
    expect([row.bucket, row.splits, row.bucketSetBy]).toEqual(['budget', null, 'rule']);
  });

  it('pending→posted carries a split and an allocation; at a new amount a hand-made split breaks', () => {
    const pending = tx('p', 'card', '2026-09-20', 4000, {
      splits: [part('budget', 2000), part('i_pay', 2000)],
      bucketSetBy: 'user',
    });
    const posted = run(
      new Map([['p', pending]]),
      plaid('posted', 42, { pending_transaction_id: 'p' }),
      [half],
    );
    expect(posted.splits).toEqual(pending.splits); // carried, not re-split by the rule
    expect(posted.bucketSetBy).toBe('user');
    expect(splitBroken(posted, 4200)).toBe(true);
    const dep = tx('pd', 'chk', '2026-09-20', -5000, {
      refundParts: [{ chargeId: 'x', cents: 100 }],
    });
    const postedDep = run(
      new Map([['pd', dep]]),
      plaid('pdd', -50, { account_id: 'chk', pending_transaction_id: 'pd' }),
      [half],
    );
    expect(postedDep.refundParts).toEqual(dep.refundParts);
    expect(postedDep.bucket).toBeNull();
  });
});
