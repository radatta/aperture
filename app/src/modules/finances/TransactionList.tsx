import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  bucketOf,
  FINANCE_BUCKET_LABELS,
  FINANCE_BUCKETS,
  fmtMonthShortDay,
  isPeriodStart,
  isSortableKind,
  matchesFinanceFilter,
  matchesFinanceText,
  netCents,
  periodOf,
} from '@aperture/shared';
import type {
  FinanceBucket,
  FinanceListFilter,
  FinanceOverview,
  FinanceTransaction,
  FinanceTxnKind,
} from '@aperture/shared';
import { EmptyState } from '../../components/EmptyState';
import { revealFocus } from '../../lib/focus';
import { useFinanceToday, useSetFinanceBucket } from '../../data/hooks/useFinances';
import { Text } from '../../components/Text';
import { cx } from '../../lib/cx';
import { BucketTag } from './BucketTag';
import { BRUSH_HINT_ID, BrushPicker, ListSummary, SearchBox, ShowChips } from './LedgerControls';
import { fmtSigned } from './money';
import { refundMeta } from './refundMeta';
import { TransactionDetail } from './TransactionDetail';
import { useLedgerKeys } from './useLedgerKeys';
import type { FinanceView } from './useFinanceData';

const NONE: ReadonlySet<string> = new Set();
const INERT_ID = 'ledger-row-inert';
const rowEls = (root: HTMLElement | null) => [
  ...(root?.querySelectorAll<HTMLElement>('[data-txn-id]') ?? []),
];

const KIND_LABEL: Record<Exclude<FinanceTxnKind, 'expense' | 'refund'>, string> = {
  income: 'money in',
  transfer: 'transfer',
  card_payment: 'card payment',
};

