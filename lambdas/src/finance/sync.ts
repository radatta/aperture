import {
  FINANCE_REFRESH_POLL_MAX_MS,
  FINANCE_REFRESH_POLL_MS,
  FINANCE_SYNC_LOCK_MS,
  reconcileSyncPage,
  referencedTxnIds,
  SYNC_PAGE_COUNT,
  toCents,
} from '@aperture/shared';
import type {
  FinanceAccount,
  FinanceItem,
  FinanceItemStatus,
  FinanceSyncState,
  FinanceTransaction,
  PlaidAccount,
  PlaidSyncResponse,
} from '@aperture/shared';
import type { Repo } from '../ddb/repo';
import { ConflictError } from '../ddb/repo';
import { PlaidApiError } from '../plaid/gateway';
import type { PlaidGateway, PlaidItemHealth } from '../plaid/gateway';

// The finance sync — one run per invoke (scheduled 4×/day, or after Refresh / connect / reconnect).
// Per item, under a lock:
//   1. accounts + item health first (a transaction never names an account the table lacks);
//   2. refresh at Plaid if asked (then poll: new data lands seconds to a minute later);
//   3. gather EVERY /transactions/sync page, reconcile them all, write, and only then save the cursor
//      — a failure anywhere writes nothing and the cursor stays put, so the next run replays safely;
//   4. rerun flag: if a sync was requested after this pass started, run one more pass before unlocking
//      (the request's own invoke found the lock held and exited), so no request is ever dropped.
// User fields are never overwritten: existing rows are written with casUpdate, merging the reconciled
// Plaid fields over the FRESH row's user fields.
//
// Stamps: `lastSyncedAt` / `lastSyncErrorAt` are the START time of the pass that set them, so a
// request stamped mid-pass stays newer and the overview keeps reading `syncing` until the rerun.

export type FinanceSyncMode = 'scheduled' | 'manual' | 'post-link';
export interface FinanceSyncEvent {
  userId: string;
  mode: FinanceSyncMode;
  itemId?: string; // one item (post-link); otherwise every alive item
  refresh?: boolean; // ask Plaid to re-pull from the bank first (Refresh button)
}

export interface SyncDeps {
  repo: Repo;
  plaid: PlaidGateway;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  userId: string;
}

export interface ItemSyncReport {
  itemId: string;
  outcome: 'ok' | 'locked' | 'error';
  code?: string;
  passes: number;
  written: number;
}

// The user-owned transaction fields a sync must never overwrite (see FinanceTransaction).
export const USER_TXN_FIELDS = [
  'bucket',
  'bucketSetBy',
  'periodOverride',
  'note',
  'refundOfId',
  'startsPeriod',
] as const satisfies readonly (keyof FinanceTransaction)[];
type UserFields = Pick<FinanceTransaction, (typeof USER_TXN_FIELDS)[number]>;
const pickUser = (t: FinanceTransaction): UserFields => ({
  bucket: t.bucket,
  bucketSetBy: t.bucketSetBy,
  periodOverride: t.periodOverride,
  note: t.note,
  refundOfId: t.refundOfId,
  startsPeriod: t.startsPeriod,
});
const sameUser = (a: UserFields, b: UserFields) => USER_TXN_FIELDS.every((k) => a[k] === b[k]);

export const MAX_PASSES = 3; // the first pass + up to two reruns for requests that landed mid-run
const MUTATION_RESTARTS = 3;
const PENDING_DISCONNECT_MS = 7 * 24 * 60 * 60_000;

const codeOf = (err: unknown): string =>
  err instanceof PlaidApiError
    ? err.code
    : err instanceof ConflictError
      ? err.code
      : err instanceof Error && err.message.startsWith('Not found')
        ? 'NOT_FOUND'
        : 'INTERNAL_ERROR';

