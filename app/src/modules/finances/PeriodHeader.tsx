import { Link } from 'react-router';
import { FINANCE_BUCKET_LABELS, FINANCE_BUCKETS, fmtMonthShortDay } from '@aperture/shared';
import type { FinanceOverview, FinancePeriodSource } from '@aperture/shared';
import { Card } from '../../components/Card';
import { Text } from '../../components/Text';
import { cx } from '../../lib/cx';
import { bucketFillClass } from './bucketStyles';
import { fmtMoney, fmtMoneyWhole } from './money';

// Says where the period boundary came from, so a wrong guess is visible rather than silent.
const SOURCE_LABEL: Record<FinancePeriodSource, string> = {
  liabilities: 'since the last card payment',
  matched: 'since the last card payment',
  hint: 'since the last card payment (best guess)',
  calendar: 'calendar cycle — no card payment found yet',
};

// "$X left of $600" for the current billing period, the three bucket totals, and what's left to sort.
export function PeriodHeader({ overview }: { overview: FinanceOverview }) {
  const { period, budgetCents, spentCents, leftCents, buckets, unsortedCount, unsortedCents } =
    overview;
  const pct = budgetCents > 0 ? Math.min(100, (spentCents / budgetCents) * 100) : 100;
  const over = leftCents < 0;
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <Text size="3xl" weight="semibold" tabular tone={over ? 'danger' : 'ink'}>
            {over ? `${fmtMoneyWhole(-leftCents)} over` : `${fmtMoneyWhole(leftCents)} left`}
          </Text>
          <Text tone="muted">of {fmtMoneyWhole(budgetCents)} budget</Text>
        </div>
        <Text size="sm" tone="muted">
          Day {period.dayCount} · {fmtMonthShortDay(period.start)} – today ·{' '}
          {SOURCE_LABEL[period.source]}
        </Text>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-panel-2"
        role="meter"
        aria-label="Budget spent"
        aria-valuemin={0}
        aria-valuemax={budgetCents}
        aria-valuenow={spentCents}
      >
        <div
          className={cx(
            'h-full rounded-full',
            over ? 'bg-danger' : pct >= 85 ? 'bg-gold' : 'bg-teal',
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <dl className="grid grid-cols-3 gap-2">
        {FINANCE_BUCKETS.map((b) => (
          <div key={b} className="flex flex-col gap-0.5">
            <dt className="flex items-center gap-1.5">
              <span aria-hidden className={cx('h-2 w-2 rounded-full', bucketFillClass[b])} />
              <Text size="xs" tone="muted">
                {FINANCE_BUCKET_LABELS[b]}
              </Text>
            </dt>
            <dd>
              <Text size="sm" tabular>
                {fmtMoney(buckets[b].totalCents)}
              </Text>
            </dd>
          </div>
        ))}
      </dl>
      {unsortedCount > 0 && (
        <Link
          to="/finances"
          className="self-start text-sm text-gold underline-offset-2 hover:underline"
        >
          {unsortedCount} to sort · {fmtMoney(unsortedCents)}
        </Link>
      )}
    </Card>
  );
}
