import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  bucketOf,
  FINANCE_BUCKET_LABELS,
  FINANCE_BUCKETS,
  fmtMonthShortDay,
  isPeriodStart,
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
import { revealFocus } from '../../lib/focus';
import { useFinanceToday } from '../../data/hooks/useFinances';
import { Text } from '../../components/Text';
import { cx } from '../../lib/cx';
import { BucketTag } from './BucketTag';
import { fmtSigned } from './money';
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
// Card refunds are sorted like charges and net against their bucket; a deposit counts only once it's
// linked as a refund. Card payments open to be marked as a period start.
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
  const today = useFinanceToday();
  // Closing the detail hands focus back to the row it opened from — found by id, because the row can
  // re-render in the other section a moment later (a "Counts in" change). Sticky until focus goes
  // anywhere else or you tap anywhere (Safari/iOS focus nothing on a tap, so a later refetch would
  // otherwise yank focus and scroll back); if the row left the list (filtered, or moved out of both
  // periods) or can't take focus (turned disabled), the list itself.
  const rootRef = useRef<HTMLDivElement>(null);
  const returnTo = useRef<string | null>(null);
  useLayoutEffect(() => {
    const id = returnTo.current;
    if (openId !== null || id === null) return;
    const row = [...(rootRef.current?.querySelectorAll<HTMLElement>('[data-txn-id]') ?? [])].find(
      (el) => el.dataset.txnId === id,
    );
    if (row && document.activeElement !== row) revealFocus(row);
    if (!row || document.activeElement !== row) {
      returnTo.current = null;
      revealFocus(rootRef.current);
    }
  });
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      const id = returnTo.current;
      if (id !== null && (e.target as HTMLElement).dataset?.txnId !== id) returnTo.current = null;
    };
    const onPointerDown = () => {
      returnTo.current = null;
    };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, []);
  if (!view)
    return <EmptyState pending={pending && !error} error={error} title="No transactions yet." />;

  const kindOf = view.kindOf;
  const shown = view.txns.filter((t) => {
    if (filter === 'all') return true;
    if (!isSortableKind(kindOf(t)) && !view.links.has(t.id)) return false;
    return filter === 'unsorted' ? isUnsorted(t, view.links) : bucketOf(t, view.links) === filter;
  });
  const sections = [
    {
      key: 'current',
      // Marked today → the new period hasn't begun yet.
      title:
        overview.period.start > today
          ? `This period · from ${fmtMonthShortDay(overview.period.start)}`
          : `This period · ${fmtMonthShortDay(overview.period.start)} – today`,
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
    <div
      ref={rootRef}
      tabIndex={-1}
      role="region"
      aria-label="Transactions"
      className="flex flex-col gap-4 outline-none"
    >
      <div role="group" aria-label="Filter" className="flex flex-wrap gap-1.5">
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
          onClose={() => {
            returnTo.current = open.id;
            setOpenId(null);
          }}
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
  // Counts toward a bucket: a charge, a card credit, or a deposit linked as a refund.
  const expense = isSortableKind(kind) || view.links.has(txn.id);
  const markable = acct?.type === 'credit' && cents < 0;
  return (
    <li>
      <button
        type="button"
        data-txn-id={txn.id}
        onClick={onOpen}
        disabled={!(expense || markable || kind === 'income')}
        className="flex w-full items-center gap-3 py-2 text-left enabled:hover:bg-panel-2"
      >
        <Text size="sm" tone="muted" tabular className="w-12 shrink-0">
          {fmtMonthShortDay(txn.date)}
        </Text>
        <span className="flex min-w-0 flex-1 flex-col">
          <Text size="sm" tone={expense ? 'ink' : 'muted'} className="truncate">
            {txn.merchantName ?? txn.name}
          </Text>
          <Text size="xs" tone="muted" className="line-clamp-2 break-words">
            {acct ? `${acct.name} ••${acct.mask}` : ''}
            {txn.pending ? ' · pending' : ''}
            {refundMeta(txn, kind, view)}
            {isPeriodStart(txn, acct) ? ' · starts period' : ''}
            {txn.periodOverride ? ` · moved to ${txn.periodOverride} period` : ''}
            {txn.note ? ` · ${txn.note}` : ''}
          </Text>
        </span>
        <Text size="sm" tabular tone={expense ? 'ink' : 'muted'}>
          {fmtSigned(cents)}
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
