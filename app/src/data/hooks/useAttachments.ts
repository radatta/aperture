import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateAttachmentInput } from '@aperture/shared';
import { useApi } from '../api-context';
import { qk } from '../queryKeys';
import { resolveViewUrl, uploadTo } from '../attachmentTransport';

// One list feeds every task card — cards filter by taskId client-side, so this is a single cached read
// rather than N per-task queries.
export function useAttachments() {
  const api = useApi();
  return useQuery({ queryKey: qk.attachments(), queryFn: () => api.listAttachments() });
}

// The THUMBNAIL URL for one image attachment (pass enabled=false for non-images so a file chip mints
// nothing). Minted at mount; once the <img> has drawn, an expired link is harmless. The click-to-open
// path does NOT use this — it mints its own fresh URL so a long-open panel never opens a stale link.
export function useAttachmentUrl(id: string, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: qk.attachmentUrl(id),
    queryFn: async () => resolveViewUrl(await api.getAttachmentDownloadUrl(id)),
    enabled,
    staleTime: 4 * 60_000,
    gcTime: 60_000,
  });
}

// Upload = presign → PUT bytes to S3 → confirm (pending → ready). Progress rides a callback because
// React Query mutations don't carry it.
export function useUploadAttachment() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: {
      input: CreateAttachmentInput;
      file: File;
      onProgress?: (fraction: number) => void;
    }) => {
      const { attachment, uploadUrl } = await api.createAttachmentUploadUrl(v.input);
      await uploadTo(uploadUrl, v.file, attachment.contentType, v.onProgress);
      return api.confirmAttachment(attachment.id);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.attachments() }),
  });
}

export function useDeleteAttachment() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteAttachment(id),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.attachments() }),
  });
}
