import {
  bucketsOf,
  claimsWithout,
  FINANCE_BUCKET_LABELS,
  periodOf,
  refundedCentsByCharge,
} from '@aperture/shared';
import type { FinanceOverview, FinanceRuleSplitPart, FinanceTransaction } from '@aperture/shared';
import { parseDollars } from './money';
import type { FinanceView } from './useFinanceData';

// Helpers for the split and allocation editors (components live in AmountRows, SplitEditor, RefundParts).

// Cents → the text a field starts with ("12.50", no "$" or commas: parseDollars reads it back).
export const centsText = (cents: number): string => (cents / 100).toFixed(2);

// Sum of the fields that parse; null when any doesn't (the remainder then says so).
export function parsedSum(amounts: string[]): number | null {
  let sum = 0;
  for (const a of amounts) {
    const c = parseDollars(a);
    if (c === null) return null;
    sum += c;
  }
  return sum;
}

export const selectClass =
  'min-w-0 rounded-xl border border-line bg-surface px-2 py-1 text-base text-ink outline-none focus:border-teal';

// What's left of each charge for THIS refund to take: its amount less every other refund's share.
export function leftForRefund(refund: FinanceTransaction, view: FinanceView) {
  const others = refundedCentsByCharge(
    claimsWithout(view.claims, refund.id),
    new Map(view.allTxns.map((t) => [t.id, t])),
    view.amount,
  );
  return (c: FinanceTransaction) => Math.max(view.amount(c) - (others.get(c.id) ?? 0), 0);
}

// "Budget, this period" — where a charge's money (and so a refund's share of it) counts.
export function chargeWhere(
  charge: FinanceTransaction,
  view: FinanceView,
  overview: FinanceOverview,
): string {
  const buckets = bucketsOf(charge, view);
  const label =
    buckets.length === 0 ? 'Unsorted' : buckets.map((b) => FINANCE_BUCKET_LABELS[b]).join(' + ');
  const which = periodOf(charge, overview.period);
  const when =
    which === 'current'
      ? 'this period'
      : which === 'previous'
        ? 'last period'
        : 'an earlier period';
  return `${label}, ${when}`;
}

// "Budget 60% · Covered 40%"
export const ruleSplitText = (split: FinanceRuleSplitPart[]): string =>
  split.map((p) => `${FINANCE_BUCKET_LABELS[p.bucket]} ${p.percent}%`).join(' · ');
