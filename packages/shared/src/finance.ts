// Finances — the three-bucket budget, plus Not spending (ported from an earlier budget app) over Plaid-synced bank data.
// Entities, DTOs, and every pure rule both ApiClient impls share: sign normalisation, internal-move
// matching, the billing period, the overview numbers, rules, and sync-page reconciliation.
//
// Sign convention: POSITIVE = MONEY OUT of the account (Plaid's rule). `rawAmountCents` is stored as
// Plaid sent it; normalisation is a read-time function with a per-account `signOverride`, so flipping
// an account never rewrites stored rows.

import type { BaseEntity } from './types';
import type { PlaidTransaction } from './plaidTypes';
import { addDays, daysBetween } from './dates';

// --- Entities --------------------------------------------------------------
// not_spending: money out that isn't spending (a transfer to an outside account, a cash withdrawal) — sorted, so it
// leaves the queue, but in no total. A stored bucket value, so rules and sync carry it like the others.
export type FinanceBucket = 'parents_pay' | 'budget' | 'i_pay' | 'not_spending';
export type FinanceSpendBucket = Exclude<FinanceBucket, 'not_spending'>;
export const FINANCE_SPEND_BUCKETS: FinanceSpendBucket[] = ['parents_pay', 'budget', 'i_pay'];
export const FINANCE_BUCKETS: FinanceBucket[] = [...FINANCE_SPEND_BUCKETS, 'not_spending']; // order = keys 1–4
export const FINANCE_BUCKET_LABELS: Record<FinanceBucket, string> = {
  parents_pay: 'Covered',
  budget: 'Budget',
  i_pay: 'I pay',
  not_spending: 'Not spending',
};
export const isFinanceBucket = (v: unknown): v is FinanceBucket =>
  typeof v === 'string' && (FINANCE_BUCKETS as string[]).includes(v);
// A membership test, not `!== 'not_spending'`, so a stray stored value is skipped rather than totalled.
export const isSpendBucket = (b: FinanceBucket): b is FinanceSpendBucket =>
  (FINANCE_SPEND_BUCKETS as string[]).includes(b);
// Both ApiClient impls check a written bucket with this, so they refuse the same values the same way.
export function financeBucketError(v: unknown, opts: { nullable: boolean }): string | null {
  if (v === null && opts.nullable) return null;
  return isFinanceBucket(v) ? null : `Unknown bucket: ${String(v)}`;
}

export type FinanceSource = 'plaid'; // 'csv' reserved
export type FinancePeriodOverride = 'current' | 'previous';
// A split part's own period: this, last, or the period after the charge's own (it waits, in no
// total, until that period starts — the day after you mark the card payment). null = the charge's.
export type FinancePartPeriod = 'current' | 'previous' | 'next';
export const FINANCE_PART_PERIODS: FinancePartPeriod[] = ['current', 'previous', 'next'];

// One part of a charge split across buckets. The parts sum exactly to the charge. A rule-made split
// carries `percent` on every part (the key is omitted otherwise), so a new amount recomputes it.
export interface FinanceSplitPart {
  bucket: FinanceBucket;
  cents: number; // integer > 0
  period: FinancePartPeriod | null;
  percent?: number;
}
// One charge a refund (money in) is allocated to, and how much of the refund goes to it.
export interface FinanceRefundPart {
  chargeId: string;
  cents: number; // integer > 0
}
export interface FinanceRuleSplitPart {
  bucket: FinanceBucket;
  percent: number; // integer 1–99; a rule's parts sum to 100
}
export const FINANCE_SPLIT_MAX_PARTS = 8;
export const FINANCE_REFUND_MAX_PARTS = 8;
export const FINANCE_RULE_SPLIT_MAX_PARTS = 4;
export type FinanceSignOverride = 'auto' | 'flip';
export type PlaidEnvironment = 'sandbox' | 'production' | 'stub';
export type FinanceItemStatus = 'ok' | 'login_required' | 'pending_disconnect' | 'error';

// One bank login. id = Plaid item_id (not a ULID — Plaid owns the identity).
export interface FinanceItem extends BaseEntity {
  institutionId: string;
  institutionName: string;
  status: FinanceItemStatus;
  errorCode: string | null;
  consentExpiresAt: number | null;
  lastSuccessfulUpdateAt: number | null;
  lastFailedUpdateAt: number | null;
  consentedProducts: string[];
}

// Per-item sync bookkeeping. id = itemId. The cursor is saved only after has_more=false.
export interface FinanceSyncState extends BaseEntity {
  itemId: string;
  cursor: string | null;
  lastSyncedAt: number | null;
  lastSyncError: string | null; // the Plaid error code of the last failed run; null after a success
  lastSyncErrorAt: number | null; // when that run failed — lets the page tell a new failure from an old one
  syncRequestedAt: number | null;
  refreshRequestedAt: number | null;
  // The start of the pass that claimed the latest refresh. A refresh is due while
  // refreshRequestedAt > lastRefreshedAt — decided from stored state, so whichever run holds the lock
  // does it (a scheduled run that beats the Refresh button's own invoke still refreshes).
  lastRefreshedAt: number | null;
  lockedUntil: number | null;
}

// id = Plaid account_id.
export interface FinanceAccount extends BaseEntity {
  itemId: string;
  name: string;
  officialName: string | null;
  mask: string | null;
  type: string; // depository | credit | …
  subtype: string | null;
  isoCurrency: string | null;
  currentCents: number | null;
  availableCents: number | null;
  balanceAt: number | null;
  signOverride: FinanceSignOverride;
  hidden: boolean;
}

// id = Plaid transaction_id. Plaid owns everything above `source`; the user owns everything after it,
// which a sync never overwrites and which carries from a pending row to its posted replacement.
export interface FinanceTransaction extends BaseEntity {
  itemId: string;
  accountId: string;
  date: string; // YYYY-MM-DD
  authorizedDate: string | null;
  name: string;
  merchantName: string | null;
  rawAmountCents: number;
  isoCurrency: string | null;
  pending: boolean;
  pendingTransactionId: string | null;
  pfcPrimary: string | null;
  pfcDetailed: string | null;
  paymentChannel: string | null;
  source: FinanceSource;
  bucket: FinanceBucket | null;
  bucketSetBy: 'user' | 'rule' | null;
  periodOverride: FinancePeriodOverride | null;
  note: string | null;
  // User-owned, like bucket: the charge this card credit reverses. Sync never writes it (it only
  // carries it pending→posted). May still name a charge's old pending id — resolveRefundLinks
  // follows pendingTransactionId, so a link survives the charge posting.
  refundOfId: string | null;
  // User-owned: this card payment ends a billing period (the next starts the day after). Trusted only
  // while periodStartError passes — a flipped or moved row stops anchoring the period.
  startsPeriod: boolean;
  // User-owned: a charge split across buckets (bucket stays null). Counts only while the parts sum to
  // the charge's amount (splitOf); a new amount breaks it back into the sort queue. null = unsplit.
  splits: FinanceSplitPart[] | null;
  // User-owned: money in allocated across several charges. Exclusive with refundOfId (one link stays
  // refundOfId, read exactly as before). null = no allocation.
  refundParts: FinanceRefundPart[] | null;
}

// "Always put <pattern> in <bucket>". pattern is lowercased and matched as a substring. With `split`,
// new matching charges arrive split by percent instead; `bucket` is then the largest part.
export interface FinanceRule extends BaseEntity {
  pattern: string;
  bucket: FinanceBucket;
  active: boolean;
  split: FinanceRuleSplitPart[] | null;
}

// --- DTOs ------------------------------------------------------------------
// marked = the payment you marked; payment_day = no mark yet, so the calendar day after your payment day.
export type FinancePeriodSource = 'marked' | 'payment_day';

export interface FinancePeriod {
  start: string;
  end: string; // today — the period is open until the next payment
  dayCount: number;
  source: FinancePeriodSource;
  lastPaymentDate: string | null; // the marked payment's date; null on the payment-day fallback
  previous: { start: string; end: string };
}

// One item's sync stamps. Both are the START time of the run that set them (a success or a failure),
// so a request that lands mid-run is newer than either and keeps the overview `syncing`.
export interface FinanceItemSync {
  itemId: string;
  lastSyncedAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
}

export interface FinanceBucketTotal {
  totalCents: number;
  count: number;
}

export interface FinanceOverview {
  period: FinancePeriod;
  budgetCents: number;
  spentCents: number; // the budget bucket's total
  leftCents: number; // budgetCents - spentCents (negative = over)
  buckets: Record<FinanceSpendBucket, FinanceBucketTotal>; // not_spending is in no total
  // Split parts set to the next period that hasn't started yet: in no total until it does. count = charges.
  upcoming: FinanceBucketTotal;
  unsortedCount: number; // current AND previous window — both are sortable
  unsortedCents: number;
  accounts: FinanceAccount[];
  items: FinanceItem[];
  sync: {
    lastSyncedAt: number | null;
    syncing: boolean;
    lastError: string | null; // a Plaid error code — financeSyncErrorMessage turns it into words
    lastErrorAt: number | null;
    items: FinanceItemSync[]; // per bank login — the page decides and names failures per item
    environment: PlaidEnvironment;
  };
}