export async function runFinanceSync(
  deps: SyncDeps,
  e: FinanceSyncEvent,
): Promise<ItemSyncReport[]> {
  const items = e.itemId
    ? [await deps.repo.getFinanceItem(e.itemId)].filter(
        (i): i is FinanceItem => i !== null && i.deletedAt === null,
      )
    : await deps.repo.listFinanceItems();
  const out: ItemSyncReport[] = [];
  // One item's failure never blocks another.
  for (const item of items) out.push(await syncItem(deps, item.id, e.refresh === true));
  return out;
}

async function syncItem(
  deps: SyncDeps,
  itemId: string,
  refreshFirst: boolean,
): Promise<ItemSyncReport> {
  const { repo, now } = deps;
  const report: ItemSyncReport = { itemId, outcome: 'ok', passes: 0, written: 0 };
  const shape = repo.finSyncShape(itemId);
  const blank = (t: number): FinanceSyncState => ({
    id: itemId,
    userId: deps.userId,
    createdAt: t,
    updatedAt: t,
    deletedAt: null,
    itemId,
    cursor: null,
    lastSyncedAt: null,
    lastSyncError: null,
    lastSyncErrorAt: null,
    syncRequestedAt: null,
    refreshRequestedAt: null,
    lastRefreshedAt: null,
    lockedUntil: null,
  });

  // Lock: atomic, because casUpdate is compare-and-set. Held → exit (the holder's rerun covers us).
  let passStart = now();
  let acquired = false;
  const lock = repo.casUpdate(
    shape,
    itemId,
    (fresh) => {
      acquired = !(fresh.lockedUntil !== null && fresh.lockedUntil > passStart);
      return acquired ? { ...fresh, lockedUntil: passStart + FINANCE_SYNC_LOCK_MS } : null;
    },
    passStart,
    {
      create: () => {
        acquired = true;
        return { ...blank(passStart), lockedUntil: passStart + FINANCE_SYNC_LOCK_MS };
      },
    },
  );
  try {
    await lock;
  } catch (err) {
    // Couldn't even take the lock (a write conflict storm, a missing row): report, touch nothing.
    return { ...report, outcome: 'error', code: codeOf(err) };
  }
  if (!acquired) return { ...report, outcome: 'locked' };

  let refresh = refreshFirst;
  try {
    for (;;) {
      report.passes++;
      await refreshAccountsAndHealth(deps, itemId, passStart);
      let refreshed = false;
      if (refresh) {
        try {
          await deps.plaid.transactionsRefresh(itemId);
          refreshed = true;
        } catch (err) {
          // A refused refresh still leaves a normal sync worth running; log it, don't fail the pass.
          console.log(
            JSON.stringify({ event: 'finance_refresh_failed', itemId, code: codeOf(err) }),
          );
        }
      }
      let written = await syncPass(deps, itemId, passStart);
      if (refreshed) {
        // Refreshed data lands later: poll until something arrives, the window closes, or a fixed
        // number of tries (so a frozen test clock can't loop forever).
        const until = passStart + FINANCE_REFRESH_POLL_MAX_MS;
        const tries = Math.ceil(FINANCE_REFRESH_POLL_MAX_MS / FINANCE_REFRESH_POLL_MS);
        for (let i = 0; written === 0 && i < tries && now() < until; i++) {
          await deps.sleep(FINANCE_REFRESH_POLL_MS);
          await renewLock(deps, itemId);
          written = await syncPass(deps, itemId, passStart);
        }
      }
      report.written += written;
      // Rerun flag: a request newer than this pass's start means someone asked mid-run.
      const state = await repo.getFinanceSyncState(itemId);
      const asked = state?.syncRequestedAt ?? 0;
      if (report.passes < MAX_PASSES && asked > passStart) {
        refresh = (state?.refreshRequestedAt ?? 0) > passStart;
        passStart = Math.max(now(), asked);
        await renewLock(deps, itemId);
        continue;
      }
      break;
    }
    await repo.casUpdate(
      shape,
      itemId,
      (fresh) => ({
        ...fresh,
        lastSyncedAt: passStart,
        lastSyncError: null,
        lastSyncErrorAt: null,
        lockedUntil: null,
      }),
      now(),
    );
  } catch (err) {
    const code = codeOf(err);
    report.outcome = 'error';
    report.code = code;
    console.log(JSON.stringify({ event: 'finance_sync_failed', itemId, code }));
    if (code === 'ITEM_LOGIN_REQUIRED')
      await repo
        .casUpdate(
          repo.finItemShape(itemId),
          itemId,
          (fresh) => ({ ...fresh, status: 'login_required' as const, errorCode: code }),
          now(),
        )
        .catch(() => {});
    // If even this write loses, the lock simply expires (FINANCE_SYNC_LOCK_MS) — never throw past here.
    await repo
      .casUpdate(
        shape,
        itemId,
        (fresh) => ({
          ...fresh,
          lastSyncError: code,
          lastSyncErrorAt: passStart,
          lockedUntil: null,
        }),
        now(),
      )
      .catch((e: unknown) =>
        console.log(
          JSON.stringify({ event: 'finance_sync_unlock_failed', itemId, code: codeOf(e) }),
        ),
      );
  }
  return report;
}

