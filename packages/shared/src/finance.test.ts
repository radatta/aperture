import { describe, expect, it } from 'vitest';
import { addDays } from './dates';
import {
  amountOf,
  applyRules,
  buildFinanceOverview,
  classifyTransaction,
  computeFinancePeriod,
  detectInternalMoves,
  financeBucketError,
  financeSyncErrorMessage,
  groupByMerchant,
  isFinanceBucket,
  deriveFinanceView,
  financeListRange,
  isDuplicateItem,
  isPeriodStart,
  linkableTransactions,
  matchesFinanceFilter,
  matchesFinanceText,
  merchantKey,
  normalizeAmountCents,
  netCents,
  periodOf,
  periodStartError,
  reconcileSyncPage,
  referencedTxnIds,
  refundLinkError,
  resolveRefundLinks,
  searchRefundCharges,
  sortableTransactions,
  suggestPeriodStart,
  suggestRefundMatches,
  bucketOf,
  capRefunds,
  chargeSideError,
  refundSideError,
  REFUND_OVER_RATIO,
  isUnsorted,
  summarizePeriod,
  toCents,
} from './finance';
import type {
  FinanceAccount,
  FinanceItem,
  FinanceOverview,
  FinanceRule,
  FinanceTransaction,
} from './finance';
import {
  FIXTURE_ACCOUNT_IDS,
  fixtureHistory,
  fixtureInitialPages,
  fixtureUpdatePage,
} from './financeFixtures';
import type { PlaidTransaction } from './plaidTypes';

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
    bucketSetBy: null,
    periodOverride: null,
    note: null,
    refundOfId: null,
    startsPeriod: false,
    ...over,
  };
}

function rule(
  pattern: string,
  bucket: FinanceRule['bucket'],
  over: Partial<FinanceRule> = {},
): FinanceRule {
  return { ...base, id: `r-${pattern}`, pattern, bucket, active: true, ...over };
}

const PAY = { pfcPrimary: 'LOAN_PAYMENTS' };
const MARK = { startsPeriod: true };
const chk = acct('chk', 'depository');
const sav = acct('sav', 'depository');
const card = acct('card', 'credit');

describe('normalizeAmountCents', () => {
  it('keeps Plaid sign on auto and flips on flip, never producing -0', () => {
    expect(normalizeAmountCents(500, 'auto')).toBe(500);
    expect(normalizeAmountCents(500, 'flip')).toBe(-500);
    expect(Object.is(normalizeAmountCents(0, 'flip'), 0)).toBe(true);
  });
  it('toCents rounds float dollars', () => {
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents(-745.18)).toBe(-74518);
  });
});

