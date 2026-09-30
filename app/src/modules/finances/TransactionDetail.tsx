import { useRef, useState } from 'react';
import {
  addDays,
  FINANCE_BUCKET_LABELS,
  FINANCE_BUCKETS,
  fmtMonthShortDay,
  isPeriodStart,
  periodOf,
  REFUND_MATCH_WINDOW_DAYS,
  refundSideError,
  suggestRefundMatches,
} from '@aperture/shared';
import type {
  FinanceOverview,
  FinancePeriodOverride,
  FinanceTransaction,
  FinanceTxnKind,
} from '@aperture/shared';
import { Button } from '../../components/Button';
import { Field } from '../../components/Field';
import { Modal } from '../../components/Modal';
import { Text } from '../../components/Text';
import { cx } from '../../lib/cx';
import { useDisclosure } from '../../lib/useDisclosure';
import {
  useLinkFinanceRefund,
  useSetFinanceBucket,
  useSetFinanceNote,
  useSetFinancePeriodOverride,
  useSetFinancePeriodStart,
} from '../../data/hooks/useFinances';
import { fmtMoney, fmtSigned } from './money';
import type { FinanceView } from './useFinanceData';

const KIND_LABEL: Record<FinanceTxnKind, string> = {
  expense: 'Charge',
  refund: 'Refund',
  income: 'Money in',
  transfer: 'Transfer',
  card_payment: 'Payment',
};

