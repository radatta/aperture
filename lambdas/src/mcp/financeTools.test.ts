import { beforeEach, describe, expect, it } from 'vitest';
import {
  FIXTURE_ACCOUNT_IDS,
  FIXTURE_INSTITUTION,
  FIXTURE_LINK_ACCOUNTS,
  bucketOf,
  deriveFinanceView,
  financeListRange,
  periodOf,
} from '@aperture/shared';
import type { ApiMethod, FinanceOverview } from '@aperture/shared';
import { InMemoryDoc } from '../ddb/DocClient';
import { Repo } from '../ddb/repo';
import { liveWrites } from '../ddb/writes';
import { BackendClient } from '../backend';
import { handleRpc } from '../handler';
import { inlineInvoker } from '../finance/invoker';
import type { FinanceSyncInvoker } from '../finance/invoker';
import { runFinanceSync } from '../finance/sync';
import { InMemoryPlaid } from '../plaid/gateway';
import type { PlaidGateway } from '../plaid/gateway';
import { TOOLS } from './tools';
import { RpcParamError } from './types';
import type { ToolContext } from './types';
import { financeTxnItem } from '../ddb/mapping';

// The fixtures are dated from TODAY; the server clock is 03:30 PDT the next morning, which the user's
// 4am rollover still counts as TODAY.
const U = 'local';
const TODAY = '2026-09-26';
const NOW = Date.parse('2026-09-27T10:30:00Z');

// The MCP must never reach Plaid or start a sync: any call on these throws.
const tripwirePlaid = new Proxy({} as PlaidGateway, {
  get: (_t, k) => {
    if (k === 'environment') return 'sandbox';
    if (k === 'then') return undefined;
    return () => {
      throw new Error(`MCP reached Plaid: ${String(k)}`);
    };
  },
});
const tripwireInvoker: FinanceSyncInvoker = {
  invoke: () => {
    throw new Error('MCP started a sync');
  },
};

let doc: InMemoryDoc;
let setup: BackendClient;
let ctx: ToolContext;

beforeEach(async () => {
  doc = new InMemoryDoc();
  const plaid = new InMemoryPlaid({ today: () => TODAY });
  const now = () => NOW;
  setup = new BackendClient(new Repo(doc, liveWrites(doc), U), {
    userId: U,
    now,
    plaid,
    financeInvoker: inlineInvoker((e) =>
      runFinanceSync(
        { repo: new Repo(doc, liveWrites(doc), U), plaid, now, sleep: async () => {}, userId: U },
        e,
      ).then(() => {}),
    ),
  });
  await setup.exchangePlaidPublicToken({
    publicToken: 'p',
    institution: FIXTURE_INSTITUTION,
    accounts: FIXTURE_LINK_ACCOUNTS,
  });
  for (const id of ['fx-ccpay-card-40', 'fx-ccpay-card-10'])
    await setup.setFinancePeriodStart(id, true);
  ctx = {
    dispatch: (method: ApiMethod, args: unknown[]) =>
      handleRpc(
        doc,
        { userId: U, method, args, now },
        { plaid: tripwirePlaid, financeInvoker: tripwireInvoker },
      ),
    upload: async () => {},
    now,
  };
});

// The tools' output, loosely: just what these assertions read.
interface TxnRow {
  id: string;
  date: string;
  kind: string;
  bucket: string | null;
  period: string;
  amountUsd: number;
  linkedChargeId: string | null;
  refundedUsd?: number;
}
interface TxnsOut {
  range: { from: string; to: string };
  total: number;
  returned: number;
  truncated: boolean;
  totalUsd: number;
  transactions: (TxnRow & { merchant: string; account: { hidden: boolean } })[];
}
interface OverviewOut {
  today: string;
  todaySource: string;
  budgetUsd: number;
  spentUsd: number;
  leftUsd: number;
  buckets: Record<string, unknown>;
  toSort: unknown;
  settings: unknown;
  period: unknown;
  accounts: { id: string; hidden: boolean }[];
  banks: { error: string | null }[];
  sync: { error: string | null };
}