// Every transaction in the current and previous period, newest first (plus, on their own, refunds
// that followed a link out to an older charge's period). Card payments, transfers and
// money into the bank are listed (so the ledger reconciles with the bank) but never sorted or totalled.
// Card refunds are sorted like charges and net against their bucket; a deposit counts only once it's
// linked as a refund. Card payments open to be marked as a period start.
//
// Above the list: "Sort into" (a brush — arm a bucket, then tap rows to sort them one by one), search,
// and the Show chips. Rows painted in one brush session stay put, even once they no longer match the
// chip, until you disarm or change the chip or search — so the list never moves under your finger.
export function TransactionList({
  overview,
  view,
  pending,
  error,
  onRetry,
}: {
  overview: FinanceOverview;
  view: FinanceView | null;
  pending: boolean;
  error: boolean;
  onRetry?: () => void; // the failed read's refetch
}) {
  const [filter, setFilter] = useState<FinanceListFilter>('all');
  const [search, setSearch] = useState('');
  const [brush, setBrush] = useState<FinanceBucket | null>(null);
  const [kept, setKept] = useState<ReadonlySet<string>>(NONE);
  const [announce, setAnnounce] = useState('');
  const [paintFailed, setPaintFailed] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const toggleRefs = useRef(new Map<FinanceBucket, HTMLButtonElement>());
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
  // Disarming can drop the focused row (it was only kept for the session): focus the nearest row still
  // listed — the next ones first, then back up — or, from the brush bar's Done, the toggle it armed.
  const pendingFocus = useRef<{ rows: string[] } | { toggle: FinanceBucket } | null>(null);
  useLayoutEffect(() => {
    const plan = pendingFocus.current;
    if (!plan) return;
    pendingFocus.current = null;
    if ('toggle' in plan) {
      toggleRefs.current.get(plan.toggle)?.focus();
      return;
    }
    const rows = rowEls(rootRef.current);
    const next = plan.rows.map((id) => rows.find((el) => el.dataset.txnId === id)).find(Boolean);
    revealFocus(next ?? rootRef.current);
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
  // Paintable: a charge or card credit on a shown account, not riding on a charge (a linked refund
  // takes its charge's bucket, so painting it would mean nothing).
  const paintable = useMemo(
    () => new Set(view ? view.sortable.filter((t) => !view.links.has(t.id)).map((t) => t.id) : []),
    [view],
  );

  function toggleBrush(b: FinanceBucket) {
    if (brush === b) return disarm();
    setBrush(b);
    setAnnounce(`Sorting into ${FINANCE_BUCKET_LABELS[b]}. Tap a row to sort it; Escape to stop.`);
  }
  function disarm() {
    if (brush === null) return;
    const active = document.activeElement;
    const rows = rowEls(rootRef.current);
    const i = rows.findIndex((el) => el === active);
    if (i >= 0)
      pendingFocus.current = {
        rows: [...rows.slice(i), ...rows.slice(0, i).reverse()].map((el) => el.dataset.txnId!),
      };
    // Done is the one brush control that unmounts; a focused toggle stays put.
    else if (active instanceof HTMLElement && active.dataset.brushDone !== undefined)
      pendingFocus.current = { toggle: brush };
    setBrush(null);
    setKept(NONE);
    setAnnounce('Stopped sorting.');
  }
  // The bucket the tap sets: the armed one, or back to Unsorted if it's already there (undo).
  function paint(t: FinanceTransaction): FinanceBucket | null {
    const next = view && bucketOf(t, view.links) === brush ? null : brush;
    setKept((k) => new Set(k).add(t.id));
    setPaintFailed(false);
    setAnnounce(`${t.merchantName ?? t.name}, ${next ? FINANCE_BUCKET_LABELS[next] : 'Unsorted'}`);
    return next;
  }
  const changeFilter = (f: FinanceListFilter) => {
    setFilter(f);
    setKept(NONE);
  };
  const changeSearch = (v: string) => {
    setSearch(v);
    setKept(NONE);
  };

  useLedgerKeys({
    digit: (n) => {
      const b = FINANCE_BUCKETS[n - 1];
      if (!b || !view || openId !== null) return false;
      toggleBrush(b);
      return true;
    },
    slash: () => searchRef.current?.focus(),
    escape: () => {
      if (brush === null || openId !== null) return false;
      disarm();
      return true;
    },
  });

  if (!view)
    return (
      <EmptyState
        pending={pending && !error}
        error={error}
        onRetry={onRetry}
        title="No transactions yet."
      />
    );

  const kindOf = view.kindOf;
  const needle = search.trim().toLowerCase();
  const matches = (t: FinanceTransaction) =>
    (!needle || matchesFinanceText(t, needle, { note: true })) &&
    (kept.has(t.id) || matchesFinanceFilter(t, view, filter));
  // Dated in a listed period, but linked to a charge from before them: it follows the charge out of
  // both, so it gets its own section — else nothing reaches it to unlink.
  const followed = view.allTxns.filter(
    (t) =>
      periodOf(t, overview.period) !== null &&
      periodOf(t, overview.period, view.links) === null &&
      matches(t),
  );
  const shown = [...view.txns.filter(matches), ...followed];
  const narrowed = needle !== '' || filter !== 'all';
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
    ...(followed.length
      ? [{ key: 'followed', title: 'Linked to older charges', rows: followed }]
      : []),
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
      <BrushPicker brush={brush} onToggle={toggleBrush} onDone={disarm} toggleRefs={toggleRefs} />
      <div className="flex flex-col gap-1.5">
        <SearchBox ref={searchRef} value={search} onChange={changeSearch} />
        {narrowed && <ListSummary count={shown.length} cents={netCents(shown, view.amount)} />}
      </div>
      <ShowChips filter={filter} onChange={changeFilter} />
      <span role="status" className="sr-only">
        {announce}
      </span>
      <span id={INERT_ID} hidden>
        Can&apos;t be sorted here — not a charge, or it follows its charge.
      </span>
      {paintFailed && (
        <div role="alert">
          <Text size="sm" tone="danger">
            Couldn&apos;t save that sort — the row shows what&apos;s saved. Check your connection
            and try again.
          </Text>
        </div>
      )}
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
                  brush={brush}
                  paintable={paintable.has(t.id)}
                  onOpen={() => setOpenId(t.id)}
                  onPaint={paint}
                  onPaintError={() => setPaintFailed(true)}
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
  brush,
  paintable,
  onOpen,
  onPaint,
  onPaintError,
}: {
  txn: FinanceTransaction;
  view: FinanceView;
  kind: FinanceTxnKind;
  brush: FinanceBucket | null;
  paintable: boolean;
  onOpen: () => void;
  onPaint: (t: FinanceTransaction) => FinanceBucket | null;
  onPaintError: () => void;
}) {
  // Each row owns its save queue — the same per-transaction scope the detail uses, so two quick taps
  // on one row land in order.
  const setBucket = useSetFinanceBucket(txn.id, { onError: onPaintError });
  const acct = view.accounts.get(txn.accountId);
  const cents = view.amount(txn);
  // Counts toward a bucket: a charge, a card credit, or a deposit linked as a refund.
  const expense = isSortableKind(kind) || view.links.has(txn.id);
  // Muted like a transfer once sorted as Not spending: listed, so the ledger matches the bank, but
  // in no total.
  const counts = expense && bucketOf(txn, view.links) !== 'not_spending';
  const markable = acct?.type === 'credit' && cents < 0;
  const disabled = !(expense || markable || kind === 'income');
  // Armed, a row that can't take a bucket goes inert — aria-disabled, not disabled, so a focused row
  // keeps focus when you arm.
  const inert = brush !== null && !paintable;
  function onClick() {
    if (brush === null) return onOpen();
    if (!paintable) return;
    setBucket.mutate({ ids: [txn.id], bucket: onPaint(txn) });
  }
  return (
    <li>
      <button
        type="button"
        data-txn-id={txn.id}
        onClick={onClick}
        disabled={disabled}
        aria-disabled={inert && !disabled ? true : undefined}
        aria-describedby={brush === null || disabled ? undefined : inert ? INERT_ID : BRUSH_HINT_ID}
        className={cx(
          'flex w-full items-center gap-3 py-2 text-left',
          // Armed, the sticky Sort-into bar covers the top: keep a focused row scrolled clear of it.
          brush !== null && 'scroll-mt-48 sm:scroll-mt-36',
          inert ? 'cursor-not-allowed' : 'enabled:hover:bg-panel-2',
          brush !== null && paintable && 'cursor-pointer',
        )}
      >
        <Text size="sm" tone="muted" tabular className="w-12 shrink-0">
          {fmtMonthShortDay(txn.date)}
        </Text>
        <span className="flex min-w-0 flex-1 flex-col">
          <Text size="sm" tone={counts && !inert ? 'ink' : 'muted'} className="truncate">
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
        <Text size="sm" tabular tone={counts && !inert ? 'ink' : 'muted'}>
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
