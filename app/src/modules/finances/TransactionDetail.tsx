import { useState } from 'react';
import {
  FINANCE_BUCKET_LABELS,
  FINANCE_BUCKETS,
  fmtMonthShortDay,
  periodOf,
  REFUND_MATCH_WINDOW_DAYS,
  suggestRefundMatches,
} from '@aperture/shared';
import type { FinanceOverview, FinancePeriodOverride, FinanceTransaction } from '@aperture/shared';
import { Button } from '../../components/Button';
import { Field } from '../../components/Field';
import { Modal } from '../../components/Modal';
import { Text } from '../../components/Text';
import { cx } from '../../lib/cx';
import {
  useLinkFinanceRefund,
  useSetFinanceBucket,
  useSetFinanceNote,
  useSetFinancePeriodOverride,
} from '../../data/hooks/useFinances';
import { fmtMoney } from './money';
import type { FinanceView } from './useFinanceData';

// One transaction: its bucket, which period it counts in (a charge that posted after the payment but
// belongs to the old cycle, or vice versa), and a note. Every control saves as you change it.
// A card refund can instead be linked to the charge it reverses — it then follows that charge's
// bucket and period, so those controls give way to the link. A charge lists the refunds against it.
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
  const link = useLinkFinanceRefund();
  const isRefund = view.kindOf(txn) === 'refund';
  const linkedTo = view.links.get(txn.id);
  const dangling = txn.refundOfId !== null && !linkedTo; // its charge isn't loaded / is gone
  const cents = view.amount(txn);
  // Focus follows a link/unlink (the clicked button unmounts) — but never on first open, where a
  // focused Link button would make a stray Enter link the refund.
  const [acted, setActed] = useState(false);
  const setLink = (chargeId: string | null) => {
    setActed(true);
    link.mutate({ refundId: txn.id, chargeId });
  };
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
    <Modal
      open
      onClose={close}
      label={`${isRefund ? 'Refund' : 'Charge'}: ${txn.merchantName ?? txn.name}`}
      closeOnBackdrop
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-baseline justify-between gap-3">
            <Text as="h2" size="lg" weight="semibold">
              {txn.merchantName ?? txn.name}
            </Text>
            <Text size="lg" tabular>
              {cents < 0 ? `+${fmtMoney(-cents)}` : fmtMoney(cents)}
            </Text>
          </div>
          <Text size="sm" tone="muted">
            {fmtMonthShortDay(txn.date)} · {txn.name}
            {acct ? ` · ${acct.name} ••${acct.mask}` : ''}
            {txn.pending ? ' · pending' : ''}
            {isRefund ? ' · refund' : ''}
          </Text>
        </div>

        {linkedTo && (
          <LinkedRefund
            charge={linkedTo}
            view={view}
            overview={overview}
            busy={link.isPending}
            focus={acted}
            onUnlink={() => setLink(null)}
          />
        )}
        {dangling && (
          <div className="flex flex-wrap items-center gap-3">
            <Text size="sm" tone="muted" className="flex-1">
              Linked to an earlier charge that isn&apos;t shown here any more, so it counts as
              unsorted.
            </Text>
            <Button
              size="sm"
              variant="ghost"
              disabled={link.isPending}
              onClick={() => setLink(null)}
            >
              Unlink
            </Button>
          </div>
        )}
        {isRefund && !txn.refundOfId && (
          <RefundSuggestions
            refund={txn}
            view={view}
            busy={link.isPending}
            focus={acted}
            onLink={(chargeId) => setLink(chargeId)}
          />
        )}
        {!isRefund && <RefundsAgainst charge={txn} view={view} />}

        {!txn.refundOfId && (
          <>
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
          </>
        )}
        {link.isError && (
          <div role="alert">
            <Text size="sm" tone="danger">
              Couldn&apos;t link it: {link.error.message}
            </Text>
          </div>
        )}
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

