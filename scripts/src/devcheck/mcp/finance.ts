// The dev check’s MCP client (mcp.ts), finance: the read-only finance tools. Finance has no MCP write.
// Its internals come from core.ts under the names the bodies use.
import { type Core } from './core';

// The slices of the tools' output the check reads (lambdas/src/mcp/financeTools.ts).
export interface McpFinanceRow {
  id: string;
  bucket: string | null;
  linkedChargeId: string | null;
  refundOfId: string | null;
  refundedUsd?: number;
  countedUsd?: number;
  split?: true;
  splitBroken?: true;
  parts?: { bucket: string; amountUsd: number; period: string; pinned: string | null }[];
  refundParts?: { chargeId: string; allocatedUsd: number; countedUsd: number }[];
}
export interface McpFinanceRule {
  pattern: string;
  bucket: string;
  split: { bucket: string; percent: number }[] | null;
}

export function financeReads(c: Core) {
  const { data } = c;
  const reads = {
    financeTransactions: (args: Record<string, unknown> = {}) =>
      data<{ transactions: McpFinanceRow[]; totalUsd: number }>('list_finance_transactions', {
        limit: 300,
        ...args,
      }),
    financeOverview: () =>
      data<{
        buckets: Record<string, { totalUsd: number }>;
        nextPeriod?: { count: number; totalUsd: number };
      }>('get_finance_overview'),
    financeRules: () => data<McpFinanceRule[]>('list_finance_rules'),
  };
  return reads;
}
