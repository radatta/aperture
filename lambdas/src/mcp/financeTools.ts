import {
  FINANCE_BUCKETS,
  FINANCE_BUCKET_LABELS,
  bucketOf,
  dayKeyInZone,
  daysBetween,
  deriveFinanceView,
  financeListRange,
  financeSyncErrorMessage,
  isDayKey,
  isSortableKind,
  needsSorting,
  periodOf,
  sortableTransactions,
} from '@aperture/shared';
import type {
  FinanceBucket,
  FinanceOverview,
  FinanceRule,
  FinanceTransaction,
  Settings,
} from '@aperture/shared';
import { RpcParamError } from './types';
import type { Tool, ToolContext } from './types';

// Read-only finance tools (docs/areas/mcp → Tools). Every derived field — kind, bucket, period — comes
// from deriveFinanceView over the same rows the page loads, so the MCP and the page can't disagree.
// Nothing here writes, syncs, or reaches Plaid (the MCP edge pins Plaid + the sync invoker inert).
//
// Money is US dollars as JSON numbers (`…Usd`), summed in cents first: positive = money out (spending),
// negative = money in — the page's convention after an account's sign flip.

// The user's zone, for "today" when the caller doesn't say. One user; they can pass `today` if travelling.
export const USER_TIME_ZONE = 'America/Los_Angeles';
const MAX_SPAN_DAYS = 366;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 300;

const usd = (cents: number): number => cents / 100;
const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

const READ_ONLY =
  'Read-only: nothing here syncs, sorts, or edits — those are app-only. Data is as of the last bank sync.';
const TODAY_ARG =
  'Omit `today` unless the user names another day; the server uses their Pacific day (4am rollover).';
const SIGN =
  'Amounts are US dollars: positive = money out (spending), negative = money in (refunds, income, payments received).';

// `today` from the arg, else the user's day in their zone at their dayStartHour.
async function resolveToday(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ today: string; todaySource: 'arg' | 'server'; settings: Settings | null }> {
  const v = args.today;
  if (v !== undefined && v !== null) {
    if (typeof v !== 'string' || !isDayKey(v))
      throw new RpcParamError('"today" must be an ISO date (YYYY-MM-DD)');
    return { today: v, todaySource: 'arg', settings: null };
  }
  const settings = (await ctx.dispatch('getSettings', [])) as Settings;
  const now = (ctx.now ?? Date.now)();
  return {
    today: dayKeyInZone(now, USER_TIME_ZONE, settings.dayStartHour),
    todaySource: 'server',
    settings,
  };
}

// The error line the page's banners show for one bank, or null.
function bankError(o: FinanceOverview, itemId: string): { text: string; code: string } | null {
  const item = o.items.find((i) => i.id === itemId);
  const bank = item?.institutionName;
  if (item?.status === 'login_required')
    return {
      code: 'ITEM_LOGIN_REQUIRED',
      text: financeSyncErrorMessage('ITEM_LOGIN_REQUIRED', bank),
    };
  if (item?.status === 'pending_disconnect')
    return {
      code: 'PENDING_EXPIRATION',
      text: financeSyncErrorMessage('PENDING_EXPIRATION', bank),
    };
  const s = o.sync.items.find((x) => x.itemId === itemId);
  if (o.sync.syncing || !s?.lastError) return null;
  return { code: s.lastError, text: financeSyncErrorMessage(s.lastError, bank) };
}

