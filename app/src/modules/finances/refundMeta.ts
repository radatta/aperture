import { FINANCE_BUCKET_LABELS, fmtMonthShortDay, splitOf, splitTotal } from '@aperture/shared';
import type { FinanceTransaction, FinanceTxnKind } from '@aperture/shared';
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
  if (kind !== 'expense' || !txn.splits?.length) return refundedText;
  const split = splitOf(txn, view.amount(txn));
  if (!split)
    return ` · split no longer adds up (was ${fmtMoney(splitTotal(txn.splits))})${refundedText}`;
  const parts = split
    .map(
      (p) =>
        `${FINANCE_BUCKET_LABELS[p.bucket]} ${fmtMoney(p.cents)}${p.period ? PIN[p.period] : ''}`,
    )
    .join(' · ');
  return ` · ${parts}${refundedText}`;
}