// One transaction: its bucket, which period it counts in (a charge that posted after the payment but
// belongs to the old cycle, or vice versa), and a note. Every control saves as you change it.
// Money coming in (a card credit or a checking/savings deposit) can instead be linked to the charge it
// reverses — it then follows that charge's bucket and period, so those controls give way to the link.
// A charge lists the refunds against it. Money in on the card can be marked as the payment that
// starts a billing period.
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
  const setBucket = useSetFinanceBucket(txn.id);
  const setOverride = useSetFinancePeriodOverride(txn.id);
  const setNote = useSetFinanceNote();
  const link = useLinkFinanceRefund();
  const mark = useSetFinancePeriodStart();
  const kind = view.kindOf(txn);
  const isRefund = kind === 'refund';
  const isIncome = kind === 'income';
  const linkedTo = view.links.get(txn.id);
  const dangling = txn.refundOfId !== null && !linkedTo; // its charge isn't loaded / is gone
  const cents = view.amount(txn);
  const acct = view.accounts.get(txn.accountId);
  const markable = acct?.type === 'credit' && cents < 0;
  // Money in that could be a refund at all — a Venmo cash-out or a transfer never is.
  const linkableIncome = isIncome && refundSideError(txn, acct, view.moves) === null;
  // Focus follows a link/unlink/mark (the clicked button unmounts) — but never on first open, where
  // a focused Link button would make a stray Enter link the refund.
  const [acted, setActed] = useState(false);
  const setLink = (chargeId: string | null) => {
    setActed(true);
    link.mutate({ refundId: txn.id, chargeId });
  };
  const setMark = (marked: boolean) => {
    setActed(true);
    mark.mutate({ id: txn.id, marked });
  };
  const incomeLink = useDisclosure();
  // null until you type: an untouched field tracks the server's note, so closing never writes it.
  const [draft, setDraft] = useState<string | null>(null);
  const overrides: { value: FinancePeriodOverride | null; label: string }[] = [
    { value: null, label: 'By date' },
    { value: 'current', label: `This period (from ${fmtMonthShortDay(overview.period.start)})` },
    { value: 'previous', label: 'Last period' },
  ];

  function close() {
    const next = draft === null ? txn.note : draft.trim() || null;
    if (next !== txn.note) setNote.mutate({ id: txn.id, note: next });
    onClose();
  }

  return (
    <Modal
      open
      onClose={close}
      label={`${KIND_LABEL[kind]}: ${txn.merchantName ?? txn.name}`}
      closeOnBackdrop
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-baseline justify-between gap-3">
            <Text as="h2" size="lg" weight="semibold">
              {txn.merchantName ?? txn.name}
            </Text>
            <Text size="lg" tabular>
              {fmtSigned(cents)}
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
            refund={txn}
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
              Linked to a charge that isn&apos;t shown here any more, so it counts as{' '}
              {isRefund ? 'unsorted' : isIncome ? 'money in' : 'a transfer, outside the budget'}.
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
            fallback="Nothing it could reverse. Sort it below instead."
            onLink={(chargeId) => setLink(chargeId)}
          />
        )}
        {linkableIncome &&
          !txn.refundOfId &&
          (incomeLink.open ? (
            <RefundSuggestions
              refund={txn}
              view={view}
              busy={link.isPending}
              focus
              fallback="Nothing it could reverse — it stays money in, outside the budget."
              onLink={(chargeId) => setLink(chargeId)}
              onCancel={incomeLink.onClose}
            />
          ) : (
            <div className="flex flex-col gap-1">
              <Text size="sm" tone="muted">
                Money in stays out of the budget — unless it reverses a charge: a refund, or someone
                paying you back.
              </Text>
              <Button
                ref={incomeLink.triggerRef}
                size="sm"
                variant="ghost"
                className="self-start"
                onClick={incomeLink.onOpen}
              >
                Link as a refund
              </Button>
            </div>
          ))}
        {kind === 'expense' && <RefundsAgainst charge={txn} view={view} />}
        {((kind === 'card_payment' && markable) || txn.startsPeriod) && (
          <PeriodMark
            txn={txn}
            marked={txn.startsPeriod}
            dormant={txn.startsPeriod && !isPeriodStart(txn, acct)}
            busy={mark.isPending}
            focus={acted}
            onMark={setMark}
          />
        )}

        {(kind === 'expense' || isRefund) && !txn.refundOfId && (
          <>
            <Segmented
              label="Bucket"
              autoFocus
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
        {isRefund && (
          <Button
            size="sm"
            variant="quiet"
            className="self-start"
            disabled={mark.isPending}
            onClick={() => setMark(true)}
          >
            It&apos;s a card payment — start the period here
          </Button>
        )}
        {mark.isError && (
          <div role="alert">
            <Text size="sm" tone="danger">
              Couldn&apos;t change the period: {mark.error.message}
            </Text>
          </div>
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
          value={draft ?? txn.note ?? ''}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault(); // else the same keypress clicks the row focus returns to, reopening it
            close();
          }}
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
  refund,
  charge,
  view,
  overview,
  busy,
  focus,
  onUnlink,
}: {
  refund: FinanceTransaction;
  charge: FinanceTransaction;
  view: FinanceView;
  overview: FinanceOverview;
  busy: boolean;
  focus: boolean;
  onUnlink: () => void;
}) {
  const which = periodOf(charge, overview.period);
  const counted = view.counted.get(refund.id) ?? 0;
  const capped = counted < -view.amount(refund);
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line p-3">
      <div className="flex flex-wrap items-center gap-3">
        <Text size="sm" className="flex-1">
          Refund of{' '}
          <Text as="span" size="sm" weight="medium">
            {charge.merchantName ?? charge.name}
          </Text>{' '}
          · {fmtMonthShortDay(charge.date)} · {fmtMoney(view.amount(charge))}
        </Text>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onUnlink} autoFocus={focus}>
          Unlink
        </Button>
      </div>
      <Text size="sm" tone="muted">
        {charge.bucket === 'not_spending' ? (
          'Not spending, like its charge — outside every total.'
        ) : (
          <>
            Counts as {charge.bucket ? FINANCE_BUCKET_LABELS[charge.bucket] : 'unsorted'},{' '}
            {which === 'current'
              ? 'this period'
              : which === 'previous'
                ? 'last period'
                : 'an earlier period'}{' '}
            — it follows the charge.
          </>
        )}
      </Text>
      {capped && (
        <Text size="sm" tone="muted">
          Only {fmtMoney(counted)} of it counts — that&apos;s all that was left of the charge. The
          rest stays money in, outside the budget.
        </Text>
      )}
    </div>
  );
}

