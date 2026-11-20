import { useState } from 'react';
import { FINANCE_REFUND_MAX_PARTS, fmtMonthShortDay, refundPartsError } from '@aperture/shared';
import type { FinanceOverview, FinanceRefundPart, FinanceTransaction } from '@aperture/shared';
import { Button } from '../../components/Button';
import { Text } from '../../components/Text';
import { useSetFinanceRefundParts } from '../../data/hooks/useFinances';
import { centsText, chargeWhere, leftForRefund, parsedSum } from './amounts';
import { MoneyInput, Remainder } from './AmountRows';
import { fmtMoney, parseDollars } from './money';
import type { FinanceView } from './useFinanceData';

// A refund allocated across charges: each charge with what this refund counts against it, where that
// lands, and an Unlink per charge; the rest of the refund stays money in.
export function RefundAllocation({
  refund,
  view,
  overview,
  busy,
  focus,
  onEdit,
  onUnlinkOne,
  onUnlinkAll,
}: {
  refund: FinanceTransaction;
  view: FinanceView;
  overview: FinanceOverview;
  busy: boolean;
  focus: boolean;
  onEdit: () => void;
  onUnlinkOne: (chargeId: string) => void;
  onUnlinkAll: () => void;
}) {
  const claims = view.claims.get(refund.id) ?? [];
  const counted = view.countedByClaim.get(refund.id);
  const size = -view.amount(refund);
  const total = view.counted.get(refund.id) ?? 0;
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line p-3">
      <Text size="sm" weight="medium">
        Refund across {claims.length} {claims.length === 1 ? 'charge' : 'charges'}
      </Text>
      <ul className="flex flex-col gap-1.5">
        {claims.map(({ charge }, i) => (
          <li key={charge.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
            <Text size="sm" className="min-w-0 flex-1 truncate">
              {charge.merchantName ?? charge.name} · {fmtMonthShortDay(charge.date)}
            </Text>
            <Text size="sm" tabular>
              {fmtMoney(counted?.get(charge.id) ?? 0)}
            </Text>
            <Button
              size="sm"
              variant="ghost"
              aria-disabled={busy || undefined}
              autoFocus={focus && i === 0}
              aria-label={`Unlink ${charge.merchantName ?? charge.name} on ${fmtMonthShortDay(charge.date)}`}
              onClick={busy ? undefined : () => onUnlinkOne(charge.id)}
            >
              Unlink
            </Button>
            <Text size="xs" tone="muted" className="w-full truncate">
              {chargeWhere(charge, view, overview)}
            </Text>
          </li>
        ))}
      </ul>
      {size > total && (
        <Text size="sm" tone="muted">
          {fmtMoney(size - total)} of it isn&apos;t linked — it stays money in, outside the budget.
        </Text>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="ghost"
          aria-disabled={busy || undefined}
          onClick={busy ? undefined : onEdit}
        >
          Edit amounts or add a charge
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-disabled={busy || undefined}
          onClick={busy ? undefined : onUnlinkAll}
        >
          Unlink all
        </Button>
      </div>
    </div>
  );
}

interface DraftRow {
  chargeId: string;
  amount: string;
}

// Allocate a refund across charges: a row per charge with how much of the refund goes to it (each
// starts at what's left of the charge, up to what's left of the refund), a running remainder, and
// `adder` — the search that adds one charge at a time. Saved explicitly; a refusal keeps every field.
export function RefundPartsEditor({
  refund,
  view,
  initial,
  adder,
  onSaved,
  onCancel,
}: {
  refund: FinanceTransaction;
  view: FinanceView;
  initial: FinanceRefundPart[];
  adder: (exclude: Set<string>, add: (chargeId: string) => void) => React.ReactNode;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const save = useSetFinanceRefundParts();
  const size = -view.amount(refund);
  const left = leftForRefund(refund, view);
  const byId = new Map(view.allTxns.map((t) => [t.id, t]));
  const [rows, setRows] = useState<DraftRow[]>(() =>
    initial.map((p) => ({ chargeId: p.chargeId, amount: centsText(p.cents) })),
  );
  const [error, setError] = useState<string | null>(null);
  const busy = save.isPending;
  const sum = parsedSum(rows.map((r) => r.amount));

  const add = (chargeId: string) =>
    setRows((rs) => {
      const charge = byId.get(chargeId);
      if (!charge || rs.some((r) => r.chargeId === chargeId)) return rs;
      const taken = parsedSum(rs.map((r) => r.amount)) ?? 0;
      const cents = Math.min(left(charge), Math.max(size - taken, 0)) || left(charge);
      return [...rs, { chargeId, amount: centsText(cents) }];
    });

  const remainder =
    sum === null
      ? { text: 'Enter an amount like 12.50 on every charge', tone: 'danger' as const }
      : sum > size
        ? {
            text: `${fmtMoney(sum - size)} over the ${fmtMoney(size)} refund`,
            tone: 'danger' as const,
          }
        : sum === size
          ? { text: `All ${fmtMoney(size)} linked`, tone: 'muted' as const }
          : {
              text: `${fmtMoney(size - sum)} not linked — it stays money in`,
              tone: 'muted' as const,
            };

  function submit() {
    if (busy) return;
    setError(null);
    const parts: FinanceRefundPart[] = [];
    for (const r of rows) {
      const cents = parseDollars(r.amount);
      if (cents === null) return setError('Enter an amount like 12.50 on every charge');
      parts.push({ chargeId: r.chargeId, cents });
    }
    const refusal = refundPartsError({
      refund,
      parts,
      txns: view.allTxns,
      accounts: [...view.accounts.values()],
      moves: view.moves,
    });
    if (refusal) return setError(refusal);
    save.mutate({ refundId: refund.id, parts }, { onSuccess: onSaved });
  }

  // The adder sits outside the form: Enter in its search box must not press Save.
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line p-3">
      <form
        className="flex flex-col gap-2"
        aria-label="Link to several charges"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Text size="sm" weight="medium">
          Link {fmtMoney(size)} across charges
        </Text>
        <ul className="flex flex-col gap-2">
          {rows.map((r, i) => {
            const c = byId.get(r.chargeId);
            const name = c ? (c.merchantName ?? c.name) : 'A charge that isn’t loaded';
            return (
              <li key={r.chargeId} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Text size="sm" className="min-w-0 flex-1 truncate">
                  {name}
                  {c ? ` · ${fmtMonthShortDay(c.date)}` : ''}
                </Text>
                <MoneyInput
                  label={`Amount for ${name}`}
                  value={r.amount}
                  autoFocus={i === 0}
                  onChange={(amount) =>
                    setRows((rs) => rs.map((x, j) => (j === i ? { ...x, amount } : x)))
                  }
                />
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove ${name}`}
                  onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                >
                  Remove
                </Button>
                {c && (
                  <Text size="xs" tone="muted" className="w-full">
                    {fmtMoney(left(c))} left of {fmtMoney(view.amount(c))}
                  </Text>
                )}
              </li>
            );
          })}
        </ul>
        <Remainder tone={remainder.tone}>{remainder.text}</Remainder>
        {(error ?? save.error) && (
          <div role="alert">
            <Text size="sm" tone="danger">
              Couldn&apos;t link it: {error ?? save.error!.message}
            </Text>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" aria-disabled={busy || rows.length === 0 || undefined}>
            Save links
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
      {rows.length < FINANCE_REFUND_MAX_PARTS && (
        <div className="flex flex-col gap-1.5 border-t border-line pt-2">
          <Text size="sm" tone="muted">
            Add a charge
          </Text>
          {adder(new Set(rows.map((r) => r.chargeId)), add)}
        </div>
      )}
    </div>
  );
}
