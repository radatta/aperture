import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildFinanceOverview,
  FIXTURE_ACCOUNT_IDS,
  FIXTURE_ITEM_ID,
  fixtureHistory,
} from '@aperture/shared';
import type { FinanceItem, FinanceSyncState } from '@aperture/shared';
import { InMemoryDoc } from '../ddb/DocClient';
import type { Item } from '../ddb/DocClient';
import { pk, sk } from '../ddb/keys';
import { entityItem, financeTxnItem } from '../ddb/mapping';
import { Repo } from '../ddb/repo';
import { liveWrites } from '../ddb/writes';
import { InMemoryPlaid } from '../plaid/gateway';
import { itemStatus, MAX_PASSES, RUN_BUDGET_MS, runFinanceSync, upsertAccounts } from './sync';
import type { FinanceSyncMode, SyncDeps } from './sync';

const U = 'u1';
const TODAY = '2026-09-26';
const T = 1_790_000_000_000;
const DEADLINE = T + 290_000;

let doc: InMemoryDoc;
let repo: Repo;
let plaid: InMemoryPlaid;
let clock: number;
let sleeps: number;
let deps: SyncDeps;

const itemRow = (itemId: string): FinanceItem => ({
  id: itemId,
  userId: U,
  createdAt: T,
  updatedAt: T,
  deletedAt: null,
  institutionId: 'ins_127989',
  institutionName: 'Bank of America',
  status: 'ok',
  errorCode: null,
  consentExpiresAt: null,
  lastSuccessfulUpdateAt: null,
  lastFailedUpdateAt: null,
  consentedProducts: ['transactions'],
});
const stateRow = (itemId: string): FinanceSyncState => ({
  id: itemId,
  userId: U,
  createdAt: T,
  updatedAt: T,
  deletedAt: null,
  itemId,
  cursor: null,
  lastSyncedAt: null,
  lastSyncError: null,
  lastSyncErrorAt: null,
  syncRequestedAt: T,
  refreshRequestedAt: null,
  lastRefreshedAt: null,
  lockedUntil: null,
});

async function link(itemId = FIXTURE_ITEM_ID): Promise<void> {
  if (itemId === FIXTURE_ITEM_ID) await plaid.exchangePublicToken('pub');
  await doc.put(entityItem(U, sk.finItem(itemId), itemRow(itemId)));
  await doc.put(entityItem(U, sk.finSync(itemId), stateRow(itemId)));
}

const stateKey = (itemId = FIXTURE_ITEM_ID) => [pk(U), sk.finSync(itemId)] as const;
const state = async (itemId = FIXTURE_ITEM_ID) =>
  (await repo.getFinanceSyncState(itemId, { consistent: true }))!;
// A write that lands "from outside" (the BFF, the user) — bumps updatedAt like any real write.
function patchState(patch: Partial<FinanceSyncState>, itemId = FIXTURE_ITEM_ID): void {
  const cur = doc.snapshot().find((i) => i.SK === sk.finSync(itemId))!;
  doc.putNow({ ...cur, ...patch, updatedAt: (cur.updatedAt as number) + 1 } as Item);
}
// What requestFinanceSync does, then a run.
function request(refresh = false, itemIds = [FIXTURE_ITEM_ID]): void {
  for (const id of itemIds)
    patchState({ syncRequestedAt: clock, ...(refresh ? { refreshRequestedAt: clock } : {}) }, id);
}
const run = (mode: FinanceSyncMode = 'manual', itemId?: string) =>
  runFinanceSync(deps, { userId: U, mode, ...(itemId ? { itemId } : {}) });
const txns = () => repo.listAllFinanceTxns();
const count = (m: string) => plaid.calls.filter((c) => c.method === m).length;

beforeEach(() => {
  doc = new InMemoryDoc();
  repo = new Repo(doc, liveWrites(doc), U);
  clock = T;
  plaid = new InMemoryPlaid({ today: () => TODAY, now: () => clock });
  sleeps = 0;
  deps = {
    repo,
    plaid,
    now: () => clock,
    // Parallel sleepers share one clock: each wakes at its own target, never double-advancing it.
    sleep: async (ms) => {
      const to = clock + ms;
      await Promise.resolve();
      clock = Math.max(clock, to);
      sleeps++;
    },
    userId: U,
    deadline: DEADLINE,
  };
});

