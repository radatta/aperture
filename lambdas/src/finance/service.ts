import {
  addDays,
  applyRules,
  buildFinanceOverview,
  dayKeyInZone,
  detectInternalMoves,
  FINANCE_OVERVIEW_LOOKBACK_DAYS,
  FINANCE_REFRESH_COOLDOWN_MS,
  financeBucketError,
  financeRuleFields,
  financeSplitError,
  duplicateItemMessage,
  isDuplicateItem,
  orderRefundParts,
  periodStartError,
  refundLinkError,
  refundPartsError,
  refundPartsFrom,
  resolveRefundPartIds,
  splitSortError,
  USER_TIME_ZONE,
} from '@aperture/shared';
import type {
  CreateLinkTokenInput,
  DateRange,
  ExchangePublicTokenInput,
  FinanceAccount,
  FinanceAccountPatch,
  FinanceItem,
  FinanceOverview,
  FinancePeriodOverride,
  FinanceRefundPart,
  FinanceRule,
  FinanceSplitPartInput,
  FinanceSyncState,
  FinanceTransaction,
  LinkTokenResult,
  RequestFinanceSyncResult,
  SetFinanceBucketInput,
  Settings,
  UpsertFinanceRuleInput,
} from '@aperture/shared';
import type { Repo } from '../ddb/repo';
import type { PlaidGateway } from '../plaid/gateway';
import type { FinanceSyncInvoker } from './invoker';
import { buryAccounts } from './sync';

export interface FinanceServiceDeps {
  repo: Repo;
  userId: string;
  now: () => number;
  ulid: () => string;
  plaid: PlaidGateway;
  invoker: FinanceSyncInvoker;
  settings: () => Promise<Settings>;
}

// The finance half of the BackendClient — the SAME behaviour and error text as the stub (the shared
// contract suite runs both), over the finance repo. Every write to an existing row is a casUpdate; every
// Plaid call goes through the gated gateway; syncs start through the invoker (an async Lambda invoke
// live, inline in tests, nothing in testMode).
export class FinanceService {
  constructor(private readonly d: FinanceServiceDeps) {}

  private get repo(): Repo {
    return this.d.repo;
  }
  private async today(): Promise<string> {
    // The user's day in their zone: on the UTC Lambda, local getters read tomorrow by evening.
    return dayKeyInZone(this.d.now(), USER_TIME_ZONE, (await this.d.settings()).dayStartHour);
  }
  private txnUpdate(
    id: string,
    fn: (t: FinanceTransaction) => FinanceTransaction | null,
    opts: { allowDeleted?: boolean } = {},
  ): Promise<FinanceTransaction> {
    return this.repo.casUpdate(this.repo.finTxnShape(id), id, fn, this.d.now(), opts);
  }

  async getFinanceOverview(input: { today: string }): Promise<FinanceOverview> {
    const settings = await this.d.settings();
    const from = addDays(input.today, -FINANCE_OVERVIEW_LOOKBACK_DAYS);
    const [items, accounts, syncStates, txns] = await Promise.all([
      this.repo.listFinanceItems(),
      this.repo.listFinanceAccounts(),
      this.repo.listFinanceSyncStates(),
      this.repo.listFinanceTxnsInRange(from, input.today),
    ]);
    return buildFinanceOverview({
      today: input.today,
      budgetCents: settings.financeBudgetCents,
      paymentDay: settings.financePaymentDay,
      items,
      accounts,
      syncStates,
      txns,
      environment: this.d.plaid.environment,
      now: this.d.now(),
    });
  }

  async listFinanceTransactions(range: DateRange): Promise<FinanceTransaction[]> {
    return (await this.repo.listFinanceTxnsInRange(range.from, range.to)).sort(
      (a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id),
    );
  }

