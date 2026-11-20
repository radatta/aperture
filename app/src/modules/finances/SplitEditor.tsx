import { useRef, useState } from 'react';
import {
  allocateProportional,
  countedParts,
  FINANCE_BUCKET_LABELS,
  FINANCE_BUCKETS,
  FINANCE_SPLIT_MAX_PARTS,
  financeSplitError,
  splitTotal,
} from '@aperture/shared';
import type {
  FinanceBucket,
  FinanceOverview,
  FinancePartPeriod,
  FinanceSplitPartInput,
  FinanceTransaction,
} from '@aperture/shared';
import { Button } from '../../components/Button';
import { Text } from '../../components/Text';
import { useSetFinanceSplit } from '../../data/hooks/useFinances';
import { centsText, parsedSum, selectClass } from './amounts';
import { MoneyInput, Remainder } from './AmountRows';
import { fmtMoney, parseDollars } from './money';
import type { FinanceView } from './useFinanceData';

const PERIOD_OPTIONS: { value: FinancePartPeriod | null; label: string }[] = [
  { value: null, label: 'With the charge' },
  { value: 'current', label: 'This period' },
  { value: 'previous', label: 'Last period' },
  { value: 'next', label: 'Next period' },
];
const periodKey = (p: FinancePartPeriod | null) => p ?? 'charge';

interface DraftPart {
  key: number;
  bucket: FinanceBucket;
  amount: string;
  period: FinancePartPeriod | null;
  touched: boolean; // typed into: with two parts, the untouched one follows the remainder
}

// The first draft: the stored parts (a broken split keeps them, to fix), else half and half — the row's
// bucket (else Budget) and the next one, the odd cent to the first (allocateProportional).
function firstDraft(txn: FinanceTransaction, total: number): DraftPart[] {
  if (txn.splits?.length)
    return txn.splits.map((p, i) => ({
      key: i,
      bucket: p.bucket,
      amount: centsText(p.cents),
      period: p.period,
      touched: true,
    }));
  const first = txn.bucket ?? 'budget';
  const second = FINANCE_BUCKETS[(FINANCE_BUCKETS.indexOf(first) + 1) % FINANCE_BUCKETS.length]!;
  const [a, b] = allocateProportional(total, [1, 1]);
  return [
    { key: 0, bucket: first, amount: centsText(a!), period: null, touched: false },
    { key: 1, bucket: second, amount: centsText(b!), period: null, touched: false },
  ];
}

