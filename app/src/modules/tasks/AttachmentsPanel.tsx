import { useRef, useState } from 'react';
import { ATTACHMENTS_PER_TASK, assertAttachmentAllowed, isImage } from '@aperture/shared';
import type { Attachment } from '@aperture/shared';
import { Button } from '../../components/Button';
import { Text } from '../../components/Text';
import { PaperclipIcon } from '../../components/icons';
import { fmtBytes } from '../../lib/format';
import {
  useAttachments,
  useAttachmentUrl,
  useDeleteAttachment,
  useUploadAttachment,
} from '../../data/hooks/useAttachments';

// The Files panel for a task, opened from the overflow menu. Uploads go browser→S3 via a presigned URL
// (or an in-memory blob in stub mode); the cap + type/size are re-checked server-side, this pre-check is
// just fast feedback.
export function AttachmentsPanel({ taskId }: { taskId: string }) {
  const { data: all = [], isError } = useAttachments();
  const files = all.filter((a) => a.taskId === taskId);
  const upload = useUploadAttachment();
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, number>>({}); // filename → 0..1

  async function onFiles(list: FileList | null) {
    if (!list) return;
    setError(null);
    let live = files.length; // grows as a multi-select uploads, so the cap holds across the batch
    for (const file of Array.from(list)) {
      try {
        assertAttachmentAllowed(file.size, live);
      } catch (e) {
        setError((e as Error).message);
        break;
      }
      live++;
      const name = file.name;
      setProgress((p) => ({ ...p, [name]: 0 }));
      try {
        await upload.mutateAsync({
          input: { taskId, filename: file.name, contentType: file.type, size: file.size },
          file,
          onProgress: (f) => setProgress((p) => ({ ...p, [name]: f })),
        });
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setProgress((p) => {
          const next = { ...p };
          delete next[name];
          return next;
        });
      }
    }
    if (inputRef.current) inputRef.current.value = ''; // let the same file be re-picked
  }

  const full = files.length >= ATTACHMENTS_PER_TASK;
  const uploading = Object.entries(progress);

  return (
    <div className="mt-3 flex flex-col gap-3 rounded-xl border border-line bg-surface p-3">
      <div className="flex items-center justify-between gap-2">
        <Text size="sm" tone="muted">
          {files.length}/{ATTACHMENTS_PER_TASK} files
        </Text>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setError(null);
            inputRef.current?.click();
          }}
          disabled={full}
          className="gap-1.5"
        >
          <PaperclipIcon size={15} /> Add file
        </Button>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => onFiles(e.target.files)}
        />
      </div>

      {isError && (
        <Text size="xs" tone="danger">
          Couldn&apos;t load this task&apos;s files.
        </Text>
      )}

      {error && (
        <Text size="xs" tone="danger">
          {error}
        </Text>
      )}

      {uploading.map(([name, f]) => (
        <div key={name} className="flex flex-col gap-1">
          <Text size="xs" tone="muted" className="truncate">
            Uploading {name}…
          </Text>
          <div className="h-1 w-full overflow-hidden rounded bg-panel-2">
            <div
              className="h-full bg-teal transition-all"
              style={{ width: `${Math.round(f * 100)}%` }}
            />
          </div>
        </div>
      ))}

      {files.length === 0 && uploading.length === 0 && (
        <Text size="xs" tone="subtle">
          No files attached.
        </Text>
      )}

      {files.map((a) => (
        <AttachmentRow key={a.id} attachment={a} />
      ))}
    </div>
  );
}

function AttachmentRow({ attachment }: { attachment: Attachment }) {
  const del = useDeleteAttachment();
  const [confirming, setConfirming] = useState(false);
  const url = useAttachmentUrl(attachment.id);
  const image = isImage(attachment.contentType);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => url.data && window.open(url.data, '_blank', 'noopener')}
          disabled={!url.data}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-line p-1.5 text-left hover:bg-panel-2 disabled:opacity-60 disabled:hover:bg-transparent"
        >
          {image && url.data ? (
            <img
              src={url.data}
              alt={attachment.filename}
              className="h-10 w-10 shrink-0 rounded object-cover"
            />
          ) : (
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-panel-2 text-ink-muted">
              <PaperclipIcon size={16} />
            </span>
          )}
          <span className="flex min-w-0 flex-col">
            <Text size="sm" className="truncate">
              {attachment.filename}
            </Text>
            <Text size="xs" tone="subtle" tabular>
              {fmtBytes(attachment.size)}
            </Text>
          </span>
        </button>
        <Button
          variant="quiet"
          size="sm"
          onClick={() => setConfirming(true)}
          aria-label={`Delete ${attachment.filename}`}
        >
          ✕
        </Button>
      </div>

      {confirming && (
        <div
          role="alertdialog"
          aria-label={`Delete ${attachment.filename}?`}
          className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-panel-2 p-3"
        >
          <Text size="sm" tone="muted">
            Delete “{attachment.filename}”? This can&apos;t be undone here.
          </Text>
          <Button
            autoFocus
            variant="gold"
            size="sm"
            disabled={del.isPending}
            onClick={() => del.mutate(attachment.id)}
          >
            Delete
          </Button>
          <Button variant="quiet" size="sm" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