describe('detectInternalMoves', () => {
  it('pairs a checking outflow with a card inflow on the same day', () => {
    const r = detectInternalMoves(
      [tx('a', 'chk', '2026-09-10', 5000, PAY), tx('b', 'card', '2026-09-10', -5000)],
      [chk, card],
    );
    expect(r.get('a')).toBe('card_payment');
    expect(r.get('b')).toBe('card_payment');
  });
  it('matches within 3 days and rejects 4', () => {
    const three = detectInternalMoves(
      [tx('a', 'chk', '2026-09-10', 5000, PAY), tx('b', 'card', '2026-09-13', -5000)],
      [chk, card],
    );
    expect(three.get('b')).toBe('card_payment');
    const four = detectInternalMoves(
      [tx('a', 'chk', '2026-09-10', 5000, PAY), tx('b', 'card', '2026-09-14', -5000)],
      [chk, card],
    );
    expect(four.size).toBe(0);
  });
  it('pairs two payments to their nearest partners', () => {
    const r = detectInternalMoves(
      [
        tx('a1', 'chk', '2026-08-10', 5000, PAY),
        tx('a2', 'chk', '2026-08-12', 5000, PAY),
        tx('b2', 'card', '2026-08-12', -5000),
        tx('b1', 'card', '2026-08-11', -5000),
      ],
      [chk, card],
    );
    expect(r.size).toBe(4);
  });
  it('calls a depository→depository pair a transfer, not a payment', () => {
    const r = detectInternalMoves(
      [tx('a', 'chk', '2026-09-10', 20000, PAY), tx('b', 'sav', '2026-09-10', -20000)],
      [chk, sav],
    );
    expect(r.get('a')).toBe('transfer');
    expect(r.get('b')).toBe('transfer');
  });
  it('uses the PFC hint for an unpaired card payment', () => {
    const r = detectInternalMoves(
      [tx('b', 'card', '2026-09-10', -5000, { pfcDetailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' })],
      [chk, card],
    );
    expect(r.get('b')).toBe('card_payment');
  });
  it('a same-size Venmo and card refund do not pair', () => {
    const r = detectInternalMoves(
      [tx('v', 'chk', '2026-09-20', 2500), tx('r', 'card', '2026-09-21', -2500)],
      [chk, card],
    );
    expect(r.size).toBe(0);
  });
  it('a marked card credit pairs with its checking outflow even without a PFC', () => {
    const rows = [tx('a', 'chk', '2026-09-16', 74518), tx('b', 'card', '2026-09-17', -74518)];
    expect(detectInternalMoves(rows, [chk, card]).size).toBe(0);
    const marked = [rows[0]!, { ...rows[1]!, startsPeriod: true }];
    expect(detectInternalMoves(marked, [chk, card]).get('a')).toBe('card_payment');
  });
  it('honours a flipped card', () => {
    const flipped = acct('card', 'credit', { signOverride: 'flip' });
    const r = detectInternalMoves(
      [tx('a', 'chk', '2026-09-10', 5000, PAY), tx('b', 'card', '2026-09-10', 5000)],
      [chk, flipped],
    );
    expect(r.get('b')).toBe('card_payment');
  });
});

describe('classifyTransaction', () => {
  it('money out is an expense, a card credit is a refund, bank money in is income, matched rows keep their move', () => {
    const moves = new Map([['p', 'card_payment' as const]]);
    expect(classifyTransaction(tx('e', 'card', '2026-09-01', 1200), card, moves)).toBe('expense');
    expect(classifyTransaction(tx('r', 'card', '2026-09-01', -1200), card, moves)).toBe('refund');
    expect(classifyTransaction(tx('w', 'chk', '2026-09-01', -1200), chk, moves)).toBe('income');
    expect(classifyTransaction(tx('p', 'chk', '2026-09-01', 1200), chk, moves)).toBe(
      'card_payment',
    );
  });
  it('a valid mark is a card payment even without a PFC; an invalid one falls through', () => {
    const none = new Map();
    expect(classifyTransaction(tx('m', 'card', '2026-09-01', -1200, MARK), card, none)).toBe(
      'card_payment',
    );
    const flipped = acct('card', 'credit', { signOverride: 'flip' });
    expect(classifyTransaction(tx('m', 'card', '2026-09-01', -1200, MARK), flipped, none)).toBe(
      'expense',
    );
    expect(classifyTransaction(tx('m', 'chk', '2026-09-01', -1200, MARK), chk, none)).toBe(
      'income',
    );
  });
});

describe('period marks', () => {
  it('periodStartError guards each rule; isPeriodStart needs the flag too', () => {
    const pay = tx('m', 'card', '2026-09-17', -5000);
    expect(periodStartError(pay, card)).toBeNull();
    expect(periodStartError({ ...pay, deletedAt: 1 }, card)).toMatch(/gone/);
    expect(periodStartError(pay, undefined)).toMatch(/account/);
    expect(periodStartError(pay, { ...card, deletedAt: 1 })).toMatch(/account/);
    expect(periodStartError(pay, chk)).toMatch(/card payment/);
    expect(periodStartError({ ...pay, rawAmountCents: 5000 }, card)).toMatch(/money coming in/);
    expect(periodStartError(pay, { ...card, hidden: true })).toBeNull(); // hiding doesn't move it
    expect(isPeriodStart(pay, card)).toBe(false);
    expect(isPeriodStart({ ...pay, ...MARK }, card)).toBe(true);
  });

  it('a marked row leaves the sortable set', () => {
    const rows = [tx('r', 'card', '2026-09-17', -5000), tx('m', 'card', '2026-09-18', -900, MARK)];
    expect(sortableTransactions(rows, [card], new Map()).map((t) => t.id)).toEqual(['r']);
  });

  it('suggestPeriodStart offers the newest unmarked recognised payment after the last mark', () => {
    const rows = [
      tx('o1', 'chk', '2026-08-18', 5000, PAY),
      tx('i1', 'card', '2026-08-18', -5000, MARK),
      tx('o2', 'chk', '2026-09-17', 7000, PAY),
      tx('i2', 'card', '2026-09-17', -7000),
      tx('r', 'card', '2026-09-20', -900), // a refund — not a recognised payment
      tx('late', 'card', '2026-09-30', -100, { pfcDetailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' }),
    ];
    const moves = detectInternalMoves(rows, [chk, card]);
    const args = { txns: rows, accounts: [chk, card], moves, today: '2026-09-26' };
    expect(suggestPeriodStart({ ...args, after: '2026-08-18' })?.id).toBe('i2');
    expect(suggestPeriodStart({ ...args, after: null })?.id).toBe('i2');
    expect(suggestPeriodStart({ ...args, after: '2026-09-17' })).toBeNull();
    // A copy within the match window of the last mark is the same payment, not a new cycle.
    const copy = [
      ...rows,
      tx('i1b', 'card', '2026-08-19', -5000, { pfcDetailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' }),
    ];
    expect(
      suggestPeriodStart({
        ...args,
        txns: copy,
        moves: detectInternalMoves(copy, [chk, card]),
        after: '2026-08-18',
        today: '2026-09-01',
      }),
    ).toBeNull();
    expect(
      suggestPeriodStart({
        ...args,
        txns: copy,
        moves: detectInternalMoves(copy, [chk, card]),
        after: '2026-08-14',
        today: '2026-09-01',
      })?.id,
    ).toBe('i1b'); // outside the window it would be offered
    const allMarked = rows.map((t) => (t.id === 'i2' ? { ...t, ...MARK } : t));
    expect(suggestPeriodStart({ ...args, txns: allMarked, after: null })).toBeNull();
  });
});

describe('computeFinancePeriod', () => {
  const mark = (d: string, over: Partial<FinanceTransaction> = {}) =>
    tx(`m${d}`, 'card', d, -5000, { ...MARK, ...over });
  const run = (txns: FinanceTransaction[], accounts = [chk, card], today = '2026-09-26') =>
    computeFinancePeriod({ today, accounts, txns, paymentDay: 20 });

  it('the latest mark wins and the mark before it bounds previous', () => {
    const p = run([mark('2026-08-18'), mark('2026-09-17')]);
    expect(p.source).toBe('marked');
    expect(p.lastPaymentDate).toBe('2026-09-17');
    expect(p.start).toBe('2026-09-18');
    expect(p.end).toBe('2026-09-26');
    expect(p.dayCount).toBe(9);
    expect(p.previous).toEqual({ start: '2026-08-19', end: '2026-09-17' });
  });
  it('a single mark gives a previous window one month back', () => {
    expect(run([mark('2026-09-17')]).previous).toEqual({ start: '2026-08-18', end: '2026-09-17' });
  });
  it('two marks on the same day are one boundary', () => {
    const p = run([mark('2026-08-18'), mark('2026-09-17'), mark('2026-09-17', { id: 'dup' })]);
    expect(p.previous.start).toBe('2026-08-19');
  });
  it('a mark today starts the period tomorrow', () => {
    const p = run([mark('2026-09-26')]);
    expect(p.start).toBe('2026-09-27');
    expect(p.end).toBe('2026-09-27');
    expect(p.dayCount).toBe(1);
  });
  it('ignores a mark after today, on a bank account, on a flipped card, tombstoned, or on a deleted account', () => {
    expect(run([mark('2026-09-27')]).source).toBe('payment_day');
    expect(run([mark('2026-09-17', { accountId: 'chk' })]).source).toBe('payment_day');
    const flipped = acct('card', 'credit', { signOverride: 'flip' });
    expect(run([mark('2026-09-17')], [chk, flipped]).source).toBe('payment_day');
    expect(run([mark('2026-09-17', { deletedAt: 1 })]).source).toBe('payment_day');
    expect(run([mark('2026-09-17')], [chk, { ...card, deletedAt: 1 }]).source).toBe('payment_day');
  });
  it('a mark on a hidden card still counts', () => {
    expect(run([mark('2026-09-17')], [chk, { ...card, hidden: true }]).source).toBe('marked');
  });
  it('a detected payment alone never sets the period', () => {
    const p = run([tx('o', 'chk', '2026-09-17', 5000, PAY), tx('i', 'card', '2026-09-17', -5000)]);
    expect(p.source).toBe('payment_day');
  });
  it('no mark → the day after the payment day, across a year boundary', () => {
    const p = run([], [], '2026-01-10');
    expect(p.source).toBe('payment_day');
    expect(p.lastPaymentDate).toBeNull();
    expect(p.start).toBe('2025-12-21');
    expect(p.previous).toEqual({ start: '2025-11-21', end: '2025-12-20' });
    expect(run([], [], '2026-09-21').start).toBe('2026-09-21');
    expect(run([], [], '2026-09-20').start).toBe('2026-08-21');
  });
  it('clamps a payment day past the end of the month', () => {
    const p = computeFinancePeriod({ today: '2026-03-05', accounts: [], txns: [], paymentDay: 31 });
    expect(p.start).toBe('2026-03-01'); // day after Feb 28
  });
});

const payments = [
  tx('o1', 'chk', '2026-08-18', 5000, PAY),
  tx('i1', 'card', '2026-08-18', -5000, MARK),
  tx('o2', 'chk', '2026-09-17', 7000, PAY),
  tx('i2', 'card', '2026-09-17', -7000, MARK),
];
const period = computeFinancePeriod({
  today: '2026-09-26',
  accounts: [chk, card],
  txns: payments,
  paymentDay: 20,
});

describe('periodOf + summarizePeriod', () => {
  it('places rows by date, lets an override move them, and ignores anything older', () => {
    expect(periodOf(tx('a', 'card', '2026-09-20', 1), period)).toBe('current');
    expect(periodOf(tx('a', 'card', '2026-09-01', 1), period)).toBe('previous');
    expect(periodOf(tx('a', 'card', '2026-09-20', 1, { periodOverride: 'previous' }), period)).toBe(
      'previous',
    );
    expect(periodOf(tx('a', 'card', '2026-09-01', 1, { periodOverride: 'current' }), period)).toBe(
      'current',
    );
    expect(
      periodOf(tx('a', 'card', '2026-07-01', 1, { periodOverride: 'current' }), period),
    ).toBeNull();
  });

  it('totals current-period buckets, counts unsorted in both windows, and skips payments', () => {
    const txns = [
      ...payments,
      tx('b1', 'card', '2026-09-20', 4000, { bucket: 'budget' }),
      tx('b2', 'card', '2026-09-21', 2500, { bucket: 'budget' }),
      tx('p1', 'card', '2026-09-22', 9000, { bucket: 'parents_pay' }),
      tx('b3', 'card', '2026-09-01', 1000, { bucket: 'budget' }), // previous — not counted
      tx('b4', 'card', '2026-09-02', 1500, { bucket: 'budget', periodOverride: 'current' }), // pulled in
      tx('u1', 'card', '2026-09-23', 700),
      tx('u2', 'card', '2026-09-03', 300), // previous-window unsorted still counts as unsorted
      tx('ref', 'card', '2026-09-24', -900, { bucket: 'budget' }), // a card refund nets against its bucket
      tx('pay', 'chk', '2026-09-24', -150000), // money into checking — never sorted
      tx('mk', 'card', '2026-09-24', -800, { ...MARK, bucket: 'budget' }), // a mark is a payment
    ];
    const s = summarizePeriod({ period, txns, accounts: [chk, card], budgetCents: 60000 });
    expect(s.buckets.budget).toEqual({ totalCents: 7100, count: 4 });
    expect(s.buckets.parents_pay.totalCents).toBe(9000);
    expect(s.spentCents).toBe(7100);
    expect(s.leftCents).toBe(52900);
    expect(s.unsortedCount).toBe(2);
    expect(s.unsortedCents).toBe(1000);
  });

  it('drops hidden accounts from the totals', () => {
    const hidden = acct('card', 'credit', { hidden: true });
    const s = summarizePeriod({
      period,
      txns: [tx('b1', 'card', '2026-09-20', 4000, { bucket: 'budget' })],
      accounts: [chk, hidden],
      budgetCents: 60000,
    });
    expect(s.spentCents).toBe(0);
  });
});

describe('not_spending', () => {
  const sum = (txns: FinanceTransaction[]) =>
    summarizePeriod({ period, txns, accounts: [chk, sav, card], budgetCents: 60000 });
  const mixed = [
    ...payments,
    tx('b1', 'card', '2026-09-20', 4200, { bucket: 'budget' }),
    tx('p1', 'card', '2026-09-22', 9000, { bucket: 'parents_pay' }),
    tx('i1', 'card', '2026-09-22', 1200, { bucket: 'i_pay' }),
    tx('u1', 'card', '2026-09-23', 700),
  ];

  it('is in no total and never to sort, in either window', () => {
    const s = sum([
      ...mixed,
      tx('inv', 'sav', '2026-09-22', 25000, { bucket: 'not_spending' }), // current
      tx('cash', 'chk', '2026-09-02', 1500, { bucket: 'not_spending' }), // previous
    ]);
    expect(s).toEqual(sum(mixed));
  });

  it('moving a charge from Budget to Not spending drops spent by exactly its amount', () => {
    const before = sum([...mixed, tx('x', 'card', '2026-09-21', 2500, { bucket: 'budget' })]);
    const after = sum([...mixed, tx('x', 'card', '2026-09-21', 2500, { bucket: 'not_spending' })]);
    expect(before.spentCents - after.spentCents).toBe(2500);
    expect(after.buckets.budget.count).toBe(before.buckets.budget.count - 1);
  });

  it('a refund linked to a Not-spending charge follows it out of every total', () => {
    const charge = tx('c', 'card', '2026-09-20', 5000, { bucket: 'not_spending' });
    const refund = tx('r', 'card', '2026-09-22', -2000, { refundOfId: 'c' });
    const links = resolveRefundLinks([charge, refund], (t) => t.rawAmountCents);
    expect(bucketOf(refund, links)).toBe('not_spending');
    expect(isUnsorted(refund, links)).toBe(false);
    expect(isUnsorted(charge, links)).toBe(false);
    expect(sum([...mixed, charge, refund])).toEqual(sum(mixed));
  });

  it('a stray stored bucket is skipped, not totalled and not thrown on', () => {
    const bogus = tx('z', 'card', '2026-09-21', 999, { bucket: 'bogus' as never });
    expect(sum([...mixed, bogus])).toEqual(sum(mixed));
  });

  it('a rule can put new rows in Not spending at sync time', () => {
    const [p1] = fixtureInitialPages('2026-09-26');
    const rows = reconcileSyncPage({
      existing: new Map(),
      page: p1!,
      rules: [rule('chipotle', 'not_spending')],
      now: 1000,
      itemId: 'item',
      userId: 'u',
    });
    const chip = rows.find((t) => t.merchantName === 'Chipotle')!;
    expect(chip.bucket).toBe('not_spending');
    expect(chip.bucketSetBy).toBe('rule');
  });

  it('isFinanceBucket / financeBucketError accept the four buckets and nothing else', () => {
    for (const b of ['parents_pay', 'budget', 'i_pay', 'not_spending']) {
      expect(isFinanceBucket(b)).toBe(true);
      expect(financeBucketError(b, { nullable: false })).toBeNull();
    }
    for (const v of ['bogus', '', null, undefined, 3]) expect(isFinanceBucket(v)).toBe(false);
    expect(financeBucketError(null, { nullable: true })).toBeNull();
    expect(financeBucketError(null, { nullable: false })).toBe('Unknown bucket: null');
    expect(financeBucketError('bogus', { nullable: true })).toBe('Unknown bucket: bogus');
  });
});

describe('list filters: matchesFinanceFilter / matchesFinanceText / netCents', () => {
  const charge = tx('c', 'card', '2026-09-20', 3499, { bucket: 'budget', merchantName: 'Amazon' });
  const refund = tx('r', 'card', '2026-09-22', -1000, { refundOfId: 'c', merchantName: 'Amazon' });
  const xfer = tx('x', 'chk', '2026-09-21', 5000, { pfcPrimary: 'TRANSFER_OUT' });
  const inn = tx('y', 'sav', '2026-09-21', -5000, { pfcPrimary: 'TRANSFER_IN' });
  const loose = tx('u', 'card', '2026-09-21', 700, { name: 'DD *DOORDASH CHIPOTLE', note: null });
  const all = [charge, refund, xfer, inn, loose];
  const view = deriveFinanceView(
    {
      period,
      accounts: [chk, sav, card],
    } as FinanceOverview,
    all,
  );

  it('a bucket chip shows a linked refund under its charge, never a transfer', () => {
    expect(matchesFinanceFilter(refund, view, 'budget')).toBe(true);
    expect(matchesFinanceFilter(xfer, view, 'budget')).toBe(false);
    expect(matchesFinanceFilter(xfer, view, 'unsorted')).toBe(false);
    expect(matchesFinanceFilter(xfer, view, 'all')).toBe(true);
    expect(matchesFinanceFilter(loose, view, 'unsorted')).toBe(true);
  });

  it('text matches merchant or bank descriptor, and the note only when asked', () => {
    expect(matchesFinanceText(charge, 'amaz')).toBe(true);
    expect(matchesFinanceText(loose, 'chipotle')).toBe(true); // descriptor, not merchant
    const noted = { ...charge, note: 'Split with Sam' };
    expect(matchesFinanceText(noted, 'sam')).toBe(false);
    expect(matchesFinanceText(noted, 'sam', { note: true })).toBe(true);
  });

  it('netCents is net: money in subtracts', () => {
    expect(netCents([charge, refund], (t) => t.rawAmountCents)).toBe(2499);
    expect(netCents([], (t: FinanceTransaction) => t.rawAmountCents)).toBe(0);
  });
});

describe('buildFinanceOverview', () => {
  const item: FinanceItem = {
    ...base,
    id: 'item',
    institutionId: 'ins',
    institutionName: 'Bank',
    status: 'ok',
    errorCode: null,
    consentExpiresAt: null,
    lastSuccessfulUpdateAt: null,
    lastFailedUpdateAt: null,
    consentedProducts: ['transactions'],
  };
  const sync = (over: Record<string, unknown> = {}) => ({
    ...base,
    id: 'item',
    itemId: 'item',
    cursor: null,
    lastSyncedAt: 100,
    lastSyncError: null,
    lastSyncErrorAt: null,
    syncRequestedAt: 50,
    refreshRequestedAt: null,
    lastRefreshedAt: null,
    lockedUntil: null,
    ...over,
  });
  const build = (syncStates = [sync()], items = [item]) =>
    buildFinanceOverview({
      today: '2026-09-26',
      budgetCents: 60000,
      paymentDay: 20,
      items,
      accounts: [chk, card],
      syncStates,
      txns: [],
      environment: 'stub',
      now: 300,
    });

  it('reports syncing while a request is newer than the last sync', () => {
    expect(build().sync.syncing).toBe(false);
    expect(build([sync({ syncRequestedAt: 200 })]).sync.syncing).toBe(true);
  });
  it('a run that failed after the request is finished, not syncing', () => {
    const failed = sync({
      syncRequestedAt: 200,
      lastSyncError: 'INSTITUTION_DOWN',
      lastSyncErrorAt: 210,
    });
    expect(build([failed]).sync.syncing).toBe(false);
    expect(build([{ ...failed, syncRequestedAt: 220 }]).sync.syncing).toBe(true); // asked again since
  });
  it('a request that outlived the sync timeout stops reading as syncing', () => {
    const stale = buildFinanceOverview({
      today: '2026-09-26',
      budgetCents: 60000,
      paymentDay: 20,
      items: [item],
      accounts: [],
      syncStates: [sync({ syncRequestedAt: 200 })],
      txns: [],
      environment: 'stub',
      now: 200 + 10 * 60_000,
    });
    expect(stale.sync.syncing).toBe(false);
  });
  it('drops accounts of a removed item', () => {
    expect(build(undefined, [{ ...item, deletedAt: 1 }]).accounts).toEqual([]);
  });
  it('reports the newest failure across items, and none after a success', () => {
    expect([build().sync.lastError, build().sync.lastErrorAt]).toEqual([null, null]);
    const two = build([
      sync({ id: 'a', itemId: 'item', lastSyncError: 'INSTITUTION_DOWN', lastSyncErrorAt: 10 }),
      sync({ id: 'b', itemId: 'item', lastSyncError: 'ITEM_LOGIN_REQUIRED', lastSyncErrorAt: 20 }),
    ]);
    expect([two.sync.lastError, two.sync.lastErrorAt]).toEqual(['ITEM_LOGIN_REQUIRED', 20]);
    expect(two.sync.items.map((i) => [i.lastError, i.lastErrorAt])).toEqual([
      ['INSTITUTION_DOWN', 10],
      ['ITEM_LOGIN_REQUIRED', 20],
    ]);
    const cleared = build([sync({ lastSyncError: null, lastSyncErrorAt: null, lastSyncedAt: 30 })]);
    expect([cleared.sync.lastError, cleared.sync.lastErrorAt]).toEqual([null, null]);
  });
  it('financeSyncErrorMessage names the bank, and falls back to the code', () => {
    expect(financeSyncErrorMessage('INSTITUTION_NOT_RESPONDING', 'Bank of America')).toBe(
      'Bank of America isn’t responding right now.',
    );
    expect(financeSyncErrorMessage('WEIRD_CODE')).toBe('The sync failed (WEIRD_CODE).');
    // The codes our own gateway and sync produce all read as words, never the raw fallback.
    for (const code of [
      'TIMEOUT',
      'NETWORK_ERROR',
      'INTERNAL_ERROR',
      'NOT_FOUND',
      'PRODUCT_NOT_READY',
    ])
      expect(financeSyncErrorMessage(code, 'Bank of America')).not.toMatch(/sync failed \(/);
  });
  it('last synced is null until every item has synced', () => {
    expect(build([sync({ lastSyncedAt: null })]).sync.lastSyncedAt).toBeNull();
  });
});

describe('rules + grouping', () => {
  it('the longest active pattern wins', () => {
    const rules = [
      rule('uber', 'i_pay'),
      rule('uber eats', 'budget'),
      rule('uber e', 'parents_pay', { active: false }),
    ];
    expect(applyRules(rules, { merchantName: 'Uber Eats', name: 'x' })?.bucket).toBe('budget');
    expect(applyRules(rules, { merchantName: null, name: 'UBER *TRIP' })?.bucket).toBe('i_pay');
    expect(applyRules(rules, { merchantName: 'Lyft', name: 'x' })).toBeNull();
  });
  it('a rule saved from a group key matches text with digits mid-string', () => {
    const txn = { merchantName: null, name: 'CHECKCARD 0915 SQ *BLUE BOTTLE' };
    const pattern = merchantKey(txn);
    expect(applyRules([rule(pattern, 'budget')], txn)?.bucket).toBe('budget');
  });
  it('merchantKey drops store numbers', () => {
    expect(merchantKey({ merchantName: null, name: 'SQ *BLUE BOTTLE #1234' })).toBe(
      merchantKey({ merchantName: null, name: 'SQ *BLUE BOTTLE #5678' }),
    );
  });
  it('groups by merchant, biggest total first', () => {
    const g = groupByMerchant(
      [
        tx('a', 'card', '2026-09-01', 500, { merchantName: 'Chipotle' }),
        tx('b', 'card', '2026-09-02', 600, { merchantName: 'Chipotle' }),
        tx('c', 'card', '2026-09-02', 900, { merchantName: 'Target' }),
      ],
      (t) => t.rawAmountCents,
    );
    expect(g.map((x) => [x.label, x.totalCents, x.txns.length])).toEqual([
      ['Chipotle', 1100, 2],
      ['Target', 900, 1],
    ]);
    expect(g[0]!.txns[0]!.id).toBe('b'); // newest first inside a group
  });
});

describe('isDuplicateItem', () => {
  const item = { ...base, id: 'item', institutionId: 'ins_1' } as FinanceItem;
  const accounts = [acct('chk-0000', 'depository'), acct('card-8812', 'credit')];
  const meta = (name: string) => ({
    id: 'x',
    name,
    mask: name.slice(-4),
    type: 'depository',
    subtype: null,
  });
  it('flags a re-link of the same accounts at the same bank', () => {
    expect(isDuplicateItem([item], accounts, 'ins_1', [meta('chk-0000')])).toBe(true);
  });
  it('allows a new account, another bank, or a removed item', () => {
    expect(isDuplicateItem([item], accounts, 'ins_1', [meta('sav-4321')])).toBe(false);
    expect(isDuplicateItem([item], accounts, 'ins_2', [meta('chk-0000')])).toBe(false);
    expect(
      isDuplicateItem([{ ...item, deletedAt: 5 }], accounts, 'ins_1', [meta('chk-0000')]),
    ).toBe(false);
  });
  it('flags a same-bank item whose accounts haven’t synced (or were all removed)', () => {
    expect(isDuplicateItem([item], [], 'ins_1', [meta('sav-4321')])).toBe(true);
    const gone = accounts.map((a) => ({ ...a, deletedAt: 5 }));
    expect(isDuplicateItem([item], gone, 'ins_1', [meta('sav-4321')])).toBe(true);
    expect(isDuplicateItem([item], [], 'ins_2', [meta('sav-4321')])).toBe(false);
  });
});

describe('reconcileSyncPage', () => {
  const today = '2026-09-26';
  const run = (
    existing: Map<string, FinanceTransaction>,
    page: Parameters<typeof reconcileSyncPage>[0]['page'],
    rules: FinanceRule[] = [],
  ) => reconcileSyncPage({ existing, page, rules, now: 1000, itemId: 'item', userId: 'u' });

  it('adds rows with cents, rule buckets, and a replayed page is idempotent', () => {
    const existing = new Map<string, FinanceTransaction>();
    const [p1] = fixtureInitialPages(today);
    const first = run(existing, p1!, [rule('chipotle', 'budget')]);
    expect(first.length).toBe(p1!.added.length);
    const chip = first.find((t) => t.merchantName === 'Chipotle')!;
    expect(chip.bucket).toBe('budget');
    expect(chip.bucketSetBy).toBe('rule');
    expect(Number.isInteger(chip.rawAmountCents)).toBe(true);

    existing.set(chip.id, { ...chip, bucket: 'i_pay', bucketSetBy: 'user' });
    const again = run(existing, p1!);
    expect(again.length).toBe(first.length);
    expect(existing.get(chip.id)!.bucket).toBe('i_pay'); // user field survived the replay
    expect(existing.size).toBe(first.length);
  });

  it('modified never touches bucket, override or note', () => {
    const t = tx('t', 'card', '2026-09-01', 100, {
      bucket: 'budget',
      bucketSetBy: 'user',
      periodOverride: 'previous',
      note: 'hi',
    });
    const existing = new Map([[t.id, t]]);
    const p: PlaidTransaction = {
      ...fixtureHistory(today)[0]!,
      transaction_id: 't',
      amount: 2.5,
      merchant_name: 'New',
    };
    run(existing, { added: [], modified: [p], removed: [] });
    const after = existing.get('t')!;
    expect(after.rawAmountCents).toBe(250);
    expect(after.merchantName).toBe('New');
    expect([after.bucket, after.bucketSetBy, after.periodOverride, after.note]).toEqual([
      'budget',
      'user',
      'previous',
      'hi',
    ]);
  });

  it('a new row starts unmarked; modified keeps a mark; a marked pending row passes it on', () => {
    const existing = new Map<string, FinanceTransaction>();
    run(existing, fixtureInitialPages(today)[0]!);
    expect([...existing.values()].every((t) => t.startsPeriod === false)).toBe(true);

    const marked = tx('m', 'card', '2026-09-17', -5000, MARK);
    const keep = new Map([[marked.id, marked]]);
    const p: PlaidTransaction = { ...fixtureHistory(today)[0]!, transaction_id: 'm', amount: -50 };
    run(keep, { added: [], modified: [p], removed: [] });
    expect(keep.get('m')!.startsPeriod).toBe(true);

    const pending = { ...marked, id: 'p-pay', pending: true, deletedAt: 900 };
    const carry = new Map([[pending.id, pending]]);
    const posted: PlaidTransaction = {
      ...fixtureHistory(today)[0]!,
      transaction_id: 'posted-pay',
      account_id: 'card',
      amount: -50,
      merchant_name: 'Payment',
      pending_transaction_id: 'p-pay',
    };
    run(carry, { added: [posted], modified: [], removed: [] }, [rule('payment', 'budget')]);
    expect(carry.get('posted-pay')!.startsPeriod).toBe(true);
    expect(carry.get('posted-pay')!.bucket).toBeNull(); // a payment picks up no rule
  });

  it('pending→posted carries the user fields, even from a tombstoned pending row', () => {
    const pending = tx('fx-pending-1', FIXTURE_ACCOUNT_IDS.card, addDays(today, -1), 2150, {
      pending: true,
      bucket: 'parents_pay',
      bucketSetBy: 'user',
      note: 'dinner w/ mom',
      deletedAt: 900,
    });
    const existing = new Map([[pending.id, pending]]);
    const page = fixtureUpdatePage(today);
    run(existing, page, [rule('sweetgreen', 'budget')]);
    const posted = existing.get('fx-posted-1')!;
    expect(posted.bucket).toBe('parents_pay'); // carried, not the rule's bucket
    expect(posted.bucketSetBy).toBe('user');
    expect(posted.note).toBe('dinner w/ mom');
    expect(posted.rawAmountCents).toBe(2450);
  });

  it('removed tombstones an alive row', () => {
    const pending = tx('fx-pending-1', 'card', today, 2150);
    const existing = new Map([[pending.id, pending]]);
    run(existing, { added: [], modified: [], removed: [{ transaction_id: 'fx-pending-1' }] });
    expect(existing.get('fx-pending-1')!.deletedAt).toBe(1000);
  });

  it('referencedTxnIds includes pending parents', () => {
    expect(referencedTxnIds(fixtureUpdatePage(today)).sort()).toEqual([
      'fx-card-2',
      'fx-pending-1',
      'fx-posted-1',
    ]);
  });
});

describe('fixtures end-to-end', () => {
  it('the fixture history with both card payments marked yields a sensible summary', () => {
    const today = '2026-09-26';
    const existing = new Map<string, FinanceTransaction>();
    for (const p of fixtureInitialPages(today)) run(p);
    function run(p: ReturnType<typeof fixtureInitialPages>[number]) {
      reconcileSyncPage({ existing, page: p, rules: [], now: 1, itemId: 'item', userId: 'u' });
    }
    const accounts = [
      acct(FIXTURE_ACCOUNT_IDS.checking, 'depository'),
      acct(FIXTURE_ACCOUNT_IDS.savings, 'depository'),
      acct(FIXTURE_ACCOUNT_IDS.card, 'credit'),
    ];
    for (const id of ['fx-ccpay-card-40', 'fx-ccpay-card-10'])
      existing.set(id, { ...existing.get(id)!, startsPeriod: true });
    const txns = [...existing.values()];
    const period = computeFinancePeriod({ today, accounts, txns, paymentDay: 20 });
    expect(period.source).toBe('marked');
    expect(period.lastPaymentDate).toBe(addDays(today, -9));
    expect(period.previous.start).toBe(addDays(today, -38));
    const s = summarizePeriod({ period, txns, accounts, budgetCents: 60000 });
    expect(s.unsortedCount).toBeGreaterThan(10);
    expect(s.spentCents).toBe(0);
  });
});

describe('refund links', () => {
  const amazon = { merchantName: 'Amazon' };

  it('resolves directly, through a posted charge’s pending id, and not to a tombstone', () => {
    const charge = tx('c', 'card', '2026-09-20', 3499, amazon);
    const refund = tx('r', 'card', '2026-09-22', -3499, { ...amazon, refundOfId: 'c' });
    expect(resolveRefundLinks([charge, refund]).get('r')?.id).toBe('c');

    const posted = tx('c-posted', 'card', '2026-09-20', 3499, {
      ...amazon,
      pendingTransactionId: 'c',
    });
    expect(resolveRefundLinks([posted, refund]).get('r')?.id).toBe('c-posted');

    expect(resolveRefundLinks([{ ...charge, deletedAt: 5 }, refund]).has('r')).toBe(false);
    expect(resolveRefundLinks([refund]).has('r')).toBe(false);
  });

  it('bucketOf follows the charge, including an unsorted one', () => {
    const charge = tx('c', 'card', '2026-09-20', 3499, amazon);
    const refund = tx('r', 'card', '2026-09-22', -3499, { refundOfId: 'c', bucket: 'i_pay' });
    const links = resolveRefundLinks([charge, refund]);
    expect(bucketOf(refund, links)).toBeNull();
    expect(isUnsorted(refund, links)).toBe(false);
    expect(isUnsorted(charge, links)).toBe(true);
  });

  it('a linked refund nets in its charge’s bucket and period, and never counts', () => {
    const txns = [
      ...payments,
      tx('c', 'card', '2026-09-20', 3499, { ...amazon, bucket: 'budget' }),
      tx('r', 'card', '2026-09-22', -3499, { ...amazon, refundOfId: 'c' }),
      tx('old', 'card', '2026-09-01', 2689, { bucket: 'budget' }), // previous period
      tx('r2', 'card', '2026-09-23', -1000, { refundOfId: 'old' }), // dated current, counts previous
    ];
    const s = summarizePeriod({ period, txns, accounts: [chk, card], budgetCents: 60000 });
    expect(s.spentCents).toBe(0);
    expect(s.buckets.budget.count).toBe(1);
    expect(s.unsortedCount).toBe(0);
  });

  it('an unsorted charge with a partial refund: one to sort, net cents', () => {
    const txns = [
      ...payments,
      tx('c', 'card', '2026-09-20', 5000, amazon),
      tx('r', 'card', '2026-09-22', -2000, { ...amazon, refundOfId: 'c' }),
      tx('r3', 'card', '2026-09-23', -1000, { ...amazon, refundOfId: 'c' }),
    ];
    const s = summarizePeriod({ period, txns, accounts: [chk, card], budgetCents: 60000 });
    expect(s.unsortedCount).toBe(1);
    expect(s.unsortedCents).toBe(2000);
  });

  it('a charge its refunds cancel in full no longer needs sorting', () => {
    const txns = [
      ...payments,
      tx('c', 'card', '2026-09-20', 3499, amazon),
      tx('r', 'card', '2026-09-22', -3499, { ...amazon, refundOfId: 'c' }),
    ];
    const s = summarizePeriod({ period, txns, accounts: [chk, card], budgetCents: 60000 });
    expect(s.unsortedCount).toBe(0);
    expect(s.unsortedCents).toBe(0);
  });

  it('a charge on a hidden account leaves its refund unlinked (back to sort)', () => {
    const other = acct('card2', 'credit', { hidden: true });
    const txns = [
      ...payments,
      tx('c', 'card2', '2026-09-20', 3499, { ...amazon, bucket: 'budget' }),
      tx('r', 'card', '2026-09-22', -3499, { ...amazon, refundOfId: 'c' }),
    ];
    const s = summarizePeriod({ period, txns, accounts: [chk, card, other], budgetCents: 60000 });
    expect(s.unsortedCount).toBe(1);
  });

  it('periodOf with links follows the charge’s override', () => {
    const charge = tx('c', 'card', '2026-09-20', 3499, { periodOverride: 'previous' });
    const refund = tx('r', 'card', '2026-09-22', -3499, { refundOfId: 'c' });
    expect(periodOf(refund, period, resolveRefundLinks([charge, refund]))).toBe('previous');
  });

  it('suggestRefundMatches ranks and filters', () => {
    const card2 = acct('card2', 'credit');
    const refund = tx('r', 'card', '2026-09-22', -3499, amazon);
    const txns = [
      refund,
      tx('exact-other-acct', 'card2', '2026-09-21', 3499, amazon),
      tx('exact-far', 'card', '2026-08-01', 3499, amazon),
      tx('exact-near', 'card', '2026-09-15', 3499, amazon),
      tx('bigger', 'card', '2026-09-20', 5000, amazon),
      tx('pending-exact', 'card', '2026-09-15', 3499, { ...amazon, pending: true }),
      tx('too-small', 'card', '2026-09-20', 1000, amazon),
      tx('too-old', 'card', '2026-06-01', 3499, amazon),
      tx('slack', 'card', '2026-09-24', 3499, amazon), // posted 2 days after its refund
      tx('after', 'card', '2026-09-26', 3499, amazon), // past the 3-day slack
      tx('other-merchant', 'card', '2026-09-20', 3499, { merchantName: 'Target' }),
      tx('used-up', 'card', '2026-09-19', 3499, amazon),
      tx('earlier-refund', 'card', '2026-09-20', -3499, { ...amazon, refundOfId: 'used-up' }),
    ];
    const links = resolveRefundLinks(txns);
    const ids = suggestRefundMatches({
      refund,
      txns,
      accounts: [chk, card, card2],
      moves: new Map(),
      links,
    }).map((t) => t.id);
    expect(ids).toEqual([
      'slack',
      'exact-near',
      'pending-exact',
      'exact-far',
      'bigger',
      'exact-other-acct',
    ]);
  });

  it('refundLinkError guards each rule', () => {
    const charge = tx('c', 'card', '2026-09-20', 3499, amazon);
    const refund = tx('r', 'card', '2026-09-22', -3499, amazon);
    const ok = { refund, refundAccount: card, charge, chargeAccount: card };
    expect(refundLinkError(ok)).toBeNull();
    expect(refundLinkError({ ...ok, charge: refund, chargeAccount: card })).toMatch(
      /itself|charge/,
    );
    expect(refundLinkError({ ...ok, refund: { ...charge, id: 'c2' } })).toMatch(/money coming in/);
    expect(refundLinkError({ ...ok, refundAccount: acct('ln', 'loan') })).toMatch(
      /money coming in/,
    );
    expect(refundLinkError({ ...ok, refund: { ...refund, pfcPrimary: 'LOAN_PAYMENTS' } })).toMatch(
      /payment/,
    );
    // Any size: the overshoot never counts (capRefunds).
    expect(refundLinkError({ ...ok, refund: { ...refund, rawAmountCents: -5000 } })).toBeNull();
    expect(refundLinkError({ ...ok, charge: { ...charge, deletedAt: 1 } })).toMatch(/gone/);
  });

  it('refundLinkError: hidden accounts, transfers, moves, marks, and a late charge are refused', () => {
    const charge = tx('c', 'card', '2026-09-20', 3499, amazon);
    const refund = tx('r', 'card', '2026-09-22', -3499, amazon);
    const ok = { refund, refundAccount: card, charge, chargeAccount: card };
    expect(refundLinkError({ ...ok, chargeAccount: { ...card, hidden: true } })).toMatch(/shown/);
    expect(refundLinkError({ ...ok, chargeAccount: undefined })).toMatch(/shown/);
    expect(refundLinkError({ ...ok, charge: { ...charge, pfcPrimary: 'TRANSFER_OUT' } })).toMatch(
      /not a payment/,
    );
    expect(refundLinkError({ ...ok, moves: new Map([['c', 'transfer' as const]]) })).toMatch(
      /not a payment/,
    );
    expect(refundLinkError({ ...ok, moves: new Map([['r', 'card_payment' as const]]) })).toMatch(
      /isn’t a refund/,
    );
    expect(refundLinkError({ ...ok, refund: { ...refund, ...MARK } })).toMatch(
      /starts your period/,
    );
    expect(refundLinkError({ ...ok, charge: { ...charge, date: '2026-09-25' } })).toBeNull();
    expect(refundLinkError({ ...ok, charge: { ...charge, date: '2026-09-26' } })).toMatch(/before/);
  });

  it('refundLinkError accepts checking/savings on either side', () => {
    const debit = tx('c', 'chk', '2026-09-20', 3861);
    const back = tx('r', 'chk', '2026-09-24', -3861);
    const ok = { refund: back, refundAccount: chk, charge: debit, chargeAccount: chk };
    expect(refundLinkError(ok)).toBeNull();
    expect(refundLinkError({ ...ok, refundAccount: card })).toBeNull(); // a card credit → debit
    expect(refundLinkError({ ...ok, refundAccount: sav })).toBeNull();
    // Someone paying you back from an account you haven't linked: Plaid calls it a transfer.
    expect(refundLinkError({ ...ok, refund: { ...back, pfcPrimary: 'TRANSFER_IN' } })).toBeNull();
    expect(refundLinkError({ ...ok, refund: { ...back, pfcPrimary: 'TRANSFER_OUT' } })).toMatch(
      /isn’t a refund/,
    );
  });

  it('a linked checking refund nets its charge; an unlinked deposit stays out of the budget', () => {
    const txns = [
      ...payments,
      tx('c', 'chk', '2026-09-20', 3861, { bucket: 'budget' }),
      tx('r', 'chk', '2026-09-24', -3861, { refundOfId: 'c' }),
      tx('wage', 'chk', '2026-09-25', -150000),
    ];
    const accounts = [chk, card];
    const moves = detectInternalMoves(txns, accounts);
    expect(linkableTransactions(txns, accounts, moves).map((t) => t.id)).toEqual([
      'c',
      'r',
      'wage',
    ]);
    const s = summarizePeriod({ period, txns, accounts, budgetCents: 60000 });
    expect(s.spentCents).toBe(0);
    expect(s.buckets.budget.count).toBe(1);
    expect(s.unsortedCount).toBe(0);
    expect(s.unsortedCents).toBe(0);
    const unlinked = txns.map((t) => (t.id === 'r' ? { ...t, refundOfId: null } : t));
    expect(
      summarizePeriod({ period, txns: unlinked, accounts, budgetCents: 60000 }).spentCents,
    ).toBe(3861);
  });

  it('a flipped checking account drops its refund link', () => {
    const charge = tx('c', 'chk', '2026-09-20', 3861);
    const refund = tx('r', 'chk', '2026-09-24', -3861, { refundOfId: 'c' });
    const flipped = acct('chk', 'depository', { signOverride: 'flip' });
    expect(resolveRefundLinks([charge, refund], (t) => amountOf(t, flipped)).has('r')).toBe(false);
  });

  it('suggestions and the per-side checks agree: no transfers, moves or marks', () => {
    const refund = tx('r', 'chk', '2026-09-24', -2500);
    const txns = [
      refund,
      tx('venmo', 'chk', '2026-09-20', 2500, { pfcPrimary: 'TRANSFER_OUT' }),
      tx('dormant', 'card', '2026-09-20', 2500, MARK), // a mark on what now reads as a charge
      tx('real', 'card', '2026-09-19', 2500),
    ];
    const args = { refund, txns, accounts: [chk, card], moves: new Map(), links: new Map() };
    expect(suggestRefundMatches({ ...args, anyMerchant: true }).map((t) => t.id)).toEqual(['real']);
    expect(chargeSideError(txns[1]!, chk)).toMatch(/not a payment/);
    expect(chargeSideError(txns[2]!, card)).toMatch(/not a payment/);
    expect(refundSideError({ ...refund, pfcPrimary: 'TRANSFER_IN' }, chk)).toBeNull();
    // …unless it paired as a move between your own accounts.
    expect(
      refundSideError({ ...refund, pfcPrimary: 'TRANSFER_IN' }, chk, new Map([['r', 'transfer']])),
    ).toMatch(/isn’t a refund/);
    expect(refundSideError({ ...refund, pfcPrimary: 'TRANSFER_IN' }, card)).toBeNull(); // unpaired card side
    expect(refundSideError(refund, chk)).toBeNull();
  });

  it('capRefunds: refunds count in date order, only up to what’s left of the charge', () => {
    const charge = tx('c', 'chk', '2026-09-20', 100000);
    const over = tx('r', 'chk', '2026-09-24', -100050, { refundOfId: 'c' });
    let txns = [charge, over];
    let got = capRefunds(
      resolveRefundLinks(txns),
      new Map(txns.map((t) => [t.id, t])),
      (t) => t.rawAmountCents,
    );
    expect(got.byCharge.get('c')).toBe(100000);
    expect(got.byRefund.get('r')).toBe(100000);

    const first = tx('r1', 'card', '2026-09-21', -3499, { refundOfId: 'c2' });
    const second = tx('r2', 'card', '2026-09-22', -1000, { refundOfId: 'c2' });
    txns = [tx('c2', 'card', '2026-09-20', 3499), first, second];
    const run = (rows: FinanceTransaction[]) =>
      capRefunds(
        resolveRefundLinks(rows),
        new Map(rows.map((t) => [t.id, t])),
        (t) => t.rawAmountCents,
      );
    got = run(txns);
    expect([got.byCharge.get('c2'), got.byRefund.get('r1'), got.byRefund.get('r2')]).toEqual([
      3499, 3499, 0,
    ]);
    // Swap the dates: the other refund is now first and uses the charge up.
    got = run([txns[0]!, { ...first, date: '2026-09-23' }, second]);
    expect([got.byRefund.get('r2'), got.byRefund.get('r1')]).toEqual([1000, 2499]);
    // A date tie falls back to id.
    got = run([txns[0]!, { ...first, date: '2026-09-22' }, second]);
    expect([got.byRefund.get('r1'), got.byRefund.get('r2')]).toEqual([3499, 0]);
  });

  it('an over-refund nets its charge to exactly $0 — in a bucket or unsorted, never below', () => {
    const rent = tx('rent', 'chk', '2026-09-21', 100000, { pfcPrimary: 'RENT_AND_UTILITIES' });
    const back = tx('back', 'chk', '2026-09-23', -100050, {
      pfcPrimary: 'TRANSFER_IN',
      refundOfId: 'rent',
    });
    const accounts = [chk, card];
    const sorted = summarizePeriod({
      period,
      txns: [...payments, { ...rent, bucket: 'budget' }, back],
      accounts,
      budgetCents: 60000,
    });
    expect([sorted.spentCents, sorted.buckets.budget.count]).toEqual([0, 1]);
    const unsorted = summarizePeriod({
      period,
      txns: [...payments, rent, back],
      accounts,
      budgetCents: 60000,
    });
    expect([unsorted.unsortedCount, unsorted.unsortedCents]).toEqual([0, 0]);
    // Unlinked, the transfer-tagged deposit is plain money in: out of every total.
    const alone = summarizePeriod({
      period,
      txns: [...payments, { ...back, refundOfId: null }],
      accounts,
      budgetCents: 60000,
    });
    expect([alone.spentCents, alone.unsortedCents]).toEqual([0, 0]);
  });

  it('suggestions offer a charge a refund overshoots by at most REFUND_OVER_RATIO', () => {
    const refund = tx('r', 'chk', '2026-09-24', -100050, {
      merchantName: 'Family',
      pfcPrimary: 'TRANSFER_IN',
    });
    const txns = [
      refund,
      tx('rent', 'chk', '2026-09-21', 100000, { merchantName: 'Roommate' }),
      tx('exact', 'chk', '2026-09-20', 100050, { merchantName: 'Landlord' }),
      tx('way-under', 'chk', '2026-09-20', 80000, { merchantName: 'Store' }), // over by 25% of it
    ];
    const ids = suggestRefundMatches({
      refund,
      txns,
      accounts: [chk],
      moves: new Map(),
      links: new Map(),
      anyMerchant: true,
    }).map((t) => t.id);
    expect(ids).toEqual(['exact', 'rent']);
    expect(REFUND_OVER_RATIO).toBe(0.1);
    // Equally far either way: the charge the refund falls short of comes before the one it overshoots.
    const tie = tx('t', 'chk', '2026-09-24', -10000, { merchantName: 'X' });
    const tieIds = suggestRefundMatches({
      refund: tie,
      txns: [
        tie,
        tx('over', 'chk', '2026-09-20', 9500, { merchantName: 'X' }),
        tx('under', 'chk', '2026-09-20', 10500, { merchantName: 'X' }),
      ],
      accounts: [chk],
      moves: new Map(),
      links: new Map(),
    }).map((t) => t.id);
    expect(tieIds).toEqual(['under', 'over']);
  });

  it('suggestRefundMatches offers the same-account checking charge first', () => {
    const refund = tx('r', 'chk', '2026-09-24', -3861, { merchantName: 'Safeway' });
    const txns = [
      refund,
      tx('on-card', 'card', '2026-09-20', 3861, { merchantName: 'Safeway' }),
      tx('on-chk', 'chk', '2026-09-18', 3861, { merchantName: 'Safeway' }),
    ];
    const ids = suggestRefundMatches({
      refund,
      txns,
      accounts: [chk, card],
      moves: new Map(),
      links: new Map(),
    }).map((t) => t.id);
    expect(ids).toEqual(['on-chk', 'on-card']);
  });

  it('a flipped account drops links whose signs no longer read refund → charge', () => {
    const charge = tx('c', 'card', '2026-09-20', 3499, amazon);
    const refund = tx('r', 'card', '2026-09-22', -3499, { ...amazon, refundOfId: 'c' });
    const flipped = (t: FinanceTransaction) => -t.rawAmountCents;
    expect(resolveRefundLinks([charge, refund], flipped).has('r')).toBe(false);
  });

  it('anyMerchant falls back to other charges when the descriptor doesn’t match', () => {
    const refund = tx('r', 'card', '2026-09-22', -3499, { merchantName: null, name: 'AMZN MKTP' });
    const charge = tx('c', 'card', '2026-09-20', 3499, amazon);
    const args = {
      refund,
      txns: [refund, charge],
      accounts: [card],
      moves: new Map(),
      links: new Map(),
    };
    expect(suggestRefundMatches(args)).toEqual([]);
    expect(suggestRefundMatches({ ...args, anyMerchant: true }).map((t) => t.id)).toEqual(['c']);
  });

  it('searchRefundCharges matches merchant, bank text, note and amount, case-insensitively', () => {
    const refund = tx('r', 'card', '2026-09-22', -3499, amazon);
    const txns = [
      refund,
      tx('m', 'card', '2026-09-20', 1200, amazon),
      tx('d', 'card', '2026-09-19', 1300, { name: 'SQ *BLUE BOTTLE' }),
      tx('n', 'card', '2026-09-18', 1400, { note: 'split with Sam' }),
      tx('big', 'chk', '2026-09-17', 100050),
    ];
    const ids = (query: string) =>
      searchRefundCharges({
        refund,
        txns,
        accounts: [chk, card],
        moves: new Map(),
        links: new Map(),
        query,
      }).map((t) => t.id);
    expect(ids('AMAZON')).toEqual(['m']);
    expect(ids('blue bot')).toEqual(['d']);
    expect(ids('sam')).toEqual(['n']);
    expect(ids('1,000.50')).toEqual(['big']);
    expect(ids('$1000.5')).toEqual(['big']);
    expect(ids('12.00')).toEqual(['m']);
    expect(ids('+$12.00')).toEqual(['m']); // pasted from a row's signed amount
    expect(ids('zzz')).toEqual([]);
  });

  it('searchRefundCharges reaches what the suggestions drop, and nothing the server refuses', () => {
    const hiddenCard = acct('hid', 'credit', { hidden: true });
    const refund = tx('r', 'card', '2026-09-22', -3499, amazon);
    const txns = [
      refund,
      tx('old', 'card', '2026-06-01', 3499, amazon), // past the 90-day window
      tx('small', 'card', '2026-09-20', 1000, amazon), // overshot by far more than 10%
      tx('other', 'card', '2026-09-20', 3499, { merchantName: 'Target' }),
      tx('slack', 'card', '2026-09-25', 3499, amazon), // 3 days after: still allowed
      tx('after', 'card', '2026-09-26', 3499, amazon), // past the slack
      tx('hidden', 'hid', '2026-09-20', 3499, amazon),
      tx('payment', 'card', '2026-09-20', 3499, { ...amazon, pfcPrimary: 'LOAN_PAYMENTS' }),
      tx('marked', 'card', '2026-09-20', 3499, { ...amazon, ...MARK }),
      tx('gone', 'card', '2026-09-20', 3499, { ...amazon, deletedAt: 1 }),
      tx('used-up', 'card', '2026-09-19', 3499, amazon),
      tx('earlier-refund', 'card', '2026-09-20', -3499, { ...amazon, refundOfId: 'used-up' }),
    ];
    const accounts = [chk, card, hiddenCard];
    const found = searchRefundCharges({
      refund,
      txns,
      accounts,
      moves: new Map(),
      links: resolveRefundLinks(txns),
      query: '',
    });
    expect(found.map((t) => t.id).sort()).toEqual(['old', 'other', 'slack', 'small']);
    const byId = new Map(accounts.map((a) => [a.id, a]));
    for (const charge of found)
      expect(
        refundLinkError({
          refund,
          refundAccount: card,
          charge,
          chargeAccount: byId.get(charge.accountId),
          moves: new Map(),
        }),
      ).toBeNull();
  });

  it('searchRefundCharges lists newest first, then id; a blank query lists every charge', () => {
    const refund = tx('r', 'card', '2026-09-22', -3499, amazon);
    const txns = [
      refund,
      tx('a', 'card', '2026-09-01', 500),
      tx('c', 'card', '2026-09-10', 500),
      tx('b', 'card', '2026-09-10', 500),
    ];
    const args = { refund, txns, accounts: [card], moves: new Map(), links: new Map() };
    expect(searchRefundCharges({ ...args, query: '' }).map((t) => t.id)).toEqual(['c', 'b', 'a']);
    expect(searchRefundCharges({ ...args, query: '   ' }).map((t) => t.id)).toEqual([
      'c',
      'b',
      'a',
    ]);
  });

  it('reconcileSyncPage carries the link pending→posted and skips the merchant rule', () => {
    const pending = tx('p-refund', 'card', '2026-09-22', -3499, {
      ...amazon,
      pending: true,
      refundOfId: 'c',
    });
    const existing = new Map([[pending.id, pending]]);
    const posted: PlaidTransaction = {
      ...fixtureHistory('2026-09-26')[0]!,
      transaction_id: 'posted-refund',
      account_id: 'card',
      amount: -34.99,
      merchant_name: 'Amazon',
      pending: false,
      pending_transaction_id: 'p-refund',
    };
    reconcileSyncPage({
      existing,
      page: { added: [posted], modified: [], removed: [{ transaction_id: 'p-refund' }] },
      rules: [rule('amazon', 'budget')],
      now: 1,
      itemId: 'item',
      userId: 'u',
    });
    const row = existing.get('posted-refund')!;
    expect(row.refundOfId).toBe('c');
    expect(row.bucket).toBeNull();
  });
});

describe('deriveFinanceView / financeListRange', () => {
  const period = {
    start: '2026-09-21',
    end: '2026-10-20',
    source: 'marked',
    previous: { start: '2026-08-21', end: '2026-09-20' },
  };
  const overview = { period, accounts: [card, chk] } as unknown as FinanceOverview;

  it('keeps rows of both windows on loaded accounts; allTxns keeps the older ones', () => {
    const v = deriveFinanceView(overview, [
      tx('now', 'card', '2026-09-25', 500),
      tx('last', 'card', '2026-09-01', 500),
      tx('old', 'card', '2026-07-01', 500),
      tx('gone', 'removed-acct', '2026-09-25', 500),
    ]);
    expect(v.txns.map((t) => t.id)).toEqual(['now', 'last']);
    expect(v.allTxns.map((t) => t.id)).toEqual(['now', 'last', 'old']);
    expect(v.kindOf(v.txns[0]!)).toBe('expense');
    expect(v.amount(v.txns[0]!)).toBe(500);
  });

  it('the list range runs to the period end when a payment marked today starts it tomorrow', () => {
    expect(financeListRange('2026-09-25', overview)).toEqual({
      from: '2026-05-28',
      to: '2026-10-20',
    });
    const endsEarlier = {
      ...overview,
      period: { ...period, end: '2026-09-20' },
    } as FinanceOverview;
    expect(financeListRange('2026-09-25', endsEarlier).to).toBe('2026-09-25');
  });
});
