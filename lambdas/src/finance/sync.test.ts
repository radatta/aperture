import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildFinanceOverview,
  FINANCE_REFRESH_POLL_MAX_MS,
  FINANCE_REFRESH_POLL_MS,
  FIXTURE_ACCOUNT_IDS,
  FIXTURE_ITEM_ID,
  fixtureHistory,
} from '@aperture/shared';
import type { FinanceItem, FinanceSyncState } from '@aperture/shared';
import { InMemoryDoc } from '../ddb/DocClient';
import { pk, sk } from '../ddb/keys';
import { entityItem, financeTxnItem } from '../ddb/mapping';
import { Repo } from '../ddb/repo';
import { liveWrites } from '../ddb/writes';
import { InMemoryPlaid } from '../plaid/gateway';
import { itemStatus, runFinanceSync, upsertAccounts } from './sync';
import type { SyncDeps } from './sync';

const U = 'u1';
const TODAY = '2026-09-26';
const T = 1_790_000_000_000;

let doc: InMemoryDoc;
let repo: Repo;
let plaid: InMemoryPlaid;
let clock: number;
let sleeps: number;
let deps: SyncDeps;

async function link(itemId = FIXTURE_ITEM_ID): Promise<void> {
  if (itemId === FIXTURE_ITEM_ID) await plaid.exchangePublicToken('pub');
  const item: FinanceItem = {
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
  };
  await doc.put(entityItem(U, sk.finItem(itemId), item));
  const state: FinanceSyncState = {
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
  };
  await doc.put(entityItem(U, sk.finSync(itemId), state));
}

const state = async (itemId = FIXTURE_ITEM_ID) => (await repo.getFinanceSyncState(itemId))!;
const txns = () => repo.listAllFinanceTxns();
const sync = (refresh = false) => runFinanceSync(deps, { userId: U, mode: 'manual', refresh });
const syncCalls = () => plaid.calls.filter((c) => c.method === 'transactionsSync').length;

beforeEach(() => {
  doc = new InMemoryDoc();
  repo = new Repo(doc, liveWrites(doc), U);
  plaid = new InMemoryPlaid({ today: () => TODAY });
  clock = T;
  sleeps = 0;
  deps = {
    repo,
    plaid,
    now: () => clock,
    sleep: async () => void sleeps++,
    userId: U,
  };
});

