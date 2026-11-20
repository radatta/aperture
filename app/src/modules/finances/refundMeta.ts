import {
  countedParts,
  FINANCE_BUCKET_LABELS,
  fmtMonthShortDay,
  liveSplits,
  splitOf,
  splitTotal,
} from '@aperture/shared';
import type { FinanceOverview, FinanceTransaction, FinanceTxnKind } from '@aperture/shared';
import { fmtMoney } from './money';
import type { FinanceView } from './useFinanceData';

const PIN: Record<string, string> = {
  current: ' (this period)',
  previous: ' (last period)',
  next: ' (next period)',
};

// "· refund of Store A · Sep 18" on a linked refund (plus "· counts $X" when it overshoots what was
// left of the charge), "· refund of 2 charges" on one allocated across charges, "· refunded $30.00" on a
// charge that has refunds, and a split charge's parts ("· Budget $20.00 · Covered $20.00 (next period)")
// — or why its split stopped counting.
export function refundMeta(
  txn: FinanceTransaction,
  kind: FinanceTxnKind,
  view: FinanceView,
): string {
  const claims = view.claims.get(txn.id);
  if (claims && claims.length > 1) {
    const counted = view.counted.get(txn.id) ?? 0;
    const capped = counted < -view.amount(txn) ? ` · counts ${fmtMoney(counted)}` : '';
    return ` · refund of ${claims.length} charges${capped}`;
  }
  const charge = view.links.get(txn.id);
  if (charge) {
    const counted = view.counted.get(txn.id) ?? 0;
    const capped = counted < -view.amount(txn) ? ` · counts ${fmtMoney(counted)}` : '';
    return ` · refund of ${charge.merchantName ?? charge.name} · ${fmtMonthShortDay(charge.date)}${capped}`;
  }
  if (kind === 'refund') return ' · refund';
  const refunded = view.refunded.get(txn.id);
  const refundedText = refunded ? ` · refunded ${fmtMoney(refunded)}` : '';
  const stored = liveSplits(txn);
  if (kind !== 'expense' || !stored) return refundedText;
  if (!splitOf(txn, view.amount(txn)))
    return ` · split no longer adds up (was ${fmtMoney(splitTotal(stored))})${refundedText}`;
  return refundedText; // the parts go on their own line (splitPartsText)
}

// A split charge's parts, each with where it lands when you chose its period: "Budget $20.00 · Covered
// $20.00 (next period)". A Next part on last period's charge already counts in this one, so it says so.
// Null for any other row.
export function splitPartsText(
  txn: FinanceTransaction,
  view: FinanceView,
  period: FinanceOverview['period'],
): string | null {
  const cents = view.amount(txn);
  if (!splitOf(txn, cents)) return null;
  return countedParts(txn, cents, 0, period)
    .map((p) => {
      const w = p.window === 'upcoming' ? 'next' : p.window;
      const label = p.pin === null || w === null ? '' : PIN[w];
      const name = p.bucket === null ? 'Unsorted' : FINANCE_BUCKET_LABELS[p.bucket];
      return `${name} ${fmtMoney(p.cents)}${label}`;
    })
    .join(' · ');
}
