import { Link } from 'react-router';
import { Text } from '../../components/Text';
import { useFinanceOverview } from '../../data/hooks/useFinances';
import { fmtMoneyWhole } from '../../modules/finances/money';

// Finances on the home is a single line, not a card — Morning is already at its ≤5-element cap
// (PRODUCT §3). Morning: budget left + what's waiting. Night: only the sort count, only when non-zero.
// Renders nothing until a bank is connected.
export function FinanceGlance({ mode }: { mode: 'morning' | 'night' }) {
  const { data: o } = useFinanceOverview();
  if (!o || o.items.length === 0) return null;
  if (mode === 'night' && o.unsortedCount === 0) return null;
  const toSort = o.unsortedCount > 0 ? `${o.unsortedCount} to sort` : 'all sorted';
  const text =
    mode === 'night'
      ? `${o.unsortedCount} ${o.unsortedCount === 1 ? 'charge' : 'charges'} to sort`
      : `${o.leftCents < 0 ? `${fmtMoneyWhole(-o.leftCents)} over` : `${fmtMoneyWhole(o.leftCents)} left`} of ${fmtMoneyWhole(o.budgetCents)} · ${toSort}`;
  return (
    <Link
      to="/finances"
      className="flex items-center justify-between gap-2 px-1 text-sm hover:text-ink"
    >
      <Text size="sm" tone={o.leftCents < 0 && mode === 'morning' ? 'danger' : 'muted'} tabular>
        {text}
      </Text>
      <Text size="sm" tone="muted" aria-hidden>
        Finances →
      </Text>
    </Link>
  );
}