// The charges this refund could reverse: the best as a one-click Link, then a few runners-up.
function RefundSuggestions({
  refund,
  view,
  busy,
  focus,
  fallback,
  onLink,
  onCancel,
}: {
  refund: FinanceTransaction;
  view: FinanceView;
  busy: boolean;
  focus: boolean;
  fallback: string;
  onLink: (chargeId: string) => void;
  onCancel?: () => void; // a collapsible list gets a way back (and a focus target when it's empty)
}) {
  // How far this refund overshoots what's left of a charge (the overshoot won't count).
  const over = (c: FinanceTransaction) =>
    -view.amount(refund) - (view.amount(c) - (view.refunded.get(c.id) ?? 0));
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
      {matches.length > 0 && (
        <Text id={labelId} size="sm" tone="muted">
          {sameMerchant.length
            ? `Refund of which ${merchant} charge?`
            : `No ${merchant} charge found from the ${REFUND_MATCH_WINDOW_DAYS} days before it. Other charges it could be:`}
        </Text>
      )}
      {matches.length === 0 ? (
        <Text size="sm" tone="muted">
          {fallback}
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
                {/* Its own line: the row above truncates on a phone, and this is why it only counts
                    part of the money. */}
                {over(c) > 0 && (
                  <Text size="xs" tone="muted" className="w-full">
                    {fmtMoney(over(c))} more than what&apos;s left of the charge — only that counts.
                  </Text>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {onCancel && (
        <Button
          size="sm"
          variant="ghost"
          className="self-start"
          autoFocus={focus && matches.length === 0}
          onClick={onCancel}
        >
          Cancel
        </Button>
      )}
    </div>
  );
}

// On a card payment: whether it ends a billing period. You mark it; the page never decides.
function PeriodMark({
  txn,
  marked,
  dormant,
  busy,
  focus,
  onMark,
}: {
  txn: FinanceTransaction;
  marked: boolean;
  dormant: boolean; // marked, but no longer money in on a card (e.g. the card was flipped)
  busy: boolean;
  focus: boolean;
  onMark: (marked: boolean) => void;
}) {
  const starts = fmtMonthShortDay(addDays(txn.date, 1));
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line p-3">
      <Text size="sm" className="min-w-0 flex-1">
        {dormant
          ? 'Marked as a period start, but it no longer reads as a card payment, so it’s ignored.'
          : marked
            ? `This payment starts a period — the one from ${starts}.`
            : `A card payment. Mark it to start a new period on ${starts}.`}
      </Text>
      <Button
        size="sm"
        variant={marked ? 'ghost' : 'primary'}
        disabled={busy}
        autoFocus={focus}
        onClick={() => onMark(!marked)}
      >
        {marked ? 'Unmark' : 'Start the period here'}
      </Button>
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
      {refunds.map((r) => {
        const counted = view.counted.get(r.id) ?? 0;
        return (
          <Text key={r.id} size="sm" tone="muted" tabular>
            {fmtMonthShortDay(r.date)} · +{fmtMoney(-view.amount(r))}
            {counted < -view.amount(r) ? ` (counts ${fmtMoney(counted)})` : ''}
          </Text>
        );
      })}
    </div>
  );
}

// A radiogroup per the WAI-ARIA pattern: one tab stop (the checked option, else the first), arrow keys
// move AND select, Home/End jump. `autoFocus` makes the dialog open on the checked option.
function Segmented<T extends string | null>({
  label,
  options,
  value,
  onChange,
  autoFocus = false,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  autoFocus?: boolean;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const checked = options.findIndex((o) => o.value === value);
  const stop = checked === -1 ? 0 : checked;
  const select = (i: number) => {
    const j = (i + options.length) % options.length;
    onChange(options[j]!.value);
    refs.current[j]?.focus();
  };
  const onKeyDown = (e: React.KeyboardEvent, i: number) => {
    const to =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? i + 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? i - 1
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? options.length - 1
              : null;
    if (to === null) return;
    e.preventDefault();
    select(to);
  };
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-col gap-1.5">
      <Text size="sm" tone="muted">
        {label}
      </Text>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o, i) => (
          <button
            key={o.label}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            tabIndex={i === stop ? 0 : -1}
            data-autofocus={autoFocus && i === stop ? '' : undefined}
            onKeyDown={(e) => onKeyDown(e, i)}
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
