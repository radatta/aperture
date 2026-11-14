import { useRef } from 'react';
import { Link } from 'react-router';
import {
  FINANCE_BUCKET_LABELS,
  FINANCE_SPEND_BUCKETS,
  FINANCE_DEFAULT_PAYMENT_DAY,
  fmtMonthShortDay,
  suggestPeriodStart,
} from '@aperture/shared';
import type { FinanceOverview, FinancePeriod } from '@aperture/shared';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Text } from '../../components/Text';
import { cx } from '../../lib/cx';
import { useFinanceToday, useSetFinancePeriodStart } from '../../data/hooks/useFinances';
import { useSettings } from '../../data/hooks/useSettings';
import { bucketFillClass } from './bucketStyles';
import { fmtMoney, fmtMoneyWhole } from './money';
import type { FinanceView } from './useFinanceData';

const ordinal = (n: number) => {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
};

// Where the boundary came from, so a fallback is visible rather than silent.
function periodLine(period: FinancePeriod, today: string, paymentDay: number): string {
  if (period.lastPaymentDate === null)
    return `Day ${period.dayCount} · ${fmtMonthShortDay(period.start)} – today · using your payment day (the ${ordinal(paymentDay)})`;
  const since = `since your ${fmtMonthShortDay(period.lastPaymentDate)} payment`;
  if (period.start > today) return `New period starts ${fmtMonthShortDay(period.start)} · ${since}`;
  return `Day ${period.dayCount} · ${fmtMonthShortDay(period.start)} – today · ${since}`;
}

// "$X left of $<budget>" for the current billing period, the three bucket totals, and what's left to sort.
// With the transactions loaded (`view`), it also offers the newest unmarked card payment as a
// one-click period start — the page never moves the boundary on its own.
export function PeriodHeader({
  overview,
  view,
}: {
  overview: FinanceOverview;
  view?: FinanceView | null;
}) {
  const { period, budgetCents, spentCents, leftCents, buckets, unsortedCount, unsortedCents } =
    overview;
  const today = useFinanceToday();
  const paymentDay = useSettings().data?.financePaymentDay ?? FINANCE_DEFAULT_PAYMENT_DAY;
  const lineRef = useRef<HTMLDivElement>(null);
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
        {/* Focus lands here after the nudge marks a payment — its button is gone by then. */}
        <div ref={lineRef} tabIndex={-1} className="outline-none">
          <Text size="sm" tone="muted">
            {periodLine(period, today, paymentDay)}
          </Text>
        </div>
        {view && (
          <PeriodNudge
            period={period}
            view={view}
            today={today}
            onMarked={() => lineRef.current?.focus()}
          />
        )}
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-panel-2"
        role="meter"
        aria-label="Budget spent"
        aria-valuemin={0}
        aria-valuemax={budgetCents}
        aria-valuenow={spentCents}
        aria-valuetext={`${fmtMoney(spentCents)} of ${fmtMoney(budgetCents)} spent`}
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
        {FINANCE_SPEND_BUCKETS.map((b) => (
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

// "Looks like you paid the card on Sep 17 — start the period there", or, once marked, the next one.
function PeriodNudge({
  period,
  view,
  today,
  onMarked,
}: {
  period: FinancePeriod;
  view: FinanceView;
  today: string;
  onMarked: () => void;
}) {
  const mark = useSetFinancePeriodStart();
  const next = suggestPeriodStart({
    txns: view.allTxns,
    accounts: [...view.accounts.values()],
    moves: view.moves,
    after: period.lastPaymentDate,
    today,
  });
  const marked = period.source === 'marked';
  const hasCard = [...view.accounts.values()].some((a) => a.type === 'credit');
  if (!next && (marked || !hasCard)) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <Text size="sm" tone="muted" className="min-w-0 flex-1">
        {next
          ? `${marked ? 'Paid the card again' : 'Looks like you paid the card'} on ${fmtMonthShortDay(next.date)} (+${fmtMoney(-view.amount(next))}).`
          : 'Mark your last card payment (open it under All) to start the period there.'}
      </Text>
      {next && (
        <Button
          size="sm"
          variant="ghost"
          disabled={mark.isPending}
          onClick={() => mark.mutate({ id: next.id, marked: true }, { onSuccess: onMarked })}
        >
          {marked ? 'Start a new period there' : 'Start the period there'}
        </Button>
      )}
      {mark.isError && (
        <div role="alert" className="w-full">
          <Text size="sm" tone="danger">
            Couldn&apos;t mark it: {mark.error.message}
          </Text>
        </div>
      )}
    </div>
  );
}