export interface LinkAccountMeta {
  id: string;
  name: string;
  mask: string | null;
  type: string;
  subtype: string | null;
}
export interface ExchangePublicTokenInput {
  publicToken: string;
  institution: { id: string; name: string };
  accounts: LinkAccountMeta[];
}
export type CreateLinkTokenInput = { mode: 'connect' } | { mode: 'update'; itemId: string };
export interface LinkTokenResult {
  linkToken: string;
  environment: PlaidEnvironment;
}
export interface SetFinanceBucketInput {
  ids: string[];
  bucket: FinanceBucket | null;
  rule?: { pattern: string }; // "Always": also save a rule and apply it to every unsorted match
}
export interface UpsertFinanceRuleInput {
  id?: string;
  pattern: string;
  bucket: FinanceBucket;
  active?: boolean;
  // null = a one-bucket rule; else bucket = its largest part. Omitted keeps a split rule's split while
  // the bucket is unchanged (a Pause, or an older client that doesn't know splits), else one bucket.
  split?: FinanceRuleSplitPart[] | null;
}
// A user's split part over the wire: never `percent` (an edit overrides a rule's split).
export type FinanceSplitPartInput = Omit<FinanceSplitPart, 'percent'>;
export type FinanceAccountPatch = Partial<Pick<FinanceAccount, 'signOverride' | 'hidden'>>;
export interface RequestFinanceSyncResult {
  accepted: boolean;
  nextAllowedAt: number | null;
}

// --- Constants -------------------------------------------------------------
export const FINANCE_DEFAULT_BUDGET_CENTS = 50_000;
export const FINANCE_DEFAULT_PAYMENT_DAY = 1;
export const FINANCE_REFRESH_COOLDOWN_MS = 5 * 60_000;
export const FINANCE_REFRESH_POLL_MS = 20_000;
export const FINANCE_REFRESH_POLL_MAX_MS = 4 * 60_000;
export const FINANCE_SYNC_LOCK_MS = 5 * 60_000;
// The sync Lambda's own timeout (300 s) plus the refresh poll ceiling — past this a request is dead.
export const FINANCE_SYNCING_MAX_MS = 5 * 60_000 + FINANCE_REFRESH_POLL_MAX_MS;
export const PAYMENT_MATCH_WINDOW_DAYS = 3;
// How far back a refund looks for the charge it reverses.
export const REFUND_MATCH_WINDOW_DAYS = 90;
// Bank dates are posting dates, so a same-day return can post before its charge does.
export const REFUND_DATE_SLACK_DAYS = 3;
// A charge is still suggested when the refund overshoots it by at most this share of the charge (a
// reimbursement rounded up). The server takes any size; the overshoot never counts (capRefunds).
export const REFUND_OVER_RATIO = 0.1;
export const SYNC_PAGE_COUNT = 500;
// How far back the overview reads: two billing periods plus slack. A mark older than this isn't
// loaded, so the period falls back to the payment day.
export const FINANCE_OVERVIEW_LOOKBACK_DAYS = 120;
const CC_PAYMENT_PFC = 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT';

// --- Sign + classification -------------------------------------------------
export function normalizeAmountCents(rawCents: number, signOverride: FinanceSignOverride): number {
  if (signOverride !== 'flip' || rawCents === 0) return rawCents;
  return -rawCents;
}

export function amountOf(txn: FinanceTransaction, account: FinanceAccount | undefined): number {
  return normalizeAmountCents(txn.rawAmountCents, account?.signOverride ?? 'auto');
}

// expense = money out; refund = money back onto a card (sorted like a charge, and nets against its
// bucket); income = money into a bank account; transfer / card_payment = moving your own money.
export type FinanceTxnKind = 'expense' | 'refund' | 'income' | 'transfer' | 'card_payment';
export const isSortableKind = (k: FinanceTxnKind): boolean => k === 'expense' || k === 'refund';
export type InternalMoves = Map<string, 'transfer' | 'card_payment'>;

// Card payments and own-account transfers, found by pairing a depository outflow with an inflow of
// the same size on another linked account within PAYMENT_MATCH_WINDOW_DAYS (nearest date wins). A
// pair needs at least one side whose PFC says payment/transfer — otherwise a $25 Venmo and a $25
// card refund two days apart would pair up as a payment. A card credit you marked as the period's
// payment passes that gate too, so its checking side stops reading as a charge. An unpaired row whose
// PFC says credit-card payment still counts as one — the "hint". Returns every id involved (both sides of a pair). None of
// this sets the billing period — you mark that payment; this only suggests it.
export function detectInternalMoves(
  txns: FinanceTransaction[],
  accounts: FinanceAccount[],
): InternalMoves {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const moves: InternalMoves = new Map();
  const live = txns.filter((t) => t.deletedAt === null && byId.has(t.accountId));
  const outs = live
    .filter(
      (t) => byId.get(t.accountId)!.type === 'depository' && amountOf(t, byId.get(t.accountId)) > 0,
    )
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const ins = live
    .filter((t) => amountOf(t, byId.get(t.accountId)) < 0)
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const used = new Set<string>();

  for (const out of outs) {
    const size = amountOf(out, byId.get(out.accountId));
    let best: FinanceTransaction | null = null;
    let bestGap = Infinity;
    for (const inn of ins) {
      if (used.has(inn.id) || inn.accountId === out.accountId) continue;
      if (-amountOf(inn, byId.get(inn.accountId)) !== size) continue;
      if (!isMovePfc(out) && !isMovePfc(inn) && !isPeriodStart(inn, byId.get(inn.accountId)))
        continue;
      const gap = Math.abs(daysBetween(out.date, inn.date));
      if (gap > PAYMENT_MATCH_WINDOW_DAYS || gap >= bestGap) continue;
      best = inn;
      bestGap = gap;
    }
    if (!best) continue;
    used.add(best.id);
    const kind = byId.get(best.accountId)!.type === 'credit' ? 'card_payment' : 'transfer';
    moves.set(out.id, kind);
    moves.set(best.id, kind);
  }

  for (const t of live)
    if (!moves.has(t.id) && t.pfcDetailed === CC_PAYMENT_PFC) moves.set(t.id, 'card_payment');
  return moves;
}

const MOVE_PFC_PRIMARIES = new Set(['LOAN_PAYMENTS', 'TRANSFER_IN', 'TRANSFER_OUT']);
const isMovePfc = (t: FinanceTransaction) =>
  t.pfcPrimary !== null && MOVE_PFC_PRIMARIES.has(t.pfcPrimary);

export function classifyTransaction(
  txn: FinanceTransaction,
  account: FinanceAccount | undefined,
  moves: InternalMoves,
): FinanceTxnKind {
  if (isPeriodStart(txn, account)) return 'card_payment'; // a payment by your declaration
  const move = moves.get(txn.id);
  if (move) return move;
  if (amountOf(txn, account) > 0) return 'expense';
  return account?.type === 'credit' ? 'refund' : 'income';
}

// --- Billing period --------------------------------------------------------
// Why this row can't start a period, or null. A period starts at money coming IN to a card — the card
// side of a payment. A hidden card still counts: hiding it mustn't move the boundary.
export function periodStartError(
  txn: FinanceTransaction,
  account: FinanceAccount | undefined,
): string | null {
  if (txn.deletedAt !== null) return 'That transaction is gone';
  if (!account || account.deletedAt !== null) return 'That account is gone';
  if (account.type !== 'credit') return 'Only a card payment can start a period';
  if (amountOf(txn, account) >= 0)
    return 'A period starts at money coming in to the card — a payment, not a charge';
  return null;
}

export const isPeriodStart = (txn: FinanceTransaction, account: FinanceAccount | undefined) =>
  txn.startsPeriod && periodStartError(txn, account) === null;

