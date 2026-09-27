import { beforeEach, describe, expect, it } from 'vitest';
import {
  FIXTURE_ACCOUNT_IDS,
  FIXTURE_INSTITUTION,
  FIXTURE_ITEM_ID,
  FIXTURE_LINK_ACCOUNTS,
  todayKey,
} from '@aperture/shared';
import type { FinanceAccountPatch } from '@aperture/shared';
import { InMemoryDoc } from './ddb/DocClient';
import { pk, sk } from './ddb/keys';
import { Repo } from './ddb/repo';
import { liveWrites } from './ddb/writes';
import { BackendClient } from './backend';
import { handleRpc } from './handler';
import { inlineInvoker } from './finance/invoker';
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

  it('a failure right after the exchange leaves a visible, removable item', async () => {
    plaid.failNext('accountsGet', 'INTERNAL_SERVER_ERROR');
    await expect(connect()).rejects.toThrow();
    const o = await api.getFinanceOverview({ today: todayKey(4, now()) });
    expect(o.items.map((i) => i.id)).toEqual([FIXTURE_ITEM_ID]);
    await api.removePlaidItem(FIXTURE_ITEM_ID);
    expect(plaid.tokens.size).toBe(0);
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
    expect([s.financeBudgetCents, s.financePaymentDay]).toEqual([60000, 20]);
    const o = await api.getFinanceOverview({ today: todayKey(4, now()) });
    expect(o.leftCents).toBe(60000);
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
});
