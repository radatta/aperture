import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../api-context';
import { qk } from '../queryKeys';

// The Progress tab's read (docs/areas/recruiting/coach.md → The Progress tab): every problem record, under the
// 'coach' prefix, so a sitting, review, logged attempt or Premium change refreshes it with the rest.
export function useProblemRecords() {
  const api = useApi();
  return useQuery({ queryKey: qk.coachRecords(), queryFn: () => api.listProblemRecords() });
}

// Desktop layout or not. No matchMedia (jsdom) reads as narrow.
export function useWide(query = '(min-width: 1024px)') {
  const [wide, setWide] = useState(
    () => (typeof window !== 'undefined' && window.matchMedia?.(query).matches) || false,
  );
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return wide;
}