  // All-or-nothing on unknown ids: every id is checked before the first write.
  async setFinanceBucket(input: SetFinanceBucketInput): Promise<FinanceTransaction[]> {
    const bucketError = financeBucketError(input.bucket, { nullable: true });
    if (bucketError) throw new Error(bucketError);
    if (input.rule && input.bucket === null) throw new Error('A rule needs a bucket');
    const found = await this.repo.getFinanceTxns(input.ids);
    for (const id of input.ids)
      if (found.get(id)?.deletedAt !== null) throw new Error(`Not found: ${id}`);
    const accounts = new Map((await this.repo.listFinanceAccounts()).map((a) => [a.id, a]));
    const refuse = (t: FinanceTransaction) => splitSortError(t, accounts.get(t.accountId));
    for (const t of found.values()) {
      const error = refuse(t);
      if (error) throw new Error(error);
    }
    const changed = new Map<string, FinanceTransaction>();
    // A row a sync tombstoned since the check above (a pending charge that posted) is skipped, not an
    // error halfway through — its posted replacement carries the old row's fields anyway.
    const set = await this.repo.casMany(input.ids, (id) =>
      this.txnUpdate(
        id,
        (t) => {
          if (t.deletedAt !== null) return null;
          const error = refuse(t); // split meanwhile, from another device
          if (error) throw new Error(error);
          return {
            ...t,
            bucket: input.bucket,
            bucketSetBy: input.bucket ? 'user' : null,
            refundOfId: null, // sorting a refund yourself unlinks it
            refundParts: null,
            splits: null, // only a broken split gets here: sorting it replaces it
          };
        },
        { allowDeleted: true },
      ),
    );
    for (const t of set) if (t.deletedAt === null) changed.set(t.id, t);
    if (input.rule && input.bucket) {
      const rule = await this.upsertFinanceRule({
        pattern: input.rule.pattern,
        bucket: input.bucket,
        split: null, // "Always put it in <bucket>"
      });
      const sweepable = (x: FinanceTransaction) =>
        x.deletedAt === null &&
        x.bucket === null &&
        x.refundOfId === null &&
        x.refundParts === null &&
        x.splits === null &&
        !x.startsPeriod &&
        applyRules([rule], x) !== null;
      const targets = (await this.repo.listAllFinanceTxns()).filter(
        (x) => !changed.has(x.id) && sweepable(x),
      );
      // Re-checked on the fresh row: a row sorted meanwhile is left alone (and not reported).
      const wrote = new Set<string>();
      const swept = await this.repo.casMany(targets, (x) =>
        this.txnUpdate(
          x.id,
          (t) => {
            const ok = sweepable(t);
            if (ok) wrote.add(t.id);
            else wrote.delete(t.id);
            return ok ? { ...t, bucket: rule.bucket, bucketSetBy: 'rule' } : null;
          },
          { allowDeleted: true },
        ),
      );
      for (const t of swept) if (wrote.has(t.id)) changed.set(t.id, t);
    }
    return [...changed.values()];
  }

  async setFinancePeriodOverride(
    id: string,
    override: FinancePeriodOverride | null,
  ): Promise<FinanceTransaction> {
    // Moving a refund yourself unlinks it.
    return this.txnUpdate(id, (t) => ({
      ...t,
      periodOverride: override,
      refundOfId: null,
      refundParts: null,
    }));
  }

  async setFinanceNote(id: string, note: string | null): Promise<FinanceTransaction> {
    return this.txnUpdate(id, (t) => ({ ...t, note: note?.trim() || null }));
  }

  async setFinancePeriodStart(id: string, marked: boolean): Promise<FinanceTransaction> {
    if (!marked) return this.txnUpdate(id, (t) => ({ ...t, startsPeriod: false }));
    const current = await this.repo.getFinanceTxn(id);
    if (!current || current.deletedAt !== null) throw new Error(`Not found: ${id}`);
    const account = (await this.repo.getFinanceAccount(current.accountId)) ?? undefined;
    return this.txnUpdate(id, (t) => {
      const error = periodStartError(t, account);
      if (error) throw new Error(error);
      return {
        ...t,
        startsPeriod: true,
        bucket: null, // it's a payment now
        bucketSetBy: null,
        periodOverride: null,
        refundOfId: null,
        refundParts: null,
        splits: null,
      };
    });
  }

  async linkFinanceRefund(refundId: string, chargeId: string | null): Promise<FinanceTransaction> {
    const refund = await this.repo.getFinanceTxn(refundId);
    if (!refund || refund.deletedAt !== null) throw new Error(`Not found: ${refundId}`);
    if (chargeId === null)
      return this.txnUpdate(refundId, (t) => ({ ...t, refundOfId: null, refundParts: null }));
    const charge = await this.repo.getFinanceTxn(chargeId);
    if (!charge || charge.deletedAt !== null) throw new Error(`Not found: ${chargeId}`);
    const accounts = await this.repo.listFinanceAccounts();
    // Moves over the same window the overview reads, so pairing at the edge matches the page.
    const recent = await this.repo.listFinanceTxnsInRange(
      addDays(await this.today(), -FINANCE_OVERVIEW_LOOKBACK_DAYS),
    );
    const moves = detectInternalMoves(recent, accounts);
    const check = (r: FinanceTransaction) =>
      refundLinkError({
        refund: r,
        refundAccount: accounts.find((a) => a.id === r.accountId),
        charge,
        chargeAccount: accounts.find((a) => a.id === charge.accountId),
        moves,
      });
    const error = check(refund);
    if (error) throw new Error(error);
    return this.txnUpdate(refundId, (t) => {
      const again = check(t); // the fresh refund row (a mark or a sort may have landed)
      if (again) throw new Error(again);
      return {
        ...t,
        refundOfId: chargeId,
        refundParts: null,
        splits: null,
        bucket: null,
        bucketSetBy: null,
        periodOverride: null,
      };
    });
  }

