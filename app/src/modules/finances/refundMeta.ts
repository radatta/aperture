import { fmtMonthShortDay } from '@aperture/shared';
import type { FinanceTransaction, FinanceTxnKind } from '@aperture/shared';
import { fmtMoney } from './money';
import type { FinanceView } from './useFinanceData';

// "· refund of Amazon · Sep 18" on a linked refund (plus "· counts $X" when it overshoots what was left
// of the charge), "· refunded $34.99" on a charge that has refunds.
export function refundMeta(
  txn: FinanceTransaction,
  kind: FinanceTxnKind,
  view: FinanceView,
): string {
  const charge = view.links.get(txn.id);
  if (charge) {
    const counted = view.counted.get(txn.id) ?? 0;
    const capped = counted < -view.amount(txn) ? ` · counts ${fmtMoney(counted)}` : '';
    return ` · refund of ${charge.merchantName ?? charge.name} · ${fmtMonthShortDay(charge.date)}${capped}`;
  }
  if (kind === 'refund') return ' · refund';
  const refunded = view.refunded.get(txn.id);
  return refunded ? ` · refunded ${fmtMoney(refunded)}` : '';
}
