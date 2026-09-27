import {
  addDays,
  applyRules,
  buildFinanceOverview,
  detectInternalMoves,
  FINANCE_OVERVIEW_LOOKBACK_DAYS,
  FINANCE_REFRESH_COOLDOWN_MS,
  isDuplicateItem,
  normalizeRulePattern,
  periodStartError,
  refundLinkError,
  todayKey,
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
  FinanceRule,
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
import { upsertAccounts } from './sync';

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
    return todayKey((await this.d.settings()).dayStartHour, this.d.now());
  }
  private txnUpdate(
    id: string,
    fn: (t: FinanceTransaction) => FinanceTransaction | null,
  ): Promise<FinanceTransaction> {
    return this.repo.casUpdate(this.repo.finTxnShape(id), id, fn, this.d.now());
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
    if (input.rule && input.bucket === null) throw new Error('A rule needs a bucket');
    const found = await this.repo.getFinanceTxns(input.ids);
    for (const id of input.ids)
      if (found.get(id)?.deletedAt !== null) throw new Error(`Not found: ${id}`);
    const changed = new Map<string, FinanceTransaction>();
    const set = await this.repo.casMany(input.ids, (id) =>
      this.txnUpdate(id, (t) => ({
        ...t,
        bucket: input.bucket,
        bucketSetBy: input.bucket ? 'user' : null,
        refundOfId: null, // sorting a refund yourself unlinks it
      })),
    );
    for (const t of set) changed.set(t.id, t);
    if (input.rule && input.bucket) {
      const rule = await this.upsertFinanceRule({
        pattern: input.rule.pattern,
        bucket: input.bucket,
      });
      const sweepable = (x: FinanceTransaction) =>
        x.bucket === null &&
        x.refundOfId === null &&
        !x.startsPeriod &&
        applyRules([rule], x) !== null;
      const targets = (await this.repo.listAllFinanceTxns()).filter(
        (x) => !changed.has(x.id) && sweepable(x),
      );
      // Re-checked on the fresh row: a row sorted meanwhile is left alone (and not reported).
      const wrote = new Set<string>();
      const swept = await this.repo.casMany(targets, (x) =>
        this.txnUpdate(x.id, (t) => {
          const ok = sweepable(t);
          if (ok) wrote.add(t.id);
          else wrote.delete(t.id);
          return ok ? { ...t, bucket: rule.bucket, bucketSetBy: 'rule' } : null;
        }),
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
    return this.txnUpdate(id, (t) => ({ ...t, periodOverride: override, refundOfId: null }));
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
      };
    });
  }

  async linkFinanceRefund(refundId: string, chargeId: string | null): Promise<FinanceTransaction> {
    const refund = await this.repo.getFinanceTxn(refundId);
    if (!refund || refund.deletedAt !== null) throw new Error(`Not found: ${refundId}`);
    if (chargeId === null) return this.txnUpdate(refundId, (t) => ({ ...t, refundOfId: null }));
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
      return { ...t, refundOfId: chargeId, bucket: null, bucketSetBy: null, periodOverride: null };
    });
  }

  async listFinanceRules(): Promise<FinanceRule[]> {
    return (await this.repo.listFinanceRules()).sort((a, b) => a.pattern.localeCompare(b.pattern));
  }

  // One live rule per pattern: saving an existing pattern updates it.
  async upsertFinanceRule(input: UpsertFinanceRuleInput): Promise<FinanceRule> {
    const pattern = normalizeRulePattern(input.pattern);
    if (!pattern) throw new Error('A rule needs a pattern');
    const fields = { pattern, bucket: input.bucket, active: input.active ?? true };
    const id =
      input.id ?? (await this.repo.listFinanceRules()).find((r) => r.pattern === pattern)?.id;
    const t = this.d.now();
    if (id)
      return this.repo.casUpdate(this.repo.finRuleShape(id), id, (r) => ({ ...r, ...fields }), t);
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
    const linkToken = await this.d.plaid.createLinkToken({ userId: this.d.userId, ...input });
    return { linkToken, environment: this.d.plaid.environment };
  }

  // The duplicate guard runs BEFORE the exchange: a Trial slot never comes back. Right after the
  // exchange the item row is written, so a later failure leaves a visible, removable item — never an
  // orphaned Plaid login. The sync state is stamped (`syncRequestedAt`) before the invoke, so the page
  // reads `syncing` until the first run reports.
  async exchangePlaidPublicToken(input: ExchangePublicTokenInput): Promise<FinanceItem> {
    const [items, accounts] = await Promise.all([
      this.repo.listFinanceItems(),
      this.repo.listFinanceAccounts(),
    ]);
    if (isDuplicateItem(items, accounts, input.institution.id, input.accounts))
      throw new Error(`${input.institution.name} is already linked with these accounts`);
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
    await upsertAccounts(
      this.repo,
      this.d.userId,
      itemId,
      await this.d.plaid.accountsGet(itemId),
      t,
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

  // Update mode finished: re-read the roster (an account added or dropped in Link), the item's health,
  // then sync — stamped first, like a connect.
  async completePlaidUpdate(itemId: string): Promise<FinanceItem> {
    await this.mustItem(itemId);
    const t = this.d.now();
    await upsertAccounts(
      this.repo,
      this.d.userId,
      itemId,
      await this.d.plaid.accountsGet(itemId),
      t,
    );
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

  // Unknown or already-removed → a no-op with no Plaid call. Otherwise revoke at Plaid FIRST (it's
  // idempotent), then tombstone the rows — a failed revoke leaves the item visible to retry.
  async removePlaidItem(itemId: string): Promise<void> {
    const item = await this.repo.getFinanceItem(itemId);
    if (!item || item.deletedAt !== null) return;
    await this.d.plaid.itemRemove(itemId);
    const t = this.d.now();
    const accounts = (await this.repo.listFinanceAccounts()).filter((a) => a.itemId === itemId);
    await this.repo.casMany(accounts, (a) =>
      this.repo.casUpdate(this.repo.finAcctShape(a.id), a.id, (x) => ({ ...x, deletedAt: t }), t),
    );
    if (await this.repo.getFinanceSyncState(itemId))
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

  async requestFinanceSync(input: { refresh: boolean }): Promise<RequestFinanceSyncResult> {
    const t = this.d.now();
    const states = await this.repo.listFinanceSyncStates();
    if (states.length === 0) return { accepted: false, nextAllowedAt: null };
    if (input.refresh) {
      const last = Math.max(...states.map((s) => s.refreshRequestedAt ?? -Infinity));
      if (t - last < FINANCE_REFRESH_COOLDOWN_MS)
        return { accepted: false, nextAllowedAt: last + FINANCE_REFRESH_COOLDOWN_MS };
    }
    await this.stampRequest(
      states.map((s) => s.itemId),
      t,
      input.refresh,
    );
    await this.d.invoker.invoke({ userId: this.d.userId, mode: 'manual', refresh: input.refresh });
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
        (s) => ({
          ...s,
          syncRequestedAt: t,
          refreshRequestedAt: refresh ? t : s.refreshRequestedAt,
        }),
        t,
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
      lockedUntil: null,
    };
  }
}