async function renewLock(deps: SyncDeps, itemId: string): Promise<void> {
  const t = deps.now();
  await deps.repo.casUpdate(
    deps.repo.finSyncShape(itemId),
    itemId,
    (fresh) => ({ ...fresh, lockedUntil: t + FINANCE_SYNC_LOCK_MS }),
    t,
  );
}

// One pass: every page from the saved cursor, reconciled together, written, then the cursor. Returns
// how many rows it wrote (0 = nothing new at Plaid).
async function syncPass(deps: SyncDeps, itemId: string, passStart: number): Promise<number> {
  const { repo, plaid } = deps;
  const state = await repo.getFinanceSyncState(itemId);
  const saved = state?.cursor ?? null;
  const pages = await gatherPages(plaid, itemId, saved);
  if (pages === null) return 0; // not ready yet at Plaid

  const ids = [...new Set(pages.flatMap((p) => referencedTxnIds(p)))];
  const existing = ids.length
    ? await repo.getFinanceTxns(ids)
    : new Map<string, FinanceTransaction>();
  const snapshot = new Map(existing);
  const rules = await repo.listFinanceRules();
  const touched = new Map<string, FinanceTransaction>();
  for (const page of pages)
    for (const row of reconcileSyncPage({
      existing,
      page,
      rules,
      now: passStart,
      itemId,
      userId: deps.userId,
    }))
      touched.set(row.id, row);

  // Existing rows: Plaid fields from the reconcile, user fields from the fresh row.
  const freshUser = new Map<string, UserFields>();
  const updates = [...touched.values()].filter((t) => snapshot.has(t.id));
  await repo.casMany(updates, (row) =>
    repo.casUpdate(
      repo.finTxnShape(row.id),
      row.id,
      (fresh) => {
        freshUser.set(row.id, pickUser(fresh));
        return { ...row, ...pickUser(fresh), createdAt: fresh.createdAt };
      },
      deps.now(),
      { allowDeleted: true },
    ),
  );
  // New rows. One carried from a pending row that the user edited mid-sync takes the fresh edit.
  const inserts = [...touched.values()]
    .filter((t) => !snapshot.has(t.id))
    .map((row) => {
      const p = row.pendingTransactionId;
      const before = p ? snapshot.get(p) : undefined;
      const after = p ? freshUser.get(p) : undefined;
      return before && after && !sameUser(pickUser(before), after) ? { ...row, ...after } : row;
    });
  await repo.insertFinanceTxns(inserts);

  const next = pages.at(-1)!.next_cursor;
  if (next && next !== saved)
    await repo.casUpdate(
      repo.finSyncShape(itemId),
      itemId,
      (fresh) => ({ ...fresh, cursor: next }),
      deps.now(),
    );
  return touched.size;
}

