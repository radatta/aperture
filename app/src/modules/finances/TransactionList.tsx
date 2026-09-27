import { useState } from 'react';
import {
  bucketOf,
  FINANCE_BUCKET_LABELS,
  FINANCE_BUCKETS,
  fmtMonthShortDay,
  isSortableKind,
  isUnsorted,
  periodOf,
} from '@aperture/shared';
import type {
  FinanceBucket,
  FinanceOverview,
  FinanceTransaction,
  FinanceTxnKind,
} from '@aperture/shared';
import { EmptyState } from '../../components/EmptyState';
import { Text } from '../../components/Text';
import { cx } from '../../lib/cx';
import { BucketTag } from './BucketTag';
import { fmtMoney } from './money';
import { refundMeta } from './refundMeta';
import { TransactionDetail } from './TransactionDetail';
import type { FinanceView } from './useFinanceData';

type Filter = 'all' | 'unsorted' | FinanceBucket;
const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'unsorted', label: 'Unsorted' },
  ...FINANCE_BUCKETS.map((b) => ({ value: b, label: FINANCE_BUCKET_LABELS[b] })),
];

const KIND_LABEL: Record<Exclude<FinanceTxnKind, 'expense' | 'refund'>, string> = {
  income: 'money in',
  transfer: 'transfer',
  card_payment: 'card payment',
};

// Every transaction in the current and previous period, newest first. Card payments, transfers and
// money into the bank are listed (so the ledger reconciles with the bank) but never sorted or totalled.
// Card refunds are sorted like charges and net against their bucket.
export function TransactionList({
  overview,
  view,
  pending,
  error,
}: {
  overview: FinanceOverview;
  view: FinanceView | null;
  pending: boolean;
  error: boolean;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  if (!view)
    return <EmptyState pending={pending && !error} error={error} title="No transactions yet." />;

  const kindOf = view.kindOf;
  const shown = view.txns.filter((t) => {
    if (filter === 'all') return true;
    if (!isSortableKind(kindOf(t))) return false;
    return filter === 'unsorted' ? isUnsorted(t, view.links) : bucketOf(t, view.links) === filter;
  });
  const sections = [
    {
      key: 'current',
      title: `This period · ${fmtMonthShortDay(overview.period.start)} – today`,
      rows: shown.filter((t) => periodOf(t, overview.period, view.links) === 'current'),
    },
    {
      key: 'previous',
      title: `Last period · ${fmtMonthShortDay(overview.period.previous.start)} – ${fmtMonthShortDay(overview.period.previous.end)}`,
      rows: shown.filter((t) => periodOf(t, overview.period, view.links) === 'previous'),
    },
  ];
  // allTxns, not txns: linking to an older charge can move a refund out of both windows mid-edit.
  const open = openId ? view.allTxns.find((t) => t.id === openId) : undefined;

  return (
    <div className="flex flex-col gap-4">
      <div
        role="group"
        aria-label="Filter"
        className="no-scrollbar -mx-5 flex gap-1.5 overflow-x-auto px-5"
      >
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            aria-pressed={filter === f.value}
            onClick={() => setFilter(f.value)}
            className={cx(
              'shrink-0 rounded-full border px-3 py-1 text-sm transition',
              filter === f.value
                ? 'border-teal bg-teal-soft text-ink'
                : 'border-line text-ink-muted hover:text-ink',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>
      {sections.map((s) => (
        <section key={s.key} aria-label={s.title} className="flex flex-col gap-1">
          <Text size="xs" tone="muted" weight="medium" className="uppercase tracking-wider">
            {s.title}
          </Text>
          {s.rows.length === 0 ? (
            <Text size="sm" tone="muted">
              Nothing here.
            </Text>
          ) : (
            <ul className="flex flex-col divide-y divide-line">
              {s.rows.map((t) => (
                <TransactionRow
                  key={t.id}
                  txn={t}
                  view={view}
                  kind={kindOf(t)}
                  onOpen={() => setOpenId(t.id)}
                />
              ))}
            </ul>
          )}
        </section>
      ))}
      {open && (
        <TransactionDetail
          txn={open}
          view={view}
          overview={overview}
          onClose={() => setOpenId(null)}
        />
      )}
    </div>
  );
}

function TransactionRow({
  txn,
  view,
  kind,
  onOpen,
}: {
  txn: FinanceTransaction;
  view: FinanceView;
  kind: FinanceTxnKind;
  onOpen: () => void;
}) {
  const acct = view.accounts.get(txn.accountId);
  const cents = view.amount(txn);
  const expense = isSortableKind(kind);
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        disabled={!expense}
        className="flex w-full items-center gap-3 py-2 text-left enabled:hover:bg-panel-2"
      >
        <Text size="sm" tone="muted" tabular className="w-12 shrink-0">
          {fmtMonthShortDay(txn.date)}
        </Text>
        <span className="flex min-w-0 flex-1 flex-col">
          <Text size="sm" tone={expense ? 'ink' : 'muted'} className="truncate">
            {txn.merchantName ?? txn.name}
          </Text>
          <Text size="xs" tone="muted" className="truncate">
            {acct ? `${acct.name} ••${acct.mask}` : ''}
            {txn.pending ? ' · pending' : ''}
            {refundMeta(txn, kind, view)}
            {txn.periodOverride ? ` · moved to ${txn.periodOverride} period` : ''}
            {txn.note ? ` · ${txn.note}` : ''}
          </Text>
        </span>
        <Text size="sm" tabular tone={expense ? 'ink' : 'muted'}>
          {cents < 0 ? `+${fmtMoney(-cents)}` : fmtMoney(cents)}
        </Text>
        <span className="w-24 shrink-0 text-right">
          {expense ? (
            <BucketTag bucket={bucketOf(txn, view.links)} />
          ) : (
            <Text size="xs" tone="muted">
              {KIND_LABEL[kind as keyof typeof KIND_LABEL]}
            </Text>
          )}
        </span>
      </button>
    </li>
  );
}
