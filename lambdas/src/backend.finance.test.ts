import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addDays,
  FINANCE_OVERVIEW_LOOKBACK_DAYS,
  FIXTURE_ACCOUNT_IDS,
  FIXTURE_INSTITUTION,
  FIXTURE_ITEM_ID,
  FIXTURE_LINK_ACCOUNTS,
  todayKey,
} from '@aperture/shared';
import type { FinanceAccountPatch } from '@aperture/shared';
import { InMemoryDoc } from './ddb/DocClient';
import { pk, sk } from './ddb/keys';
import { entityItem, financeTxnItem } from './ddb/mapping';
import { Repo } from './ddb/repo';
import { liveWrites } from './ddb/writes';
import { BackendClient } from './backend';
import { handleRpc } from './handler';
import { inlineInvoker, noopInvoker } from './finance/invoker';
import type { FinanceSyncEvent } from './finance/sync';
import { runFinanceSync } from './finance/sync';
import { InMemoryPlaid } from './plaid/gateway';

// Lambda-only finance behaviour the shared contract can't see: what reaches Plaid (and what never
// does), the access token's life, update mode's roster, the settings backfill, and testMode.

const U = 'local';
let doc: InMemoryDoc;
let plaid: InMemoryPlaid;
let invoked: FinanceSyncEvent[];
let api: BackendClient;
const now = () => 1_790_000_000_000;

beforeEach(() => {
  doc = new InMemoryDoc();
  plaid = new InMemoryPlaid({ today: () => todayKey(4, now()) });
  invoked = [];
  const run = inlineInvoker(async (e) => {
    invoked.push(e);
    await runFinanceSync(
      { repo: new Repo(doc, liveWrites(doc), U), plaid, now, sleep: async () => {}, userId: U },
      e,
    );
  });
  api = new BackendClient(new Repo(doc, liveWrites(doc), U), {
    userId: U,
    now,
    plaid,
    financeInvoker: run,
  });
});

const connect = () =>
  api.exchangePlaidPublicToken({
    publicToken: 'public-1',
    institution: FIXTURE_INSTITUTION,
    accounts: FIXTURE_LINK_ACCOUNTS,
  });
const methods = () => plaid.calls.map((c) => c.method);

