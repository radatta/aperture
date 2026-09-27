import { useMemo } from 'react';
import { amountOf, detectInternalMoves, periodOf } from '@aperture/shared';
import type { FinanceAccount, FinanceTransaction, InternalMoves } from '@aperture/shared';
import { useFinanceOverview, useFinanceTransactions } from '../../data/hooks/useFinances';

export interface FinanceView {
  accounts: Map<string, FinanceAccount>;
  moves: InternalMoves;
  txns: FinanceTransaction[]; // alive, inside the current or previous window, date desc
  amount: (t: FinanceTransaction) => number; // normalised: positive = money out
}

// The overview plus the transactions of both windows, with the derived bits every tab needs. Moves are
// detected over the widened list range, then rows outside both windows are dropped.
export function useFinanceData() {
  const overviewQ = useFinanceOverview();
  const txnsQ = useFinanceTransactions(overviewQ.data);
  const overview = overviewQ.data;
  const view = useMemo<FinanceView | null>(() => {
    if (!overview || !txnsQ.data) return null;
    const accounts = new Map(overview.accounts.map((a) => [a.id, a]));
    const { moves } = detectInternalMoves(txnsQ.data, overview.accounts);
    return {
      accounts,
      moves,
      txns: txnsQ.data.filter(
        (t) => accounts.has(t.accountId) && periodOf(t, overview.period) !== null,
      ),
      amount: (t) => amountOf(t, accounts.get(t.accountId)),
    };
  }, [overview, txnsQ.data]);
  return { overview, overviewQ, txnsQ, view };
}