function parts(key: string): [number, number, number] {
  const p = key.split('-');
  return [Number(p[0]), Number(p[1]), Number(p[2])];
}
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
function daysInMonth(y: number, m: number): number {
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${pad2(m + 1)}-01`;
  return daysBetween(`${y}-${pad2(m)}-01`, next);
}
// The day after `paymentDay` in the given month, clamped (day 31 in February → Mar 1).
function cycleStartIn(y: number, m: number, paymentDay: number): string {
  return addDays(`${y}-${pad2(m)}-${pad2(Math.min(paymentDay, daysInMonth(y, m)))}`, 1);
}
function prevMonth(y: number, m: number): [number, number] {
  return m === 1 ? [y - 1, 12] : [y, m - 1];
}
// The same day one month earlier, clamped (Mar 31 → Feb 28).
function monthBefore(key: string): string {
  const [y, m, d] = parts(key);
  const [py, pm] = prevMonth(y, m);
  return `${py}-${pad2(pm)}-${pad2(Math.min(d, daysInMonth(py, pm)))}`;
}

// Fallback: the period that started the day after the last `paymentDay` on or before today.
function calendarStart(today: string, paymentDay: number): string {
  const [y, m] = parts(today);
  const thisMonth = cycleStartIn(y, m, paymentDay);
  if (thisMonth <= today) return thisMonth;
  const [py, pm] = prevMonth(y, m);
  return cycleStartIn(py, pm, paymentDay);
}

// The current period starts the day after the newest payment you marked (dated on or before today)
// and runs to today; `previous` runs from the mark before it, or one month back when there isn't one.
// No mark → the day after your payment day.
export function computeFinancePeriod(input: {
  today: string;
  accounts: FinanceAccount[];
  txns: FinanceTransaction[];
  paymentDay: number;
}): FinancePeriod {
  const { today, accounts, txns, paymentDay } = input;
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const marks = [
    ...new Set(
      txns
        .filter((t) => t.date <= today && isPeriodStart(t, byId.get(t.accountId)))
        .map((t) => t.date),
    ),
  ].sort();
  const last = marks.at(-1);

  if (last === undefined) {
    const start = calendarStart(today, paymentDay);
    const prevStart = calendarStart(addDays(start, -1), paymentDay);
    return {
      start,
      end: today,
      dayCount: daysBetween(start, today) + 1,
      source: 'payment_day',
      lastPaymentDate: null,
      previous: { start: prevStart, end: addDays(start, -1) },
    };
  }

  const start = addDays(last, 1);
  const end = start > today ? start : today; // paid today → an empty period that starts tomorrow
  const prior = marks.at(-2);
  return {
    start,
    end,
    dayCount: daysBetween(start, end) + 1,
    source: 'marked',
    lastPaymentDate: last,
    previous: { start: prior ? addDays(prior, 1) : monthBefore(start), end: last },
  };
}

// The newest unmarked payment the page recognises (the card side of a detected payment) dated after
// `after` and on or before today — offered as a one-click mark, never applied on its own. A payment
// within PAYMENT_MATCH_WINDOW_DAYS of the last mark is that same payment seen twice (a posted copy
// whose pending row carried no link), not a new cycle.
export function suggestPeriodStart(input: {
  txns: FinanceTransaction[];
  accounts: FinanceAccount[];
  moves: InternalMoves;
  after: string | null;
  today: string;
}): FinanceTransaction | null {
  const { txns, accounts, moves, after, today } = input;
  const byId = new Map(accounts.map((a) => [a.id, a]));
  let best: FinanceTransaction | null = null;
  for (const t of txns) {
    const account = byId.get(t.accountId);
    if (t.startsPeriod || moves.get(t.id) !== 'card_payment') continue;
    if (periodStartError(t, account) !== null) continue;
    if (t.date > today) continue;
    if (after !== null && daysBetween(after, t.date) <= PAYMENT_MATCH_WINDOW_DAYS) continue;
    if (!best || t.date > best.date || (t.date === best.date && t.id > best.id)) best = t;
  }
  return best;
}

// Which window a transaction counts in. An override moves a charge across the boundary; anything
// outside both windows is ignored, override or not. A linked refund counts wherever its charge does.
export function periodOf(
  txn: FinanceTransaction,
  period: FinancePeriod,
  links?: RefundLinks,
): 'current' | 'previous' | null {
  const charge = links?.get(txn.id);
  if (charge) return periodOf(charge, period);
  const inCurrent = txn.date >= period.start && txn.date <= period.end;
  const inPrevious = txn.date >= period.previous.start && txn.date <= period.previous.end;
  if (!inCurrent && !inPrevious) return null;
  if (txn.periodOverride) return txn.periodOverride;
  return inCurrent ? 'current' : 'previous';
}

// --- Overview --------------------------------------------------------------
function onShownAccounts(
  txns: FinanceTransaction[],
  accounts: FinanceAccount[],
  moves: InternalMoves,
  keep: (k: FinanceTxnKind) => boolean,
): FinanceTransaction[] {
  const visible = new Map(
    accounts.filter((a) => a.deletedAt === null && !a.hidden).map((a) => [a.id, a]),
  );
  return txns.filter(
    (t) =>
      t.deletedAt === null &&
      visible.has(t.accountId) &&
      keep(classifyTransaction(t, visible.get(t.accountId), moves)),
  );
}

// The sortable rows: alive, on a visible account, and a charge or card refund (not a payment/transfer).
export const sortableTransactions = (
  txns: FinanceTransaction[],
  accounts: FinanceAccount[],
  moves: InternalMoves,
) => onShownAccounts(txns, accounts, moves, isSortableKind);

// Rows a refund link can touch: the sortable set plus deposits (money into checking/savings, which
// counts only once you link it to the charge it reverses). Never a payment or transfer.
export const linkableTransactions = (
  txns: FinanceTransaction[],
  accounts: FinanceAccount[],
  moves: InternalMoves,
) => onShownAccounts(txns, accounts, moves, (k) => isSortableKind(k) || k === 'income');

// --- Refund links -----------------------------------------------------------
// A refund reaches its charges two ways: one link (refundOfId — the whole refund, as it always was)
// or an allocation across charges (refundParts — each part a set amount). Both resolve to claims:
// refund id → [{charge, cents}], cents null for the whole refund. A claim whose charge went
// pending→posted resolves through the posted row's pendingTransactionId. Only rows in `txns` resolve:
// a charge outside the loaded window, tombstoned, or filtered out (a hidden account) drops that claim,
// and a refund with no claim left reads as unlinked. Signs are re-checked with `amount`, so flipping
// an account can't leave a stale link on a charge.
export interface RefundClaim {
  charge: FinanceTransaction;
  cents: number | null; // null = the whole refund (a single link)
}
export type RefundClaims = Map<string, RefundClaim[]>;
// refund id → its primary charge (the single link, or the first stored part — the largest): where the
// refund is listed, and the period and bucket a single link takes.
export type RefundLinks = Map<string, FinanceTransaction>;

export function resolveRefundClaims(
  txns: FinanceTransaction[],
  amount: (t: FinanceTransaction) => number = (t) => t.rawAmountCents,
): RefundClaims {
  const live = txns.filter((t) => t.deletedAt === null);
  const byId = new Map(live.map((t) => [t.id, t]));
  const byPending = new Map(
    live.filter((t) => t.pendingTransactionId).map((t) => [t.pendingTransactionId!, t]),
  );
  const claims: RefundClaims = new Map();
  for (const t of live) {
    const parts: { chargeId: string; cents: number | null }[] | null =
      liveRefundParts(t) ?? (t.refundOfId ? [{ chargeId: t.refundOfId, cents: null }] : null);
    if (!parts || amount(t) >= 0) continue;
    const found: RefundClaim[] = [];
    for (const p of parts) {
      const charge = byId.get(p.chargeId) ?? byPending.get(p.chargeId);
      if (!charge || charge.id === t.id || amount(charge) <= 0) continue;
      if (found.some((c) => c.charge.id === charge.id)) continue;
      found.push({ charge, cents: p.cents });
    }
    if (found.length > 0) claims.set(t.id, found);
  }
  return claims;
}

export const linksOf = (claims: RefundClaims): RefundLinks =>
  new Map([...claims].map(([id, cs]) => [id, cs[0]!.charge]));

export function resolveRefundLinks(
  txns: FinanceTransaction[],
  amount: (t: FinanceTransaction) => number = (t) => t.rawAmountCents,
): RefundLinks {
  return linksOf(resolveRefundClaims(txns, amount));
}

// The claims with one refund's left out — what's left of each charge for that refund to take.
export const claimsWithout = (claims: RefundClaims, refundId: string): RefundClaims =>
  new Map([...claims].filter(([id]) => id !== refundId));

// A linked refund takes its charge's bucket — explicitly, so an unsorted charge yields null. A split
// charge (and so a refund on it) has no single bucket: null here; bucketsOf lists its parts'.
export function bucketOf(t: FinanceTransaction, links: RefundLinks): FinanceBucket | null {
  const charge = links.get(t.id);
  return charge ? charge.bucket : t.bucket;
}

// Needs a decision from you: no bucket, not riding on a charge, and not split (at this amount).
export function isUnsorted(t: FinanceTransaction, links: RefundLinks, cents: number): boolean {
  return !links.has(t.id) && t.bucket === null && splitOf(t, cents) === null;
}

// Each claim counts in date order of its refund (then id), only up to what's left of the charge, so
// charge + refunds net to exactly $0, never below; and a refund's parts together never count more than
// the refund itself (a stale allocation after its amount changed). byCharge: charge id → cents refunded
// (≤ the charge); byRefund: refund id → the cents it counts in all (positive, ≤ its own size); byClaim:
// refund id → charge id → the cents that claim counts. The overshoot stays money in, outside every total.
export function capRefunds(
  claims: RefundClaims,
  txnsById: Map<string, FinanceTransaction>,
  amount: (t: FinanceTransaction) => number,
): {
  byCharge: Map<string, number>;
  byRefund: Map<string, number>;
  byClaim: Map<string, Map<string, number>>;
} {
  const perCharge = new Map<
    string,
    { charge: FinanceTransaction; asks: { refund: FinanceTransaction; cents: number }[] }
  >();
  for (const [refundId, cs] of claims) {
    const refund = txnsById.get(refundId);
    if (!refund) continue;
    let size = Math.max(-amount(refund), 0);
    for (const c of cs) {
      const cents = Math.min(c.cents ?? size, size);
      size -= cents;
      const entry = perCharge.get(c.charge.id) ?? { charge: c.charge, asks: [] };
      entry.asks.push({ refund, cents });
      perCharge.set(c.charge.id, entry);
    }
  }
  const byCharge = new Map<string, number>();
  const byRefund = new Map<string, number>();
  const byClaim = new Map<string, Map<string, number>>();
  for (const { charge, asks } of perCharge.values()) {
    asks.sort(
      (a, b) =>
        a.refund.date.localeCompare(b.refund.date) || a.refund.id.localeCompare(b.refund.id),
    );
    let left = Math.max(amount(charge), 0);
    for (const { refund, cents } of asks) {
      const counted = Math.min(cents, left);
      byRefund.set(refund.id, (byRefund.get(refund.id) ?? 0) + counted);
      const mine = byClaim.get(refund.id) ?? new Map<string, number>();
      mine.set(charge.id, counted);
      byClaim.set(refund.id, mine);
      left -= counted;
    }
    byCharge.set(charge.id, Math.max(amount(charge), 0) - left);
  }
  return { byCharge, byRefund, byClaim };
}

// charge id → cents refunded (positive), capped at the charge.
export const refundedCentsByCharge = (
  claims: RefundClaims,
  txnsById: Map<string, FinanceTransaction>,
  amount: (t: FinanceTransaction) => number,
): Map<string, number> => capRefunds(claims, txnsById, amount).byCharge;

// --- Allocation: an amount split across targets ------------------------------
// `total` cents shared in proportion to `weights`: each share floored, then the leftover cents go one
// each to the largest remainders, ties to the earlier part — so the shares sum to `total` exactly, and
// no share exceeds its weight while total ≤ the weights' sum. The one rounding rule for a half/half
// default (the odd cent goes to the first part), a rule's percents, and a refund across a split's parts.
export function allocateProportional(total: number, weights: number[]): number[] {
  const sum = weights.reduce((n, w) => n + Math.max(w, 0), 0);
  if (sum <= 0 || total <= 0) return weights.map(() => 0);
  const shares = weights.map((w) => Math.floor((total * Math.max(w, 0)) / sum));
  const rest = weights.map((w, i) => total * Math.max(w, 0) - shares[i]! * sum);
  let left = total - shares.reduce((n, c) => n + c, 0);
  const order = rest.map((r, i) => ({ r, i })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    shares[i]! += 1;
    left -= 1;
  }
  return shares;
}

// Cents as "$12.34" for refusal text (the page's own formatter is app money.ts).
export const usdText = (cents: number): string =>
  `$${(Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Why these part amounts don't fit `total`, or null. exact: a split, whose parts must add up to the
// charge; otherwise a refund's allocation, which may leave some of the refund over (it stays money in).
export function allocationSumError(
  cents: number[],
  total: number,
  opts: { exact: boolean },
): string | null {
  if (cents.some((c) => !Number.isInteger(c) || c <= 0))
    return 'Each part needs an amount above $0.00';
  const sum = cents.reduce((n, c) => n + c, 0);
  if (opts.exact && sum < total)
    return `${usdText(total - sum)} is left to assign — the parts must add up to ${usdText(total)}`;
  if (sum > total)
    return opts.exact
      ? `The parts add up to ${usdText(sum)}, ${usdText(sum - total)} more than the ${usdText(total)} charge`
      : `The charges take ${usdText(sum)}, ${usdText(sum - total)} more than the ${usdText(total)} refund`;
  return null;
}

// The stored fields as they stand. Newer code never writes a split beside a bucket or a period mark, nor
// refund parts beside a single link, a bucket, a period pin or a mark — so such a pair comes from an older
// write (code from before splits, after a revert), and that newer write wins. A split also needs the
// `bucketSetBy` every newer split sets ('user' from the editor, 'rule' at sync): an older unsort, mark or
// link nulls it, so its undo can't bring the split back. One judgment, two places: the server applies it
// as it reads a row (normalizeFinanceTxn in toFinanceTxn), so server code reads plain fields; the client
// and the shared derivations read through these, since a cached PWA can meet a reverted BFF's raw rows.
// `?.` because a row from an older server has no key at all.
export const liveSplits = (t: FinanceTransaction): FinanceSplitPart[] | null =>
  t.splits?.length && t.bucket === null && !t.startsPeriod && t.bucketSetBy != null
    ? t.splits
    : null;
export const liveRefundParts = (t: FinanceTransaction): FinanceRefundPart[] | null =>
  t.refundParts?.length &&
  t.refundOfId === null &&
  t.bucket === null &&
  t.periodOverride === null &&
  !t.startsPeriod
    ? t.refundParts
    : null;
// A rule's split, unless an older write retargeted the rule's bucket away from the split's largest part.
export const ruleSplitOf = (r: FinanceRule): FinanceRuleSplitPart[] | null =>
  r.split?.length && r.bucket === ruleSplitBucket(r.split) ? r.split : null;
// A row with any stale field dropped (and missing keys read as none) — what the server's reads return.
export const normalizeFinanceTxn = (t: FinanceTransaction): FinanceTransaction => ({
  ...t,
  splits: liveSplits(t),
  refundParts: liveRefundParts(t),
});
export const normalizeFinanceRule = (r: FinanceRule): FinanceRule => ({
  ...r,
  split: ruleSplitOf(r),
});
// A refund's parts with each charge id as it stands now: a part saved on a pending charge names the
// posted row once Plaid posts it (its pendingTransactionId).
export function resolveRefundPartIds(
  parts: FinanceRefundPart[],
  txns: FinanceTransaction[],
): FinanceRefundPart[] {
  const posted = new Map(
    txns
      .filter((t) => t.deletedAt === null && t.pendingTransactionId)
      .map((t) => [t.pendingTransactionId!, t.id]),
  );
  return parts.map((p) => ({ chargeId: posted.get(p.chargeId) ?? p.chargeId, cents: p.cents }));
}

// The split that counts for this charge at `cents` (its normalised amount), or null: unsplit, or
// broken — the parts no longer add up to the amount (it posted at a new amount, or its account
// flipped). A broken split reads as unsorted and keeps its parts to prefill the editor. A rule-made
// split (percent on every part) recomputes from the percents instead of breaking.
export function splitOf(t: FinanceTransaction, cents: number): FinanceSplitPart[] | null {
  const parts = liveSplits(t);
  if (!parts || cents <= 0) return null;
  if (parts.every((p) => p.percent !== undefined)) {
    const shares = allocateProportional(
      cents,
      parts.map((p) => p.percent!),
    );
    return parts.map((p, i) => ({ ...p, cents: shares[i]! }));
  }
  return parts.reduce((n, p) => n + p.cents, 0) === cents ? parts : null;
}

export const splitBroken = (t: FinanceTransaction, cents: number): boolean =>
  liveSplits(t) !== null && splitOf(t, cents) === null;

// What a stored split added up to — the "was $X" of a broken one.
export const splitTotal = (parts: Pick<FinanceSplitPart, 'cents'>[]): number =>
  parts.reduce((n, p) => n + p.cents, 0);

// Rule percents → stored parts for a charge of `cents` (> 0).
export function splitFromRule(split: FinanceRuleSplitPart[], cents: number): FinanceSplitPart[] {
  const shares = allocateProportional(
    cents,
    split.map((p) => p.percent),
  );
  return split.map((p, i) => ({
    bucket: p.bucket,
    cents: shares[i]!,
    period: null,
    percent: p.percent,
  }));
}

// Charges this refund could reverse, best first: an alive expense at the same merchant, dated at most
// REFUND_DATE_SLACK_DAYS after the refund and REFUND_MATCH_WINDOW_DAYS before it, with enough left
// unrefunded to cover it — or overshot by at most REFUND_OVER_RATIO of the charge (a rounded-up
// reimbursement). Works for card credits and checking/savings deposits alike.
// Ranked: same account → closest either way (exact first; under beats over) → nearer date → posted →
// id. `anyMerchant` drops the merchant match — the fallback when a card credit's descriptor doesn't
// match its charge.
export function suggestRefundMatches(input: {
  refund: FinanceTransaction;
  txns: FinanceTransaction[];
  accounts: FinanceAccount[];
  moves: InternalMoves;
  claims: RefundClaims;
  anyMerchant?: boolean;
}): FinanceTransaction[] {
  const { refund, txns, accounts, moves, claims, anyMerchant = false } = input;
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const amount = (t: FinanceTransaction) => amountOf(t, byId.get(t.accountId));
  const refunded = refundedCentsByCharge(
    claimsWithout(claims, refund.id),
    new Map(txns.map((t) => [t.id, t])),
    amount,
  );
  const size = -amount(refund);
  const key = merchantKey(refund);
  const scored = txns
    .filter(
      (c) =>
        c.id !== refund.id &&
        chargeSideError(c, byId.get(c.accountId), moves) === null &&
        (anyMerchant || merchantKey(c) === key) &&
        c.date <= addDays(refund.date, REFUND_DATE_SLACK_DAYS) &&
        daysBetween(c.date, refund.date) <= REFUND_MATCH_WINDOW_DAYS,
    )
    .map((c) => {
      const remaining = amount(c) - (refunded.get(c.id) ?? 0);
      return { c, remaining, left: remaining - size };
    })
    .filter((x) => x.remaining > 0 && (x.left >= 0 || -x.left <= amount(x.c) * REFUND_OVER_RATIO));
  const rank = (x: { c: FinanceTransaction; left: number }) => [
    x.c.accountId === refund.accountId ? 0 : 1,
    Math.abs(x.left),
    x.left < 0 ? 1 : 0,
    Math.abs(daysBetween(x.c.date, refund.date)),
    x.c.pending ? 1 : 0,
  ];
  return scored
    .sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i]! - rb[i]!;
      return a.c.id.localeCompare(b.c.id);
    })
    .map((x) => x.c);
}