describe('finance backend', () => {
  it('connect: exchanges once, keeps the token at the gateway, and runs a post-link sync', async () => {
    const item = await connect();
    expect(item.id).toBe(FIXTURE_ITEM_ID);
    expect(plaid.tokens.has(FIXTURE_ITEM_ID)).toBe(true);
    expect(invoked).toEqual([{ userId: U, mode: 'post-link', itemId: FIXTURE_ITEM_ID }]);
    expect(JSON.stringify(await api.exportData())).not.toContain(
      plaid.tokens.get(FIXTURE_ITEM_ID)!,
    );
    const o = await api.getFinanceOverview({ today: todayKey(4, now()) });
    expect(o.sync).toMatchObject({ syncing: false, lastError: null, environment: 'sandbox' });
  });

  it('refuses a duplicate BEFORE exchanging — a Trial slot never comes back', async () => {
    await connect();
    const exchanges = methods().filter((m) => m === 'exchangePublicToken').length;
    await expect(connect()).rejects.toThrow(/already linked/);
    expect(methods().filter((m) => m === 'exchangePublicToken').length).toBe(exchanges);
  });

  it('connect makes no Plaid call past the exchange — the sync reads the accounts', async () => {
    const quiet = new BackendClient(new Repo(doc, liveWrites(doc), U), {
      userId: U,
      now,
      plaid,
      financeInvoker: noopInvoker(),
    });
    await quiet.exchangePlaidPublicToken({
      publicToken: 'public-1',
      institution: FIXTURE_INSTITUTION,
      accounts: FIXTURE_LINK_ACCOUNTS,
    });
    expect(methods()).toEqual(['exchangePublicToken']);
    const o = await quiet.getFinanceOverview({ today: todayKey(4, now()) });
    expect(o.items.map((i) => i.id)).toEqual([FIXTURE_ITEM_ID]);
    expect(o.sync.syncing).toBe(true); // stamped before the invoke
  });

  it('a first sync that fails right after connecting leaves a bank Refresh can fix', async () => {
    plaid.failNext('accountsGet', 'INTERNAL_SERVER_ERROR');
    const item = await connect(); // the sync failed inside; the connect itself succeeded
    expect(item.id).toBe(FIXTURE_ITEM_ID);
    const today = todayKey(4, now());
    expect((await api.getFinanceOverview({ today })).sync.items[0]).toMatchObject({
      lastError: 'INTERNAL_SERVER_ERROR',
    });
    // No accounts synced yet, but re-linking the same bank is still refused before the exchange.
    const exchanges = methods().filter((m) => m === 'exchangePublicToken').length;
    await expect(connect()).rejects.toThrow(/already linked/);
    expect(methods().filter((m) => m === 'exchangePublicToken').length).toBe(exchanges);
    expect((await api.requestFinanceSync({ refresh: false })).accepted).toBe(true);
    const o = await api.getFinanceOverview({ today });
    expect(o.sync.items[0]).toMatchObject({ lastError: null });
    expect(o.accounts).toHaveLength(3);
  });

  it('Refresh with a tombstoned sync row (a half-done remove) skips it instead of failing', async () => {
    await connect();
    const repo = new Repo(doc, liveWrites(doc), U);
    const row = (await repo.getFinanceSyncState(FIXTURE_ITEM_ID))!;
    doc.putNow(
      entityItem(U, sk.finSync(FIXTURE_ITEM_ID), {
        ...row,
        deletedAt: 5,
        updatedAt: row.updatedAt + 1,
      }),
    );
    invoked.length = 0;
    expect((await api.requestFinanceSync({ refresh: false })).accepted).toBe(true);
    expect(invoked).toHaveLength(1);
  });

  it('removing a bank again sweeps accounts a half-done remove left alive, with no Plaid call', async () => {
    await connect();
    const repo = new Repo(doc, liveWrites(doc), U);
    const item = (await repo.getFinanceItem(FIXTURE_ITEM_ID))!;
    doc.putNow(
      entityItem(U, sk.finItem(FIXTURE_ITEM_ID), {
        ...item,
        deletedAt: 5,
        updatedAt: item.updatedAt + 1,
      }),
    );
    plaid.calls.length = 0;
    await api.removePlaidItem(FIXTURE_ITEM_ID);
    expect(plaid.calls).toEqual([]);
    expect(await repo.listFinanceAccounts()).toEqual([]);
  });

  it('Refresh recovers a bank whose sync state row is missing', async () => {
    await connect();
    await doc.delete(pk(U), sk.finSync(FIXTURE_ITEM_ID));
    expect((await api.requestFinanceSync({ refresh: false })).accepted).toBe(true);
    const o = await api.getFinanceOverview({ today: todayKey(4, now()) });
    expect(o.sync.items).toHaveLength(1);
    expect(o.sync.lastSyncedAt).not.toBeNull();
  });

  it('an "Always" sort skips a row a sync tombstoned meanwhile instead of failing halfway', async () => {
    await connect();
    const today = todayKey(4, now());
    const txns = await api.listFinanceTransactions({ from: '2000-01-01', to: today });
    const uber = txns.filter((t) => t.merchantName === 'Uber');
    const victim = uber[1]!;
    // A sync tombstones one sweep target between the list and the write.
    const row = (await new Repo(doc, liveWrites(doc), U).getFinanceTxn(victim.id))!;
    doc.interceptNextPutIf(pk(U), sk.finTxn(victim.id), () =>
      doc.putNow(financeTxnItem(U, { ...row, deletedAt: 5, updatedAt: row.updatedAt + 1 })),
    );
    const changed = await api.setFinanceBucket({
      ids: [uber[0]!.id],
      bucket: 'i_pay',
      rule: { pattern: 'uber' },
    });
    expect(changed.map((t) => t.id)).not.toContain(victim.id);
    expect((await api.listFinanceRules()).map((r) => r.pattern)).toEqual(['uber']);
    const after = await new Repo(doc, liveWrites(doc), U).getFinanceTxn(victim.id);
    expect(after!.deletedAt).toBe(5); // not revived
  });

  it('the link token is always for the caller, whatever the RPC args say', async () => {
    await api.createPlaidLinkToken({ mode: 'connect', userId: 'evil' } as unknown as Parameters<
      typeof api.createPlaidLinkToken
    >[0]);
    const call = plaid.calls.find((c) => c.method === 'createLinkToken')!;
    expect((call.detail as { userId: string }).userId).toBe(U);
  });

  it('remove revokes at Plaid and tombstones; an unknown or removed id makes no Plaid call', async () => {
    await connect();
    await api.removePlaidItem(FIXTURE_ITEM_ID);
    expect(methods()).toContain('itemRemove');
    expect(plaid.tokens.has(FIXTURE_ITEM_ID)).toBe(false);
    const calls = plaid.calls.length;
    await api.removePlaidItem(FIXTURE_ITEM_ID);
    await api.removePlaidItem('nope');
    expect(plaid.calls.length).toBe(calls);
  });

  it('update mode re-reads the roster (drops and adds accounts) and syncs', async () => {
    await connect();
    plaid.accounts = plaid.accounts.filter((a) => a.account_id !== FIXTURE_ACCOUNT_IDS.savings);
    invoked = [];
    await api.completePlaidUpdate(FIXTURE_ITEM_ID);
    const today = todayKey(4, now());
    expect((await api.getFinanceOverview({ today })).accounts.map((a) => a.id)).not.toContain(
      FIXTURE_ACCOUNT_IDS.savings,
    );
    expect(invoked[0]).toMatchObject({ mode: 'post-link', itemId: FIXTURE_ITEM_ID });
    await expect(api.completePlaidUpdate('nope')).rejects.toThrow('Not found');
  });

  it('a login error flags the item; reconnecting clears it and the next sync is clean', async () => {
    await connect();
    plaid.failNext('transactionsSync', 'ITEM_LOGIN_REQUIRED');
    await api.requestFinanceSync({ refresh: false });
    const today = todayKey(4, now());
    const bad = await api.getFinanceOverview({ today });
    expect(bad.items[0]!.status).toBe('login_required');
    expect(bad.sync.items[0]).toMatchObject({ lastError: 'ITEM_LOGIN_REQUIRED' });
    await api.completePlaidUpdate(FIXTURE_ITEM_ID);
    const good = await api.getFinanceOverview({ today });
    expect(good.items[0]!.status).toBe('ok');
    expect(good.sync.items[0]).toMatchObject({ lastError: null, lastErrorAt: null });
  });

  it('refresh goes to the sync run, with the cooldown on the RPC', async () => {
    await connect();
    const r = await api.requestFinanceSync({ refresh: true });
    expect(r.accepted).toBe(true);
    // The event carries no flag — the stamp makes the refresh due, and the run does it.
    expect(invoked.at(-1)).toEqual({ userId: U, mode: 'manual' });
    expect(methods()).toContain('transactionsRefresh');
    expect((await api.requestFinanceSync({ refresh: true })).accepted).toBe(false);
  });

  it('an account patch only touches the fields the user owns', async () => {
    await connect();
    const sneaky = {
      hidden: true,
      itemId: 'other',
      currentCents: 1,
    } as unknown as FinanceAccountPatch;
    const a = await api.updateFinanceAccount(FIXTURE_ACCOUNT_IDS.card, sneaky);
    expect(a.hidden).toBe(true);
    expect(a.itemId).toBe(FIXTURE_ITEM_ID);
    expect(a.currentCents).not.toBe(1);
  });

  it('settings written before finances existed read the finance defaults', async () => {
    await doc.put({
      PK: pk(U),
      SK: sk.settings(),
      id: 's',
      userId: U,
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
      dayStartHour: 4,
    });
    const s = await api.getSettings();
    expect([s.financeBudgetCents, s.financePaymentDay]).toEqual([50000, 1]);
    const o = await api.getFinanceOverview({ today: todayKey(4, now()) });
    expect(o.leftCents).toBe(50000);
  });

  it('testMode on REAL data: nothing reaches Plaid, nothing is written, nothing is invoked', async () => {
    await connect();
    const today = todayKey(4, now());
    const [first] = await api.listFinanceTransactions({ from: '2000-01-01', to: today });
    const before = doc.snapshot();
    plaid.calls.length = 0;
    invoked = [];
    const call = (method: string, args: unknown[]) =>
      handleRpc(
        doc,
        { userId: U, method, args, now, testMode: true },
        { plaid, financeInvoker: inlineInvoker(async (e) => void invoked.push(e)) },
      );
    await call('requestFinanceSync', [{ refresh: true }]);
    await call('completePlaidUpdate', [FIXTURE_ITEM_ID]).catch(() => {});
    await call('setFinanceBucket', [
      { ids: [first!.id], bucket: 'budget', rule: { pattern: 'x' } },
    ]);
    await call('updateFinanceAccount', [FIXTURE_ACCOUNT_IDS.card, { hidden: true }]);
    await call('setFinancePeriodStart', [first!.id, false]);
    await call('removePlaidItem', [FIXTURE_ITEM_ID]);
    expect(plaid.calls).toEqual([]);
    expect(invoked).toEqual([]);
    expect(doc.snapshot()).toEqual(before);
  });

  it('testMode: finance calls reach no Plaid and write nothing', async () => {
    const before = doc.size;
    const call = (method: string, args: unknown[]) =>
      handleRpc(
        doc,
        { userId: U, method, args, now, testMode: true },
        {
          plaid,
          financeInvoker: inlineInvoker(
            async () => void invoked.push({ userId: U, mode: 'manual' }),
          ),
        },
      );
    await expect(
      call('exchangePlaidPublicToken', [
        { publicToken: 'p', institution: FIXTURE_INSTITUTION, accounts: FIXTURE_LINK_ACCOUNTS },
      ]),
    ).rejects.toThrow(/testMode/);
    await call('getFinanceOverview', [{ today: todayKey(4, now()) }]);
    await call('requestFinanceSync', [{ refresh: true }]);
    expect(plaid.calls).toEqual([]);
    expect(invoked).toEqual([]);
    expect(doc.size).toBe(before); // noop writes: not even the lazy settings row
  });

  it("the server's finance day is the user's Pacific day, not the Lambda's UTC one", async () => {
    // 10pm PDT on Aug 1 is 05:00 UTC on Aug 2: past the 4am day start in UTC, still Aug 1 for the user.
    const evening = () => Date.parse('2026-08-01T22:00:00-07:00');
    await connect(); // the fixture rows, synced at the suite's clock
    const repo = new Repo(doc, liveWrites(doc), U);
    const range = vi.spyOn(repo, 'listFinanceTxnsInRange'); // this instance only: nothing to restore
    const client = new BackendClient(repo, {
      userId: U,
      now: evening,
      plaid,
      financeInvoker: noopInvoker(),
    });
    await client.linkFinanceRefund('fx-refund-1', 'fx-card-8'); // reads the overview's window back from today
    expect(range).toHaveBeenCalledWith(addDays('2026-08-01', -FINANCE_OVERVIEW_LOOKBACK_DAYS));
  });
});
