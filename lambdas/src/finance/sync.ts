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
import { mapLimit } from '../util/mapLimit';
import { PLAID_CALL_MAX_MS, PlaidApiError } from '../plaid/gateway';
import type { PlaidGateway, PlaidItemHealth } from '../plaid/gateway';

// The finance sync — one run per invoke (scheduled 3×/day, or after Refresh / connect / reconnect).
// Items run in parallel (each has its own lock; Plaid's limits are per item), all inside one deadline.
// Per item, under the lock:
//   1. accounts + item health first (a transaction never names an account the table lacks);
//   2. refresh at Plaid if one is DUE (refreshRequestedAt > lastRefreshedAt — stored state, so whichever
//      run holds the lock does it), then poll /item/get until Plaid says the refresh landed;
//   3. gather EVERY /transactions/sync page, reconcile them all, write, and only then save the cursor
//      — a failure anywhere leaves the cursor put, so the next run replays safely;
//   4. finish in ONE conditional write on the sync state: if a sync was requested after this pass
//      started (its own invoke found the lock held and exited), renew and run another pass — on
//      success and on failure alike; otherwise stamp the result and unlock. Because the check and the
//      unlock are one compare-and-set, a request can't slip between them.
// User fields are never overwritten: existing rows are written with casUpdate, merging the reconciled
// Plaid fields over the FRESH row's user fields; "new" rows are inserted only if absent.
//
// Stamps (the overview's `syncing` contract): `lastSyncedAt` / `lastSyncErrorAt` are the START time of
// the pass that set them, and a rerun starts at max(now, the request) — so a request always ends up
// covered by a stamp at least as new, and `syncing` (request > max(stamps)) clears exactly then. The
// one exception to "pass start": a request the run had to leave unserved (MAX_PASSES reached, or no
// time left for a rerun) gets `lastSyncErrorAt` = that request, as SYNC_DEFERRED — never dropped.
//
// The lock: `lockedUntil`'s value doubles as the holder's token. Renewing and finishing check it, so a
// run that lost its lock (expired, taken over, or the bank was removed) writes nothing more.

export type FinanceSyncMode = 'scheduled' | 'manual' | 'post-link';
export interface FinanceSyncEvent {
  userId: string;
  mode: FinanceSyncMode;
  itemId?: string; // one item (post-link); otherwise every alive item
}

export interface SyncDeps {
  repo: Repo;
  plaid: PlaidGateway;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  userId: string;
  deadline?: number; // absolute ms the whole run must finish by (the Lambda's remaining time)
}

export interface ItemSyncReport {
  itemId: string;
  outcome: 'ok' | 'locked' | 'removed' | 'error';
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
  'splits',
  'refundParts',
] as const satisfies readonly (keyof FinanceTransaction)[];
type UserFields = Pick<FinanceTransaction, (typeof USER_TXN_FIELDS)[number]>;
const pickUser = (t: FinanceTransaction): UserFields => ({
  bucket: t.bucket,
  bucketSetBy: t.bucketSetBy,
  periodOverride: t.periodOverride,
  note: t.note,
  refundOfId: t.refundOfId,
  startsPeriod: t.startsPeriod,
  splits: t.splits,
  refundParts: t.refundParts,
});
// Structural: splits and refundParts are arrays, read fresh each time.
const sameUser = (a: UserFields, b: UserFields) =>
  USER_TXN_FIELDS.every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));

export const MAX_PASSES = 3; // the first pass + up to two reruns for requests that landed mid-run
export const RUN_BUDGET_MS = 290_000; // default deadline when the caller gives none
// No step (one Plaid call and the DynamoDB work around it) starts unless it can finish by the deadline
// at its worst: every retry timing out. So a slow Plaid ends the run with TIMEOUT, not a killed Lambda
// still holding the lock.
export const STEP_MAX_MS = PLAID_CALL_MAX_MS + 3_500;
export const PASS_RESERVE_MS = 2 * STEP_MAX_MS; // what starting a rerun or a refresh must leave room for
const MUTATION_RESTARTS = 3;
const PENDING_DISCONNECT_MS = 7 * 24 * 60 * 60_000;
const POLL_TRIES = Math.ceil(FINANCE_REFRESH_POLL_MAX_MS / FINANCE_REFRESH_POLL_MS);

