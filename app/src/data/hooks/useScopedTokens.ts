import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TokenScope } from '@aperture/shared';
import { useApi } from '../api-context';
import { qk } from '../queryKeys';

// Scoped device tokens (capture.ts) — Settings › Capture tokens. The plaintext is only ever in a mint's
// result: the caller shows it once, and the cache keeps just the list.
export function useScopedTokens(scope: TokenScope) {
  const api = useApi();
  return useQuery({ queryKey: qk.scopedTokens(scope), queryFn: () => api.listScopedTokens(scope) });
}

export function useMintScopedToken(scope: TokenScope) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.mintScopedToken(scope, name),
    gcTime: 0, // the result holds the plaintext: gone from the mutation cache once the caller is done
    onSettled: () => qc.invalidateQueries({ queryKey: qk.scopedTokens(scope) }),
  });
}

export function useRevokeScopedToken(scope: TokenScope) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.revokeScopedToken(id),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.scopedTokens(scope) }),
  });
}
