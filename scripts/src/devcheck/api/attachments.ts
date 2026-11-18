// The dev check’s BFF client (api.ts), attachments: attachments and their presigned URLs.
// Its internals come from core.ts under the names the bodies use.
import { assertPresignedDevUrl } from '../config';
import { DevcheckError } from '../errors';
import { type Core, type DevAttachment } from './core';

export function attachmentsReads(c: Core) {
  const { fetch, call } = c;
  const reads = {
    listAttachments: (taskId: string) => call<DevAttachment[]>('listAttachments', [taskId]),
    getAttachmentDownloadUrl: (id: string) => call<string>('getAttachmentDownloadUrl', [id]),
    // GET a BFF-minted presigned URL and return only its status (200 while the bytes exist, 403/404 after).
    // Gone is 403 or 404 — see isGone.
    async probePresigned(url: string): Promise<number> {
      assertPresignedDevUrl(url);
      const res = await fetch(url, { method: 'GET', headers: {}, redirect: 'error' });
      await res.text(); // drain
      return res.status;
    },
  };
  return reads;
}

export function attachmentsWrites(c: Core) {
  const { fetch, call, assertLedgerTask, attachmentIds } = c;
  const writes = {
    // Mint an upload URL, PUT the bytes to S3 as the app does, then confirm — or leave it pending
    // (confirm: false), as an abandoned upload would.
    async createAttachment(
      taskId: string,
      file: { filename: string; contentType: string; text: string; confirm?: boolean },
    ): Promise<DevAttachment> {
      assertLedgerTask(taskId);
      const bytes = new TextEncoder().encode(file.text);
      const { attachment, uploadUrl } = await call<{
        attachment: DevAttachment;
        uploadUrl: string;
      }>('createAttachmentUploadUrl', [
        { taskId, filename: file.filename, contentType: file.contentType, size: bytes.byteLength },
      ]);
      attachmentIds.add(attachment.id);
      assertPresignedDevUrl(uploadUrl);
      const res = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': attachment.contentType }, // the server-normalised type
        body: bytes,
        redirect: 'error',
      });
      if (res.status !== 200) throw new Error(`attachment PUT → HTTP ${res.status}`);
      if (file.confirm === false) return attachment;
      return call<DevAttachment>('confirmAttachment', [attachment.id]);
    },
    async deleteAttachment(taskId: string, id: string): Promise<void> {
      assertLedgerTask(taskId);
      if (!attachmentIds.has(id))
        throw new DevcheckError(
          'LEDGER_GUARD',
          `refusing to delete attachment ${id} — not this run's`,
        );
      await call<null>('deleteAttachment', [id]);
    },
  };
  return writes;
}
