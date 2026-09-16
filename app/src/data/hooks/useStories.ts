import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateStoryInput, StoryPatch } from '@aperture/shared';
import { useApi } from '../api-context';
import { qk } from '../queryKeys';

export function useStories() {
  const api = useApi();
  return useQuery({ queryKey: qk.stories(), queryFn: () => api.listStories() });
}

export function useCreateStory() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateStoryInput) => api.createStory(input),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.stories() }),
  });
}

export function useUpdateStory() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; patch: StoryPatch }) => api.updateStory(v.id, v.patch),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.stories() }),
  });
}

export function useDeleteStory() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteStory(id),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.stories() }),
  });
}