const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return (await tool.run(args, ctx)) as T;
};
const overview = () => setup.getFinanceOverview({ today: TODAY });

describe('get_finance_overview', () => {
  it('matches the overview in dollars, folds in settings, and resolves today server-side', async () => {
    const o = await overview();
    const r = await call<OverviewOut>('get_finance_overview');
    expect([r.today, r.todaySource]).toEqual([TODAY, 'server']);
    expect([r.budgetUsd, r.spentUsd, r.leftUsd]).toEqual([
      o.budgetCents / 100,
      o.spentCents / 100,
      o.leftCents / 100,
    ]);
    expect(r.buckets.budget).toEqual({
      label: 'Budget',
      totalUsd: o.buckets.budget.totalCents / 100,
      count: o.buckets.budget.count,
    });
    expect(r.toSort).toEqual({ count: o.unsortedCount, totalUsd: o.unsortedCents / 100 });
    expect(r.settings).toEqual({ budgetUsd: 600, paymentDay: 20 });
    expect(r.period).toMatchObject({
      start: o.period.start,
      day: o.period.dayCount,
      source: 'marked',
    });
    expect(r.banks).toEqual([
      expect.objectContaining({ name: FIXTURE_INSTITUTION.name, status: 'ok', error: null }),
    ]);
    expect(JSON.stringify(r)).not.toMatch(/environment/);
  });

  it('flags a hidden account and says why a bank is failing', async () => {
    await setup.updateFinanceAccount(FIXTURE_ACCOUNT_IDS.savings, { hidden: true });
    const repo = new Repo(doc, liveWrites(doc), U);
    const [item] = await repo.listFinanceItems();
    await repo.casUpdate(
      repo.finSyncShape(item!.id),
      item!.id,
      (s) => ({ ...s, lastSyncError: 'INSTITUTION_DOWN', lastSyncErrorAt: NOW }),
      NOW,
    );
    const r = await call<OverviewOut>('get_finance_overview', { today: TODAY });
    expect(r.todaySource).toBe('arg');
    expect(r.accounts.find((a) => a.id === FIXTURE_ACCOUNT_IDS.savings)?.hidden).toBe(true);
    expect(r.banks[0]?.error).toBe(`${FIXTURE_INSTITUTION.name} is down right now.`);
    expect(r.sync.error).toBe(`${FIXTURE_INSTITUTION.name} is down right now.`);
  });
});