function overviewSyncing(s: FinanceSyncState): boolean {
  return buildFinanceOverview({
    today: TODAY,
    budgetCents: 60000,
    paymentDay: 20,
    items: [{ id: s.itemId, deletedAt: null } as FinanceItem],
    accounts: [],
    syncStates: [s],
    txns: [],
    environment: 'sandbox',
    now: clock,
  }).sync.syncing;
}

describe('runFinanceSync — the basics', () => {
  it('first sync: accounts, every page, cursor last, stamps the pass start', async () => {
    await link();
    clock = T + 5;
    const [r] = await run();
    expect(r).toMatchObject({ outcome: 'ok', passes: 1 });
    expect((await txns()).length).toBe(fixtureHistory(TODAY).length);
    expect((await repo.listFinanceAccounts()).map((a) => a.id).sort()).toEqual(
      Object.values(FIXTURE_ACCOUNT_IDS).sort(),
    );
    const s = await state();
    expect([s.cursor, s.lastSyncedAt, s.lastSyncError, s.lockedUntil]).toEqual([
      'fx-cursor-2',
      T + 5,
      null,
      null,
    ]);
  });

  it('a failure on page 2 writes nothing, keeps the cursor, records the error, and unlocks', async () => {
    await link();
    let n = 0;
    const real = plaid.transactionsSync.bind(plaid);
    plaid.transactionsSync = async (...a) => {
      if (++n === 2) plaid.failNext('transactionsSync', 'INSTITUTION_DOWN');
      return real(...a);
    };
    const [r] = await run();
    expect(r).toMatchObject({ outcome: 'error', code: 'INSTITUTION_DOWN' });
    expect(await txns()).toEqual([]);
    const s = await state();
    expect([s.cursor, s.lastSyncError, s.lastSyncErrorAt, s.lockedUntil]).toEqual([
      null,
      'INSTITUTION_DOWN',
      T,
      null,
    ]);
    await run(); // the next run succeeds and clears both error fields
    const ok = await state();
    expect([ok.lastSyncError, ok.lastSyncErrorAt, ok.cursor]).toEqual([null, null, 'fx-cursor-2']);
  });

  it('restarts the whole batch on a mid-pagination mutation, and gives up after three', async () => {
    await link();
    plaid.failNext('transactionsSync', 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION');
    expect((await run())[0]!.outcome).toBe('ok');
    expect((await txns()).length).toBe(fixtureHistory(TODAY).length);
    patchState({ cursor: null });
    for (let i = 0; i < 4; i++)
      plaid.failNext('transactionsSync', 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION');
    expect((await run())[0]).toMatchObject({
      outcome: 'error',
      code: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION',
    });
  });

  it('replaying from a null cursor is harmless and keeps user fields', async () => {
    await link();
    await run();
    const before = await txns();
    const chip = before.find((t) => t.merchantName === 'Chipotle')!;
    await repo.casUpdate(
      repo.finTxnShape(chip.id),
      chip.id,
      (t) => ({ ...t, bucket: 'i_pay' as const, bucketSetBy: 'user' as const }),
      clock,
    );
    patchState({ cursor: null });
    await run();
    const after = await txns();
    expect(after.length).toBe(before.length);
    expect(after.find((t) => t.id === chip.id)!.bucket).toBe('i_pay');
  });

  it('a bucket set while the sync writes a modified row survives, and so does the rename', async () => {
    await link();
    await run(); // → fx-cursor-2; the next page modifies fx-card-2
    const current = (await repo.getFinanceTxn('fx-card-2'))!;
    doc.interceptNextPutIf(pk(U), sk.finTxn('fx-card-2'), () =>
      doc.putNow(
        financeTxnItem(U, {
          ...current,
          bucket: 'budget',
          bucketSetBy: 'user',
          updatedAt: current.updatedAt + 7,
        }),
      ),
    );
    await run();
    const row = (await repo.getFinanceTxn('fx-card-2'))!;
    expect(row.bucket).toBe('budget');
    expect(row.merchantName).toMatch(/Mexican Grill$/);
  });

  it('an edit to the pending row mid-sync carries onto its posted replacement', async () => {
    await link();
    await run();
    const pending = (await repo.getFinanceTxn('fx-pending-1'))!;
    doc.interceptNextPutIf(pk(U), sk.finTxn('fx-pending-1'), () =>
      doc.putNow(
        financeTxnItem(U, {
          ...pending,
          bucket: 'parents_pay',
          bucketSetBy: 'user',
          note: 'dinner',
          updatedAt: pending.updatedAt + 3,
        }),
      ),
    );
    await run();
    const posted = (await repo.getFinanceTxn('fx-posted-1'))!;
    expect([posted.bucket, posted.note]).toEqual(['parents_pay', 'dinner']);
    expect((await repo.getFinanceTxn('fx-pending-1'))!.deletedAt).not.toBeNull();
  });

  it('a held lock means no Plaid sync calls at all; an expired one is taken over', async () => {
    await link();
    patchState({ lockedUntil: T + 60_000 });
    expect((await run())[0]!.outcome).toBe('locked');
    expect(count('transactionsSync')).toBe(0);
    clock = T + 60_001;
    expect((await run())[0]!.outcome).toBe('ok');
  });

  it('two concurrent runs: exactly one proceeds', async () => {
    await link();
    const [a, b] = await Promise.all([run(), run()]);
    expect([a![0]!.outcome, b![0]!.outcome].sort()).toEqual(['locked', 'ok']);
  });

  it('a login error flags the item and records the error', async () => {
    await link();
    plaid.failNext('transactionsSync', 'ITEM_LOGIN_REQUIRED');
    await run();
    expect((await repo.getFinanceItem(FIXTURE_ITEM_ID))!.status).toBe('login_required');
    expect((await state()).lastSyncError).toBe('ITEM_LOGIN_REQUIRED');
  });

  it('one item erroring does not block another', async () => {
    await link('item-orphan'); // no token at Plaid → ITEM_NOT_FOUND
    await link();
    const out = await run();
    expect(out.find((o) => o.itemId === 'item-orphan')!.outcome).toBe('error');
    expect(out.find((o) => o.itemId === FIXTURE_ITEM_ID)!.outcome).toBe('ok');
  });
});

describe('runFinanceSync — the review findings', () => {
  it('A1: a refresh on two banks runs them in parallel and finishes inside the deadline', async () => {
    await link();
    plaid.addItem('item-2');
    await link('item-2');
    await run(); // settle the first sync
    plaid.refreshLandsAfter = null; // the refresh never confirms
    request(true, [FIXTURE_ITEM_ID, 'item-2']);
    const out = await run();
    expect(out.map((o) => o.outcome)).toEqual(['ok', 'ok']);
    expect(clock).toBeLessThanOrEqual(DEADLINE);
    for (const id of [FIXTURE_ITEM_ID, 'item-2']) {
      const s = await state(id);
      expect(s.lockedUntil).toBeNull();
      expect(s.lastSyncedAt).not.toBeNull();
    }
    // Interleaved health checks = the two polls ran side by side, not one after the other.
    const gets = plaid.calls.filter((c) => c.method === 'itemGet').map((c) => c.itemId);
    const firstOther = gets.indexOf('item-2');
    expect(gets.slice(firstOther).includes(FIXTURE_ITEM_ID)).toBe(true);
  });

  it('A1: a refresh stops polling once Plaid says it landed, even with no new rows', async () => {
    await link();
    await run();
    await run(); // past the update page: nothing new at Plaid
    plaid.refreshLandsAfter = 2;
    sleeps = 0;
    request(true);
    await run();
    expect(count('transactionsRefresh')).toBe(1);
    expect(sleeps).toBe(2);
  });

  it('A2: a request that lands between the rerun check and the unlock still gets a pass', async () => {
    await link();
    doc.interceptNextPutIf(
      ...stateKey(),
      () => patchState({ syncRequestedAt: T + 1 }),
      (item) => item.lockedUntil === null, // the finishing write
    );
    const [r] = await run();
    expect(r!.passes).toBe(2);
    const s = await state();
    expect(s.lastSyncedAt).toBeGreaterThanOrEqual(T + 1);
    expect(overviewSyncing(s)).toBe(false);
  });

  it('A3: a stale read of the lock does not turn a free lock into "held"', async () => {
    await link();
    const cur = doc.snapshot().find((i) => i.SK === sk.finSync(FIXTURE_ITEM_ID))!;
    doc.staleNextGets(...stateKey(), { ...cur, lockedUntil: T + 60_000 }, 5);
    expect((await run())[0]!.outcome).toBe('ok');
    const first = doc.gets.find((g) => g.key === `${pk(U)} ${sk.finSync(FIXTURE_ITEM_ID)}`)!;
    expect(first.consistent).toBe(true);
  });

  it('A4: a failed pass with a request behind it reruns — and succeeds', async () => {
    await link();
    const real = plaid.accountsGet.bind(plaid);
    let stamped = false;
    plaid.accountsGet = async (id) => {
      if (!stamped) {
        stamped = true;
        patchState({ syncRequestedAt: T + 1 });
        plaid.failNext('transactionsSync', 'INSTITUTION_DOWN');
      }
      return real(id);
    };
    const [r] = await run();
    expect(r).toMatchObject({ outcome: 'ok', passes: 2 });
    const s = await state();
    expect([s.lastSyncError, s.lastSyncErrorAt]).toEqual([null, null]);
    expect(s.lastSyncedAt).toBeGreaterThanOrEqual(T + 1);
  });

  it('A4: when it keeps failing, the error stamp covers the request so the popup can decide', async () => {
    await link();
    const real = plaid.accountsGet.bind(plaid);
    let stamped = false;
    plaid.accountsGet = async (id) => {
      if (!stamped) {
        stamped = true;
        patchState({ syncRequestedAt: T + 1 });
      }
      plaid.failNext('transactionsSync', 'INSTITUTION_DOWN');
      return real(id);
    };
    await run();
    const s = await state();
    expect(s.lastSyncError).toBe('INSTITUTION_DOWN');
    expect(s.lastSyncErrorAt).toBeGreaterThanOrEqual(T + 1);
    expect(overviewSyncing(s)).toBe(false);
  });

  it('A5: a scheduled run that grabs the lock first still does the requested refresh, once', async () => {
    await link();
    await run();
    request(true); // Refresh pressed at T
    clock = T + 50;
    const [sched, manual] = await Promise.all([run('scheduled'), run('manual')]);
    expect([sched![0]!.outcome, manual![0]!.outcome].sort()).toEqual(['locked', 'ok']);
    expect(count('transactionsRefresh')).toBe(1);
    expect((await state()).lastRefreshedAt).toBe(T + 50);
    await run('scheduled');
    expect(count('transactionsRefresh')).toBe(1); // no longer due
  });

  it('A6: right after a link, a not-ready Plaid is polled until the history arrives', async () => {
    await link();
    plaid.notReadyCalls = 2;
    const [r] = await run('post-link', FIXTURE_ITEM_ID);
    expect(r!.outcome).toBe('ok');
    expect(sleeps).toBe(2);
    expect((await txns()).length).toBe(fixtureHistory(TODAY).length);
    expect((await state()).cursor).toBe('fx-cursor-2');
  });

  it('A6: never ready → an error, not "synced with nothing"; scheduled runs don’t wait', async () => {
    await link();
    plaid.notReadyCalls = 10_000;
    const [r] = await run('post-link', FIXTURE_ITEM_ID);
    expect(r).toMatchObject({ outcome: 'error', code: 'PRODUCT_NOT_READY' });
    const s = await state();
    expect([s.cursor, s.lastSyncedAt, s.lastSyncError]).toEqual([null, null, 'PRODUCT_NOT_READY']);
    expect(clock).toBeLessThanOrEqual(DEADLINE);
    sleeps = 0;
    expect((await run('scheduled'))[0]).toMatchObject({ code: 'PRODUCT_NOT_READY' });
    expect(sleeps).toBe(0);
  });

  it('A7: a "new" row that exists by write time keeps the user edit and takes Plaid’s fields', async () => {
    await link();
    const plaidRow = fixtureHistory(TODAY).find((p) => p.transaction_id === 'fx-card-2')!;
    doc.interceptNextPutIf(pk(U), sk.finTxn('fx-card-2'), () =>
      doc.putNow(
        financeTxnItem(U, {
          id: 'fx-card-2',
          userId: U,
          createdAt: 1,
          updatedAt: 1,
          deletedAt: null,
          itemId: FIXTURE_ITEM_ID,
          accountId: plaidRow.account_id,
          date: plaidRow.date,
          authorizedDate: null,
          name: 'stale',
          merchantName: null,
          rawAmountCents: 1,
          isoCurrency: 'USD',
          pending: false,
          pendingTransactionId: null,
          pfcPrimary: null,
          pfcDetailed: null,
          paymentChannel: null,
          source: 'plaid',
          bucket: 'budget',
          bucketSetBy: 'user',
          periodOverride: null,
          note: null,
          refundOfId: null,
          startsPeriod: false,
        }),
      ),
    );
    await run();
    const txnGets = doc.gets.filter((g) => g.key.includes('fin#txn#')); // the sync's reads only
    const row = (await repo.getFinanceTxn('fx-card-2'))!;
    expect([row.bucket, row.rawAmountCents, row.name]).toEqual([
      'budget',
      Math.round(plaidRow.amount * 100),
      plaidRow.name,
    ]);
    expect(txnGets.length).toBeGreaterThan(0);
    expect(txnGets.every((g) => g.consistent)).toBe(true);
  });

  it('A10: removing the bank mid-sync is final — nothing revived, nothing stamped', async () => {
    await link();
    await run(); // accounts exist now
    const syncedBefore = (await state()).lastSyncedAt;
    const real = plaid.accountsGet.bind(plaid);
    plaid.accountsGet = async (id) => {
      const accounts = await real(id);
      // removePlaidItem, landing while the sync holds the lock
      for (const row of doc.snapshot())
        if (/^fin#(item|sync|acct)#/.test(row.SK))
          doc.putNow({
            ...row,
            deletedAt: clock,
            ...(row.SK.startsWith('fin#sync#') ? { lockedUntil: null } : {}),
            updatedAt: (row.updatedAt as number) + 1,
          } as Item);
      return accounts;
    };
    const [r] = await run();
    expect(r!.outcome).toBe('removed');
    expect(await repo.listFinanceAccounts()).toEqual([]);
    const s = (await repo.getFinanceSyncState(FIXTURE_ITEM_ID, { consistent: true }))!;
    expect([s.lastSyncedAt, s.lastSyncError]).toEqual([syncedBefore, null]);
    expect(count('transactionsSync')).toBe(2); // the first run's two pages; none after the removal
  });

  it('a run that lost its lock stops and writes nothing more', async () => {
    await link();
    await run();
    plaid.refreshLandsAfter = null;
    request(true);
    const realSleep = deps.sleep;
    let stolen = false;
    deps.sleep = async (ms) => {
      if (!stolen) {
        stolen = true;
        patchState({ lockedUntil: T + 999_999 }); // another run took over
      }
      return realSleep(ms);
    };
    const [r] = await run();
    expect(r).toMatchObject({ outcome: 'error', code: 'LOCK_LOST' });
    expect((await state()).lockedUntil).toBe(T + 999_999);
  });

  it('a slow Plaid never starts a step past the deadline', async () => {
    await link();
    deps.deadline = T + 60_000;
    const real = plaid.transactionsSync.bind(plaid);
    plaid.transactionsSync = async (...a) => {
      clock += 31_500; // every retry timed out
      return real(...a);
    };
    const [r] = await run();
    expect(r).toMatchObject({ outcome: 'error', code: 'TIMEOUT' });
    expect(clock).toBeLessThanOrEqual(deps.deadline);
    const s = await state();
    expect([s.cursor, s.lockedUntil, s.lastSyncErrorAt]).toEqual([null, null, T]);
    expect(await txns()).toEqual([]);
  });

  it('a caller deadline past the budget is capped, so a pass never outlives its lock', async () => {
    await link();
    deps.deadline = T + 900_000;
    plaid.notReadyCalls = 10_000;
    const real = plaid.transactionsSync.bind(plaid);
    plaid.transactionsSync = async (...a) => {
      clock += 5_000;
      return real(...a);
    };
    await run('post-link', FIXTURE_ITEM_ID);
    expect(clock).toBeLessThanOrEqual(T + RUN_BUDGET_MS);
  });

  it('never runs more than MAX_PASSES, even with requests arriving every pass', async () => {
    await link();
    const real = plaid.accountsGet.bind(plaid);
    let n = 0;
    plaid.accountsGet = async (id) => {
      patchState({ syncRequestedAt: T + ++n * 1000 });
      return real(id);
    };
    const [r] = await run();
    expect(r!.passes).toBe(MAX_PASSES);
    // The request it couldn't serve is covered, not dropped: syncing clears and the page can say so.
    const s = await state();
    expect(s.lastSyncError).toBe('SYNC_DEFERRED');
    expect(s.lastSyncErrorAt).toBe(s.syncRequestedAt);
    expect(s.lockedUntil).toBeNull();
    expect(overviewSyncing(s)).toBe(false);
  });

  it('a request with no time left for a rerun is covered as SYNC_DEFERRED', async () => {
    await link();
    deps.deadline = T + 100_000; // room for the pass, not for a rerun after it
    const real = plaid.accountsGet.bind(plaid);
    plaid.accountsGet = async (id) => {
      clock += 40_000;
      patchState({ syncRequestedAt: clock });
      return real(id);
    };
    const [r] = await run();
    expect(r!.passes).toBe(1);
    const s = await state();
    expect([s.lastSyncError, s.lastSyncErrorAt, s.lastSyncedAt]).toEqual([
      'SYNC_DEFERRED',
      T + 40_000,
      T,
    ]);
    expect(overviewSyncing(s)).toBe(false);
  });
});

describe('accounts + health', () => {
  it('upsert keeps flip/hide, revives a returning account, drops a missing one, ignores an empty list', async () => {
    await link();
    await run();
    const card = FIXTURE_ACCOUNT_IDS.card;
    await repo.casUpdate(
      repo.finAcctShape(card),
      card,
      (a) => ({ ...a, signOverride: 'flip' as const, hidden: true }),
      clock,
    );
    const all = await plaid.accountsGet(FIXTURE_ITEM_ID);
    await upsertAccounts(
      repo,
      U,
      FIXTURE_ITEM_ID,
      all.filter((a) => a.account_id !== FIXTURE_ACCOUNT_IDS.savings),
      clock,
    );
    expect((await repo.listFinanceAccounts()).map((a) => a.id)).not.toContain(
      FIXTURE_ACCOUNT_IDS.savings,
    );
    await upsertAccounts(repo, U, FIXTURE_ITEM_ID, [], clock);
    expect(await repo.listFinanceAccounts()).toHaveLength(2);
    await upsertAccounts(repo, U, FIXTURE_ITEM_ID, all, clock);
    const accounts = await repo.listFinanceAccounts();
    expect(accounts).toHaveLength(3);
    expect(accounts.find((a) => a.id === card)).toMatchObject({
      signOverride: 'flip',
      hidden: true,
    });
  });

  it('maps item health to a status', () => {
    const h = {
      errorCode: null,
      consentExpiresAt: null,
      consentedProducts: [],
      lastSuccessfulUpdateAt: null,
      lastFailedUpdateAt: null,
    };
    expect(itemStatus(h, T)).toBe('ok');
    expect(itemStatus({ ...h, errorCode: 'ITEM_LOGIN_REQUIRED' }, T)).toBe('login_required');
    expect(itemStatus({ ...h, errorCode: 'INSTITUTION_DOWN' }, T)).toBe('error');
    expect(itemStatus({ ...h, consentExpiresAt: T + 6 * 86_400_000 }, T)).toBe(
      'pending_disconnect',
    );
    expect(itemStatus({ ...h, consentExpiresAt: T + 30 * 86_400_000 }, T)).toBe('ok');
  });
});