describe('runFinanceSync', () => {
  it('first sync: accounts, every page, cursor last, stamps the pass start', async () => {
    await link();
    clock = T + 5;
    const [r] = await sync();
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
    const [r] = await sync();
    expect(r).toMatchObject({ outcome: 'error', code: 'INSTITUTION_DOWN' });
    expect(await txns()).toEqual([]);
    const s = await state();
    expect([s.cursor, s.lastSyncError, s.lastSyncErrorAt, s.lockedUntil]).toEqual([
      null,
      'INSTITUTION_DOWN',
      T,
      null,
    ]);
    // The next run succeeds and clears both error fields.
    await sync();
    const ok = await state();
    expect([ok.lastSyncError, ok.lastSyncErrorAt, ok.cursor]).toEqual([null, null, 'fx-cursor-2']);
  });

  it('restarts the whole batch on a mid-pagination mutation, and gives up after three', async () => {
    await link();
    plaid.failNext('transactionsSync', 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION');
    const [r] = await sync();
    expect(r!.outcome).toBe('ok');
    expect((await txns()).length).toBe(fixtureHistory(TODAY).length);

    const fresh = new Repo(doc, liveWrites(doc), U);
    await doc.put(entityItem(U, sk.finSync(FIXTURE_ITEM_ID), { ...(await state()), cursor: null }));
    for (let i = 0; i < 4; i++)
      plaid.failNext('transactionsSync', 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION');
    const [r2] = await runFinanceSync({ ...deps, repo: fresh }, { userId: U, mode: 'manual' });
    expect(r2).toMatchObject({
      outcome: 'error',
      code: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION',
    });
  });

  it('replaying from a null cursor is harmless and keeps user fields', async () => {
    await link();
    await sync();
    const before = await txns();
    const chip = before.find((t) => t.merchantName === 'Chipotle')!;
    await repo.casUpdate(
      repo.finTxnShape(chip.id),
      chip.id,
      (t) => ({ ...t, bucket: 'i_pay' as const, bucketSetBy: 'user' as const }),
      clock,
    );
    await doc.put(entityItem(U, sk.finSync(FIXTURE_ITEM_ID), { ...(await state()), cursor: null }));
    await sync();
    const after = await txns();
    expect(after.length).toBe(before.length);
    expect(after.find((t) => t.id === chip.id)!.bucket).toBe('i_pay');
  });

  it('a bucket set while the sync writes a modified row survives, and so does the rename', async () => {
    await link();
    await sync(); // → fx-cursor-2; the next page modifies fx-card-2
    // The "user" write lands between the sync's read and its conditional put.
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
    await sync();
    const row = (await repo.getFinanceTxn('fx-card-2'))!;
    expect(row.bucket).toBe('budget');
    expect(row.merchantName).toMatch(/Mexican Grill$/);
  });

  it('an edit to the pending row mid-sync carries onto its posted replacement', async () => {
    await link();
    await sync();
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
    await sync();
    const posted = (await repo.getFinanceTxn('fx-posted-1'))!;
    expect([posted.bucket, posted.note]).toEqual(['parents_pay', 'dinner']);
    expect((await repo.getFinanceTxn('fx-pending-1'))!.deletedAt).not.toBeNull();
  });

  it('a held lock means no Plaid sync calls at all', async () => {
    await link();
    await doc.put(
      entityItem(U, sk.finSync(FIXTURE_ITEM_ID), { ...(await state()), lockedUntil: T + 60_000 }),
    );
    const [r] = await sync();
    expect(r!.outcome).toBe('locked');
    expect(syncCalls()).toBe(0);
    clock = T + 60_001; // an expired lock (a crashed run) is taken over
    expect((await sync())[0]!.outcome).toBe('ok');
  });

  it('two concurrent runs: exactly one proceeds', async () => {
    await link();
    const [a, b] = await Promise.all([sync(), sync()]);
    expect([a![0]!.outcome, b![0]!.outcome].sort()).toEqual(['locked', 'ok']);
  });

  it('rerun flag: a request stamped mid-pass gets a second pass, and the overview stays syncing until then', async () => {
    await link();
    // Stamp a request (as requestFinanceSync would) while the first pass writes its new rows.
    const realInsert = repo.insertFinanceTxns.bind(repo);
    let stamped = false;
    repo.insertFinanceTxns = async (rows) => {
      if (!stamped) {
        stamped = true;
        const s = await state();
        doc.putNow(
          entityItem(U, sk.finSync(FIXTURE_ITEM_ID), {
            ...s,
            syncRequestedAt: T + 1,
            updatedAt: s.updatedAt + 1,
          }),
        );
      }
      return realInsert(rows);
    };
    const [r] = await sync();
    expect(r!.passes).toBe(2);
    const s = await state();
    expect(s.lastSyncedAt).toBeGreaterThanOrEqual(T + 1);
    expect(overviewSyncing(s)).toBe(false);
  });

  it('a first pass that fails with a request stamped mid-pass still reads as syncing', async () => {
    await link();
    const realGet = plaid.accountsGet.bind(plaid);
    plaid.accountsGet = async (id) => {
      const s = await state();
      doc.putNow(
        entityItem(U, sk.finSync(FIXTURE_ITEM_ID), {
          ...s,
          syncRequestedAt: T + 1,
          updatedAt: s.updatedAt + 1,
        }),
      );
      plaid.failNext('transactionsSync', 'INSTITUTION_DOWN');
      return realGet(id);
    };
    await sync();
    const s = await state();
    expect(s.lastSyncErrorAt).toBe(T); // the pass start, not its end
    expect(overviewSyncing(s)).toBe(true);
  });

  it('a login error marks the item and records the error', async () => {
    await link();
    plaid.failNext('transactionsSync', 'ITEM_LOGIN_REQUIRED');
    await sync();
    expect((await repo.getFinanceItem(FIXTURE_ITEM_ID))!.status).toBe('login_required');
    expect((await state()).lastSyncError).toBe('ITEM_LOGIN_REQUIRED');
  });

  it('refresh: stops polling once data lands; with nothing new, polls to the cap', async () => {
    await link();
    await sync(); // → fx-cursor-2; the next page has the posted Sweetgreen
    await sync(true);
    expect(plaid.calls.some((c) => c.method === 'transactionsRefresh')).toBe(true);
    expect(sleeps).toBe(0);
    await sync(true); // nothing new past fx-cursor-3
    expect(sleeps).toBe(Math.ceil(FINANCE_REFRESH_POLL_MAX_MS / FINANCE_REFRESH_POLL_MS));
  });

  it('a failed refresh still runs a normal sync', async () => {
    await link();
    plaid.failNext('transactionsRefresh', 'PRODUCT_NOT_SUPPORTED');
    const [r] = await sync(true);
    expect(r!.outcome).toBe('ok');
    expect((await txns()).length).toBeGreaterThan(0);
  });

  it('one item erroring does not block another', async () => {
    await link('item-orphan'); // no token at Plaid → ITEM_NOT_FOUND
    await link();
    const out = await sync();
    expect(out.find((o) => o.itemId === 'item-orphan')!.outcome).toBe('error');
    expect(out.find((o) => o.itemId === FIXTURE_ITEM_ID)!.outcome).toBe('ok');
  });
});

describe('accounts + health', () => {
  it('upsert keeps flip/hide, revives a returning account, drops a missing one, ignores an empty list', async () => {
    await link();
    await sync();
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
