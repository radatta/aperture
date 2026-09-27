import { useEffect, useMemo, useRef, useState } from 'react';
import {
  FINANCE_BUCKET_LABELS,
  FINANCE_BUCKETS,
  fmtMonthShortDay,
  groupByMerchant,
  periodOf,
  sortableTransactions,
} from '@aperture/shared';
import type {
  FinanceBucket,
  FinanceOverview,
  FinanceTransaction,
  MerchantGroup,
} from '@aperture/shared';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { Text } from '../../components/Text';
import { cx } from '../../lib/cx';
import { useSetFinanceBucket } from '../../data/hooks/useFinances';
import { fmtMoney } from './money';
import type { FinanceView } from './useFinanceData';

// The batch sort: every unsorted charge in the current AND previous period, grouped by merchant,
// biggest first. One press sorts a whole group (keys 1/2/3 when it has focus), "Always" also saves a
// rule so that merchant never comes back, and focus moves on to the next group — built for sitting
// down mid- or end-of-cycle and clearing the lot, not for sorting as charges land.
export function SortQueue({
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
  const groups = useMemo(() => {
    if (!view) return [];
    const unsorted = sortableTransactions(view.txns, overview.accounts, view.moves).filter(
      (t) => t.bucket === null,
    );
    return groupByMerchant(unsorted, view.amount);
  }, [view, overview.accounts]);
  const setBucket = useSetFinanceBucket();
  const refs = useRef(new Map<string, HTMLDivElement>());
  // Which group was just sorted, and where it sat. Keyed, not indexed: an unrelated re-render (the
  // previous sort settling, the sync poll) can change `groups` first, and sorting one charge re-orders
  // groups by total — so wait until THAT group is gone, then focus whatever took its place. A partial
  // sort (one charge of several) keeps the group, so focus returns to its card.
  const pendingFocus = useRef<{ key: string; index: number; partial: boolean } | null>(null);
  const doneRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const p = pendingFocus.current;
    if (!p) return;
    const still = groups.findIndex((g) => g.key === p.key);
    if (still !== -1) {
      if (!p.partial) return;
      pendingFocus.current = null;
      refs.current.get(p.key)?.focus();
      return;
    }
    pendingFocus.current = null;
    const next = groups[Math.min(p.index, groups.length - 1)];
    if (next) refs.current.get(next.key)?.focus();
    else doneRef.current?.focus();
  }, [groups]);

  function sort(
    group: MerchantGroup,
    index: number,
    ids: string[],
    bucket: FinanceBucket,
    rulePattern: string | null,
  ) {
    pendingFocus.current = { key: group.key, index, partial: ids.length < group.txns.length };
    setBucket.mutate({ ids, bucket, rule: rulePattern ? { pattern: rulePattern } : undefined });
  }

  if (groups.length === 0)
    return (
      <div ref={doneRef} tabIndex={-1} className="outline-none">
        <EmptyState pending={!error && (pending || !view)} error={error} title="All sorted.">
          New charges land here after each sync (four times a day). Sort them whenever — mid-cycle
          or right before the payment.
        </EmptyState>
      </div>
    );

  return (
    <div className="flex flex-col gap-3">
      <Text id="sort-help" size="sm" tone="muted">
        {groups.reduce((n, g) => n + g.txns.length, 0)} charges from {groups.length} places. Focus a
        group and press <Kbd>1</Kbd> <Kbd>2</Kbd> <Kbd>3</Kbd>.
      </Text>
      {setBucket.isError && (
        <div role="alert">
          <Text size="sm" tone="danger">
            Couldn&apos;t save that sort — it&apos;s back in the list. Check your connection and try
            again.
          </Text>
        </div>
      )}
      {groups.map((g, i) => (
        <GroupCard
          key={g.key}
          group={g}
          overview={overview}
          view={view!}
          cardRef={(el) => {
            if (el) refs.current.set(g.key, el);
            else refs.current.delete(g.key);
          }}
          onSort={(ids, bucket, rule) => sort(g, i, ids, bucket, rule)}
        />
      ))}
    </div>
  );
}

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="rounded-md border border-line-strong px-1.5 py-0.5 font-sans text-xs text-ink">
      {children}
    </kbd>
  );
}