class LockLostError extends Error {
  constructor() {
    super('The sync lock was lost');
    this.name = 'LockLostError';
  }
}
class RemovedError extends Error {}
class DeadlineError extends Error {}

function guard(ctx: Ctx, itemId: string, step: string): void {
  if (ctx.now() + STEP_MAX_MS <= ctx.deadline) return;
  console.log(JSON.stringify({ event: 'finance_sync_out_of_time', itemId, step }));
  throw new DeadlineError();
}

const codeOf = (err: unknown): string =>
  err instanceof PlaidApiError
    ? err.code
    : err instanceof ConflictError
      ? err.code
      : err instanceof LockLostError
        ? 'LOCK_LOST'
        : err instanceof DeadlineError
          ? 'TIMEOUT'
          : err instanceof Error && err.message.startsWith('Not found')
            ? 'NOT_FOUND'
            : 'INTERNAL_ERROR';

const refreshDue = (s: FinanceSyncState) => (s.refreshRequestedAt ?? 0) > (s.lastRefreshedAt ?? 0);

interface Ctx extends SyncDeps {
  deadline: number;
}

export async function runFinanceSync(
  deps: SyncDeps,
  e: FinanceSyncEvent,
): Promise<ItemSyncReport[]> {
  // Never past the budget, which is under the lock's length: a pass can't outlive its own lock.
  const ctx: Ctx = {
    ...deps,
    deadline: Math.min(deps.deadline ?? Infinity, deps.now() + RUN_BUDGET_MS),
  };
  const items = e.itemId
    ? [await deps.repo.getFinanceItem(e.itemId, { consistent: true })].filter(
        (i): i is FinanceItem => i !== null && i.deletedAt === null,
      )
    : await deps.repo.listFinanceItems();
  // In parallel, and one item's failure never blocks another.
  return Promise.all(
    items.map((item) =>
      syncItem(ctx, item.id, e.mode).catch((err: unknown): ItemSyncReport => ({
        itemId: item.id,
        outcome: 'error',
        code: codeOf(err),
        passes: 0,
        written: 0,
      })),
    ),
  );
}

