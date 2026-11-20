// The dev check’s BFF client (api.ts), finance: the finance fixture’s rows and rules.
// Its internals come from core.ts under the names the bodies use.
import { pendingIds } from '../ledger';
import {
  type Core,
  type DevFinanceOverview,
  type DevFinanceRule,
  type DevFinanceTransaction,
  FINANCE_ANY_RANGE,
  FINANCE_BUCKET_VIA,
  FINANCE_LINK_VIA,
  FINANCE_MARK_VIA,
  FINANCE_RULE_VIA,
  FINANCE_SPLIT_VIA,
  financeBucketId,
  financeLinkId,
  financeMarkId,
  financeRowOf,
  financeSplitId,
} from './core';

type SplitPart = { bucket: string; cents: number; period: string | null };
type RefundPart = { chargeId: string; cents: number };
// A write the server should refuse: its message, or null if it took (a regression — the caller fails the step;
// the ledger entry recorded first lets cleanup undo it).
const refusal = async (p: Promise<unknown>): Promise<string | null> =>
  p.then(
    () => null,
    (e: unknown) => (e instanceof Error ? e.message : String(e)),
  );

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
    getFinanceOverview: (today: string) =>
      call<DevFinanceOverview>('getFinanceOverview', [{ today }]),
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
    recordFinanceSplit(row: string): void {
      const id = financeSplitId(run, row);
      if (!pendingIds(ledger.read()).includes(id))
        ledger.append({ run, op: 'created', id, via: FINANCE_SPLIT_VIA, title: `split on ${row}` });
    },
    // A rule the browser is about to create (the Rules tab): the intent before the click, so a crash before
    // recordFinanceRule reports it rather than losing it.
    recordFinanceRuleIntent(pattern: string): void {
      ledger.append({ run, op: 'intent', via: FINANCE_RULE_VIA, title: pattern });
    },
    // A rule the browser created: recorded from the server's list once it shows (resolves the intent).
    recordFinanceRule(rule: DevFinanceRule): void {
      if (!pendingIds(ledger.read()).includes(rule.id))
        ledger.append({
          run,
          op: 'created',
          id: rule.id,
          via: FINANCE_RULE_VIA,
          title: rule.pattern,
        });
    },
    // Refusal probes: recorded before the call, so one that wrongly lands is still cleared by id.
    async refuseFinanceSplit(row: string, parts: SplitPart[] | null): Promise<string | null> {
      writes.recordFinanceSplit(row);
      return refusal(call<unknown>('setFinanceSplit', [row, parts]));
    },
    async refuseFinanceBucket(row: string, bucket: string): Promise<string | null> {
      writes.recordFinanceBucket(row);
      return refusal(call<unknown>('setFinanceBucket', [{ ids: [row], bucket }]));
    },
    // A single link made over the API (refund-cap: a second refund on a charge another one already
    // covers), recorded first like the browser's.
    async linkFinanceRefund(row: string, chargeId: string): Promise<void> {
      writes.recordFinanceLink(row);
      await call<unknown>('linkFinanceRefund', [row, chargeId]);
    },
    async refuseFinanceRefundParts(row: string, parts: RefundPart[]): Promise<string | null> {
      writes.recordFinanceLink(row);
      return refusal(call<unknown>('setFinanceRefundParts', [row, parts]));
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
    async unsetFinanceSplit(id: string): Promise<void> {
      assertLedger(id, 'financeSplit');
      await call<unknown>('setFinanceSplit', [financeRowOf(id), null]);
    },
    async unmarkFinancePeriodStart(id: string): Promise<void> {
      assertLedger(id, 'financeMark');
      await call<unknown>('setFinancePeriodStart', [financeRowOf(id), false]);
    },
    // A rule, recorded from the create response like a place; deleted only when recorded.
    async upsertFinanceRule(input: {
      pattern: string;
      bucket: string;
      split?: { bucket: string; percent: number }[] | null;
    }): Promise<DevFinanceRule> {
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
