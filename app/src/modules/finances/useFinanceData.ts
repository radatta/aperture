import { useMemo } from 'react';
import {
  amountOf,
  classifyTransaction,
  detectInternalMoves,
  linkableTransactions,
  periodOf,
  refundedCentsByCharge,
  resolveRefundLinks,
  sortableTransactions,
} from '@aperture/shared';
import type {
  FinanceAccount,
  FinanceTransaction,
  FinanceTxnKind,
  InternalMoves,
  RefundLinks,
} from '@aperture/shared';
import { useFinanceOverview, useFinanceTransactions } from '../../data/hooks/useFinances';

export interface FinanceView {
  accounts: Map<string, FinanceAccount>;
  moves: InternalMoves;
  txns: FinanceTransaction[]; // alive, inside the current or previous window, date desc
  allTxns: FinanceTransaction[]; // the whole loaded range — refund suggestions look back further
  sortable: FinanceTransaction[]; // allTxns on shown accounts, charges + refunds only
  linkable: FinanceTransaction[]; // sortable + deposits — what a refund link can touch
  amount: (t: FinanceTransaction) => number; // normalised: positive = money out
  kindOf: (t: FinanceTransaction) => FinanceTxnKind;
  links: RefundLinks; // refund id → the charge it reverses
  refunded: Map<string, number>; // charge id → cents refunded so far
}

// The overview plus the transactions of both windows, with the derived bits every tab needs. Moves and
// refund links are resolved over the same range and rows the server's overview used (links over the
// linkable set, so a charge on a hidden account leaves its refund unlinked), then rows outside both
// windows are dropped.
export function useFinanceData() {
  const overviewQ = useFinanceOverview();
  const txnsQ = useFinanceTransactions(overviewQ.data);
  const overview = overviewQ.data;
  const view = useMemo<FinanceView | null>(() => {
    if (!overview || !txnsQ.data) return null;
    const accounts = new Map(overview.accounts.map((a) => [a.id, a]));
    const allTxns = txnsQ.data.filter((t) => accounts.has(t.accountId));
    const moves = detectInternalMoves(allTxns, overview.accounts);
    const amount = (t: FinanceTransaction) => amountOf(t, accounts.get(t.accountId));
    const sortable = sortableTransactions(allTxns, overview.accounts, moves);
    const linkable = linkableTransactions(allTxns, overview.accounts, moves);
    const links = resolveRefundLinks(linkable, amount);
    return {
      accounts,
      moves,
      allTxns,
      sortable,
      linkable,
      txns: allTxns.filter((t) => periodOf(t, overview.period, links) !== null),
      amount,
      kindOf: (t) => classifyTransaction(t, accounts.get(t.accountId), moves),
      links,
      refunded: refundedCentsByCharge(links, new Map(allTxns.map((t) => [t.id, t])), amount),
    };
  }, [overview, txnsQ.data]);
  return { overview, overviewQ, txnsQ, view };
}
