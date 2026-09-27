import { useState } from 'react';
import { FINANCE_BUCKET_LABELS, FINANCE_BUCKETS, fmtMonthShortDay } from '@aperture/shared';
import type { FinanceOverview, FinancePeriodOverride, FinanceTransaction } from '@aperture/shared';
import { Button } from '../../components/Button';
import { Field } from '../../components/Field';
import { Modal } from '../../components/Modal';
import { Text } from '../../components/Text';
import { cx } from '../../lib/cx';
import {
  useSetFinanceBucket,
  useSetFinanceNote,
  useSetFinancePeriodOverride,
} from '../../data/hooks/useFinances';
import { fmtMoney } from './money';
import type { FinanceView } from './useFinanceData';

// One charge: its bucket, which period it counts in (a charge that posted after the payment but
// belongs to the old cycle, or vice versa), and a note. Every control saves as you change it.
export function TransactionDetail({
  txn,
  view,
  overview,
  onClose,
}: {
  txn: FinanceTransaction;
  view: FinanceView;
  overview: FinanceOverview;
  onClose: () => void;
}) {
  const setBucket = useSetFinanceBucket();
  const setOverride = useSetFinancePeriodOverride();
  const setNote = useSetFinanceNote();
  const [note, setNoteText] = useState(txn.note ?? '');
  const acct = view.accounts.get(txn.accountId);
  const overrides: { value: FinancePeriodOverride | null; label: string }[] = [
    { value: null, label: 'By date' },
    { value: 'current', label: `This period (from ${fmtMonthShortDay(overview.period.start)})` },
    { value: 'previous', label: 'Last period' },
  ];

  function close() {
    const next = note.trim() || null;
    if (next !== txn.note) setNote.mutate({ id: txn.id, note: next });
    onClose();
  }

  return (
    <Modal open onClose={close} label={`Charge: ${txn.merchantName ?? txn.name}`} closeOnBackdrop>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-baseline justify-between gap-3">
            <Text as="h2" size="lg" weight="semibold">
              {txn.merchantName ?? txn.name}
            </Text>
            <Text size="lg" tabular>
              {fmtMoney(view.amount(txn))}
            </Text>
          </div>
          <Text size="sm" tone="muted">
            {fmtMonthShortDay(txn.date)} · {txn.name}
            {acct ? ` · ${acct.name} ••${acct.mask}` : ''}
            {txn.pending ? ' · pending' : ''}
          </Text>
        </div>

        <Segmented
          label="Bucket"
          options={[
            ...FINANCE_BUCKETS.map((b) => ({ value: b, label: FINANCE_BUCKET_LABELS[b] })),
            { value: null, label: 'Unsorted' },
          ]}
          value={txn.bucket}
          onChange={(bucket) => setBucket.mutate({ ids: [txn.id], bucket })}
        />
        <Segmented
          label="Counts in"
          options={overrides}
          value={txn.periodOverride}
          onChange={(override) => setOverride.mutate({ id: txn.id, override })}
        />
        {(setBucket.isError || setOverride.isError || setNote.isError) && (
          <div role="alert">
            <Text size="sm" tone="danger">
              Couldn&apos;t save that change — check your connection and try again.
            </Text>
          </div>
        )}
        <Field
          label="Note"
          value={note}
          onChange={(e) => setNoteText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && close()}
          placeholder="Split with…, refund pending…"
        />
        <div className="flex justify-end">
          <Button onClick={close}>Done</Button>
        </div>
      </div>
    </Modal>
  );
}

function Segmented<T extends string | null>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-col gap-1.5">
      <Text size="sm" tone="muted">
        {label}
      </Text>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => (
          <button
            key={o.label}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            onClick={() => onChange(o.value)}
            className={cx(
              'rounded-xl border px-3 py-1.5 text-sm transition',
              value === o.value
                ? 'border-teal bg-teal-soft text-ink'
                : 'border-line text-ink-muted hover:text-ink',
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
