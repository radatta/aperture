import { useMemo } from 'react';
import { deriveFinanceView } from '@aperture/shared';
import type { FinanceView } from '@aperture/shared';
import { useFinanceOverview, useFinanceTransactions } from '../../data/hooks/useFinances';

export type { FinanceView };

// The overview plus the transactions of both windows, derived once for every tab (deriveFinanceView,
// shared with the MCP read tools so the two can't disagree).
export function useFinanceData() {
  const overviewQ = useFinanceOverview();
  const txnsQ = useFinanceTransactions(overviewQ.data);
  const overview = overviewQ.data;
  const view = useMemo<FinanceView | null>(
    () => (overview && txnsQ.data ? deriveFinanceView(overview, txnsQ.data) : null),
    [overview, txnsQ.data],
  );
  return { overview, overviewQ, txnsQ, view };
}