  async setFinanceSplit(
    id: string,
    parts: FinanceSplitPartInput[] | null,
  ): Promise<FinanceTransaction> {
    const current = await this.repo.getFinanceTxn(id);
    if (!current || current.deletedAt !== null) throw new Error(`Not found: ${id}`);
    if (parts === null)
      // Only a row still split: a stale Remove never unsorts a row sorted since (null: no write).
      return this.txnUpdate(id, (t) =>
        t.splits === null ? null : { ...t, splits: null, bucket: null, bucketSetBy: null },
      );
    const accounts = await this.repo.listFinanceAccounts();
    // Moves over the same window the overview reads, so pairing at the edge matches the page.
    const recent = await this.repo.listFinanceTxnsInRange(
      addDays(await this.today(), -FINANCE_OVERVIEW_LOOKBACK_DAYS),
    );
    const moves = detectInternalMoves(recent, accounts);
    const check = (t: FinanceTransaction) =>
      financeSplitError({
        txn: t,
        account: accounts.find((a) => a.id === t.accountId),
        moves,
        parts,
      });
    const error = check(current);
    if (error) throw new Error(error);
    return this.txnUpdate(id, (t) => {
      const again = check(t); // the fresh row (a sync may have posted a new amount)
      if (again) throw new Error(again);
      return {
        ...t,
        splits: parts.map((p) => ({ bucket: p.bucket, cents: p.cents, period: p.period })),
        bucket: null,
        bucketSetBy: 'user',
        refundOfId: null,
        refundParts: null,
      };
    });
  }

  async setFinanceRefundParts(
    refundId: string,
    parts: FinanceRefundPart[],
  ): Promise<FinanceTransaction> {
    const refund = await this.repo.getFinanceTxn(refundId);
    if (!refund || refund.deletedAt !== null) throw new Error(`Not found: ${refundId}`);
    const [accounts, found] = await Promise.all([
      this.repo.listFinanceAccounts(),
      this.repo.getFinanceTxns(parts.map((p) => p.chargeId)),
    ]);
    const today = await this.today();
    // Tombstoned too: a pending charge that posted still dates the range its posted row sits in.
    const charges = [...found.values()];
    const lookback = addDays(today, -FINANCE_OVERVIEW_LOOKBACK_DAYS);
    const rows = await this.repo.listFinanceTxnsInRange(refundPartsFrom(today, charges));
    const moves = detectInternalMoves(
      rows.filter((x) => x.date >= lookback),
      accounts,
    );
    const check = (r: FinanceTransaction) =>
      refundPartsError({
        refund: r,
        parts,
        txns: rows.map((x) => (x.id === r.id ? r : x)),
        accounts,
        moves,
      });
    const error = check(refund);
    if (error) throw new Error(error);
    return this.txnUpdate(refundId, (t) => {
      const again = check(t); // the fresh refund row (a mark or a sort may have landed)
      if (again) throw new Error(again);
      return {
        ...t,
        refundParts: orderRefundParts(resolveRefundPartIds(parts, rows)),
        refundOfId: null,
        bucket: null,
        bucketSetBy: 'user', // the marker the read check needs (liveRefundParts)
        periodOverride: null,
        splits: null,
      };
    });
  }

  async listFinanceRules(): Promise<FinanceRule[]> {
    return (await this.repo.listFinanceRules()).sort((a, b) => a.pattern.localeCompare(b.pattern));
  }

  // One live rule per pattern: saving an existing pattern updates it.
  async upsertFinanceRule(input: UpsertFinanceRuleInput): Promise<FinanceRule> {
    const pattern = financeRuleFields({ ...input, split: null }).pattern;
    const rules = await this.repo.listFinanceRules();
    const id = input.id ?? rules.find((r) => r.pattern === pattern)?.id;
    const fields = financeRuleFields(
      input,
      rules.find((r) => r.id === id),
    );
    const t = this.d.now();
    // The kept split is decided against the rule as the CAS re-reads it, not the list read above.
    if (id)
      return this.repo.casUpdate(
        this.repo.finRuleShape(id),
        id,
        (r) => ({ ...r, ...financeRuleFields(input, r) }),
        t,
      );
    const rule: FinanceRule = {
      id: this.d.ulid(),
      userId: this.d.userId,
      createdAt: t,
      updatedAt: t,
      deletedAt: null,
      ...fields,
    };
    return this.repo.casUpdate(this.repo.finRuleShape(rule.id), rule.id, () => null, t, {
      create: () => rule,
    });
  }

