import { describe, expect, it } from 'vitest';
import { addDays } from './dates';
import {
  applyRules,
  buildFinanceOverview,
  classifyTransaction,
  computeFinancePeriod,
  detectInternalMoves,
  groupByMerchant,
  isDuplicateItem,
  merchantKey,
  normalizeAmountCents,
  periodOf,
  reconcileSyncPage,
  referencedTxnIds,
  refundLinkError,
  resolveRefundLinks,
  suggestRefundMatches,
  bucketOf,
  isUnsorted,
  summarizePeriod,
  toCents,
} from './finance';
import type { FinanceAccount, FinanceItem, FinanceRule, FinanceTransaction } from './finance';
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
    lastPaymentDate: null,
    nextPaymentDueDate: null,
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
    expect(r.moves.get('a')).toBe('card_payment');
    expect(r.moves.get('b')).toBe('card_payment');
    expect(r.matchedPaymentDates).toEqual(['2026-09-10']);
  });
  it('matches within 3 days and rejects 4', () => {
    const three = detectInternalMoves(
      [tx('a', 'chk', '2026-09-10', 5000, PAY), tx('b', 'card', '2026-09-13', -5000)],
      [chk, card],
    );
    expect(three.matchedPaymentDates).toEqual(['2026-09-13']); // the card-side date
    const four = detectInternalMoves(
      [tx('a', 'chk', '2026-09-10', 5000, PAY), tx('b', 'card', '2026-09-14', -5000)],
      [chk, card],
    );
    expect(four.moves.size).toBe(0);
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
    expect([...r.matchedPaymentDates].sort()).toEqual(['2026-08-11', '2026-08-12']);
    expect(r.moves.size).toBe(4);
  });
  it('calls a depository→depository pair a transfer, not a payment', () => {
    const r = detectInternalMoves(
      [tx('a', 'chk', '2026-09-10', 20000, PAY), tx('b', 'sav', '2026-09-10', -20000)],
      [chk, sav],
    );
    expect(r.moves.get('a')).toBe('transfer');
    expect(r.matchedPaymentDates).toEqual([]);
  });
  it('uses the PFC hint for an unpaired card payment', () => {
    const r = detectInternalMoves(
      [tx('b', 'card', '2026-09-10', -5000, { pfcDetailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' })],
      [chk, card],
    );
    expect(r.moves.get('b')).toBe('card_payment');
    expect(r.hintedPaymentDates).toEqual(['2026-09-10']);
  });
  it('honours a flipped card', () => {
    const flipped = acct('card', 'credit', { signOverride: 'flip' });
    const r = detectInternalMoves(
      [tx('a', 'chk', '2026-09-10', 5000, PAY), tx('b', 'card', '2026-09-10', 5000)],
      [chk, flipped],
    );
    expect(r.moves.get('b')).toBe('card_payment');
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
});

describe('computeFinancePeriod', () => {
  const pair = (d: string, cents = 5000) => [
    tx(`o${d}`, 'chk', d, cents, PAY),
    tx(`i${d}`, 'card', d, -cents),
  ];

  it('uses Liabilities when it is the newest payment', () => {
    const p = computeFinancePeriod({
      today: '2026-09-26',
      accounts: [chk, acct('card', 'credit', { lastPaymentDate: '2026-09-20' })],
      txns: pair('2026-09-15'),
      cycleDay: 23,
    });
    expect(p.source).toBe('liabilities');
    expect(p.start).toBe('2026-09-21');
    expect(p.end).toBe('2026-09-26');
    expect(p.dayCount).toBe(6);
    expect(p.previous).toEqual({ start: '2026-09-16', end: '2026-09-20' });
  });
  it('uses the latest matched payment, and the one before for previous', () => {
    const p = computeFinancePeriod({
      today: '2026-09-26',
      accounts: [chk, card],
      txns: [...pair('2026-08-18'), ...pair('2026-09-17', 7000)],
      cycleDay: 23,
    });
    expect(p.source).toBe('matched');
    expect(p.lastPaymentDate).toBe('2026-09-17');
    expect(p.start).toBe('2026-09-18');
    expect(p.previous).toEqual({ start: '2026-08-19', end: '2026-09-17' });
  });
  it('a newer matched payment beats a stale Liabilities date', () => {
    const p = computeFinancePeriod({
      today: '2026-09-26',
      accounts: [chk, acct('card', 'credit', { lastPaymentDate: '2026-08-18' })],
      txns: [...pair('2026-08-18'), ...pair('2026-09-17')],
      cycleDay: 23,
    });
    expect(p.source).toBe('matched');
    expect(p.start).toBe('2026-09-18');
    expect(p.previous).toEqual({ start: '2026-08-19', end: '2026-09-17' });
  });
  it('the same payment seen by Liabilities and a match a day apart keeps a full previous window', () => {
    const p = computeFinancePeriod({
      today: '2026-09-26',
      accounts: [chk, acct('card', 'credit', { lastPaymentDate: '2026-09-17' })],
      txns: pair('2026-09-16'),
      cycleDay: 23,
    });
    expect(p.source).toBe('liabilities');
    expect(p.previous).toEqual({ start: '2026-08-18', end: '2026-09-17' }); // one month back
  });
  it('a same-size Venmo and card refund do not restart the period', () => {
    const p = computeFinancePeriod({
      today: '2026-09-26',
      accounts: [chk, card],
      txns: [tx('v', 'chk', '2026-09-20', 2500), tx('r', 'card', '2026-09-21', -2500)],
      cycleDay: 23,
    });
    expect(p.source).toBe('calendar');
  });
  it('falls back to the PFC hint', () => {
    const p = computeFinancePeriod({
      today: '2026-09-26',
      accounts: [card],
      txns: [
        tx('b', 'card', '2026-09-12', -5000, { pfcDetailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' }),
      ],
      cycleDay: 23,
    });
    expect(p.source).toBe('hint');
    expect(p.start).toBe('2026-09-13');
    expect(p.previous.end).toBe('2026-09-12');
  });
  it('falls back to the calendar cycle, across a year boundary', () => {
    const p = computeFinancePeriod({ today: '2026-01-10', accounts: [], txns: [], cycleDay: 23 });
    expect(p.source).toBe('calendar');
    expect(p.start).toBe('2025-12-24');
    expect(p.previous).toEqual({ start: '2025-11-24', end: '2025-12-23' });
  });
  it('clamps a cycle day past the end of the month', () => {
    const p = computeFinancePeriod({ today: '2026-03-05', accounts: [], txns: [], cycleDay: 31 });
    expect(p.start).toBe('2026-03-01'); // day after Feb 28
  });
  it('ignores a payment dated after today', () => {
    const p = computeFinancePeriod({
      today: '2026-09-26',
      accounts: [chk, card],
      txns: pair('2026-09-27'),
      cycleDay: 23,
    });
    expect(p.source).toBe('calendar');
  });
  it('paid today → the new period starts tomorrow', () => {
    const p = computeFinancePeriod({
      today: '2026-09-26',
      accounts: [chk, card],
      txns: pair('2026-09-26'),
      cycleDay: 23,
    });
    expect(p.start).toBe('2026-09-27');
    expect(p.dayCount).toBe(1);
  });
});

describe('periodOf + summarizePeriod', () => {
  const period = computeFinancePeriod({
    today: '2026-09-26',
    accounts: [chk, card],
    txns: [
      tx('o1', 'chk', '2026-08-18', 5000, PAY),
      tx('i1', 'card', '2026-08-18', -5000),
      tx('o2', 'chk', '2026-09-17', 7000, PAY),
      tx('i2', 'card', '2026-09-17', -7000),
    ],
    cycleDay: 23,
  });
  const payments = [
    tx('o1', 'chk', '2026-08-18', 5000, PAY),
    tx('i1', 'card', '2026-08-18', -5000),
    tx('o2', 'chk', '2026-09-17', 7000, PAY),
    tx('i2', 'card', '2026-09-17', -7000),
  ];

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
    syncRequestedAt: 50,
    refreshRequestedAt: null,
    lockedUntil: null,
    ...over,
  });
  const build = (syncStates = [sync()], items = [item]) =>
    buildFinanceOverview({
      today: '2026-09-26',
      budgetCents: 60000,
      cycleDay: 23,
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
  it('a request that outlived the sync timeout stops reading as syncing', () => {
    const stale = buildFinanceOverview({
      today: '2026-09-26',
      budgetCents: 60000,
      cycleDay: 23,
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
  const accounts = [acct('chk-2050', 'depository'), acct('card-8812', 'credit')];
  const meta = (name: string) => ({
    id: 'x',
    name,
    mask: name.slice(-4),
    type: 'depository',
    subtype: null,
  });
  it('flags a re-link of the same accounts at the same bank', () => {
    expect(isDuplicateItem([item], accounts, 'ins_1', [meta('chk-2050')])).toBe(true);
  });
  it('allows a new account, another bank, or a removed item', () => {
    expect(isDuplicateItem([item], accounts, 'ins_1', [meta('sav-4321')])).toBe(false);
    expect(isDuplicateItem([item], accounts, 'ins_2', [meta('chk-2050')])).toBe(false);
    expect(
      isDuplicateItem([{ ...item, deletedAt: 5 }], accounts, 'ins_1', [meta('chk-2050')]),
    ).toBe(false);
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
  it('the fixture history yields a matched period and a sensible summary', () => {
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
    const txns = [...existing.values()];
    const period = computeFinancePeriod({ today, accounts, txns, cycleDay: 23 });
    expect(period.source).toBe('matched');
    expect(period.lastPaymentDate).toBe(addDays(today, -9));
    const s = summarizePeriod({ period, txns, accounts, budgetCents: 60000 });
    expect(s.unsortedCount).toBeGreaterThan(10);
    expect(s.spentCents).toBe(0);
  });
});

describe('refund links', () => {
  const period = computeFinancePeriod({
    today: '2026-09-26',
    accounts: [chk, card],
    txns: [
      tx('o1', 'chk', '2026-08-18', 5000, PAY),
      tx('i1', 'card', '2026-08-18', -5000),
      tx('o2', 'chk', '2026-09-17', 7000, PAY),
      tx('i2', 'card', '2026-09-17', -7000),
    ],
    cycleDay: 23,
  });
  const payments = [
    tx('o1', 'chk', '2026-08-18', 5000, PAY),
    tx('i1', 'card', '2026-08-18', -5000),
    tx('o2', 'chk', '2026-09-17', 7000, PAY),
    tx('i2', 'card', '2026-09-17', -7000),
  ];
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
      tx('after', 'card', '2026-09-23', 3499, amazon),
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
    expect(ids).toEqual(['exact-near', 'pending-exact', 'exact-far', 'bigger', 'exact-other-acct']);
  });

  it('refundLinkError guards each rule', () => {
    const charge = tx('c', 'card', '2026-09-20', 3499, amazon);
    const refund = tx('r', 'card', '2026-09-22', -3499, amazon);
    const ok = { refund, refundAccount: card, charge, chargeAccount: card };
    expect(refundLinkError(ok)).toBeNull();
    expect(refundLinkError({ ...ok, charge: refund, chargeAccount: card })).toMatch(
      /itself|charge/,
    );
    expect(refundLinkError({ ...ok, refund: { ...charge, id: 'c2' } })).toMatch(/card credit/);
    expect(refundLinkError({ ...ok, refundAccount: chk })).toMatch(/card credit/);
    expect(refundLinkError({ ...ok, refund: { ...refund, pfcPrimary: 'LOAN_PAYMENTS' } })).toMatch(
      /payment/,
    );
    expect(refundLinkError({ ...ok, refund: { ...refund, rawAmountCents: -5000 } })).toMatch(
      /larger/,
    );
    expect(refundLinkError({ ...ok, charge: { ...charge, deletedAt: 1 } })).toMatch(/gone/);
  });

  it('refundLinkError: hidden or checking accounts, transfers, and a later charge are refused', () => {
    const charge = tx('c', 'card', '2026-09-20', 3499, amazon);
    const refund = tx('r', 'card', '2026-09-22', -3499, amazon);
    const ok = { refund, refundAccount: card, charge, chargeAccount: card };
    expect(refundLinkError({ ...ok, chargeAccount: { ...card, hidden: true } })).toMatch(/shown/);
    expect(refundLinkError({ ...ok, chargeAccount: undefined })).toMatch(/shown/);
    expect(
      refundLinkError({ ...ok, charge: { ...charge, accountId: 'chk' }, chargeAccount: chk }),
    ).toMatch(/card charge/);
    expect(refundLinkError({ ...ok, charge: { ...charge, pfcPrimary: 'TRANSFER_OUT' } })).toMatch(
      /card charge/,
    );
    expect(refundLinkError({ ...ok, charge: { ...charge, date: '2026-09-23' } })).toMatch(/before/);
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
