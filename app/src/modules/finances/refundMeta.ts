import { fmtMonthShortDay } from '@aperture/shared';
import type { FinanceTransaction, FinanceTxnKind } from '@aperture/shared';
import { fmtMoney } from './money';
import type { FinanceView } from './useFinanceData';

// "· refund of Amazon · Sep 18" on a linked refund, "· refunded $34.99" on a charge that has refunds.
export function refundMeta(
  txn: FinanceTransaction,
  kind: FinanceTxnKind,
  view: FinanceView,
): string {
  const charge = view.links.get(txn.id);
  if (charge)
    return ` · refund of ${charge.merchantName ?? charge.name} · ${fmtMonthShortDay(charge.date)}`;
  if (kind === 'refund') return ' · refund';
  const refunded = view.refunded.get(txn.id);
  return refunded ? ` · refunded ${fmtMoney(refunded)}` : '';
}