  async deleteFinanceRule(id: string): Promise<void> {
    const r = await this.repo.getFinanceRule(id);
    if (!r) return;
    await this.repo.casUpdate(
      this.repo.finRuleShape(id),
      id,
      (x) => ({ ...x, deletedAt: this.d.now() }),
      this.d.now(),
      { allowDeleted: true },
    );
  }

  // Only the fields the user owns — RPC args are untrusted, never spread raw.
  async updateFinanceAccount(id: string, patch: FinanceAccountPatch): Promise<FinanceAccount> {
    return this.repo.casUpdate(
      this.repo.finAcctShape(id),
      id,
      (a) => ({
        ...a,
        ...(patch.signOverride === 'auto' || patch.signOverride === 'flip'
          ? { signOverride: patch.signOverride }
          : {}),
        ...(typeof patch.hidden === 'boolean' ? { hidden: patch.hidden } : {}),
      }),
      this.d.now(),
    );
  }

  async createPlaidLinkToken(input: CreateLinkTokenInput): Promise<LinkTokenResult> {
    if (input.mode === 'update') await this.mustItem(input.itemId);
    // The caller's user id always wins — an RPC argument can't pick whose Plaid user this is.
    const linkToken = await this.d.plaid.createLinkToken({ ...input, userId: this.d.userId });
    return { linkToken, environment: this.d.plaid.environment };
  }

  // The duplicate guard runs BEFORE the exchange: a Trial slot never comes back. Right after the
  // exchange the item row and a fresh, stamped sync state are written — nothing else can fail in
  // between — so the login is visible, removable and Refresh-able whatever happens next, and the page
  // reads `syncing` until the first run reports. Accounts come from that first sync (it reads them
  // before any transaction), not from here: one less Plaid call inside the BFF's 15 s.
  async exchangePlaidPublicToken(input: ExchangePublicTokenInput): Promise<FinanceItem> {
    const [items, accounts] = await Promise.all([
      this.repo.listFinanceItems(),
      this.repo.listFinanceAccounts(),
    ]);
    if (isDuplicateItem(items, accounts, input.institution.id, input.accounts))
      throw new Error(duplicateItemMessage(input.institution.name));
    const { itemId } = await this.d.plaid.exchangePublicToken(input.publicToken);
    const t = this.d.now();
    const item: FinanceItem = {
      id: itemId,
      userId: this.d.userId,
      createdAt: t,
      updatedAt: t,
      deletedAt: null,
      institutionId: input.institution.id,
      institutionName: input.institution.name,
      status: 'ok',
      errorCode: null,
      consentExpiresAt: null,
      lastSuccessfulUpdateAt: null,
      lastFailedUpdateAt: null,
      consentedProducts: ['transactions'],
    };
    // A re-link of a removed login revives its row (Plaid issued the same item id).
    const saved = await this.repo.casUpdate(
      this.repo.finItemShape(itemId),
      itemId,
      (fresh) => ({ ...item, createdAt: fresh.createdAt }),
      t,
      { allowDeleted: true, create: () => item },
    );
    // A connect always starts from a clean state (no cursor) — also when re-linking a removed login.
    const fresh = this.freshState(itemId, t);
    await this.repo.casUpdate(
      this.repo.finSyncShape(itemId),
      itemId,
      (s) => ({ ...fresh, createdAt: s.createdAt }),
      t,
      { allowDeleted: true, create: () => fresh },
    );
    await this.d.invoker.invoke({ userId: this.d.userId, mode: 'post-link', itemId });
    return (await this.repo.getFinanceItem(itemId)) ?? saved;
  }

  // Update mode finished: the login works again; sync — stamped first, like a connect. The sync re-reads
  // the roster (an account added or dropped in Link) and the item's health before any transaction.
  async completePlaidUpdate(itemId: string): Promise<FinanceItem> {
    await this.mustItem(itemId);
    const t = this.d.now();
    await this.repo.casUpdate(
      this.repo.finItemShape(itemId),
      itemId,
      (i) => ({ ...i, status: 'ok' as const, errorCode: null }),
      t,
    );
    await this.stampRequest([itemId], t, false);
    await this.d.invoker.invoke({ userId: this.d.userId, mode: 'post-link', itemId });
    return this.mustItem(itemId);
  }