async function syncItem(ctx: Ctx, itemId: string, mode: FinanceSyncMode): Promise<ItemSyncReport> {
  const { repo, now } = ctx;
  const report: ItemSyncReport = { itemId, outcome: 'ok', passes: 0, written: 0 };
  const shape = repo.finSyncShape(itemId);
  // Room to claim a refresh: its poll plus this pass plus one rerun must still fit.
  const roomForRefresh = (t: number) =>
    t + 2 * PASS_RESERVE_MS + FINANCE_REFRESH_POLL_MS <= ctx.deadline;

  // 1. Acquire — a consistent read (a stale "held" would drop the request), atomic via the CAS.
  //    Every fn below ASSIGNS all its outputs: casUpdate may run it more than once.
  const t = now();
  let acquired = false;
  let removed = false;
  let claim = false;
  // The refresh claim: lastRefreshedAt before it (to give it back if the call never goes out) and the
  // value it wrote — at least the request, so a request stamped ahead of this clock isn't due again.
  const claimed = { prev: null as number | null, at: 0 };
  const taken = await repo.casUpdate(
    shape,
    itemId,
    (fresh) => {
      removed = fresh.deletedAt !== null;
      acquired = !removed && !(fresh.lockedUntil !== null && fresh.lockedUntil > t);
      claim = acquired && refreshDue(fresh) && roomForRefresh(t);
      claimed.prev = fresh.lastRefreshedAt;
      claimed.at = Math.max(t, fresh.refreshRequestedAt ?? 0);
      if (!acquired) return null;
      return {
        ...fresh,
        lockedUntil: t + FINANCE_SYNC_LOCK_MS,
        lastRefreshedAt: claim ? claimed.at : fresh.lastRefreshedAt,
      };
    },
    t,
    {
      consistent: true,
      allowDeleted: true,
      create: () => {
        acquired = true;
        removed = false;
        claim = false;
        return { ...blankState(ctx.userId, itemId, t), lockedUntil: t + FINANCE_SYNC_LOCK_MS };
      },
    },
  );
  if (!acquired) return { ...report, outcome: removed ? 'removed' : 'locked' };

  const lock = { token: taken.lockedUntil! };
  const renew = () => renewLock(ctx, itemId, lock);
  let passStart = t;
  let refresh = claim;
  const wroteAccounts = new Set<string>();

  for (;;) {
    report.passes++;
    let result: { ok: true } | { ok: false; code: string };
    let refreshCalled = false;
    try {
      // The bank may have been removed while we waited or ran — stop, and write nothing.
      const item = await repo.getFinanceItem(itemId, { consistent: true });
      if (!item || item.deletedAt !== null) throw new RemovedError();
      guard(ctx, itemId, 'accounts');
      const before = await refreshAccountsAndHealth(ctx, itemId, passStart, wroteAccounts);
      if (refresh) {
        try {
          guard(ctx, itemId, 'refresh');
          refreshCalled = true; // from here the claim is spent, even if the call fails (2/min limit)
          await ctx.plaid.transactionsRefresh(itemId);
          await pollRefresh(ctx, itemId, before, renew);
        } catch (err) {
          if (
            err instanceof LockLostError ||
            err instanceof DeadlineError ||
            err instanceof RemovedError
          )
            throw err;
          // A refused refresh still leaves a normal sync worth running.
          console.log(
            JSON.stringify({ event: 'finance_refresh_failed', itemId, code: codeOf(err) }),
          );
        }
      }
      let pass = await syncPass(ctx, itemId, passStart);
      report.written += pass.written;
      // Right after a link Plaid may not be ready: poll until the history is in, or time runs out.
      if (mode === 'post-link')
        for (
          let i = 0;
          i < POLL_TRIES &&
          pass.status !== null &&
          pass.status !== 'HISTORICAL_UPDATE_COMPLETE' &&
          now() + FINANCE_REFRESH_POLL_MS + PASS_RESERVE_MS <= ctx.deadline;
          i++
        ) {
          await ctx.sleep(FINANCE_REFRESH_POLL_MS);
          await renew();
          pass = await syncPass(ctx, itemId, passStart);
          report.written += pass.written;
        }
      // Never "synced" with nothing in it: not ready is a failure the page can say out loud.
      if (pass.status === 'NOT_READY') throw new PlaidApiError('PRODUCT_NOT_READY');
      result = { ok: true };
    } catch (err) {
      if (err instanceof RemovedError) {
        await buryAccounts(repo, itemId, now(), wroteAccounts);
        return { ...report, outcome: 'removed' };
      }
      if (err instanceof LockLostError) return { ...report, outcome: 'error', code: 'LOCK_LOST' };
      const code = codeOf(err);
      result = { ok: false, code };
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
    }

    // 2. Finish: the rerun check and the unlock are ONE conditional write.
    // Outputs of the finish fn (an object: TS can't see assignments made inside the callback).
    const fin: {
      decision: 'lost' | 'removed' | 'rerun' | 'done';
      nextStart: number;
      nextClaim: boolean;
      nextClaimed: { prev: number | null; at: number };
      deferred: boolean;
    } = {
      decision: 'lost',
      nextStart: passStart,
      nextClaim: false,
      nextClaimed: { ...claimed },
      deferred: false,
    };
    const finished = await repo
      .casUpdate(
        shape,
        itemId,
        (stored) => {
          const t2 = now();
          fin.nextStart = passStart;
          fin.nextClaim = false;
          fin.nextClaimed = { ...claimed };
          fin.deferred = false;
          // A claimed refresh that never went out (the pass failed first) is due again.
          const fresh =
            refresh && !refreshCalled && stored.lastRefreshedAt === claimed.at
              ? { ...stored, lastRefreshedAt: claimed.prev }
              : stored;
          if (fresh.deletedAt !== null) {
            fin.decision = 'removed';
            return null;
          }
          if (fresh.lockedUntil !== lock.token) {
            fin.decision = 'lost';
            return null;
          }
          const asked = fresh.syncRequestedAt ?? 0;
          if (
            report.passes < MAX_PASSES &&
            asked > passStart &&
            t2 + PASS_RESERVE_MS <= ctx.deadline
          ) {
            fin.decision = 'rerun';
            fin.nextStart = Math.max(t2, asked);
            fin.nextClaim = refreshDue(fresh) && roomForRefresh(t2);
            fin.nextClaimed = {
              prev: fresh.lastRefreshedAt,
              at: Math.max(fin.nextStart, fresh.refreshRequestedAt ?? 0),
            };
            return {
              ...fresh,
              lockedUntil: t2 + FINANCE_SYNC_LOCK_MS,
              lastRefreshedAt: fin.nextClaim ? fin.nextClaimed.at : fresh.lastRefreshedAt,
            };
          }
          fin.decision = 'done';
          // A request newer than this pass that we can't rerun for: cover it, don't drop it.
          fin.deferred = asked > passStart;
          if (!result.ok)
            return {
              ...fresh,
              lastSyncError: result.code,
              lastSyncErrorAt: Math.max(passStart, asked),
              lockedUntil: null,
            };
          return fin.deferred
            ? {
                ...fresh,
                lastSyncedAt: passStart,
                lastSyncError: 'SYNC_DEFERRED',
                lastSyncErrorAt: asked,
                lockedUntil: null,
              }
            : {
                ...fresh,
                lastSyncedAt: passStart,
                lastSyncError: null,
                lastSyncErrorAt: null,
                lockedUntil: null,
              };
        },
        now(),
        { consistent: true, allowDeleted: true },
      )
      .catch((err: unknown) => {
        // Can't even finish (a write storm): the lock simply expires. Never throw past here.
        console.log(
          JSON.stringify({ event: 'finance_sync_unlock_failed', itemId, code: codeOf(err) }),
        );
        return null;
      });
    if (finished === null) return { ...report, outcome: 'error', code: 'UNLOCK_FAILED' };
    if (fin.decision === 'done' && fin.deferred)
      console.log(
        JSON.stringify({
          event: 'finance_sync_request_deferred',
          itemId,
          passes: report.passes,
          reason: report.passes >= MAX_PASSES ? 'cap' : 'deadline',
        }),
      );
    if (fin.decision === 'removed') {
      await buryAccounts(repo, itemId, now(), wroteAccounts);
      return { ...report, outcome: 'removed' };
    }
    if (fin.decision === 'lost') return { ...report, outcome: 'error', code: 'LOCK_LOST' };
    if (fin.decision === 'rerun') {
      passStart = fin.nextStart;
      lock.token = finished.lockedUntil!;
      refresh = fin.nextClaim;
      Object.assign(claimed, fin.nextClaimed);
      continue;
    }
    return result.ok ? report : { ...report, outcome: 'error', code: result.code };
  }
}

