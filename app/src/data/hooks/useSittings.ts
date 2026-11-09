import { useQuery } from '@tanstack/react-query';
import type { DateRange } from '@aperture/shared';
import { useApi } from '../api-context';
import { qk } from '../queryKeys';

// LeetCode sittings (heads), newest first. Written by the extension; a rep's Done ends one, which is why
// every task write invalidates this prefix (invalidate.ts).
export function useSittings(range?: DateRange) {
  const api = useApi();
  return useQuery({
    queryKey: qk.sittings(range?.from, range?.to),
    queryFn: () => api.listSittings(range),
  });
}