// The search under the suggestions, for the charge they miss: any merchant, any age in the loaded
// range, any size (the overshoot never counts — capRefunds). Still only what refundLinkError accepts,
// and only with something left to refund. Matches a case-insensitive substring of the merchant, the
// bank's text, the note, or the dollar amount ("30.00", "$800.50"). Newest first, then id; a blank
// query lists every such charge.
export function searchRefundCharges(input: {
  refund: FinanceTransaction;
  txns: FinanceTransaction[];
  accounts: FinanceAccount[];
  moves: InternalMoves;
  claims: RefundClaims;
  query: string;
}): FinanceTransaction[] {
  const { refund, txns, accounts, moves, claims, query } = input;
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const amount = (t: FinanceTransaction) => amountOf(t, byId.get(t.accountId));
  const refunded = refundedCentsByCharge(
    claimsWithout(claims, refund.id),
    new Map(txns.map((t) => [t.id, t])),
    amount,
  );
  const needle = query.trim().toLowerCase();
  // "+$30.00" pasted from a row's signed amount still matches.
  const amountNeedle = needle.replace(/[+\-$,]/g, '');
  const matches = (c: FinanceTransaction) =>
    needle === '' ||
    matchesFinanceText(c, needle, { note: true }) ||
    // Cents as dollar text here too (app money.ts is the page's): integer cents ÷ 100 is exact at 2dp.
    (amountNeedle !== '' && (amount(c) / 100).toFixed(2).includes(amountNeedle));
  return txns
    .filter(
      (c) =>
        c.id !== refund.id &&
        chargeSideError(c, byId.get(c.accountId), moves) === null &&
        c.date <= addDays(refund.date, REFUND_DATE_SLACK_DAYS) &&
        amount(c) - (refunded.get(c.id) ?? 0) > 0 &&
        matches(c),
    )
    .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
}

const shownAccount = (a: FinanceAccount | undefined) =>
  a !== undefined && a.deletedAt === null && !a.hidden;
const moneyAccount = (a: FinanceAccount | undefined) =>
  a?.type === 'credit' || a?.type === 'depository';