describe('list_finance_transactions', () => {
  it("every row's kind, bucket and period are exactly what the page derives", async () => {
    const o = await overview();
    const view = deriveFinanceView(
      o,
      await setup.listFinanceTransactions(financeListRange(TODAY, o)),
    );
    const r = await call<TxnsOut>('list_finance_transactions', { limit: 300 });
    expect(r.total).toBe(view.txns.length);
    for (const row of r.transactions) {
      const t = view.allTxns.find((x) => x.id === row.id)!;
      expect(row.kind).toBe(view.kindOf(t));
      expect(row.bucket).toBe(bucketOf(t, view.links));
      expect(row.period).toBe(periodOf(t, o.period, view.links) ?? 'outside');
      expect(row.amountUsd).toBe(view.amount(t) / 100);
    }
    const kinds = new Set(r.transactions.map((x) => x.kind));
    for (const k of ['expense', 'refund', 'income', 'transfer', 'card_payment'])
      expect(kinds).toContain(k);
  });

  it("unsorted is exactly the to-sort queue; a linked refund takes its charge's bucket", async () => {
    const o = await overview();
    const r = await call<TxnsOut>('list_finance_transactions', { unsorted: true, limit: 300 });
    expect(o.unsortedCount).toBeGreaterThan(0);
    expect(r.total).toBe(o.unsortedCount);

    await setup.setFinanceBucket({ ids: ['fx-card-8'], bucket: 'budget' });
    await setup.linkFinanceRefund('fx-refund-1', 'fx-card-8');
    const all = await call<TxnsOut>('list_finance_transactions', { limit: 300 });
    const refund = all.transactions.find((x) => x.id === 'fx-refund-1')!;
    expect(refund).toMatchObject({ kind: 'refund', bucket: 'budget', linkedChargeId: 'fx-card-8' });
    expect(refund.amountUsd).toBeLessThan(0);
    const charge = all.transactions.find((x) => x.id === 'fx-card-8')!;
    expect(charge.amountUsd).toBeGreaterThan(0);
    expect(charge.refundedUsd).toBe(-refund.amountUsd);
    const budget = await call<TxnsOut>('list_finance_transactions', {
      bucket: 'budget',
      limit: 300,
    });
    expect(budget.transactions.map((x) => x.id)).toEqual(
      expect.arrayContaining(['fx-card-8', 'fx-refund-1']),
    );
    expect(budget.transactions.every((x) => x.bucket === 'budget')).toBe(true);
  });

  it('Not spending: out of the overview totals and the queue, listed by its own bucket', async () => {
    const before = await call<OverviewOut>('get_finance_overview');
    await setup.setFinanceBucket({ ids: ['fx-brokerage'], bucket: 'not_spending' });
    const o = await overview();
    const r = await call<OverviewOut>('get_finance_overview');
    expect(Object.keys(r.buckets).sort()).toEqual(['budget', 'i_pay', 'parents_pay']);
    expect(r.buckets).toEqual(before.buckets);
    expect(r.toSort).toEqual({ count: o.unsortedCount, totalUsd: o.unsortedCents / 100 });
    const q = await call<TxnsOut>('list_finance_transactions', { unsorted: true, limit: 300 });
    expect(q.transactions.map((x) => x.id)).not.toContain('fx-brokerage');
    const ns = await call<TxnsOut>('list_finance_transactions', { bucket: 'not_spending' });
    expect(ns.transactions.map((x) => [x.id, x.bucket])).toEqual([
      ['fx-brokerage', 'not_spending'],
    ]);
    expect(ns.totalUsd).toBe(350);
    await expect(call('list_finance_transactions', { bucket: 'nope' })).rejects.toThrow(
      'parents_pay, budget, i_pay, not_spending',
    );
  });

  it('a capped refund reports countedUsd; its charge’s refundedUsd never exceeds the charge', async () => {
    await setup.setFinanceBucket({ ids: ['fx-rent'], bucket: 'budget' });
    await setup.linkFinanceRefund('fx-reimburse', 'fx-rent');
    await setup.linkFinanceRefund('fx-refund-1', 'fx-card-8'); // an exact refund: no countedUsd
    const all = await call<TxnsOut>('list_finance_transactions', { limit: 300 });
    const back = all.transactions.find((x) => x.id === 'fx-reimburse')! as TxnRow & {
      countedUsd?: number;
    };
    expect(back).toMatchObject({
      kind: 'income',
      bucket: 'budget',
      linkedChargeId: 'fx-rent',
      amountUsd: -1000.5,
      countedUsd: -1000,
    });
    expect(all.transactions.find((x) => x.id === 'fx-rent')!.refundedUsd).toBe(1000);
    expect(all.transactions.find((x) => x.id === 'fx-refund-1')).not.toHaveProperty('countedUsd');
    const o = await call<OverviewOut>('get_finance_overview');
    expect(o.spentUsd).toBe(0); // Budget holds only the rent, netted to $0 by the capped refund
  });

  it('a from/to window, the limit, and bad args', async () => {
    const w = await call<TxnsOut>('list_finance_transactions', {
      from: '2026-09-20',
      to: '2026-09-26',
    });
    expect(w.range).toEqual({ from: '2026-09-20', to: '2026-09-26' });
    expect(w.transactions.every((x) => x.date >= '2026-09-20' && x.date <= '2026-09-26')).toBe(
      true,
    );
    const cut = await call<TxnsOut>('list_finance_transactions', { limit: 2 });
    expect([cut.returned, cut.truncated]).toEqual([2, true]);
    for (const bad of [
      { from: '2026-09-20' },
      { from: '2026-09-26', to: '2026-09-20' },
      { from: '2025-01-01', to: '2026-09-26' },
      { unsorted: true, bucket: 'budget' },
      { bucket: 'food' },
      { limit: 0 },
      { today: 'tomorrow' },
    ])
      await expect(call<TxnsOut>('list_finance_transactions', bad)).rejects.toBeInstanceOf(
        RpcParamError,
      );
  });
});

