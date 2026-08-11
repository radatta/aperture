import { useQuery } from '@tanstack/react-query';
import { useApi } from '../api-context';
import { qk } from '../queryKeys';

// Done tasks with a frozen estimate, over a day range → the estimate-vs-actual evidence.
export function useCalibration(from: string, to: string) {
  const api = useApi();
  return useQuery({
    queryKey: qk.calibration(from, to),
    queryFn: () => api.getCalibration({ from, to }),
  });
}