// Split a charge across buckets, each part with its own period. Saved explicitly (Save), unlike the
// detail's other controls: a half-typed split never adds up. A refusal — the page's own check or the
// server's — shows why and keeps every field as typed.
export function SplitEditor({
  txn,
  view,
  onSaved,
  onCancel,
}: {
  txn: FinanceTransaction;
  view: FinanceView;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const total = view.amount(txn);
  const save = useSetFinanceSplit();
  const [rows, setRows] = useState<DraftPart[]>(() => firstDraft(txn, total));
  const nextKey = useRef(rows.length);
  const [error, setError] = useState<string | null>(null);
  const busy = save.isPending;

  // Any edit clears a refusal: it was about the parts as they were.
  const update = (i: number, patch: Partial<DraftPart>) => {
    setError(null);
    save.reset();
    setRows((rs) => {
      const next = rs.map((r, j) => (j === i ? { ...r, ...patch } : r));
      // Two parts and the other untouched: it takes whatever's left, so typing one amount is enough.
      if (patch.amount !== undefined && next.length === 2 && !next[1 - i]!.touched) {
        const typed = parseDollars(patch.amount);
        if (typed !== null && typed <= total)
          next[1 - i] = { ...next[1 - i]!, amount: centsText(total - typed) };
      }
      return next;
    });
  };
  const addPart = () =>
    setRows((rs) => {
      const sum = parsedSum(rs.map((r) => r.amount)) ?? total;
      const used = new Set(rs.map((r) => r.bucket));
      const bucket = FINANCE_BUCKETS.find((b) => !used.has(b)) ?? 'budget';
      const left = Math.max(total - sum, 0);
      return [
        ...rs,
        { key: nextKey.current++, bucket, amount: centsText(left), period: null, touched: true },
      ];
    });

  const sum = parsedSum(rows.map((r) => r.amount));
  const remainder =
    sum === null
      ? { text: 'Enter an amount like 12.50 on every part', tone: 'danger' as const }
      : sum === total
        ? { text: `Adds up to ${fmtMoney(total)}`, tone: 'muted' as const }
        : sum < total
          ? { text: `${fmtMoney(total - sum)} left to assign`, tone: 'muted' as const }
          : {
              text: `${fmtMoney(sum - total)} over the ${fmtMoney(total)} charge`,
              tone: 'danger' as const,
            };

  function submit() {
    if (busy) return;
    setError(null);
    const parts: FinanceSplitPartInput[] = [];
    for (const r of rows) {
      const cents = parseDollars(r.amount);
      if (cents === null) return setError('Enter an amount like 12.50 on every part');
      parts.push({ bucket: r.bucket, cents, period: r.period });
    }
    const refusal = financeSplitError({
      txn,
      account: view.accounts.get(txn.accountId),
      moves: view.moves,
      parts,
    });
    if (refusal) return setError(refusal);
    save.mutate({ id: txn.id, parts }, { onSuccess: onSaved });
  }

  return (
    <form
      className="flex flex-col gap-2 rounded-xl border border-line p-3"
      aria-label="Split this charge"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Text size="sm" weight="medium">
        Split {fmtMoney(total)} across buckets
      </Text>
      <ul className="flex flex-col gap-2">
        {rows.map((r, i) => (
          <li key={r.key} className="flex flex-wrap items-center gap-2">
            <select
              aria-label={`Part ${i + 1} bucket`}
              value={r.bucket}
              autoFocus={i === 0}
              onChange={(e) => update(i, { bucket: e.target.value as FinanceBucket })}
              className={selectClass}
            >
              {FINANCE_BUCKETS.map((b) => (
                <option key={b} value={b}>
                  {FINANCE_BUCKET_LABELS[b]}
                </option>
              ))}
            </select>
            <MoneyInput
              label={`Part ${i + 1} amount`}
              value={r.amount}
              onChange={(amount) => update(i, { amount, touched: true })}
            />
            <select
              aria-label={`Part ${i + 1} period`}
              value={periodKey(r.period)}
              onChange={(e) =>
                update(i, {
                  period: PERIOD_OPTIONS.find((o) => periodKey(o.value) === e.target.value)!.value,
                })
              }
              className={selectClass}
            >
              {PERIOD_OPTIONS.map((o) => (
                <option key={periodKey(o.value)} value={periodKey(o.value)}>
                  {o.label}
                </option>
              ))}
            </select>
            {rows.length > 2 && (
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Remove part ${i + 1}`}
                onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
              >
                Remove
              </Button>
            )}
          </li>
        ))}
      </ul>
      <Remainder tone={remainder.tone}>{remainder.text}</Remainder>
      {rows.some((r) => r.period === 'next') && (
        <Text size="xs" tone="muted">
          A next-period part waits outside every total until you mark the card payment that starts
          the next period.
        </Text>
      )}
      {(error ?? save.error) && (
        <div role="alert">
          <Text size="sm" tone="danger">
            Couldn&apos;t save the split: {error ?? save.error!.message}
          </Text>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {/* Busy is aria-disabled, not disabled: a disabled button drops the focus it holds. */}
        <Button type="submit" size="sm" aria-disabled={busy || undefined}>
          Save split
        </Button>
        {rows.length < FINANCE_SPLIT_MAX_PARTS && (
          <Button size="sm" variant="ghost" onClick={addPart}>
            Add part
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// A saved split, in place of the Bucket group: each part's bucket, amount (after its share of any
// refunds) and where it counts.
export function SplitSummary({
  txn,
  view,
  overview,
  busy,
  focus,
  editRef,
  onEdit,
  onRemove,
}: {
  txn: FinanceTransaction;
  view: FinanceView;
  overview: FinanceOverview;
  busy: boolean;
  focus: boolean;
  editRef?: React.Ref<HTMLButtonElement>;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const cents = view.amount(txn);
  const parts = countedParts(txn, cents, view.refunded.get(txn.id) ?? 0, overview.period);
  const where = (p: (typeof parts)[number]) =>
    p.window === 'upcoming'
      ? 'next period — waits until it starts'
      : p.window === 'current'
        ? 'this period'
        : p.window === 'previous'
          ? 'last period'
          : 'an earlier period';
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line p-3">
      <Text size="sm" weight="medium">
        Split across {parts.length} parts
      </Text>
      <ul className="flex flex-col gap-1">
        {parts.map((p, i) => (
          <li key={i} className="flex flex-wrap items-baseline gap-x-2">
            <Text size="sm" className="min-w-0 flex-1">
              {p.bucket ? FINANCE_BUCKET_LABELS[p.bucket] : 'Unsorted'}
            </Text>
            <Text size="sm" tabular>
              {fmtMoney(p.cents - p.refundedCents)}
              {p.refundedCents > 0 ? ` of ${fmtMoney(p.cents)}` : ''}
            </Text>
            <Text size="xs" tone="muted" className="w-full">
              {p.bucket === 'not_spending' ? 'Not spending — outside every total' : where(p)}
            </Text>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button
          ref={editRef}
          size="sm"
          variant="ghost"
          autoFocus={focus}
          aria-disabled={busy || undefined}
          onClick={busy ? undefined : onEdit}
        >
          Edit split
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-disabled={busy || undefined}
          onClick={busy ? undefined : onRemove}
        >
          Remove split
        </Button>
      </div>
    </div>
  );
}

// A split whose parts no longer add up to the charge (it posted at a new amount): why, and a way back.
export function BrokenSplit({
  txn,
  view,
  fixRef,
  onFix,
}: {
  txn: FinanceTransaction;
  view: FinanceView;
  fixRef?: React.Ref<HTMLButtonElement>;
  onFix: () => void;
}) {
  const was = splitTotal(txn.splits ?? []);
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line p-3">
      <Text size="sm" className="min-w-0 flex-1">
        The amount changed from {fmtMoney(was)} to {fmtMoney(view.amount(txn))}, so the split no
        longer adds up. Fix the split, or sort it below.
      </Text>
      <Button ref={fixRef} size="sm" variant="ghost" onClick={onFix}>
        Fix the split
      </Button>
    </div>
  );
}