export const FINANCE_TOOLS: Tool[] = [
  {
    name: 'get_finance_overview',
    description: [
      'The budget at a glance — "how much budget is left?". The current billing period (from the card payment the user marked, else their payment day), budget / spent / left (left < 0 = over), totals per bucket (parents_pay "Parents pay", budget "Budget", i_pay "I pay"), how many charges are still to sort, account balances, and each bank\'s sync status.',
      "Hidden accounts are listed (hidden: true) but excluded from every total. A credit account's balance is the amount owed.",
      SIGN,
      TODAY_ARG,
      READ_ONLY,
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: { today: { type: 'string', description: 'YYYY-MM-DD; usually omit' } },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const { today, todaySource, settings: known } = await resolveToday(args, ctx);
      const [settings, o] = await Promise.all([
        known ? Promise.resolve(known) : (ctx.dispatch('getSettings', []) as Promise<Settings>),
        ctx.dispatch('getFinanceOverview', [{ today }]) as Promise<FinanceOverview>,
      ]);
      const bankName = new Map(o.items.map((i) => [i.id, i.institutionName]));
      const errors = o.items.map((i) => bankError(o, i.id)).filter((e) => e !== null);
      return {
        today,
        todaySource,
        ...(o.items.length === 0 ? { note: 'No bank connected — connect one in the app.' } : {}),
        period: {
          start: o.period.start,
          end: o.period.end,
          day: o.period.dayCount,
          source: o.period.source, // 'marked' = from a card payment the user marked; else the payment day
          lastPaymentDate: o.period.lastPaymentDate,
          previous: o.period.previous,
          ...(o.period.start > today
            ? { note: 'A payment was marked today; the new period starts tomorrow.' }
            : {}),
        },
        budgetUsd: usd(o.budgetCents),
        spentUsd: usd(o.spentCents),
        leftUsd: usd(o.leftCents),
        overBudget: o.leftCents < 0,
        buckets: Object.fromEntries(
          FINANCE_BUCKETS.map((b) => [
            b,
            {
              label: FINANCE_BUCKET_LABELS[b],
              totalUsd: usd(o.buckets[b].totalCents),
              count: o.buckets[b].count,
            },
          ]),
        ),
        toSort: { count: o.unsortedCount, totalUsd: usd(o.unsortedCents) },
        settings: {
          budgetUsd: usd(settings.financeBudgetCents),
          paymentDay: settings.financePaymentDay,
        },
        accounts: o.accounts.map((a) => ({
          id: a.id,
          name: a.name,
          mask: a.mask,
          bank: bankName.get(a.itemId) ?? null,
          type: a.type,
          subtype: a.subtype,
          balanceUsd: a.currentCents === null ? null : usd(a.currentCents),
          availableUsd: a.availableCents === null ? null : usd(a.availableCents),
          balanceAt: iso(a.balanceAt),
          hidden: a.hidden,
          amountsFlipped: a.signOverride === 'flip',
        })),
        banks: o.items.map((i) => {
          const s = o.sync.items.find((x) => x.itemId === i.id);
          const e = bankError(o, i.id);
          return {
            name: i.institutionName,
            status: i.status,
            needsSignIn: i.status === 'login_required' || i.status === 'pending_disconnect',
            lastSyncedAt: iso(s?.lastSyncedAt ?? null),
            error: e?.text ?? null,
            errorCode: e?.code ?? null,
          };
        }),
        // No Plaid environment: the MCP runs an inert gateway, so it would always read "sandbox".
        sync: {
          syncing: o.sync.syncing,
          lastSyncedAt: iso(o.sync.lastSyncedAt),
          error: errors[0]?.text ?? null,
        },
      };
    },
  },
  {
    name: 'list_finance_transactions',
    description: [
      'Bank/card transactions with how the user sorted them — "what did I spend at Amazon this period?", "what\'s still unsorted?".',
      'Default: the current and previous billing periods. Or pass from + to (YYYY-MM-DD, both or neither, ≤ 366 days).',
      "unsorted: true → exactly the app's to-sort queue (matches get_finance_overview toSort.count). bucket → one bucket (parents_pay | budget | i_pay); not with unsorted.",
      "kind: expense (a charge) | refund | income | transfer (between the user's own accounts) | card_payment. Only expense and refund rows (and deposits linked as refunds) count toward buckets.",
      "bucket is resolved through refund links (a linked refund takes its charge's bucket); period is which billing period it counts in (current | previous | outside).",
      "category is Plaid's (e.g. FOOD_AND_DRINK / FOOD_AND_DRINK_RESTAURANT). Newest first; limit defaults to 100 (max 300), truncated says if more matched.",
      SIGN,
      TODAY_ARG,
      READ_ONLY,
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string' },
        to: { type: 'string' },
        unsorted: { type: 'boolean' },
        bucket: { type: 'string', enum: FINANCE_BUCKETS },
        today: { type: 'string', description: 'YYYY-MM-DD; usually omit' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const window = parseWindow(args);
      const unsorted =
        args.unsorted === undefined || args.unsorted === null ? false : args.unsorted;
      if (typeof unsorted !== 'boolean')
        throw new RpcParamError('"unsorted" must be true or false');
      const bucket = parseBucket(args);
      if (unsorted && bucket) throw new RpcParamError('pass "unsorted" or "bucket", not both');
      const limit = parseLimit(args);

      const { today, todaySource } = await resolveToday(args, ctx);
      const o = (await ctx.dispatch('getFinanceOverview', [{ today }])) as FinanceOverview;
      // Load the page's range (so kinds and refund links match it), widened to cover a window.
      const pageRange = financeListRange(today, o);
      const load = window
        ? {
            from: window.from < pageRange.from ? window.from : pageRange.from,
            to: window.to > pageRange.to ? window.to : pageRange.to,
          }
        : pageRange;
      const loaded = (await ctx.dispatch('listFinanceTransactions', [
        load,
      ])) as FinanceTransaction[];
      const view = deriveFinanceView(o, loaded);

      let rows = window
        ? view.allTxns.filter((t) => t.date >= window.from && t.date <= window.to)
        : view.txns;
      if (unsorted)
        rows = sortableTransactions(rows, o.accounts, view.moves).filter((t) =>
          needsSorting(t, view.links, view.refunded, view.amount(t)),
        );
      if (bucket)
        rows = rows.filter(
          (t) =>
            !view.accounts.get(t.accountId)?.hidden &&
            (isSortableKind(view.kindOf(t)) || view.links.has(t.id)) &&
            bucketOf(t, view.links) === bucket,
        );

      const shown = rows.slice(0, limit);
      return {
        today,
        todaySource,
        period: { start: o.period.start, end: o.period.end, previous: o.period.previous },
        range: window ?? { from: o.period.previous.start, to: o.period.end },
        total: rows.length,
        returned: shown.length,
        truncated: rows.length > shown.length,
        transactions: shown.map((t) => {
          const acct = view.accounts.get(t.accountId);
          const refunded = view.refunded.get(t.id) ?? 0;
          return {
            id: t.id,
            date: t.date,
            authorizedDate: t.authorizedDate,
            merchant: t.merchantName ?? t.name,
            name: t.name,
            amountUsd: usd(view.amount(t)),
            ...(t.isoCurrency && t.isoCurrency !== 'USD' ? { currency: t.isoCurrency } : {}),
            pending: t.pending,
            account: {
              name: acct?.name ?? null,
              mask: acct?.mask ?? null,
              hidden: acct?.hidden ?? false,
            },
            kind: view.kindOf(t),
            bucket: bucketOf(t, view.links),
            bucketSetBy: t.bucketSetBy,
            period: periodOf(t, o.period, view.links) ?? 'outside',
            periodOverride: t.periodOverride,
            category: { primary: t.pfcPrimary, detailed: t.pfcDetailed },
            paymentChannel: t.paymentChannel,
            note: t.note,
            refundOfId: t.refundOfId,
            linkedChargeId: view.links.get(t.id)?.id ?? null,
            ...(refunded > 0 ? { refundedUsd: usd(refunded) } : {}),
            startsPeriod: t.startsPeriod,
          };
        }),
      };
    },
  },
  {
    name: 'list_finance_rules',
    description:
      'The user\'s auto-sort rules: "always put <pattern> in <bucket>". A pattern is a case-insensitive substring of the merchant; the longest active match wins, and a rule never re-sorts a charge the user sorted by hand. ' +
      READ_ONLY,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run(_args, ctx) {
      const rules = (await ctx.dispatch('listFinanceRules', [])) as FinanceRule[];
      return rules.map((r) => ({
        pattern: r.pattern,
        bucket: r.bucket,
        bucketLabel: FINANCE_BUCKET_LABELS[r.bucket],
        active: r.active,
      }));
    },
  },
];

function parseWindow(args: Record<string, unknown>): { from: string; to: string } | null {
  const has = (k: string) => args[k] !== undefined && args[k] !== null;
  if (has('from') !== has('to')) throw new RpcParamError('pass both "from" and "to", or neither');
  if (!has('from')) return null;
  const day = (k: string) => {
    const v = args[k];
    if (typeof v !== 'string' || !isDayKey(v))
      throw new RpcParamError(`"${k}" must be an ISO date (YYYY-MM-DD)`);
    return v;
  };
  const from = day('from');
  const to = day('to');
  if (from > to) throw new RpcParamError('"from" must be on or before "to"');
  if (daysBetween(from, to) > MAX_SPAN_DAYS)
    throw new RpcParamError(`"from" to "to" can span at most ${MAX_SPAN_DAYS} days`);
  return { from, to };
}

function parseBucket(args: Record<string, unknown>): FinanceBucket | null {
  const v = args.bucket;
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || !(FINANCE_BUCKETS as string[]).includes(v))
    throw new RpcParamError(`"bucket" must be one of: ${FINANCE_BUCKETS.join(', ')}`);
  return v as FinanceBucket;
}

function parseLimit(args: Record<string, unknown>): number {
  const v = args.limit;
  if (v === undefined || v === null) return DEFAULT_LIMIT;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > MAX_LIMIT)
    throw new RpcParamError(`"limit" must be an integer from 1 to ${MAX_LIMIT}`);
  return v;
}
