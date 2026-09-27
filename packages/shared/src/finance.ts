// Finances — the three-bucket budget (ported from penny-pilot) over Plaid-synced bank data.
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
export type FinanceBucket = 'parents_pay' | 'budget' | 'i_pay';
export const FINANCE_BUCKETS: FinanceBucket[] = ['parents_pay', 'budget', 'i_pay']; // order = keys 1/2/3
export const FINANCE_BUCKET_LABELS: Record<FinanceBucket, string> = {
  parents_pay: 'Parents pay',
  budget: 'Budget',
  i_pay: 'I pay',
};

export type FinanceSource = 'plaid'; // 'csv' reserved
export type FinancePeriodOverride = 'current' | 'previous';
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
}

// "Always put <pattern> in <bucket>". pattern is lowercased and matched as a substring.
export interface FinanceRule extends BaseEntity {
  pattern: string;
  bucket: FinanceBucket;
  active: boolean;
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
  buckets: Record<FinanceBucket, FinanceBucketTotal>;
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
}
export type FinanceAccountPatch = Partial<Pick<FinanceAccount, 'signOverride' | 'hidden'>>;
export interface RequestFinanceSyncResult {
  accepted: boolean;
  nextAllowedAt: number | null;
}

// --- Constants -------------------------------------------------------------
export const FINANCE_DEFAULT_BUDGET_CENTS = 60_000;
export const FINANCE_DEFAULT_PAYMENT_DAY = 20;
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
// refund id → the alive charge it reverses. A link whose charge went pending→posted resolves through
// the posted row's pendingTransactionId. Only rows in `txns` resolve: a charge outside the loaded
// window, tombstoned, or filtered out (a hidden account) leaves the refund unlinked in effect. Signs
// are re-checked with `amount`, so flipping an account can't leave a stale link on a charge.
export type RefundLinks = Map<string, FinanceTransaction>;

export function resolveRefundLinks(
  txns: FinanceTransaction[],
  amount: (t: FinanceTransaction) => number = (t) => t.rawAmountCents,
): RefundLinks {
  const live = txns.filter((t) => t.deletedAt === null);
  const byId = new Map(live.map((t) => [t.id, t]));
  const byPending = new Map(
    live.filter((t) => t.pendingTransactionId).map((t) => [t.pendingTransactionId!, t]),
  );
  const links: RefundLinks = new Map();
  for (const t of live) {
    if (!t.refundOfId) continue;
    const charge = byId.get(t.refundOfId) ?? byPending.get(t.refundOfId);
    if (charge && charge.id !== t.id && amount(t) < 0 && amount(charge) > 0)
      links.set(t.id, charge);
  }
  return links;
}

// A linked refund takes its charge's bucket — explicitly, so an unsorted charge yields null.
export function bucketOf(t: FinanceTransaction, links: RefundLinks): FinanceBucket | null {
  const charge = links.get(t.id);
  return charge ? charge.bucket : t.bucket;
}

// Needs a decision from you: no bucket, and not riding on a charge.
export function isUnsorted(t: FinanceTransaction, links: RefundLinks): boolean {
  return !links.has(t.id) && t.bucket === null;
}

// charge id → cents already refunded (positive), summed over its linked refunds.
export function refundedCentsByCharge(
  links: RefundLinks,
  txnsById: Map<string, FinanceTransaction>,
  amount: (t: FinanceTransaction) => number,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const [refundId, charge] of links) {
    const refund = txnsById.get(refundId);
    if (refund) out.set(charge.id, (out.get(charge.id) ?? 0) - amount(refund));
  }
  return out;
}