function LinkedRefund({
  charge,
  view,
  overview,
  busy,
  focus,
  onUnlink,
}: {
  charge: FinanceTransaction;
  view: FinanceView;
  overview: FinanceOverview;
  busy: boolean;
  focus: boolean;
  onUnlink: () => void;
}) {
  const which = periodOf(charge, overview.period);
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line p-3">
      <div className="flex flex-wrap items-center gap-3">
        <Text size="sm" className="flex-1">
          Refund of <Text weight="medium">{charge.merchantName ?? charge.name}</Text> ·{' '}
          {fmtMonthShortDay(charge.date)} · {fmtMoney(view.amount(charge))}
        </Text>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onUnlink} autoFocus={focus}>
          Unlink
        </Button>
      </div>
      <Text size="sm" tone="muted">
        Counts as {charge.bucket ? FINANCE_BUCKET_LABELS[charge.bucket] : 'unsorted'},{' '}
        {which === 'current'
          ? 'this period'
          : which === 'previous'
            ? 'last period'
            : 'an earlier period'}{' '}
        — it follows the charge.
      </Text>
    </div>
  );
}

// The charges this refund could reverse: the best as a one-click Link, then a few runners-up.
function RefundSuggestions({
  refund,
  view,
  busy,
  focus,
  onLink,
}: {
  refund: FinanceTransaction;
  view: FinanceView;
  busy: boolean;
  focus: boolean;
  onLink: (chargeId: string) => void;
}) {
  // Charges on shown accounts only — a hidden account's rows never resolve as a link target.
  const suggest = (anyMerchant: boolean) =>
    suggestRefundMatches({
      refund,
      txns: view.sortable,
      accounts: [...view.accounts.values()],
      moves: view.moves,
      links: view.links,
      anyMerchant,
    }).slice(0, 5);
  const sameMerchant = suggest(false);
  // A card credit's descriptor doesn't always match its charge's merchant — fall back to any charge.
  const matches = sameMerchant.length ? sameMerchant : suggest(true);
  const merchant = refund.merchantName ?? refund.name;
  const labelId = `refund-of-${refund.id}`;
  return (
    <div className="flex flex-col gap-1.5">
      <Text id={labelId} size="sm" tone="muted">
        {sameMerchant.length
          ? `Refund of which ${merchant} charge?`
          : `No ${merchant} charge found from the ${REFUND_MATCH_WINDOW_DAYS} days before it. Other charges it could be:`}
      </Text>
      {matches.length === 0 ? (
        <Text size="sm" tone="muted">
          Nothing it could reverse. Sort it below instead.
        </Text>
      ) : (
        <ul aria-labelledby={labelId} className="flex flex-col gap-1.5">
          {matches.map((c, i) => {
            const refunded = view.refunded.get(c.id) ?? 0;
            return (
              <li
                key={c.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-line px-3 py-2"
              >
                <Text size="sm" tone="muted" tabular className="w-12 shrink-0">
                  {fmtMonthShortDay(c.date)}
                </Text>
                <Text size="sm" className="min-w-0 flex-1 truncate">
                  {sameMerchant.length ? '' : `${c.merchantName ?? c.name} · `}
                  {c.bucket ? FINANCE_BUCKET_LABELS[c.bucket] : 'Unsorted'}
                  {refunded > 0 ? ` · ${fmtMoney(refunded)} already refunded` : ''}
                </Text>
                <Text size="sm" tabular>
                  {fmtMoney(view.amount(c))}
                </Text>
                <Button
                  size="sm"
                  variant={i === 0 ? 'primary' : 'ghost'}
                  disabled={busy}
                  autoFocus={focus && i === 0}
                  onClick={() => onLink(c.id)}
                  aria-label={`Link to ${c.merchantName ?? c.name} on ${fmtMonthShortDay(c.date)}, ${fmtMoney(view.amount(c))}`}
                >
                  Link
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// On a charge: what's been refunded against it, so a smaller net makes sense at a glance.
function RefundsAgainst({ charge, view }: { charge: FinanceTransaction; view: FinanceView }) {
  const refunds = view.allTxns.filter((t) => view.links.get(t.id)?.id === charge.id);
  if (refunds.length === 0) return null;
  const total = view.refunded.get(charge.id) ?? 0;
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-line p-3">
      <Text size="sm">
        Refunded {fmtMoney(total)} of {fmtMoney(view.amount(charge))}
      </Text>
      {refunds.map((r) => (
        <Text key={r.id} size="sm" tone="muted" tabular>
          {fmtMonthShortDay(r.date)} · +{fmtMoney(-view.amount(r))}
        </Text>
      ))}
    </div>
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