function blankState(userId: string, itemId: string, t: number): FinanceSyncState {
  return {
    id: itemId,
    userId,
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
  };
}

// Extend the lock — only if it's still ours (same token, bank not removed); otherwise stop the run.
async function renewLock(ctx: Ctx, itemId: string, lock: { token: number }): Promise<void> {
  const t = ctx.now();
  let lost = false;
  let removed = false;
  const out = await ctx.repo.casUpdate(
    ctx.repo.finSyncShape(itemId),
    itemId,
    (fresh) => {
      removed = fresh.deletedAt !== null;
      lost = removed || fresh.lockedUntil !== lock.token;
      return lost ? null : { ...fresh, lockedUntil: t + FINANCE_SYNC_LOCK_MS };
    },
    t,
    { consistent: true, allowDeleted: true },
  );
  if (removed) throw new RemovedError();
  if (lost) throw new LockLostError();
  lock.token = out.lockedUntil!;
}

// After /transactions/refresh, wait for Plaid to say the bank pull finished: its own
// last_successful_update (or last_failed_update) moves past the value read before the refresh. That
// compares Plaid's clock with Plaid's clock, and it moves even when nothing new was found — so a quiet
// day doesn't poll to the cap. Bounded by the poll window and the run's deadline.
async function pollRefresh(
  ctx: Ctx,
  itemId: string,
  before: PlaidItemHealth,
  renew: () => Promise<void>,
): Promise<void> {
  const horizon = Math.min(
    ctx.now() + FINANCE_REFRESH_POLL_MAX_MS,
    ctx.deadline - 2 * PASS_RESERVE_MS,
  );
  const after = (x: number | null, y: number | null) => x !== null && (y === null || x > y);
  for (let i = 0; i < POLL_TRIES && ctx.now() + FINANCE_REFRESH_POLL_MS <= horizon; i++) {
    await ctx.sleep(FINANCE_REFRESH_POLL_MS);
    await renew();
    const h = await ctx.plaid.itemGet(itemId);
    if (after(h.lastSuccessfulUpdateAt, before.lastSuccessfulUpdateAt)) return;
    if (after(h.lastFailedUpdateAt, before.lastFailedUpdateAt)) {
      console.log(JSON.stringify({ event: 'finance_refresh_bank_failed', itemId }));
      return;
    }
  }
  console.log(JSON.stringify({ event: 'finance_refresh_unconfirmed', itemId }));
}