const isMoveOrMark = (t: FinanceTransaction, moves: InternalMoves | undefined) =>
  isMovePfc(t) || t.startsPeriod || (moves?.has(t.id) ?? false);

// Why this row can't be the refund side of a link, or null: it must be alive money coming in on a
// shown card or bank account, and not a payment or period mark (a flipped card's dormant mark still
// counts — unmark it first). A transfer-tagged deposit (TRANSFER_IN) may be a refund — someone paying
// you back from an account you haven't linked — unless it paired as a move between your own accounts,
// which `moves` (when the caller has it) rules out. The page uses this to decide whether to offer
// linking at all.
export function refundSideError(
  refund: FinanceTransaction,
  account: FinanceAccount | undefined,
  moves?: InternalMoves,
): string | null {
  if (refund.deletedAt !== null) return 'That transaction is gone';
  if (!shownAccount(account)) return 'Both need to be on an account that’s shown in your totals';
  if (!moneyAccount(account) || amountOf(refund, account) >= 0)
    return 'Only money coming in — a card credit or a deposit — can be linked as a refund';
  if (refund.startsPeriod) return 'That’s the card payment that starts your period';
  if (moves?.has(refund.id) || (isMovePfc(refund) && refund.pfcPrimary !== 'TRANSFER_IN'))
    return 'A card payment or transfer isn’t a refund';
  return null;
}

// The charge side: alive money going out on a shown card or bank account, not a payment, transfer or
// period mark. suggestRefundMatches filters with this, so it never offers a link the server refuses.
export function chargeSideError(
  charge: FinanceTransaction,
  account: FinanceAccount | undefined,
  moves?: InternalMoves,
): string | null {
  if (charge.deletedAt !== null) return 'That transaction is gone';
  if (!shownAccount(account)) return 'Both need to be on an account that’s shown in your totals';
  if (!moneyAccount(account) || amountOf(charge, account) <= 0 || isMoveOrMark(charge, moves))
    return 'A refund can only reverse a charge — not a payment or transfer';
  return null;
}

// Structural checks both ApiClient impls run before linking; the error text, or null when valid: each
// side's own check, and the charge dated at most REFUND_DATE_SLACK_DAYS after its refund. Any size:
// a refund larger than what's left of its charge counts only up to it (capRefunds), so the overshoot
// is inert. Which charges to offer is the suggestions' and the search's job.
export function refundLinkError(input: {
  refund: FinanceTransaction;
  refundAccount: FinanceAccount | undefined;
  charge: FinanceTransaction;
  chargeAccount: FinanceAccount | undefined;
  moves?: InternalMoves;
}): string | null {
  const { refund, refundAccount, charge, chargeAccount, moves } = input;
  if (refund.id === charge.id) return 'A refund can’t reverse itself';
  const error =
    refundSideError(refund, refundAccount, moves) ?? chargeSideError(charge, chargeAccount, moves);
  if (error) return error;
  if (charge.date > addDays(refund.date, REFUND_DATE_SLACK_DAYS))
    return 'The charge has to come before its refund';
  return null;
}

// What the sort queue asks you about: unsorted, not riding on a charge, not split, and not a charge its
// linked refunds already cancel out in full (it nets to $0 whichever bucket it lands in).
export function needsSorting(
  t: FinanceTransaction,
  links: RefundLinks,
  refunded: Map<string, number>,
  cents: number,
): boolean {
  if (!isUnsorted(t, links, cents)) return false;
  return !(cents > 0 && (refunded.get(t.id) ?? 0) >= cents);
}

// --- Split parts: where each counts --------------------------------------------
// 'upcoming' = a next-period part whose period hasn't started: in no total yet.
export type FinancePartWindow = 'current' | 'previous' | 'upcoming';

// Which window a split part counts in. The part's own pin wins; with none (null) it follows the row,
// override and all. "next" is relative to the charge's own date window, never the row's override: a
// charge dated in the current window waits (upcoming), one dated in the previous window has already
// reached its next period, which is the current one — so the part lands by itself when you mark the
// payment that starts the new period. A charge outside both windows counts nowhere, pin or not.
export function periodOfPart(
  t: FinanceTransaction,
  part: Pick<FinanceSplitPart, 'period'>,
  period: FinancePeriod,
): FinancePartWindow | null {
  const own = periodOf({ ...t, periodOverride: null }, period);
  if (own === null) return null;
  if (part.period === null) return periodOf(t, period);
  if (part.period === 'next') return own === 'current' ? 'upcoming' : 'current';
  return part.period;
}

export interface CountedPart {
  bucket: FinanceBucket | null; // null = unsorted (an unsplit row with no bucket, or a broken split)
  cents: number;
  refundedCents: number; // this part's share of the charge's refunds (≤ cents)
  window: FinancePartWindow | null;
  pin: FinancePartPeriod | null; // the part's own period choice (null = with the charge)
}

// A row's money by part: a valid split gives one entry per part, anything else one entry for the row.
// The charge's (capped) refunded total is spread once across the parts in proportion to them
// (allocateProportional), so no part goes below $0; each share counts where its part does. A linked
// refund's money is inside its charge's entries — callers skip linked refunds.
export function countedParts(
  t: FinanceTransaction,
  cents: number,
  refunded: number,
  period: FinancePeriod,
): CountedPart[] {
  const split = splitOf(t, cents);
  if (!split)
    return [
      { bucket: t.bucket, cents, refundedCents: refunded, window: periodOf(t, period), pin: null },
    ];
  const shares = allocateProportional(
    Math.min(refunded, cents),
    split.map((p) => p.cents),
  );
  return split.map((p, i) => ({
    bucket: p.bucket,
    cents: p.cents,
    refundedCents: shares[i]!,
    window: periodOfPart(t, p, period),
    pin: p.period,
  }));
}

// Why these parts can't split this charge, or null. Both ApiClient impls run it, on the fresh row.
export function financeSplitError(input: {
  txn: FinanceTransaction;
  account: FinanceAccount | undefined;
  moves?: InternalMoves;
  parts: FinanceSplitPartInput[];
}): string | null {
  const { txn, account, moves, parts } = input;
  if (txn.deletedAt !== null) return 'That transaction is gone';
  if (!shownAccount(account)) return 'Only a charge on an account that’s shown can be split';
  const cents = amountOf(txn, account);
  if (!moneyAccount(account) || cents <= 0 || isMoveOrMark(txn, moves))
    return 'Only a charge can be split — not a refund, payment or transfer';
  if (parts.length < 2) return 'A split needs at least two parts';
  if (parts.length > FINANCE_SPLIT_MAX_PARTS)
    return `A split has at most ${FINANCE_SPLIT_MAX_PARTS} parts`;
  const seen = new Set<string>();
  for (const p of parts) {
    const bucketError = financeBucketError(p.bucket, { nullable: false });
    if (bucketError) return bucketError;
    if (p.period !== null && !FINANCE_PART_PERIODS.includes(p.period))
      return `Unknown period: ${String(p.period)}`;
    const key = `${p.bucket}|${p.period ?? ''}`;
    if (seen.has(key))
      return `Two parts go to ${FINANCE_BUCKET_LABELS[p.bucket]} in the same period — merge them`;
    seen.add(key);
  }
  return allocationSumError(
    parts.map((p) => p.cents),
    cents,
    { exact: true },
  );
}

// Why this allocation of a refund across charges can't be saved, or null. Both ApiClient impls run it
// over the same rows: `txns` = every alive row from refundPartsFrom(…) on, so each charge's other
// refunds are in view. Each part must be a link refundLinkError accepts, at most what's left of its
// charge after every OTHER refund (re-saving your own allocation is fine), and together at most the
// refund — what's over stays money in.
export function refundPartsError(input: {
  refund: FinanceTransaction;
  parts: FinanceRefundPart[];
  txns: FinanceTransaction[];
  accounts: FinanceAccount[];
  moves?: InternalMoves;
}): string | null {
  const { refund, txns, accounts, moves } = input;
  const parts = resolveRefundPartIds(input.parts, txns);
  const byAccount = new Map(accounts.map((a) => [a.id, a]));
  const amount = (t: FinanceTransaction) => amountOf(t, byAccount.get(t.accountId));
  if (parts.length === 0) return 'Pick at least one charge';
  if (parts.length > FINANCE_REFUND_MAX_PARTS)
    return `A refund goes to at most ${FINANCE_REFUND_MAX_PARTS} charges`;
  if (new Set(parts.map((p) => p.chargeId)).size !== parts.length)
    return 'That charge is already in the list';
  const byId = new Map(txns.filter((t) => t.deletedAt === null).map((t) => [t.id, t]));
  const linkable = linkableTransactions(txns, accounts, moves ?? new Map());
  const others = claimsWithout(resolveRefundClaims(linkable, amount), refund.id);
  const refunded = refundedCentsByCharge(others, new Map(linkable.map((t) => [t.id, t])), amount);
  for (const p of parts) {
    const charge = byId.get(p.chargeId);
    if (!charge) return 'That charge is gone';
    const error = refundLinkError({
      refund,
      refundAccount: byAccount.get(refund.accountId),
      charge,
      chargeAccount: byAccount.get(charge.accountId),
      moves,
    });
    if (error) return error;
    if (!Number.isInteger(p.cents) || p.cents <= 0) return 'Each part needs an amount above $0.00';
    const left = amount(charge) - (refunded.get(charge.id) ?? 0);
    if (p.cents > left)
      return `Only ${usdText(Math.max(left, 0))} is left to refund on ${charge.merchantName ?? charge.name}`;
  }
  return allocationSumError(
    parts.map((p) => p.cents),
    -amount(refund),
    { exact: false },
  );
}