function GroupCard({
  group,
  overview,
  view,
  cardRef,
  onSort,
}: {
  group: MerchantGroup;
  overview: FinanceOverview;
  view: FinanceView;
  cardRef: (el: HTMLDivElement | null) => void;
  onSort: (ids: string[], bucket: FinanceBucket, rulePattern: string | null) => void;
}) {
  const [always, setAlways] = useState(false);
  const [open, setOpen] = useState(false);
  const ids = group.txns.map((t) => t.id);
  const dates = group.txns.map((t) => t.date).sort();
  const span =
    dates[0] === dates[dates.length - 1]
      ? fmtMonthShortDay(dates[0]!)
      : `${fmtMonthShortDay(dates[0]!)} – ${fmtMonthShortDay(dates[dates.length - 1]!)}`;
  const sortAll = (b: FinanceBucket) => onSort(ids, b, always ? group.key : null);
  const listId = `grp-${group.key.replace(/\W+/g, '-')}`;

  return (
    <Card
      ref={cardRef}
      role="group"
      tabIndex={0}
      aria-keyshortcuts="1 2 3"
      aria-describedby="sort-help"
      aria-label={`${group.label}, ${group.txns.length} charges, ${fmtMoney(group.totalCents)}`}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return; // keys typed into the checkbox etc. aren't sorts
        const n = Number(e.key);
        if (n >= 1 && n <= FINANCE_BUCKETS.length) {
          e.preventDefault();
          sortAll(FINANCE_BUCKETS[n - 1]!);
        }
      }}
      className="flex flex-col gap-3 outline-none focus-visible:border-teal"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <Text weight="medium" className="truncate">
            {group.label}
          </Text>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => setOpen((o) => !o)}
            className="self-start text-sm text-ink-muted hover:text-ink"
          >
            {group.txns.length} {group.txns.length === 1 ? 'charge' : 'charges'} · {span}{' '}
            {open ? '▴' : '▾'}
          </button>
        </div>
        <Text weight="medium" tabular>
          {fmtMoney(group.totalCents)}
        </Text>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {FINANCE_BUCKETS.map((b, i) => (
          <Button key={b} size="sm" variant="ghost" onClick={() => sortAll(b)}>
            <span className="mr-1.5 text-xs text-ink-muted">{i + 1}</span>
            {FINANCE_BUCKET_LABELS[b]}
          </Button>
        ))}
        <label className="ml-auto flex items-center gap-1.5 text-sm text-ink-muted">
          <input
            type="checkbox"
            checked={always}
            onChange={(e) => setAlways(e.target.checked)}
            className="accent-teal"
          />
          Always
        </label>
      </div>
      {always && (
        <Text size="xs" tone="muted">
          Saves a rule: anything matching “{group.key}” sorts itself from now on.
        </Text>
      )}
      {open && (
        <ul id={listId} className="flex flex-col divide-y divide-line border-t border-line">
          {group.txns.map((t) => (
            <ChargeRow
              key={t.id}
              txn={t}
              view={view}
              previous={periodOf(t, overview.period) === 'previous'}
              onSort={(b) => onSort([t.id], b, null)}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

function ChargeRow({
  txn,
  view,
  previous,
  onSort,
}: {
  txn: FinanceTransaction;
  view: FinanceView;
  previous: boolean;
  onSort: (b: FinanceBucket) => void;
}) {
  const acct = view.accounts.get(txn.accountId);
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
      <Text size="sm" tone="muted" tabular className="w-12 shrink-0">
        {fmtMonthShortDay(txn.date)}
      </Text>
      <Text size="sm" tone="muted" className={cx('min-w-0 flex-1 truncate')}>
        {txn.name}
        {acct?.mask ? ` · ••${acct.mask}` : ''}
        {txn.pending ? ' · pending' : ''}
        {previous ? ' · last period' : ''}
      </Text>
      <Text size="sm" tabular>
        {fmtMoney(view.amount(txn))}
      </Text>
      <div className="flex gap-1">
        {FINANCE_BUCKETS.map((b) => (
          <Button
            key={b}
            size="sm"
            variant="quiet"
            onClick={() => onSort(b)}
            aria-label={`${FINANCE_BUCKET_LABELS[b]}: ${txn.name}`}
          >
            {FINANCE_BUCKET_LABELS[b]}
          </Button>
        ))}
      </div>
    </li>
  );
}
