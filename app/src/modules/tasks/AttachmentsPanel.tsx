import { useRef, useState } from 'react';
import { ATTACHMENTS_PER_TASK, assertAttachmentAllowed, isImage } from '@aperture/shared';
import type { Attachment } from '@aperture/shared';
import { Button } from '../../components/Button';
import { Text } from '../../components/Text';
import { PaperclipIcon } from '../../components/icons';
import { cx } from '../../lib/cx';
import { fmtBytes } from '../../lib/format';
import { useApi } from '../../data/api-context';
import { resolveViewUrl } from '../../data/attachmentTransport';
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
  const [dragging, setDragging] = useState(false);

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
    <div
      role="group"
      aria-label="Task files"
      onDragOver={(e) => {
        e.preventDefault(); // required for onDrop to fire
        setDragging(true);
      }}
      onDragLeave={(e) => {
        // Ignore the dragleave that fires when the cursor crosses a child row.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void onFiles(e.dataTransfer?.files ?? null);
      }}
      className={cx(
        'mt-3 flex flex-col gap-3 rounded-xl border bg-surface p-3',
        dragging ? 'border-teal bg-panel-2' : 'border-line',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <Text size="sm" tone="muted">
          {dragging ? 'Drop to attach' : `${files.length}/${ATTACHMENTS_PER_TASK} files`}
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
  const api = useApi();
  const del = useDeleteAttachment();
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const image = isImage(attachment.contentType);
  // Mount-time mint is thumbnail-only (an already-drawn <img> is unaffected if its link expires); the
  // click path mints its own fresh URL, so a long-open panel never opens an expired link.
  const url = useAttachmentUrl(attachment.id, image);

  // Mint a FRESH presigned URL at click time (the mount-time one may be >5 min stale). Open the tab
  // synchronously first — after an await the popup blocker would eat it — then point it at the URL.
  async function openFile() {
    setNote(null); // clear a stale error so a transient failure stays retryable
    const tab = window.open('', '_blank'); // NOT 'noopener' — that returns null and defeats the redirect
    if (tab) tab.opener = null;
    try {
      const resolved = resolveViewUrl(await api.getAttachmentDownloadUrl(attachment.id));
      if (!resolved) {
        tab?.close();
        setNote('Not available — the stub copy was lost on reload.');
        return;
      }
      if (tab) tab.location.href = resolved;
      else window.location.href = resolved; // blocker ate the tab: navigate/download in place
    } catch (e) {
      tab?.close();
      setNote((e as Error).message);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={openFile}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-line p-1.5 text-left hover:bg-panel-2"
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

      {note && (
        <Text size="xs" tone="danger">
          {note}
        </Text>
      )}

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