// The first day both impls load rows from for refundPartsError: the overview's window, or earlier when a
// charge is older — a refund is dated at most REFUND_DATE_SLACK_DAYS before its charge.
export function refundPartsFrom(today: string, charges: FinanceTransaction[]): string {
  const from = addDays(today, -FINANCE_OVERVIEW_LOOKBACK_DAYS);
  const oldest = charges.reduce((d, c) => (c.date < d ? c.date : d), from);
  return oldest < from ? addDays(oldest, -REFUND_DATE_SLACK_DAYS) : from;
}

// Why setFinanceBucket refuses this row, or null: a split that still adds up is changed from its
// detail (Edit split / Remove split), never silently replaced by one bucket. A broken split may be sorted.
export function splitSortError(
  t: FinanceTransaction,
  account: FinanceAccount | undefined,
): string | null {
  return splitOf(t, amountOf(t, account))
    ? `${t.merchantName ?? t.name} is split — change it from its detail`
    : null;
}

// How both impls store an allocation: only the two fields, largest part first (the primary link —
// where the refund is listed), ties in the order given.
export const orderRefundParts = (parts: FinanceRefundPart[]): FinanceRefundPart[] =>
  parts.map((p) => ({ chargeId: p.chargeId, cents: p.cents })).sort((a, b) => b.cents - a.cents);

// A rule's stored fields from an upsert (over `existing`, the rule it updates), or a thrown refusal —
// both impls. A split rule's bucket is its largest part, so anything reading `bucket` alone still gets
// a sensible answer.
export function financeRuleFields(
  input: UpsertFinanceRuleInput,
  existing?: FinanceRule,
): Pick<FinanceRule, 'pattern' | 'bucket' | 'active' | 'split'> {
  const bucketError = financeBucketError(input.bucket, { nullable: false });
  if (bucketError) throw new Error(bucketError);
  const pattern = normalizeRulePattern(input.pattern);
  if (!pattern) throw new Error('A rule needs a pattern');
  const kept = existing?.split && existing.bucket === input.bucket ? existing.split : null;
  const split = input.split === undefined ? kept : input.split;
  if (split) {
    const splitError = financeRuleSplitError(split);
    if (splitError) throw new Error(splitError);
  }
  return {
    pattern,
    bucket: split ? ruleSplitBucket(split) : input.bucket,
    active: input.active ?? true,
    split: split ? split.map((p) => ({ bucket: p.bucket, percent: p.percent })) : null,
  };
}

export const REFUND_SET_POOL = 12;
export const REFUND_SET_SHOWN = 3;

// Sets of 2–3 charges one refund could cover together — what suggestRefundMatches can't offer when no
// single charge fits. Same rules per charge (alive, refundLinkError-clean, within the match window, with
// something left), but only charges whose remaining is below the refund, the REFUND_SET_POOL nearest in
// date (so a paycheck's search stays at most 286 sets). A set fits when its remaining sum equals the
// refund, or the refund overshoots it by at most REFUND_OVER_RATIO of it. Ranked: one merchant across
// the set → closest sum (exact first) → fewer charges → nearer newest date → ids. At most REFUND_SET_SHOWN.
export function suggestRefundSets(input: {
  refund: FinanceTransaction;
  txns: FinanceTransaction[];
  accounts: FinanceAccount[];
  moves: InternalMoves;
  claims: RefundClaims;
}): { charges: FinanceTransaction[]; cents: number[] }[] {
  const { refund, txns, accounts, moves, claims } = input;
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const amount = (t: FinanceTransaction) => amountOf(t, byId.get(t.accountId));
  const refunded = refundedCentsByCharge(
    claimsWithout(claims, refund.id),
    new Map(txns.map((t) => [t.id, t])),
    amount,
  );
  const size = -amount(refund);
  if (size <= 0) return [];
  const pool = txns
    .filter(
      (c) =>
        c.id !== refund.id &&
        chargeSideError(c, byId.get(c.accountId), moves) === null &&
        c.date <= addDays(refund.date, REFUND_DATE_SLACK_DAYS) &&
        daysBetween(c.date, refund.date) <= REFUND_MATCH_WINDOW_DAYS,
    )
    .map((c) => ({ c, left: amount(c) - (refunded.get(c.id) ?? 0) }))
    .filter((x) => x.left > 0 && x.left < size)
    .sort(
      (a, b) =>
        Math.abs(daysBetween(a.c.date, refund.date)) -
          Math.abs(daysBetween(b.c.date, refund.date)) || a.c.id.localeCompare(b.c.id),
    )
    .slice(0, REFUND_SET_POOL);
  const sets: { xs: typeof pool; sum: number }[] = [];
  const consider = (xs: typeof pool) => {
    const sum = xs.reduce((n, x) => n + x.left, 0);
    if (sum <= size && size - sum <= sum * REFUND_OVER_RATIO) sets.push({ xs, sum });
  };
  for (let i = 0; i < pool.length; i++)
    for (let j = i + 1; j < pool.length; j++) {
      consider([pool[i]!, pool[j]!]);
      for (let k = j + 1; k < pool.length; k++) consider([pool[i]!, pool[j]!, pool[k]!]);
    }
  const rank = (s: { xs: typeof pool; sum: number }) => [
    new Set(s.xs.map((x) => merchantKey(x.c))).size === 1 ? 0 : 1,
    size - s.sum,
    s.xs.length,
    Math.min(...s.xs.map((x) => Math.abs(daysBetween(x.c.date, refund.date)))),
  ];
  const ids = (s: { xs: typeof pool }) => s.xs.map((x) => x.c.id).join('|');
  return sets
    .sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i]! - rb[i]!;
      return ids(a).localeCompare(ids(b));
    })
    .slice(0, REFUND_SET_SHOWN)
    .map((s) => ({ charges: s.xs.map((x) => x.c), cents: s.xs.map((x) => x.left) }));
}

// A rule's percent split: 2–4 parts, whole percents 1–99 that sum to 100, distinct known buckets.
// The sum refusal on its own, so the Rules form can tell it from the others.
export const ruleSplitSumError = (sum: number) => `The parts add up to ${sum}%, not 100%`;
export function financeRuleSplitError(split: FinanceRuleSplitPart[]): string | null {
  if (split.length < 2) return 'A split needs at least two parts';
  if (split.length > FINANCE_RULE_SPLIT_MAX_PARTS)
    return `A rule splits into at most ${FINANCE_RULE_SPLIT_MAX_PARTS} parts`;
  const seen = new Set<FinanceBucket>();
  for (const p of split) {
    const bucketError = financeBucketError(p.bucket, { nullable: false });
    if (bucketError) return bucketError;
    if (seen.has(p.bucket)) return `${FINANCE_BUCKET_LABELS[p.bucket]} is in the split twice`;
    seen.add(p.bucket);
    if (!Number.isInteger(p.percent) || p.percent < 1 || p.percent > 99)
      return 'Each part needs a whole percent from 1 to 99';
  }
  const sum = split.reduce((n, p) => n + p.percent, 0);
  return sum === 100 ? null : ruleSplitSumError(sum);
}

// The rule's bucket when it splits: its largest part (the first on a tie).
export const ruleSplitBucket = (split: FinanceRuleSplitPart[]): FinanceBucket =>
  split.reduce((best, p) => (p.percent > best.percent ? p : best), split[0]!).bucket;

export function summarizePeriod(input: {
  period: FinancePeriod;
  txns: FinanceTransaction[];
  accounts: FinanceAccount[];
  budgetCents: number;
}): Pick<
  FinanceOverview,
  | 'budgetCents'
  | 'spentCents'
  | 'leftCents'
  | 'buckets'
  | 'upcoming'
  | 'unsortedCount'
  | 'unsortedCents'
> {
  const { period, txns, accounts, budgetCents } = input;
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const moves = detectInternalMoves(txns, accounts);
  const buckets: Record<FinanceSpendBucket, FinanceBucketTotal> = {
    parents_pay: { totalCents: 0, count: 0 },
    budget: { totalCents: 0, count: 0 },
    i_pay: { totalCents: 0, count: 0 },
  };
  const upcoming: FinanceBucketTotal = { totalCents: 0, count: 0 };
  let unsortedCount = 0;
  let unsortedCents = 0;
  const amount = (t: FinanceTransaction) => amountOf(t, byId.get(t.accountId));
  const linkable = linkableTransactions(txns, accounts, moves);
  // Built over the linkable set, so a refund whose charge is on a hidden account counts as unlinked.
  const claims = resolveRefundClaims(linkable, amount);
  const links = linksOf(claims);
  const refunded = capRefunds(claims, new Map(linkable.map((t) => [t.id, t])), amount).byCharge;
  for (const t of linkable) {
    // A linked refund nets inside its charge's parts (countedParts), never on its own row. An unlinked
    // deposit is income, outside the budget.
    if (links.has(t.id)) continue;
    if (classifyTransaction(t, byId.get(t.accountId), moves) === 'income') continue;
    const cents = amount(t);
    const parts = countedParts(t, cents, refunded.get(t.id) ?? 0, period);
    const only = parts[0]!;
    if (parts.length === 1 && only.bucket === null) {
      if (only.window === null) continue;
      if (needsSorting(t, links, refunded, cents)) unsortedCount += 1;
      unsortedCents += only.cents - only.refundedCents;
      continue;
    }
    const counted = new Set<FinanceSpendBucket>();
    let waiting = false;
    for (const p of parts) {
      // not spending: no total, never to sort
      if (p.bucket === null || !isSpendBucket(p.bucket) || p.window === null) continue;
      if (p.window === 'current') {
        buckets[p.bucket].totalCents += p.cents - p.refundedCents;
        counted.add(p.bucket);
      } else if (p.window === 'upcoming') {
        upcoming.totalCents += p.cents - p.refundedCents;
        waiting = true;
      }
    }
    for (const b of counted) buckets[b].count += 1; // a charge counts once per bucket it lands in
    if (waiting) upcoming.count += 1;
  }
  const spentCents = buckets.budget.totalCents;
  return {
    budgetCents,
    spentCents,
    leftCents: budgetCents - spentCents,
    buckets,
    upcoming,
    unsortedCount,
    unsortedCents,
  };
}

