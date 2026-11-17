import { useQuery } from '@tanstack/react-query';
import { useApi } from '../api-context';
import { qk } from '../queryKeys';

// The Progress tab's read (docs/areas/recruiting/coach.md → The Progress tab): every problem record, under the
// 'coach' prefix, so a sitting, review, logged attempt or Premium change refreshes it with the rest.
export function useProblemRecords() {
  const api = useApi();
  return useQuery({ queryKey: qk.coachRecords(), queryFn: () => api.listProblemRecords() });
}