interface PassResult {
  written: number;
  status: string | null; // Plaid's transactions_update_status; null when it didn't say
}

// One pass: every page from the saved cursor, reconciled together, written, then the cursor.
async function syncPass(ctx: Ctx, itemId: string, passStart: number): Promise<PassResult> {
  const { repo } = ctx;
  // Consistent reads throughout: a pass right after another must see its cursor and its rows.
  const state = await repo.getFinanceSyncState(itemId, { consistent: true });
  const saved = state?.cursor ?? null;
  const gathered = await gatherPages(ctx, itemId, saved);
  if (gathered === null) return { written: 0, status: 'NOT_READY' };
  const { pages, status } = gathered;
  guard(ctx, itemId, 'write'); // nothing written, so the cursor stays and the next run replays

  const ids = [...new Set(pages.flatMap((p) => referencedTxnIds(p)))];
  const existing = ids.length
    ? await repo.getFinanceTxns(ids, { consistent: true })
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
      userId: ctx.userId,
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
      ctx.now(),
      { allowDeleted: true, consistent: true },
    ),
  );
  // New rows, inserted only if still absent (else merged like an update). One carried from a pending
  // row that the user edited mid-sync takes the fresh edit.
  const inserts = [...touched.values()]
    .filter((t) => !snapshot.has(t.id))
    .map((row) => {
      const p = row.pendingTransactionId;
      const before = p ? snapshot.get(p) : undefined;
      const after = p ? freshUser.get(p) : undefined;
      return before && after && !sameUser(pickUser(before), after) ? { ...row, ...after } : row;
    });
  await repo.casMany(inserts, (row) =>
    repo.insertFinanceTxn(row, (fresh) => ({
      ...row,
      ...pickUser(fresh),
      createdAt: fresh.createdAt,
    })),
  );

  const next = pages.at(-1)!.next_cursor;
  if (next && next !== saved)
    await repo.casUpdate(
      repo.finSyncShape(itemId),
      itemId,
      (fresh) => ({ ...fresh, cursor: next }),
      ctx.now(),
      { consistent: true },
    );
  return { written: touched.size, status: status ?? null };
}