// All pages from `cursor` until has_more=false. Plaid can change data mid-pagination — then the whole
// batch restarts from the SAVED cursor. Not ready yet (a fresh link) → null: nothing to apply.
async function gatherPages(
  plaid: PlaidGateway,
  itemId: string,
  cursor: string | null,
): Promise<PlaidSyncResponse[] | null> {
  for (let attempt = 0; attempt <= MUTATION_RESTARTS; attempt++) {
    const pages: PlaidSyncResponse[] = [];
    let c = cursor;
    try {
      for (;;) {
        const page = await plaid.transactionsSync(itemId, c, SYNC_PAGE_COUNT);
        pages.push(page);
        c = page.next_cursor || c;
        if (!page.has_more) return pages;
      }
    } catch (err) {
      if (err instanceof PlaidApiError && err.code === 'PRODUCT_NOT_READY') return null;
      if (
        err instanceof PlaidApiError &&
        err.code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION'
      )
        continue;
      throw err;
    }
  }
  throw new PlaidApiError('TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION');
}

async function refreshAccountsAndHealth(deps: SyncDeps, itemId: string, t: number): Promise<void> {
  const [accounts, health] = await Promise.all([
    deps.plaid.accountsGet(itemId),
    deps.plaid.itemGet(itemId),
  ]);
  await upsertAccounts(deps.repo, deps.userId, itemId, accounts, t);
  await applyItemHealth(deps.repo, itemId, health, t);
}

// Plaid owns the account fields; the user owns signOverride + hidden. A returning account revives
// with its settings; one missing from the response is tombstoned — except when the response is empty
// (a hiccup must not wipe the roster).
export async function upsertAccounts(
  repo: Repo,
  userId: string,
  itemId: string,
  accounts: PlaidAccount[],
  t: number,
): Promise<void> {
  if (accounts.length === 0) return;
  const plaidFields = (a: PlaidAccount) => ({
    itemId,
    name: a.name,
    officialName: a.official_name,
    mask: a.mask,
    type: a.type,
    subtype: a.subtype,
    isoCurrency: a.balances.iso_currency_code,
    currentCents: a.balances.current === null ? null : toCents(a.balances.current),
    availableCents: a.balances.available === null ? null : toCents(a.balances.available),
    balanceAt: t,
  });
  await repo.casMany(accounts, (a) =>
    repo.casUpdate(
      repo.finAcctShape(a.account_id),
      a.account_id,
      (fresh) => ({ ...fresh, ...plaidFields(a), deletedAt: null }),
      t,
      {
        allowDeleted: true,
        create: (): FinanceAccount => ({
          id: a.account_id,
          userId,
          createdAt: t,
          updatedAt: t,
          deletedAt: null,
          ...plaidFields(a),
          signOverride: 'auto',
          hidden: false,
        }),
      },
    ),
  );
  const present = new Set(accounts.map((a) => a.account_id));
  const dropped = (await repo.listFinanceAccounts()).filter(
    (a) => a.itemId === itemId && !present.has(a.id),
  );
  await repo.casMany(dropped, (a) =>
    repo.casUpdate(repo.finAcctShape(a.id), a.id, (fresh) => ({ ...fresh, deletedAt: t }), t),
  );
}

export function itemStatus(health: PlaidItemHealth, t: number): FinanceItemStatus {
  if (health.errorCode === 'ITEM_LOGIN_REQUIRED') return 'login_required';
  if (health.errorCode) return 'error';
  if (health.consentExpiresAt !== null && health.consentExpiresAt - t <= PENDING_DISCONNECT_MS)
    return 'pending_disconnect';
  return 'ok';
}

export async function applyItemHealth(
  repo: Repo,
  itemId: string,
  health: PlaidItemHealth,
  t: number,
): Promise<void> {
  await repo.casUpdate(
    repo.finItemShape(itemId),
    itemId,
    (fresh) => ({
      ...fresh,
      status: itemStatus(health, t),
      errorCode: health.errorCode,
      consentExpiresAt: health.consentExpiresAt,
      consentedProducts: health.consentedProducts.length
        ? health.consentedProducts
        : fresh.consentedProducts,
      lastSuccessfulUpdateAt: health.lastSuccessfulUpdateAt,
      lastFailedUpdateAt: health.lastFailedUpdateAt,
    }),
    t,
  );
}