// --- The page's view of the ledger -------------------------------------------
// The same window the server's overview reads (FINANCE_OVERVIEW_LOOKBACK_DAYS back from today), so a
// client's payment/transfer matching sees exactly the rows the server's did and the sort queue's count
// can't drift from the header's.
export function financeListRange(today: string, o: FinanceOverview): { from: string; to: string } {
  return {
    from: addDays(today, -FINANCE_OVERVIEW_LOOKBACK_DAYS),
    to: o.period.end > today ? o.period.end : today,
  };
}

// Not a DTO: carries functions, never serialized.
export interface FinanceView {
  accounts: Map<string, FinanceAccount>;
  moves: InternalMoves;
  txns: FinanceTransaction[]; // alive, inside the current or previous window, date desc
  allTxns: FinanceTransaction[]; // the whole loaded range — refund suggestions look back further
  sortable: FinanceTransaction[]; // allTxns on shown accounts, charges + refunds only
  amount: (t: FinanceTransaction) => number; // normalised: positive = money out
  kindOf: (t: FinanceTransaction) => FinanceTxnKind;
  links: RefundLinks; // refund id → its primary charge (where it's listed)
  claims: RefundClaims; // refund id → every charge it's linked or allocated to
  refunded: Map<string, number>; // charge id → cents refunded so far (capped at the charge)
  counted: Map<string, number>; // linked refund id → the cents it counts (≤ its size; capRefunds)
  countedByClaim: Map<string, Map<string, number>>; // refund id → charge id → the cents that claim counts
}

// The overview plus the transactions of financeListRange, with the derived bits every tab (and the MCP
// read tools) need. Moves and refund links are resolved over the same range and rows the server's
// overview used (links over the linkable set, so a charge on a hidden account leaves its refund
// unlinked), then rows outside both windows are dropped from `txns`. One function for the page and the
// MCP, so the two can't disagree about a row's kind, bucket or period.
export function deriveFinanceView(
  overview: FinanceOverview,
  loaded: FinanceTransaction[],
): FinanceView {
  const accounts = new Map(overview.accounts.map((a) => [a.id, a]));
  const allTxns = loaded.filter((t) => accounts.has(t.accountId));
  const moves = detectInternalMoves(allTxns, overview.accounts);
  const amount = (t: FinanceTransaction) => amountOf(t, accounts.get(t.accountId));
  const sortable = sortableTransactions(allTxns, overview.accounts, moves);
  const linkable = linkableTransactions(allTxns, overview.accounts, moves);
  const claims = resolveRefundClaims(linkable, amount);
  const links = linksOf(claims);
  const capped = capRefunds(claims, new Map(allTxns.map((t) => [t.id, t])), amount);
  return {
    accounts,
    moves,
    allTxns,
    sortable,
    // A refund across charges is listed while any of its charges counts in a window.
    txns: allTxns.filter(
      (t) =>
        periodOf(t, overview.period, links) !== null ||
        (claims.get(t.id)?.some((c) => periodOf(c.charge, overview.period) !== null) ?? false),
    ),
    amount,
    kindOf: (t) => classifyTransaction(t, accounts.get(t.accountId), moves),
    links,
    claims,
    refunded: capped.byCharge,
    counted: capped.byRefund,
    countedByClaim: capped.byClaim,
  };
}

// --- List filters (the All tab and the MCP list tool share them) ------------
export type FinanceListFilter = 'all' | 'unsorted' | FinanceBucket;

// A bucket chip (or Unsorted) only shows rows that can carry a bucket: charges, card credits, and
// deposits linked as refunds (which take their charge's bucket).
export function matchesFinanceFilter(
  t: FinanceTransaction,
  view: Pick<FinanceView, 'kindOf' | 'links' | 'claims' | 'amount'>,
  f: FinanceListFilter,
): boolean {
  if (f === 'all') return true;
  if (!isSortableKind(view.kindOf(t)) && !view.links.has(t.id)) return false;
  return f === 'unsorted'
    ? isUnsorted(t, view.links, view.amount(t))
    : bucketsOf(t, view).includes(f);
}

// Every bucket a row's money lands in: a split charge's parts', a refund's charges' (a refund across
// charges, or on a split charge, lands in several), else its one bucket. Unsorted contributes nothing.
export function bucketsOf(
  t: FinanceTransaction,
  view: Pick<FinanceView, 'claims' | 'amount'>,
): FinanceBucket[] {
  const own = (x: FinanceTransaction): FinanceBucket[] => {
    const split = splitOf(x, view.amount(x));
    if (split) return [...new Set(split.map((p) => p.bucket))];
    return x.bucket === null ? [] : [x.bucket];
  };
  const claims = view.claims.get(t.id);
  if (!claims) return own(t);
  return [...new Set(claims.flatMap((c) => own(c.charge)))];
}

// A row's share of a list total under a filter: under a bucket chip a split charge counts only that
// bucket's parts, and a linked refund only what it counts against that bucket — each claim's counted
// cents, spread over a split charge's parts in proportion (as summarizePeriod spreads it). Every other
// row counts its whole amount (netCents' rule).
export function filterCents(
  t: FinanceTransaction,
  view: Pick<FinanceView, 'amount' | 'claims' | 'countedByClaim'>,
  f: FinanceListFilter,
): number {
  const cents = view.amount(t);
  if (f === 'all' || f === 'unsorted') return cents;
  const inBucket = (parts: { bucket: FinanceBucket; cents: number }[]) =>
    parts.filter((p) => p.bucket === f).reduce((n, p) => n + p.cents, 0);
  const claims = view.claims.get(t.id);
  if (claims) {
    const counted = view.countedByClaim.get(t.id);
    let out = 0;
    for (const { charge } of claims) {
      const share = counted?.get(charge.id) ?? 0;
      const split = splitOf(charge, view.amount(charge));
      if (!split) out += charge.bucket === f ? share : 0;
      else {
        const spread = allocateProportional(
          share,
          split.map((p) => p.cents),
        );
        out += inBucket(split.map((p, i) => ({ bucket: p.bucket, cents: spread[i]! })));
      }
    }
    return out === 0 ? 0 : -out; // never -0
  }
  const split = splitOf(t, cents);
  return split ? inBucket(split) : cents;
}

// A case-insensitive substring of the merchant or the bank's descriptor (`needle` already lowercased),
// and of the note when asked — the page searches notes, the MCP `merchant` filter doesn't.
export function matchesFinanceText(
  t: FinanceTransaction,
  needle: string,
  opts: { note?: boolean } = {},
): boolean {
  return (
    merchantText(t).includes(needle) ||
    t.name.toLowerCase().includes(needle) ||
    (opts.note === true && t.note !== null && t.note.toLowerCase().includes(needle))
  );
}

// The one list-total rule: net, so money in subtracts. The All tab's summary and the MCP's totalUsd.
export const netCents = <T>(rows: T[], cents: (r: T) => number): number =>
  rows.reduce((n, r) => n + cents(r), 0);

export function buildFinanceOverview(input: {
  today: string;
  budgetCents: number;
  paymentDay: number;
  items: FinanceItem[];
  accounts: FinanceAccount[];
  syncStates: FinanceSyncState[];
  txns: FinanceTransaction[];
  environment: PlaidEnvironment;
  now: number;
}): FinanceOverview {
  const items = input.items.filter((i) => i.deletedAt === null);
  const liveItemIds = new Set(items.map((i) => i.id));
  const accounts = input.accounts.filter((a) => a.deletedAt === null && liveItemIds.has(a.itemId));
  const txns = input.txns.filter((t) => t.deletedAt === null);
  const period = computeFinancePeriod({
    today: input.today,
    accounts,
    txns,
    paymentDay: input.paymentDay,
  });
  const syncs = input.syncStates.filter((s) => s.deletedAt === null && liveItemIds.has(s.itemId));
  const synced = syncs.map((s) => s.lastSyncedAt);
  return {
    period,
    ...summarizePeriod({ period, txns, accounts, budgetCents: input.budgetCents }),
    accounts,
    items,
    sync: {
      // The oldest item's sync — "last synced" should never overstate freshness.
      lastSyncedAt:
        synced.length === 0 || synced.includes(null) ? null : Math.min(...(synced as number[])),
      // A request newer than the run that last finished — a success OR a failure — and young enough
      // that the run can't have died (a crashed run records neither, so without the age cap it would
      // read as syncing forever).
      syncing: syncs.some(
        (s) =>
          (s.syncRequestedAt ?? 0) > Math.max(s.lastSyncedAt ?? 0, s.lastSyncErrorAt ?? 0) &&
          input.now - (s.syncRequestedAt ?? 0) < FINANCE_SYNCING_MAX_MS,
      ),
      ...lastSyncError(syncs),
      items: syncs.map((s) => ({
        itemId: s.itemId,
        lastSyncedAt: s.lastSyncedAt,
        lastError: s.lastSyncError,
        lastErrorAt: s.lastSyncErrorAt,
      })),
      environment: input.environment,
    },
  };
}

// The newest failure across items (one bank's error shouldn't hide another's newer one).
function lastSyncError(syncs: FinanceSyncState[]): {
  lastError: string | null;
  lastErrorAt: number | null;
} {
  let worst: FinanceSyncState | null = null;
  for (const s of syncs)
    if (s.lastSyncError && (!worst || (s.lastSyncErrorAt ?? 0) > (worst.lastSyncErrorAt ?? 0)))
      worst = s;
  return { lastError: worst?.lastSyncError ?? null, lastErrorAt: worst?.lastSyncErrorAt ?? null };
}

