import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { addDays, PAYMENT_MATCH_WINDOW_DAYS, todayKey } from '@aperture/shared';
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

// The current + previous windows, widened by the payment-match window so a card payment whose checking
// side sits just outside the previous period still pairs up (and isn't mistaken for spending).
export function financeListRange(o: FinanceOverview): { from: string; to: string } {
  return { from: addDays(o.period.previous.start, -PAYMENT_MATCH_WINDOW_DAYS), to: o.period.end };
}

export function useFinanceTransactions(overview: FinanceOverview | undefined) {
  const api = useApi();
  const range = overview ? financeListRange(overview) : null;
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

export function useSetFinanceBucket() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SetFinanceBucketInput) => api.setFinanceBucket(input),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: ['finance', 'txns'] });
      const ids = new Set(input.ids);
      patchTxnCaches(qc, (t) =>
        ids.has(t.id)
          ? { ...t, bucket: input.bucket, bucketSetBy: input.bucket ? 'user' : null }
          : t,
      );
    },
    onSuccess: (changed) => {
      const byId = new Map(changed.map((t) => [t.id, t]));
      patchTxnCaches(qc, (t) => byId.get(t.id) ?? t);
    },
    onSettled: () => invalidateFinance(qc),
  });
}

export function useSetFinancePeriodOverride() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; override: FinancePeriodOverride | null }) =>
      api.setFinancePeriodOverride(v.id, v.override),
    onSettled: () => invalidateFinance(qc),
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