describe('list_finance_transactions — page parity at the edges', () => {
  it("a window reaching past the page's range never changes a row the page also shows", async () => {
    // An old charge (past the 120-day lookback) that a current refund names: the page can't load it,
    // so the refund is unlinked there — and must stay unlinked in any window that includes it.
    const repo = new Repo(doc, liveWrites(doc), U);
    const charge = (await repo.getFinanceTxn('fx-card-8'))!;
    doc.putNow(
      financeTxnItem(U, { ...charge, id: 'old-charge', date: '2026-04-01', bucket: 'i_pay' }),
    );
    const refund = (await repo.getFinanceTxn('fx-refund-2'))!;
    doc.putNow(
      financeTxnItem(U, { ...refund, refundOfId: 'old-charge', updatedAt: refund.updatedAt + 1 }),
    );
    const pick = (r: TxnsOut) => r.transactions.find((x) => x.id === 'fx-refund-2')!;
    const onPage = pick(await call<TxnsOut>('list_finance_transactions', { limit: 300 }));
    const wide = await call<TxnsOut>('list_finance_transactions', {
      from: '2026-03-15',
      to: TODAY,
      limit: 300,
    });
    expect(onPage).toMatchObject({ linkedChargeId: null, period: 'current', bucket: null });
    expect(pick(wide)).toMatchObject({
      kind: onPage.kind,
      bucket: onPage.bucket,
      period: onPage.period,
      linkedChargeId: null,
    });
    expect(wide.transactions.some((x) => x.id === 'old-charge')).toBe(true); // outside rows still come
  });

  it("a bucket filter keeps rows on a hidden account, like the page's chip", async () => {
    await setup.setFinanceBucket({ ids: ['fx-card-8'], bucket: 'budget' });
    await setup.updateFinanceAccount(FIXTURE_ACCOUNT_IDS.card, { hidden: true });
    const r = await call<TxnsOut>('list_finance_transactions', { bucket: 'budget', limit: 300 });
    const row = r.transactions.find((x) => x.id === 'fx-card-8');
    expect(row?.account.hidden).toBe(true);
  });

  it('merchant narrows by name, and totalUsd sums every match', async () => {
    const all = await call<TxnsOut>('list_finance_transactions', {
      merchant: 'AMAZON',
      limit: 300,
    });
    expect(all.total).toBeGreaterThan(2);
    expect(all.transactions.every((x) => /amazon/i.test(x.merchant))).toBe(true);
    const sum = all.transactions.reduce((s, x) => s + Math.round(x.amountUsd * 100), 0) / 100;
    expect(all.totalUsd).toBe(sum);
    const cut = await call<TxnsOut>('list_finance_transactions', { merchant: 'amazon', limit: 1 });
    expect([cut.returned, cut.truncated, cut.totalUsd]).toEqual([1, true, sum]);
  });
});

describe('list_finance_rules', () => {
  it('lists pattern, bucket, label and active', async () => {
    await setup.upsertFinanceRule({ pattern: 'Uber', bucket: 'i_pay' });
    expect(await call('list_finance_rules')).toEqual([
      { pattern: 'uber', bucket: 'i_pay', bucketLabel: 'I pay', active: true },
    ]);
  });
});

it('the three finance tools write nothing and never touch Plaid or the sync', async () => {
  await setup.getSettings(); // a first-ever settings read creates the defaults row (the app's first load does too)
  const before = JSON.stringify(doc.snapshot());
  await call<OverviewOut>('get_finance_overview');
  await call<TxnsOut>('list_finance_transactions', { unsorted: true });
  await call('list_finance_rules');
  expect(JSON.stringify(doc.snapshot())).toBe(before);
  const o: FinanceOverview = await overview();
  expect(o.items).toHaveLength(1); // the tripwires would have thrown on any Plaid call or invoke
});
