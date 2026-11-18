// The dev check’s BFF client (api.ts), finance: the finance fixture’s rows and rules.
// Its internals come from core.ts under the names the bodies use.
import { pendingIds } from '../ledger';
import {
  type Core,
  type DevFinanceRule,
  type DevFinanceTransaction,
  FINANCE_ANY_RANGE,
  FINANCE_BUCKET_VIA,
  FINANCE_LINK_VIA,
  FINANCE_MARK_VIA,
  FINANCE_RULE_VIA,
  financeBucketId,
  financeLinkId,
  financeMarkId,
  financeRowOf,
} from './core';

export function financeReads(c: Core) {
  const { call } = c;
  const reads = {
    listFinanceTransactions: (range: { from: string; to: string }) =>
      call<DevFinanceTransaction[]>('listFinanceTransactions', [range]),
    // One row by id, anywhere the server keeps it (there is no get-by-id RPC) — null when gone.
    getFinanceTransaction: async (id: string) =>
      (await call<DevFinanceTransaction[]>('listFinanceTransactions', [FINANCE_ANY_RANGE])).find(
        (t) => t.id === id,
      ) ?? null,
    listFinanceRules: () => call<DevFinanceRule[]>('listFinanceRules', []),
  };
  return reads;
}

export function financeWrites(c: Core) {
  const { ledger, run, call, assertLedger } = c;
  const writes = {
    // The ledger half of a bucket set / refund link the browser is about to make on a fixture row: called
    // before the click, so a crash mid-step still leaves it for the next run's sweep to clear. Writes
    // nothing to dev; recorded once a run per row.
    recordFinanceBucket(row: string): void {
      const id = financeBucketId(run, row);
      if (!pendingIds(ledger.read()).includes(id))
        ledger.append({
          run,
          op: 'created',
          id,
          via: FINANCE_BUCKET_VIA,
          title: `bucket on ${row}`,
        });
    },
    recordFinanceLink(row: string): void {
      const id = financeLinkId(run, row);
      if (!pendingIds(ledger.read()).includes(id))
        ledger.append({ run, op: 'created', id, via: FINANCE_LINK_VIA, title: `link on ${row}` });
    },
    recordFinanceMark(row: string): void {
      const id = financeMarkId(run, row);
      if (!pendingIds(ledger.read()).includes(id))
        ledger.append({ run, op: 'created', id, via: FINANCE_MARK_VIA, title: `mark on ${row}` });
    },
    // Cleanup's halves: clear what a recorded entry set — never a row the ledger doesn't name.
    async unsetFinanceBucket(id: string): Promise<void> {
      assertLedger(id, 'financeBucket');
      await call<unknown>('setFinanceBucket', [{ ids: [financeRowOf(id)], bucket: null }]);
    },
    async unlinkFinanceRefund(id: string): Promise<void> {
      assertLedger(id, 'financeLink');
      await call<unknown>('linkFinanceRefund', [financeRowOf(id), null]);
    },
    async unmarkFinancePeriodStart(id: string): Promise<void> {
      assertLedger(id, 'financeMark');
      await call<unknown>('setFinancePeriodStart', [financeRowOf(id), false]);
    },
    // A rule, recorded from the create response like a place; deleted only when recorded.
    async upsertFinanceRule(input: { pattern: string; bucket: string }): Promise<DevFinanceRule> {
      ledger.append({ run, op: 'intent', via: FINANCE_RULE_VIA, title: input.pattern });
      const rule = await call<DevFinanceRule>('upsertFinanceRule', [input]);
      ledger.append({
        run,
        op: 'created',
        id: rule.id,
        via: FINANCE_RULE_VIA,
        title: input.pattern,
      });
      return rule;
    },
    async deleteFinanceRule(id: string): Promise<void> {
      assertLedger(id, 'financeRule');
      await call<null>('deleteFinanceRule', [id]);
    },
  };
  return writes;
}