// Charges this refund could reverse, best first: an alive expense at the same merchant, dated at most
// REFUND_DATE_SLACK_DAYS after the refund and REFUND_MATCH_WINDOW_DAYS before it, with enough left
// unrefunded to cover it. Works for card credits and checking/savings deposits alike.
// Ranked: same account → smallest leftover (exact first) → nearer date → posted → id. `anyMerchant`
// drops the merchant match — the fallback when a card credit's descriptor doesn't match its charge.
export function suggestRefundMatches(input: {
  refund: FinanceTransaction;
  txns: FinanceTransaction[];
  accounts: FinanceAccount[];
  moves: InternalMoves;
  links: RefundLinks;
  anyMerchant?: boolean;
}): FinanceTransaction[] {
  const { refund, txns, accounts, moves, links, anyMerchant = false } = input;
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const amount = (t: FinanceTransaction) => amountOf(t, byId.get(t.accountId));
  const refunded = refundedCentsByCharge(links, new Map(txns.map((t) => [t.id, t])), amount);
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
    .map((c) => ({ c, left: amount(c) - (refunded.get(c.id) ?? 0) - size }))
    .filter((x) => x.left >= 0);
  const rank = (x: { c: FinanceTransaction; left: number }) => [
    x.c.accountId === refund.accountId ? 0 : 1,
    x.left,
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

const shownAccount = (a: FinanceAccount | undefined) =>
  a !== undefined && a.deletedAt === null && !a.hidden;
const moneyAccount = (a: FinanceAccount | undefined) =>
  a?.type === 'credit' || a?.type === 'depository';
const isMoveOrMark = (t: FinanceTransaction, moves: InternalMoves | undefined) =>
  isMovePfc(t) || t.startsPeriod || (moves?.has(t.id) ?? false);

// Why this row can't be the refund side of a link, or null: it must be alive money coming in on a
// shown card or bank account, and not a payment, transfer or period mark (a flipped card's dormant
// mark still counts — unmark it first). `moves`, when the caller has it, also rules out detected moves.
// The page uses this to decide whether to offer linking at all.
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
  if (isMoveOrMark(refund, moves)) return 'A card payment or transfer isn’t a refund';
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
// side's own check, the charge dated at most REFUND_DATE_SLACK_DAYS after its refund, and the refund
// no larger than the charge. "Remaining unrefunded" is the suggestion list's job — the server only
// caps at the full charge.
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
  if (-amountOf(refund, refundAccount) > amountOf(charge, chargeAccount))
    return 'The refund is larger than the charge';
  return null;
}

// What the sort queue asks you about: unsorted, not riding on a charge, and not a charge its linked
// refunds already cancel out in full (it nets to $0 whichever bucket it lands in).
export function needsSorting(
  t: FinanceTransaction,
  links: RefundLinks,
  refunded: Map<string, number>,
  cents: number,
): boolean {
  if (!isUnsorted(t, links)) return false;
  return !(cents > 0 && (refunded.get(t.id) ?? 0) >= cents);
}

export function summarizePeriod(input: {
  period: FinancePeriod;
  txns: FinanceTransaction[];
  accounts: FinanceAccount[];
  budgetCents: number;
}): Pick<
  FinanceOverview,
  'budgetCents' | 'spentCents' | 'leftCents' | 'buckets' | 'unsortedCount' | 'unsortedCents'
> {
  const { period, txns, accounts, budgetCents } = input;
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const moves = detectInternalMoves(txns, accounts);
  const buckets: Record<FinanceBucket, FinanceBucketTotal> = {
    parents_pay: { totalCents: 0, count: 0 },
    budget: { totalCents: 0, count: 0 },
    i_pay: { totalCents: 0, count: 0 },
  };
  let unsortedCount = 0;
  let unsortedCents = 0;
  const amount = (t: FinanceTransaction) => amountOf(t, byId.get(t.accountId));
  const linkable = linkableTransactions(txns, accounts, moves);
  // Built over the linkable set, so a refund whose charge is on a hidden account counts as unlinked.
  const links = resolveRefundLinks(linkable, amount);
  const refunded = refundedCentsByCharge(links, new Map(linkable.map((t) => [t.id, t])), amount);
  for (const t of linkable) {
    // A deposit counts only as a linked refund; otherwise it's income, outside the budget.
    if (classifyTransaction(t, byId.get(t.accountId), moves) === 'income' && !links.has(t.id))
      continue;
    const which = periodOf(t, period, links);
    if (which === null) continue;
    const cents = amount(t);
    const linked = links.has(t.id); // rides on its charge: nets its money, never adds to a count
    const bucket = bucketOf(t, links);
    if (bucket === null) {
      if (needsSorting(t, links, refunded, cents)) unsortedCount += 1;
      unsortedCents += cents;
    } else if (which === 'current') {
      buckets[bucket].totalCents += cents;
      if (!linked) buckets[bucket].count += 1;
    }
  }
  const spentCents = buckets.budget.totalCents;
  return {
    budgetCents,
    spentCents,
    leftCents: budgetCents - spentCents,
    buckets,
    unsortedCount,
    unsortedCents,
  };
}

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
//  - A new posted row inherits bucket/override/note/refund link/period mark from its pending row
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
      carry?.bucket || carry?.refundOfId || carry?.startsPeriod
        ? null
        : applyRules(rules, { merchantName: p.merchant_name, name: p.name });
    write({
      id: p.transaction_id,
      userId,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      ...plaidOwnedFields(p, itemId),
      source: 'plaid',
      bucket: carry?.bucket ?? rule?.bucket ?? null,
      bucketSetBy: carry?.bucket ? carry.bucketSetBy : rule ? 'rule' : null,
      periodOverride: carry?.periodOverride ?? null,
      note: carry?.note ?? null,
      refundOfId: carry?.refundOfId ?? null,
      startsPeriod: carry?.startsPeriod ?? false,
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
