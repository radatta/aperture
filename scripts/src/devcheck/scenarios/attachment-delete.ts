// Deleting an attachment, or its task, deletes the bytes in S3 — not just the metadata row. Files are
// uploaded through the API exactly as the app does (mint → PUT to the presigned URL → confirm), on
// ledger-recorded tasks. The proof is a presigned GET: 200 before the delete, 403 or 404 after (with a
// delete marker as the current version, 404 is likelier; which one isn't verified, so both count). Each
// URL is minted right before its probe (5-minute TTL).
import type { DevAttachment } from '../api';
import type { Ctx, Scenario } from '../scenario';

const name = (ctx: Ctx, what: string) => `devcheck ${ctx.nonce} ${what}`;
const file = (filename: string, confirm = true) => ({
  filename,
  contentType: 'text/plain',
  text: `devcheck ${filename}`,
  confirm,
});

// Steps share what setup made; a failed setup skips the rest, so these are always set when read.
let A: { taskId: string; a: DevAttachment };
let B: { taskId: string; partId: string; files: DevAttachment[] };

async function expectGone(ctx: Ctx, url: string, what: string): Promise<void> {
  const status = await ctx.api.reads.probePresigned(url);
  if (status !== 403 && status !== 404) throw new Error(`${what}: GET after delete → ${status}`);
}

export const attachmentDelete: Scenario = {
  id: 'attachment-delete',
  title: 'Deleting a file, or its task, deletes the bytes',
  tiers: ['full'],
  steps: [
    {
      id: 'setup',
      title:
        'Task A with a file; parent B with a file, a pending upload, and a part with a file (API)',
      async run(ctx) {
        const a = await ctx.api.writes.createTask({ title: name(ctx, 'A') });
        A = { taskId: a.id, a: await ctx.api.writes.createAttachment(a.id, file('a.txt')) };
        const b = await ctx.api.writes.createTask({ title: name(ctx, 'B') });
        const part = await ctx.api.writes.createTask({
          title: name(ctx, 'B part'),
          parentId: b.id,
        });
        B = {
          taskId: b.id,
          partId: part.id,
          files: [
            await ctx.api.writes.createAttachment(b.id, file('b.txt')),
            await ctx.api.writes.createAttachment(b.id, file('c.txt', false)), // never confirmed
            await ctx.api.writes.createAttachment(part.id, file('p.txt')),
          ],
        };
      },
    },
    {
      id: 'backlog',
      title: 'Task A is in the Backlog (the shot shows its file count)',
      async run(ctx) {
        await ctx.ui.goto('/tasks?lens=backlog');
        await ctx.ui.expectText(name(ctx, 'A'), 15_000);
        await ctx.shot('backlog-file-count');
      },
    },
    {
      id: 'delete-attachment',
      title: 'Deleting A’s file deletes its bytes',
      async run(ctx) {
        const before = await ctx.api.reads.getAttachmentDownloadUrl(A.a.id);
        const status = await ctx.api.reads.probePresigned(before);
        if (status !== 200) throw new Error(`GET before delete → ${status}`);
        await ctx.api.writes.deleteAttachment(A.taskId, A.a.id);
        const left = await ctx.api.reads.listAttachments(A.taskId);
        if (left.length) throw new Error(`still listed: ${left.map((x) => x.id).join(', ')}`);
        const minted = await ctx.api.reads.getAttachmentDownloadUrl(A.a.id).then(
          () => true,
          () => false,
        );
        if (minted) throw new Error('a deleted file still mints a download URL');
        await expectGone(ctx, before, 'a.txt');
      },
    },
    {
      id: 'delete-task',
      title: 'Deleting parent B deletes every file’s bytes — pending and the part’s too',
      async run(ctx) {
        const urls: string[] = [];
        for (const f of B.files) {
          const url = await ctx.api.reads.getAttachmentDownloadUrl(f.id);
          const status = await ctx.api.reads.probePresigned(url);
          if (status !== 200) throw new Error(`${f.id}: GET before delete → ${status}`);
          urls.push(url);
        }
        await ctx.api.writes.deleteTask(B.taskId);
        for (const id of [B.taskId, B.partId])
          if (await ctx.api.reads.getTask(id)) throw new Error(`task ${id} survived the delete`);
        for (const [i, url] of urls.entries()) await expectGone(ctx, url, B.files[i]!.id);
      },
    },
    {
      id: 'idempotent',
      title: 'Deleting again is a quiet no-op',
      async run(ctx) {
        await ctx.api.writes.deleteAttachment(A.taskId, A.a.id);
        await ctx.api.writes.deleteTask(B.taskId);
        const errors = ctx.consoleErrors();
        if (errors.length) throw new Error(`console errors: ${errors.join(' | ')}`);
      },
    },
  ],
};
