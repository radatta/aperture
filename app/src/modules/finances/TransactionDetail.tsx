import { useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { Ref } from 'react';
import {
  addDays,
  FINANCE_BUCKET_LABELS,
  FINANCE_BUCKETS,
  fmtMonthShortDay,
  isPeriodStart,
  REFUND_MATCH_WINDOW_DAYS,
  refundSideError,
  searchRefundCharges,
  splitBroken,
  splitOf,
  suggestRefundMatches,
  suggestRefundSets,
} from '@aperture/shared';
import type {
  FinanceOverview,
  FinancePeriodOverride,
  FinanceRefundPart,
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
  useSetFinanceRefundParts,
  useSetFinanceSplit,
} from '../../data/hooks/useFinances';
import { SearchBox } from './LedgerControls';
import { fmtMoney, fmtSigned } from './money';
import { chargeWhere, leftForRefund } from './amounts';
import { RefundAllocation, RefundPartsEditor } from './RefundParts';
import { BrokenSplit, SplitEditor, SplitSummary } from './SplitEditor';
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
  const linkedAny = txn.refundOfId !== null || txn.refundParts !== null;
  const dangling = linkedAny && !linkedTo; // its charge(s) aren't loaded / are gone
  const cents = view.amount(txn);
  const split = kind === 'expense' ? splitOf(txn, cents) : null;
  const broken = kind === 'expense' && splitBroken(txn, cents);
  const setSplit = useSetFinanceSplit();
  const setParts = useSetFinanceRefundParts();
  const splitEditor = useDisclosure();
  // Editing a refund's allocation: the parts it starts from (a single link becomes its first row).
  const [partsDraft, setPartsDraft] = useState<FinanceRefundPart[] | null>(null);
  // After Remove split, focus goes to the Bucket group that replaces the summary.
  const [focusBucket, setFocusBucket] = useState(false);
  const acct = view.accounts.get(txn.accountId);
  const markable = acct?.type === 'credit' && cents < 0;
  // Money in that could be a refund at all — a Venmo cash-out, a transfer or a period mark never is.
  const linkable = refundSideError(txn, acct, view.moves) === null;
  const linkableIncome = isIncome && linkable;
  // Focus follows a link/unlink/mark (the clicked button unmounts) — but never on first open, where
  // a focused Link button would make a stray Enter link the refund. The cache updates before the
  // server answers, so the next button mounts busy: busy is aria-disabled with no click handler, never
  // disabled — a disabled button can't take autoFocus, and focus would fall to <body>.
  const [acted, setActed] = useState(false);
  // The last action was an Unlink or an Unmark: the ones after which the suggestions mount with nothing
  // to focus. Never a Mark — while one is in flight the suggestions are still mounted asking for focus.
  const [undid, setUndid] = useState(false);
  const setLink = (chargeId: string | null) => {
    setActed(true);
    setUndid(chargeId === null);
    link.mutate({ refundId: txn.id, chargeId });
  };
  // Unlink one charge of an allocation: the rest stays; the last one unlinks the refund.
  const unlinkOne = (chargeId: string) => {
    const rest = (txn.refundParts ?? []).filter((p) => p.chargeId !== chargeId);
    if (rest.length === 0) return setLink(null);
    setActed(true);
    setParts.mutate({ refundId: txn.id, parts: rest });
  };
  const linkSet = (parts: FinanceRefundPart[]) => {
    setActed(true);
    setParts.mutate({ refundId: txn.id, parts });
  };
  // A single link's allocation to start editing from: its charge, at what this refund counts there.
  const startAllocation = () =>
    setPartsDraft(
      txn.refundParts ??
        (linkedTo
          ? [{ chargeId: linkedTo.id, cents: Math.min(-cents, leftForRefund(txn, view)(linkedTo)) }]
          : []),
    );
  const setMark = (marked: boolean) => {
    setActed(true);
    setUndid(!marked);
    // A failed Mark puts the refund back once the refetch lands: it may have nothing to focus either.
    mark.mutate({ id: txn.id, marked }, { onError: () => setUndid(true) });
  };
  const incomeLink = useDisclosure();
  // The Bucket group is where the detail opens. Without one (linked, money in, a payment), it opens on
  // the dialog itself: the first button would be Unlink or a mark, and a stray Enter would press it.
  const sortable = (kind === 'expense' || isRefund) && !linkedAny && !split;
  // After an Unlink or Unmark that leaves nothing to focus (a card credit with no suggestions), focus goes
  // to the Bucket group — sorting it is the next thing you do. Never the search box: that pops the iPhone
  // keyboard. Never after a Mark (`undid`): one in flight would otherwise hop there before Unmark mounts.
  const bucketRef = useRef<SegmentedHandle>(null);
  // Only focus that was lost (the pressed button unmounted): the list can come back late — a failed Mark
  // offline returns on reconnect — and must never pull you out of the Note field.
  const focusBucketIfLost = () => {
    const at = document.activeElement;
    if (!at || at === document.body || at.tagName === 'DIALOG') bucketRef.current?.focus();
  };
  useEffect(() => {
    if (!focusBucket || !sortable) return;
    setFocusBucket(false);
    bucketRef.current?.focus();
  }, [focusBucket, sortable]);
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
      initialFocus={sortable ? 'content' : 'dialog'}
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

        {partsDraft !== null ? (
          <RefundPartsEditor
            refund={txn}
            view={view}
            initial={partsDraft}
            adder={(exclude, add) => (
              <RefundSuggestions
                refund={txn}
                view={view}
                busy={false}
                focus={false}
                exclude={exclude}
                actionLabel="Add"
                fallback="No other likely charge — search for it above."
                onLink={add}
              />
            )}
            onSaved={() => {
              setActed(true);
              setPartsDraft(null);
            }}
            onCancel={() => setPartsDraft(null)}
          />
        ) : txn.refundParts !== null && linkedTo ? (
          <RefundAllocation
            refund={txn}
            view={view}
            overview={overview}
            busy={setParts.isPending || link.isPending}
            focus={acted}
            onEdit={startAllocation}
            onUnlinkOne={unlinkOne}
            onUnlinkAll={() => setLink(null)}
          />
        ) : (
          linkedTo && (
            <LinkedRefund
              refund={txn}
              charge={linkedTo}
              view={view}
              overview={overview}
              busy={link.isPending}
              focus={acted}
              onUnlink={() => setLink(null)}
              onAddAnother={startAllocation}
            />
          )
        )}
        {setParts.isError && partsDraft === null && (
          <div role="alert">
            <Text size="sm" tone="danger">
              Couldn&apos;t change the links: {setParts.error.message}
            </Text>
          </div>
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
              aria-disabled={link.isPending || undefined}
              onClick={link.isPending ? undefined : () => setLink(null)}
            >
              Unlink
            </Button>
          </div>
        )}
        {isRefund && linkable && !linkedAny && partsDraft === null && (
          <RefundSuggestions
            refund={txn}
            view={view}
            busy={link.isPending || setParts.isPending}
            focus={acted}
            fallback="No likely charge found — search for it above, or sort it below instead."
            onLink={(chargeId) => setLink(chargeId)}
            onLinkSet={linkSet}
            onNothingToFocus={undid ? focusBucketIfLost : undefined}
          />
        )}
        {linkableIncome &&
          !linkedAny &&
          partsDraft === null &&
          (incomeLink.open ? (
            <RefundSuggestions
              refund={txn}
              view={view}
              busy={link.isPending || setParts.isPending}
              focus
              fallback="No likely charge found — search for it above, or it stays money in, outside the budget."
              onLink={(chargeId) => setLink(chargeId)}
              onLinkSet={linkSet}
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
                // Mounts after an action only when an Unlink brings it back: the focus target then.
                autoFocus={acted}
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

        {broken && !splitEditor.open && (
          <BrokenSplit
            txn={txn}
            view={view}
            fixRef={splitEditor.triggerRef}
            onFix={splitEditor.onOpen}
          />
        )}
        {split && !splitEditor.open && (
          <SplitSummary
            txn={txn}
            view={view}
            overview={overview}
            busy={setSplit.isPending}
            focus={acted}
            editRef={splitEditor.triggerRef}
            onEdit={splitEditor.onOpen}
            onRemove={() =>
              setSplit.mutate(
                { id: txn.id, parts: null },
                { onSuccess: () => setFocusBucket(true) },
              )
            }
          />
        )}
        {splitEditor.open && (
          <SplitEditor
            txn={txn}
            view={view}
            onSaved={() => {
              setActed(true); // focus lands on the summary's Edit split
              splitEditor.onClose();
            }}
            onCancel={splitEditor.onClose}
          />
        )}
        {setSplit.isError && !splitEditor.open && (
          <div role="alert">
            <Text size="sm" tone="danger">
              Couldn&apos;t remove the split: {setSplit.error.message}
            </Text>
          </div>
        )}
        {(sortable || split) && (
          <>
            {sortable && !splitEditor.open && (
              <div className="flex flex-col gap-1.5">
                <Segmented
                  ref={bucketRef}
                  label="Bucket"
                  autoFocus
                  options={[
                    ...FINANCE_BUCKETS.map((b) => ({ value: b, label: FINANCE_BUCKET_LABELS[b] })),
                    { value: null, label: 'Unsorted' },
                  ]}
                  value={txn.bucket}
                  onChange={(bucket) => setBucket.mutate({ ids: [txn.id], bucket })}
                />
                {kind === 'expense' && cents > 0 && !broken && (
                  <Button
                    ref={splitEditor.triggerRef}
                    size="sm"
                    variant="quiet"
                    className="self-start"
                    onClick={splitEditor.onOpen}
                  >
                    Split across buckets…
                  </Button>
                )}
              </div>
            )}
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
            aria-disabled={mark.isPending || undefined}
            onClick={mark.isPending ? undefined : () => setMark(true)}
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
  onAddAnother,
}: {
  refund: FinanceTransaction;
  charge: FinanceTransaction;
  view: FinanceView;
  overview: FinanceOverview;
  busy: boolean;
  focus: boolean;
  onUnlink: () => void;
  onAddAnother: () => void;
}) {
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
        <Button
          size="sm"
          variant="ghost"
          aria-disabled={busy || undefined}
          onClick={busy ? undefined : onUnlink}
          autoFocus={focus}
        >
          Unlink
        </Button>
      </div>
      <Text size="sm" tone="muted">
        {charge.bucket === 'not_spending' ? (
          'Not spending, like its charge — outside every total.'
        ) : (
          <>Counts as {chargeWhere(charge, view, overview)} — it follows the charge.</>
        )}
      </Text>
      {capped && (
        <Text size="sm" tone="muted">
          Only {fmtMoney(counted)} of it counts — that&apos;s all that was left of the charge. The
          rest stays money in, outside the budget.
        </Text>
      )}
      <Button
        size="sm"
        variant="quiet"
        className="self-start"
        aria-disabled={busy || undefined}
        onClick={busy ? undefined : onAddAnother}
      >
        Split it across another charge…
      </Button>
    </div>
  );
}

const REFUND_SEARCH_LIMIT = 8;

// The charges this refund could reverse: the best as a one-click Link, then a few runners-up. Above
// them, a search over every charge it could link to, for the one they miss; while you search, its
// results replace them.
function RefundSuggestions({
  refund,
  view,
  busy,
  focus,
  fallback,
  onLink,
  onLinkSet,
  onCancel,
  onNothingToFocus,
  exclude,
  actionLabel = 'Link',
}: {
  refund: FinanceTransaction;
  view: FinanceView;
  busy: boolean;
  focus: boolean;
  fallback: string;
  onLink: (chargeId: string) => void;
  onLinkSet?: (parts: FinanceRefundPart[]) => void; // offers sets of charges that cover it together
  exclude?: Set<string>; // charges already chosen (the allocation editor's adder)
  actionLabel?: string;
  onCancel?: () => void; // a collapsible list gets a way back (and a focus target when it's empty)
  onNothingToFocus?: () => void; // asked to focus, but no Link row and no Cancel to take it
}) {
  const [query, setQuery] = useState('');
  // Once you've typed, nothing autofocuses: clearing the box remounts the suggestions, and their
  // Link would pull focus out of it mid-edit.
  const [typed, setTyped] = useState(false);
  const autoFocus = focus && !typed;
  // How far this refund overshoots what's left of a charge (the overshoot won't count).
  const over = (c: FinanceTransaction) =>
    -view.amount(refund) - (view.amount(c) - (view.refunded.get(c.id) ?? 0));
  // Every row, not view.sortable: a deposit's refund must count against its charge's "left" (as
  // view.refunded does); chargeSideError keeps hidden accounts, moves and marks out as targets.
  const args = {
    refund,
    txns: view.allTxns,
    accounts: [...view.accounts.values()],
    moves: view.moves,
    claims: view.claims,
  };
  const keep = (c: FinanceTransaction) => !exclude?.has(c.id);
  const suggest = (anyMerchant: boolean) =>
    suggestRefundMatches({ ...args, anyMerchant })
      .filter(keep)
      .slice(0, 5);
  const sameMerchant = suggest(false);
  // A card credit's descriptor doesn't always match its charge's merchant — fall back to any charge.
  const matches = sameMerchant.length ? sameMerchant : suggest(true);
  const searching = query.trim() !== '';
  const found = searching ? searchRefundCharges({ ...args, query }).filter(keep) : [];
  // Sets of charges this refund covers together — offered when no single charge fits it exactly.
  const exact = matches.some((c) => over(c) === 0);
  const sets = onLinkSet && !searching && !exact ? suggestRefundSets(args) : [];
  const merchant = refund.merchantName ?? refund.name;
  const labelId = `refund-of-${refund.id}`;
  const statusId = `refund-search-${refund.id}`;
  // Nothing on screen takes the focus that was asked for: no Link row, and no Cancel. Once, when that
  // first holds — a later render never re-steals it, and typing ends autoFocus for good.
  const nothingToFocus = autoFocus && matches.length === 0 && !onCancel;
  const nothingRef = useRef(onNothingToFocus);
  nothingRef.current = onNothingToFocus;
  const handedOff = useRef(false); // once a mount: a refetch that empties the list never re-steals it
  // Also when the target arrives late: a failed Mark's onError lands after the refetch remounts this.
  const canHandOff = onNothingToFocus !== undefined;
  useEffect(() => {
    if (!nothingToFocus || !canHandOff || handedOff.current) return;
    handedOff.current = true;
    nothingRef.current?.();
  }, [nothingToFocus, canHandOff]);

  const row = (
    c: FinanceTransaction,
    opts: { named: boolean; primary: boolean; focus: boolean },
  ) => {
    const refunded = view.refunded.get(c.id) ?? 0;
    const bucket = c.bucket ? FINANCE_BUCKET_LABELS[c.bucket] : 'Unsorted';
    // Under the merchant, on their own line: a phone truncates the line above, and the bucket and what's
    // already refunded were what got cut. A same-merchant row names no merchant, so its bucket stays up.
    const meta = [
      opts.named ? bucket : null,
      refunded > 0 ? `${fmtMoney(refunded)} already refunded` : null,
    ]
      .filter((x) => x !== null)
      .join(' · ');
    return (
      <li
        key={c.id}
        className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-line px-3 py-2"
      >
        <Text size="sm" tone="muted" tabular className="w-12 shrink-0">
          {fmtMonthShortDay(c.date)}
        </Text>
        <Text size="sm" className="min-w-0 flex-1 truncate">
          {opts.named ? (c.merchantName ?? c.name) : bucket}
        </Text>
        <Text size="sm" tabular>
          {fmtMoney(view.amount(c))}
        </Text>
        <Button
          size="sm"
          variant={opts.primary ? 'primary' : 'ghost'}
          aria-disabled={busy || undefined}
          autoFocus={opts.focus}
          onClick={busy ? undefined : () => onLink(c.id)}
          aria-label={`${actionLabel === 'Link' ? 'Link to' : actionLabel} ${c.merchantName ?? c.name} on ${fmtMonthShortDay(c.date)}, ${fmtMoney(view.amount(c))}`}
        >
          {actionLabel}
        </Button>
        {meta && (
          <Text size="xs" tone="muted" className="w-full truncate">
            {meta}
          </Text>
        )}
        {/* Its own line: the row above truncates on a phone, and this is why it only counts
            part of the money. */}
        {over(c) > 0 && (
          <Text size="xs" tone="muted" className="w-full">
            {fmtMoney(over(c))} more than what&apos;s left of the charge — only that counts.
          </Text>
        )}
      </li>
    );
  };

  return (
    <div className="flex flex-col gap-1.5">
      {/* First, so it never moves: typing only swaps the list under it. */}
      <SearchBox
        value={query}
        onChange={(v) => {
          setTyped(true);
          setQuery(v);
        }}
        label="Search charges to link"
        placeholder="Search merchant, bank text, note or amount"
        keyshortcut={null}
        onPanel
      />
      {!searching && matches.length > 0 && (
        <>
          <Text id={labelId} size="sm" tone="muted">
            {sameMerchant.length
              ? `Refund of which ${merchant} charge?`
              : `No ${merchant} charge found from the ${REFUND_MATCH_WINDOW_DAYS} days before it. Other charges it could be:`}
          </Text>
          <ul aria-labelledby={labelId} className="flex flex-col gap-1.5">
            {matches.map((c, i) =>
              row(c, {
                named: !sameMerchant.length,
                primary: i === 0,
                focus: autoFocus && i === 0,
              }),
            )}
          </ul>
        </>
      )}
      {!searching && matches.length === 0 && sets.length === 0 && (
        <Text size="sm" tone="muted">
          {fallback}
        </Text>
      )}
      {sets.length > 0 && (
        <>
          <Text id={`${labelId}-sets`} size="sm" tone="muted">
            Or several charges together:
          </Text>
          <ul aria-labelledby={`${labelId}-sets`} className="flex flex-col gap-1.5">
            {sets.map((set) => {
              const label = set.charges
                .map((c, i) => `${c.merchantName ?? c.name} ${fmtMoney(set.cents[i]!)}`)
                .join(' + ');
              return (
                <li
                  key={set.charges.map((c) => c.id).join('|')}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-line px-3 py-2"
                >
                  <Text size="sm" className="min-w-0 flex-1">
                    {label}
                  </Text>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-disabled={busy || undefined}
                    aria-label={`Link to ${label}`}
                    onClick={
                      busy
                        ? undefined
                        : () =>
                            onLinkSet!(
                              set.charges.map((c, i) => ({ chargeId: c.id, cents: set.cents[i]! })),
                            )
                    }
                  >
                    Link all {set.charges.length}
                  </Button>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {searching && (
        <>
          <Text id={statusId} size="sm" tone="muted">
            {found.length === 0
              ? `No charge matches “${query.trim()}”.`
              : found.length > REFUND_SEARCH_LIMIT
                ? `Showing ${REFUND_SEARCH_LIMIT} of ${found.length} — add a word to narrow it.`
                : `${found.length} ${found.length === 1 ? 'charge' : 'charges'}`}
          </Text>
          {found.length > 0 && (
            <ul aria-labelledby={statusId} className="flex flex-col gap-1.5">
              {found
                .slice(0, REFUND_SEARCH_LIMIT)
                .map((c) => row(c, { named: true, primary: false, focus: false }))}
            </ul>
          )}
        </>
      )}
      {onCancel && (
        <Button
          size="sm"
          variant="ghost"
          className="self-start"
          autoFocus={autoFocus && matches.length === 0}
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
        aria-disabled={busy || undefined}
        autoFocus={focus}
        onClick={busy ? undefined : () => onMark(!marked)}
      >
        {marked ? 'Unmark' : 'Start the period here'}
      </Button>
    </div>
  );
}

// On a charge: what's been refunded against it, so a smaller net makes sense at a glance.
function RefundsAgainst({ charge, view }: { charge: FinanceTransaction; view: FinanceView }) {
  const refunds = view.allTxns.filter((t) =>
    view.claims.get(t.id)?.some((c) => c.charge.id === charge.id),
  );
  if (refunds.length === 0) return null;
  const total = view.refunded.get(charge.id) ?? 0;
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-line p-3">
      <Text size="sm">
        Refunded {fmtMoney(total)} of {fmtMoney(view.amount(charge))}
      </Text>
      {refunds.map((r) => {
        const counted = view.countedByClaim.get(r.id)?.get(charge.id) ?? 0;
        const many = (view.claims.get(r.id)?.length ?? 0) > 1;
        return (
          <Text key={r.id} size="sm" tone="muted" tabular>
            {fmtMonthShortDay(r.date)} · +{fmtMoney(-view.amount(r))}
            {many
              ? ` (${fmtMoney(counted)} of it to this charge)`
              : counted < -view.amount(r)
                ? ` (counts ${fmtMoney(counted)})`
                : ''}
          </Text>
        );
      })}
    </div>
  );
}

export interface SegmentedHandle {
  focus(): void; // the group's one tab stop: the checked option, else the first
}

// A radiogroup per the WAI-ARIA pattern: one tab stop (the checked option, else the first), arrow keys
// move AND select, Home/End jump. `autoFocus` makes the dialog open on the checked option; `ref` lets the
// detail send focus there later (after an Unlink or Unmark that leaves nothing else to focus).
function Segmented<T extends string | null>({
  ref,
  label,
  options,
  value,
  onChange,
  autoFocus = false,
}: {
  ref?: Ref<SegmentedHandle>;
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  autoFocus?: boolean;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const checked = options.findIndex((o) => o.value === value);
  const stop = checked === -1 ? 0 : checked;
  useImperativeHandle(ref, () => ({ focus: () => refs.current[stop]?.focus() }), [stop]);
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