// A sync failure in plain words. Codes are Plaid's (plus CONFLICT from our own write retries).
const SYNC_ERROR_TEXT: Record<string, string> = {
  ITEM_LOGIN_REQUIRED: '{bank} needs you to sign in again.',
  PENDING_EXPIRATION: '{bank} needs you to sign in again soon.',
  INSTITUTION_NOT_RESPONDING: '{bank} isn’t responding right now.',
  INSTITUTION_DOWN: '{bank} is down right now.',
  INSTITUTION_NOT_AVAILABLE: '{bank} isn’t available right now.',
  PLANNED_MAINTENANCE: 'The bank connection is down for maintenance.',
  RATE_LIMIT_EXCEEDED: 'Too many requests to the bank — it’ll catch up on the next sync.',
  INTERNAL_SERVER_ERROR: 'The bank connection had a hiccup.',
  TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION: '{bank} changed its data mid-sync.',
  ITEM_NOT_FOUND: 'This bank connection no longer exists — remove it and connect again.',
  CONFLICT: 'Your edits and the sync collided.',
  TIMEOUT: '{bank} took too long to answer.',
  NETWORK_ERROR: 'Couldn’t reach the bank connection.',
  INTERNAL_ERROR: 'Something went wrong on our side.',
  NOT_FOUND: 'Something went wrong on our side.',
  PRODUCT_NOT_READY:
    '{bank} is still getting your transactions ready — try Refresh in a few minutes.',
  SYNC_DEFERRED: '{bank} was still busy with an earlier sync — try again.',
};

export function financeSyncErrorMessage(code: string, bank = 'The bank'): string {
  const text = SYNC_ERROR_TEXT[code];
  return text ? text.replace('{bank}', bank) : `The sync failed (${code}).`;
}

// --- Rules -----------------------------------------------------------------
export function normalizeRulePattern(pattern: string): string {
  return pattern.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function merchantText(txn: Pick<FinanceTransaction, 'merchantName' | 'name'>): string {
  return (txn.merchantName ?? txn.name).toLowerCase();
}

// The longest active pattern contained in the merchant text wins (the most specific rule).
// Matched against both the raw text and its merchantKey, so a pattern saved from a sort-queue group
// (which is a merchantKey — digits stripped) still matches "CHECKCARD 0915 SQ *BLUE BOTTLE".
export function applyRules(
  rules: FinanceRule[],
  txn: Pick<FinanceTransaction, 'merchantName' | 'name'>,
): FinanceRule | null {
  const texts = [normalizeRulePattern(merchantText(txn)), merchantKey(txn)];
  let best: FinanceRule | null = null;
  for (const r of rules) {
    if (!r.active || r.deletedAt !== null || !r.pattern) continue;
    if (!texts.some((t) => t.includes(r.pattern))) continue;
    if (!best || r.pattern.length > best.pattern.length) best = r;
  }
  return best;
}

// --- Grouping (the sort queue) ---------------------------------------------
export interface MerchantGroup {
  key: string; // also the suggested rule pattern
  label: string;
  txns: FinanceTransaction[];
  totalCents: number;
}

// "SQ *BLUE BOTTLE #1234" and "SQ *BLUE BOTTLE #5678" are one merchant: store numbers and long digit
// runs are dropped before grouping.
export function merchantKey(txn: Pick<FinanceTransaction, 'merchantName' | 'name'>): string {
  return normalizeRulePattern(
    merchantText(txn)
      .replace(/#\s*\d+/g, ' ')
      .replace(/\d{3,}/g, ' '),
  );
}

export function groupByMerchant(
  txns: FinanceTransaction[],
  amount: (t: FinanceTransaction) => number,
): MerchantGroup[] {
  const groups = new Map<string, MerchantGroup>();
  for (const t of txns) {
    const key = merchantKey(t) || merchantText(t);
    const g = groups.get(key) ?? { key, label: t.merchantName ?? t.name, txns: [], totalCents: 0 };
    g.txns.push(t);
    g.totalCents += amount(t);
    groups.set(key, g);
  }
  for (const g of groups.values())
    g.txns.sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
  return [...groups.values()].sort(
    (a, b) => b.totalCents - a.totalCents || a.key.localeCompare(b.key),
  );
}

// --- Link guard ------------------------------------------------------------
// Plaid Trial has 10 Items and /item/remove doesn't free a slot, so re-linking the same login is
// refused BEFORE the public token is exchanged: same institution and every ticked account already
// present (by name + mask, Plaid's recommended check). A same-bank item with no live accounts also
// counts: the sync writes accounts, so until its first sync lands (or forever, if that failed) the
// check above has nothing to compare, and letting it through spends a second slot on the same login.
// Covers both refusals: the same accounts again, and a bank whose existing link hasn't synced yet.
export const duplicateItemMessage = (bank: string): string =>
  `${bank} is already linked — Refresh it, or remove it before linking again.`;

export function isDuplicateItem(
  items: FinanceItem[],
  accounts: FinanceAccount[],
  institutionId: string,
  linkAccounts: LinkAccountMeta[],
): boolean {
  const sameInst = new Set(
    items.filter((i) => i.deletedAt === null && i.institutionId === institutionId).map((i) => i.id),
  );
  if (sameInst.size === 0) return false;
  const live = accounts.filter((a) => a.deletedAt === null && sameInst.has(a.itemId));
  if ([...sameInst].some((id) => !live.some((a) => a.itemId === id))) return true;
  const have = new Set(live.map((a) => `${a.name}|${a.mask ?? ''}`));
  return linkAccounts.every((a) => have.has(`${a.name}|${a.mask ?? ''}`));
}

// --- Sync reconciliation ---------------------------------------------------
export const toCents = (dollars: number): number => Math.round(dollars * 100);

function plaidOwnedFields(p: PlaidTransaction, itemId: string) {
  return {
    itemId,
    accountId: p.account_id,
    date: p.date,
    authorizedDate: p.authorized_date,
    name: p.name,
    merchantName: p.merchant_name,
    rawAmountCents: toCents(p.amount),
    isoCurrency: p.iso_currency_code,
    pending: p.pending,
    pendingTransactionId: p.pending_transaction_id,
    pfcPrimary: p.personal_finance_category?.primary ?? null,
    pfcDetailed: p.personal_finance_category?.detailed ?? null,
    paymentChannel: p.payment_channel,
  };
}

export interface ReconcileInput {
  existing: Map<string, FinanceTransaction>; // every referenced row, tombstones included
  page: {
    added: PlaidTransaction[];
    modified: PlaidTransaction[];
    removed: { transaction_id: string }[];
  };
  rules: FinanceRule[];
  now: number;
  itemId: string;
  userId: string;
}

// One /transactions/sync page → the rows to write, applied added → modified → removed.
//  - A replayed `added` (a restart after a failed batch) is treated as `modified` — idempotent.
//  - A new posted row inherits bucket/split/override/note/refund link or allocation/period mark from its pending row
//    (pending_transaction_id), even when that pending row was already tombstoned; otherwise the rules
//    decide — except for a carried refund link, which must not pick up its charge's merchant rule.
//  - `modified` overwrites Plaid-owned fields only.
//  - `removed` tombstones.
// `existing` is updated in place so the caller can feed the next page through the same map.
export function reconcileSyncPage(input: ReconcileInput): FinanceTransaction[] {
  const { existing, page, rules, now, itemId, userId } = input;
  const touched = new Map<string, FinanceTransaction>();
  const write = (t: FinanceTransaction) => {
    existing.set(t.id, t);
    touched.set(t.id, t);
  };

  for (const p of [...page.added, ...page.modified]) {
    const prev = existing.get(p.transaction_id);
    if (prev) {
      write({ ...prev, ...plaidOwnedFields(p, itemId), deletedAt: null, updatedAt: now });
      continue;
    }
    const carry = p.pending_transaction_id ? existing.get(p.pending_transaction_id) : undefined;
    const rule =
      carry?.bucket ||
      carry?.refundOfId ||
      carry?.refundParts ||
      carry?.splits ||
      carry?.startsPeriod
        ? null
        : applyRules(rules, { merchantName: p.merchant_name, name: p.name });
    // A split rule splits money out by its percents; money in (a card credit) takes its bucket.
    const cents = toCents(p.amount);
    const split = rule ? ruleSplitOf(rule) : null;
    const ruleSplit = split && cents > 0 ? splitFromRule(split, cents) : null;
    write({
      id: p.transaction_id,
      userId,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      ...plaidOwnedFields(p, itemId),
      source: 'plaid',
      bucket: carry?.bucket ?? (ruleSplit ? null : (rule?.bucket ?? null)),
      bucketSetBy:
        carry && (carry.bucket || carry.splits) ? carry.bucketSetBy : rule ? 'rule' : null,
      periodOverride: carry?.periodOverride ?? null,
      note: carry?.note ?? null,
      refundOfId: carry?.refundOfId ?? null,
      startsPeriod: carry?.startsPeriod ?? false,
      // Carried as stored: at a new amount a hand-made split breaks (splitOf) and the row asks again.
      splits: carry?.splits ?? ruleSplit,
      refundParts: carry?.refundParts ?? null,
    });
  }

  for (const r of page.removed) {
    const prev = existing.get(r.transaction_id);
    if (!prev || prev.deletedAt !== null) continue;
    write({ ...prev, deletedAt: now, updatedAt: now });
  }
  return [...touched.values()];
}

// The ids a page references that must be loaded before reconciling it.
export function referencedTxnIds(page: ReconcileInput['page']): string[] {
  const ids = new Set<string>();
  for (const p of [...page.added, ...page.modified]) {
    ids.add(p.transaction_id);
    if (p.pending_transaction_id) ids.add(p.pending_transaction_id);
  }
  for (const r of page.removed) ids.add(r.transaction_id);
  return [...ids];
}
