import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { IdeaStatus } from '@aperture/shared';
import { useApi } from '../api-context';
import { qk } from '../queryKeys';

export function useIdeas(status: IdeaStatus = 'open') {
  const api = useApi();
  return useQuery({ queryKey: qk.ideas(status), queryFn: () => api.listIdeas(status) });
}

export function useCreateIdea() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (text: string) => api.createIdea(text),
    onSettled: () => qc.invalidateQueries({ queryKey: ['ideas'] }),
  });
}

export function useTriageIdea() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; status: IdeaStatus }) => api.triageIdea(v.id, v.status),
    onSettled: () => qc.invalidateQueries({ queryKey: ['ideas'] }),
  });
}