  // Unknown → a no-op; already removed → no Plaid call, only a sweep of accounts a half-done remove
  // left. Otherwise revoke at Plaid FIRST (it's idempotent), then tombstone — a failed revoke leaves
  // the item visible to retry. Order: sync state (kills the lock), item, accounts LAST — so a sync
  // that upserts accounts after this sweep finishes after the state tombstone too, sees "removed",
  // and buries them itself (sync.ts buryAccounts).
  async removePlaidItem(itemId: string): Promise<void> {
    const item = await this.repo.getFinanceItem(itemId);
    if (!item) return;
    if (item.deletedAt === null) {
      await this.d.plaid.itemRemove(itemId);
      const t = this.d.now();
      // Consistent: a state row written moments ago (a fresh link) must get its tombstone, which the
      // running sync's finish relies on to bury accounts it upserted.
      if (await this.repo.getFinanceSyncState(itemId, { consistent: true }))
        await this.repo.casUpdate(
          this.repo.finSyncShape(itemId),
          itemId,
          (s) => ({ ...s, deletedAt: t, lockedUntil: null }),
          t,
          { allowDeleted: true },
        );
      await this.repo.casUpdate(
        this.repo.finItemShape(itemId),
        itemId,
        (i) => ({ ...i, deletedAt: t }),
        t,
      );
    }
    await buryAccounts(this.repo, itemId, this.d.now());
  }

  // Based on the linked banks, not their sync rows: a bank whose state row is missing (a failure right
  // after connecting) gets one here, so Refresh can always recover it.
  async requestFinanceSync(input: { refresh: boolean }): Promise<RequestFinanceSyncResult> {
    const t = this.d.now();
    const items = await this.repo.listFinanceItems();
    if (items.length === 0) return { accepted: false, nextAllowedAt: null };
    if (input.refresh) {
      const states = await this.repo.listFinanceSyncStates();
      const last = Math.max(...states.map((s) => s.refreshRequestedAt ?? -Infinity));
      if (t - last < FINANCE_REFRESH_COOLDOWN_MS)
        return { accepted: false, nextAllowedAt: last + FINANCE_REFRESH_COOLDOWN_MS };
    }
    await this.stampRequest(
      items.map((i) => i.id),
      t,
      input.refresh,
    );
    // No refresh flag on the event: the stamp above makes a refresh DUE, and whichever run holds the
    // lock does it (a scheduled run that beats this invoke included).
    await this.d.invoker.invoke({ userId: this.d.userId, mode: 'manual' });
    return {
      accepted: true,
      nextAllowedAt: input.refresh ? t + FINANCE_REFRESH_COOLDOWN_MS : null,
    };
  }

  async exportCollections() {
    const [financeItems, financeAccounts, financeSyncStates, financeTransactions, financeRules] =
      await Promise.all([
        this.repo.listFinanceItems(),
        this.repo.listFinanceAccounts(),
        this.repo.listFinanceSyncStates(),
        this.repo.listAllFinanceTxns(),
        this.repo.listFinanceRules(),
      ]);
    return { financeItems, financeAccounts, financeSyncStates, financeTransactions, financeRules };
  }

  private async mustItem(itemId: string): Promise<FinanceItem> {
    const item = await this.repo.getFinanceItem(itemId);
    if (!item || item.deletedAt !== null) throw new Error(`Not found: ${itemId}`);
    return item;
  }

  // Record that a sync was asked for — the page reads `syncing` off it until a run reports.
  private async stampRequest(itemIds: string[], t: number, refresh: boolean): Promise<void> {
    await this.repo.casMany(itemIds, (itemId) =>
      this.repo.casUpdate(
        this.repo.finSyncShape(itemId),
        itemId,
        // A tombstoned row (a remove half-done, or a stale item list) is skipped, not an error that
        // would stop the other banks' stamps and the invoke.
        (s) =>
          s.deletedAt !== null
            ? null
            : {
                ...s,
                syncRequestedAt: t,
                refreshRequestedAt: refresh ? t : s.refreshRequestedAt,
              },
        t,
        {
          allowDeleted: true,
          create: () => ({
            ...this.freshState(itemId, t),
            refreshRequestedAt: refresh ? t : null,
          }),
        },
      ),
    );
  }

  private freshState(itemId: string, t: number): FinanceSyncState {
    return {
      id: itemId,
      userId: this.d.userId,
      createdAt: t,
      updatedAt: t,
      deletedAt: null,
      itemId,
      cursor: null,
      lastSyncedAt: null,
      lastSyncError: null,
      lastSyncErrorAt: null,
      syncRequestedAt: t,
      refreshRequestedAt: null,
      lastRefreshedAt: null,
      lockedUntil: null,
    };
  }
}
