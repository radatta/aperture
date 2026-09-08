import { useQuery } from '@tanstack/react-query';
import type { DateRange } from '@aperture/shared';
import { useApi } from '../api-context';
import { qk } from '../queryKeys';

// Captured LeetCode attempts (accepted + wrong), reverse-chron. Derived/read-only, like calibration.
export function useLeetcodeAttempts(range?: DateRange) {
  const api = useApi();
  return useQuery({
    queryKey: qk.leetcodeAttempts(range?.from, range?.to),
    queryFn: () => api.listLeetcodeAttempts(range),
  });
}