// All pages from `cursor` until has_more=false. Plaid can change data mid-pagination — then the whole
// batch restarts from the SAVED cursor. Not ready yet (a fresh link: empty arrays + NOT_READY) → null.
async function gatherPages(
  ctx: Ctx,
  itemId: string,
  cursor: string | null,
): Promise<{ pages: PlaidSyncResponse[]; status: string | undefined } | null> {
  for (let attempt = 0; attempt <= MUTATION_RESTARTS; attempt++) {
    const pages: PlaidSyncResponse[] = [];
    let c = cursor;
    try {
      for (;;) {
        guard(ctx, itemId, 'page');
        const page = await ctx.plaid.transactionsSync(itemId, c, SYNC_PAGE_COUNT);
        if (pages.length === 0 && page.transactions_update_status === 'NOT_READY') return null;
        pages.push(page);
        c = page.next_cursor || c;
        if (!page.has_more) return { pages, status: page.transactions_update_status };
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

// Accounts and item health, before any transaction lands. Returns the health read BEFORE a refresh,
// which pollRefresh compares against.
async function refreshAccountsAndHealth(
  ctx: Ctx,
  itemId: string,
  since: number,
  wrote: Set<string>,
): Promise<PlaidItemHealth> {
  const [accounts, health] = await Promise.all([
    ctx.plaid.accountsGet(itemId),
    ctx.plaid.itemGet(itemId),
  ]);
  for (const a of accounts) wrote.add(a.account_id); // before the writes: a failure midway still counts
  await upsertAccounts(ctx.repo, ctx.userId, itemId, accounts, since, { since });
  await applyItemHealth(ctx.repo, itemId, health, since);
  return health;
}

// Plaid owns the account fields; the user owns signOverride + hidden. A returning account revives
// with its settings; one missing from the response is tombstoned — except when the response is empty
// (a hiccup must not wipe the roster). `since`: an account tombstoned at or after it was removed WITH
// its bank during this pass — never revive that one.
export async function upsertAccounts(
  repo: Repo,
  userId: string,
  itemId: string,
  accounts: PlaidAccount[],
  t: number,
  opts: { since?: number } = {},
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
  const removedDuringPass = (a: FinanceAccount) =>
    a.deletedAt !== null && opts.since !== undefined && a.deletedAt >= opts.since;
  await repo.casMany(accounts, (a) =>
    repo.casUpdate(
      repo.finAcctShape(a.account_id),
      a.account_id,
      (fresh) =>
        removedDuringPass(fresh) ? null : { ...fresh, ...plaidFields(a), deletedAt: null },
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
    repo.casUpdate(
      repo.finAcctShape(a.id),
      a.id,
      (fresh) => (fresh.deletedAt !== null ? null : { ...fresh, deletedAt: t }),
      t,
      { allowDeleted: true },
    ),
  );
}

// A bank removed while this run wrote its accounts: tombstone whatever it left alive. The remove
// tombstones accounts last, so any upsert that beat that sweep is caught here (the finish saw the
// state tombstone, which the remove writes first). `wrote`: the ids this run upserted — read
// consistently, since the list query may not see a write this fresh (and skipped if the upsert
// failed before creating it).
export async function buryAccounts(
  repo: Repo,
  itemId: string,
  t: number,
  wrote: Iterable<string> = [],
): Promise<void> {
  const listed = (await repo.listFinanceAccounts()).filter((a) => a.itemId === itemId);
  const ids = [...new Set([...listed.map((a) => a.id), ...wrote])];
  const rows = await mapLimit(ids, 8, (id) => repo.getFinanceAccount(id, { consistent: true }));
  const live = rows.filter(
    (a): a is FinanceAccount => a !== null && a.deletedAt === null && a.itemId === itemId,
  );
  await repo.casMany(live, (a) =>
    repo.casUpdate(
      repo.finAcctShape(a.id),
      a.id,
      (fresh) =>
        fresh.deletedAt !== null || fresh.itemId !== itemId ? null : { ...fresh, deletedAt: t },
      t,
      { allowDeleted: true, consistent: true },
    ),
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
