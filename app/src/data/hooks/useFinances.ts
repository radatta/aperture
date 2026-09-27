import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { addDays, FINANCE_OVERVIEW_LOOKBACK_DAYS, todayKey } from '@aperture/shared';
import type {
  ExchangePublicTokenInput,
  FinanceAccountPatch,
  FinanceOverview,
  FinancePeriodOverride,
  FinanceTransaction,
  SetFinanceBucketInput,
  UpsertFinanceRuleInput,
} from '@aperture/shared';
import { useApi } from '../api-context';
import { qk } from '../queryKeys';
import { useSettings } from './useSettings';

// While a sync is running server-side, re-read the overview on this cadence until `syncing` clears.
// The server bounds `syncing` itself (FINANCE_SYNCING_MAX_MS), so a dead run can't poll forever.
const SYNC_POLL_MS = 15_000;

export function useFinanceToday(): string {
  const { data: settings } = useSettings();
  return todayKey(settings?.dayStartHour ?? 4);
}

export function useFinanceOverview() {
  const api = useApi();
  const today = useFinanceToday();
  return useQuery({
    queryKey: qk.financeOverview(today),
    queryFn: () => api.getFinanceOverview({ today }),
    refetchInterval: (q) => (q.state.data?.sync.syncing ? SYNC_POLL_MS : false),
  });
}

// The same window the server's overview reads (FINANCE_OVERVIEW_LOOKBACK_DAYS back from today), so
// the client's payment/transfer matching sees exactly the rows the server's did and the sort queue's
// count can't drift from the header's.
export function financeListRange(today: string, o: FinanceOverview): { from: string; to: string } {
  return {
    from: addDays(today, -FINANCE_OVERVIEW_LOOKBACK_DAYS),
    to: o.period.end > today ? o.period.end : today,
  };
}

export function useFinanceTransactions(overview: FinanceOverview | undefined) {
  const api = useApi();
  const today = useFinanceToday();
  const range = overview ? financeListRange(today, overview) : null;
  return useQuery({
    queryKey: qk.financeTxns(range?.from ?? '', range?.to ?? ''),
    queryFn: () => api.listFinanceTransactions(range!),
    enabled: range !== null,
  });
}

export function useFinanceRules() {
  const api = useApi();
  return useQuery({ queryKey: qk.financeRules(), queryFn: () => api.listFinanceRules() });
}

const invalidateFinance = (qc: QueryClient) => qc.invalidateQueries({ queryKey: qk.finance() });

// Patch cached transaction lists in place — sorting a group should feel instant, not wait a round trip.
function patchTxnCaches(qc: QueryClient, fn: (t: FinanceTransaction) => FinanceTransaction) {
  qc.setQueriesData<FinanceTransaction[]>({ queryKey: ['finance', 'txns'] }, (old) => old?.map(fn));
}

// One transaction's detail edits run in order (a TanStack mutation scope): its arrow keys save on
// every press, and saves racing on the server could leave a different option saved than the one
// shown. While a later edit is queued, an earlier one neither patches nor refetches — the optimistic
// value of the latest press stays on screen until the last save settles.
const txnEditKey = (id: string) => ['finance', 'txn-edit', id];
const txnScope = (id?: string) =>
  id === undefined ? {} : { scope: { id: `finance-txn:${id}` }, mutationKey: txnEditKey(id) };
const laterQueued = (qc: QueryClient, id?: string) =>
  id !== undefined && qc.isMutating({ mutationKey: txnEditKey(id) }) > 1;

export function useSetFinanceBucket(scopeId?: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    ...txnScope(scopeId),
    mutationFn: (input: SetFinanceBucketInput) => api.setFinanceBucket(input),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: ['finance', 'txns'] });
      const ids = new Set(input.ids);
      patchTxnCaches(qc, (t) =>
        ids.has(t.id)
          ? {
              ...t,
              bucket: input.bucket,
              bucketSetBy: input.bucket ? 'user' : null,
              refundOfId: null,
            }
          : t,
      );
    },
    onSuccess: (changed) => {
      if (laterQueued(qc, scopeId)) return;
      const byId = new Map(changed.map((t) => [t.id, t]));
      patchTxnCaches(qc, (t) => byId.get(t.id) ?? t);
    },
    onSettled: () => (laterQueued(qc, scopeId) ? undefined : invalidateFinance(qc)),
  });
}

export function useLinkFinanceRefund() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { refundId: string; chargeId: string | null }) =>
      api.linkFinanceRefund(v.refundId, v.chargeId),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ['finance', 'txns'] });
      patchTxnCaches(qc, (t) =>
        t.id !== v.refundId
          ? t
          : v.chargeId
            ? {
                ...t,
                refundOfId: v.chargeId,
                bucket: null,
                bucketSetBy: null,
                periodOverride: null,
              }
            : { ...t, refundOfId: null },
      );
    },
    onSettled: () => invalidateFinance(qc),
  });
}

export function useSetFinancePeriodStart() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; marked: boolean }) => api.setFinancePeriodStart(v.id, v.marked),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ['finance', 'txns'] });
      patchTxnCaches(qc, (t) =>
        t.id !== v.id
          ? t
          : v.marked
            ? {
                ...t,
                startsPeriod: true,
                bucket: null,
                bucketSetBy: null,
                periodOverride: null,
                refundOfId: null,
              }
            : { ...t, startsPeriod: false },
      );
    },
    onSettled: () => invalidateFinance(qc),
  });
}

export function useSetFinancePeriodOverride(scopeId?: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    ...txnScope(scopeId),
    mutationFn: (v: { id: string; override: FinancePeriodOverride | null }) =>
      api.setFinancePeriodOverride(v.id, v.override),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ['finance', 'txns'] });
      patchTxnCaches(qc, (t) => (t.id === v.id ? { ...t, periodOverride: v.override } : t));
    },
    onSettled: () => (laterQueued(qc, scopeId) ? undefined : invalidateFinance(qc)),
  });
}

export function useSetFinanceNote() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; note: string | null }) => api.setFinanceNote(v.id, v.note),
    onSettled: () => invalidateFinance(qc),
  });
}

export function useUpsertFinanceRule() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpsertFinanceRuleInput) => api.upsertFinanceRule(input),
    onSettled: () => invalidateFinance(qc),
  });
}

export function useDeleteFinanceRule() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteFinanceRule(id),
    onSettled: () => invalidateFinance(qc),
  });
}

export function useUpdateFinanceAccount() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; patch: FinanceAccountPatch }) =>
      api.updateFinanceAccount(v.id, v.patch),
    onSettled: () => invalidateFinance(qc),
  });
}

export function useRequestFinanceSync() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (refresh: boolean) => api.requestFinanceSync({ refresh }),
    onSettled: () => invalidateFinance(qc),
  });
}

export function useRemovePlaidItem() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (itemId: string) => api.removePlaidItem(itemId),
    onSettled: () => invalidateFinance(qc),
  });
}

export function useExchangePublicToken() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ExchangePublicTokenInput) => api.exchangePlaidPublicToken(input),
    onSettled: () => invalidateFinance(qc),
  });
}

export function useCompletePlaidUpdate() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (itemId: string) => api.completePlaidUpdate(itemId),
    onSettled: () => invalidateFinance(qc),
  });
}
