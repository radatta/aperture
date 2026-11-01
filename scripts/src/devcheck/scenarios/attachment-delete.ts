// Deleting a file, or its task, deletes the bytes in S3 — driven the way a user does it: the task editor's
// Files panel (✕ → Delete / Cancel) and its Delete task…. Files are uploaded through the API exactly as
// the app does (mint → PUT to the presigned URL → confirm), on ledger-recorded tasks. The byte-level proof
// is a presigned GET: 200 before the delete, 403 or 404 after (403 is what dev returns — the role has
// no ListBucket, so S3 won't say NoSuchKey; 404 still counts). Each URL is minted right before its
// probe (5-minute TTL). Step titles carry their dev-test-matrix rows ([n]) from the PR's report.
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
let A: { taskId: string; a1: DevAttachment; a2: DevAttachment };
let B: { taskId: string; partId: string; files: DevAttachment[] };

async function expectLive(ctx: Ctx, id: string, what: string): Promise<void> {
  const url = await ctx.api.reads.getAttachmentDownloadUrl(id);
  const status = await ctx.api.reads.probePresigned(url);
  if (status !== 200) throw new Error(`${what}: GET → ${status}, expected 200`);
}
async function expectGone(ctx: Ctx, url: string, what: string): Promise<void> {
  const status = await ctx.api.reads.probePresigned(url);
  if (status !== 403 && status !== 404) throw new Error(`${what}: GET after delete → ${status}`);
}

const editor = (ctx: Ctx, title: string) =>
  ctx.page.getByRole('dialog', { name: `Task: ${title}` });

async function openTask(ctx: Ctx, title: string): Promise<void> {
  await ctx.ui.goto('/tasks?lens=backlog');
  await ctx.page.getByRole('button', { name: title, exact: true }).first().click();
  await editor(ctx, title).waitFor({ state: 'visible', timeout: 10_000 });
}

export const attachmentDelete: Scenario = {
  id: 'attachment-delete',
  title: 'Deleting a file, or its task, deletes the bytes',
  tiers: ['full'],
  steps: [
    {
      id: 'setup',
      title:
        'Task A with two files; parent B with a file, a pending upload, and a part with a file (API)',
      async run(ctx) {
        const a = await ctx.api.writes.createTask({ title: name(ctx, 'A') });
        A = {
          taskId: a.id,
          a1: await ctx.api.writes.createAttachment(a.id, file('a1.txt')),
          a2: await ctx.api.writes.createAttachment(a.id, file('a2.txt')),
        };
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
        await ctx.ui.goto('/tasks?lens=backlog');
        await ctx.ui.expectText(name(ctx, 'A'), 15_000);
        await ctx.shot('backlog-file-counts');
      },
    },
    {
      id: 'ui-cancel',
      title: '[2] Files panel: ✕ then Cancel deletes nothing — the file still downloads',
      async run(ctx) {
        await openTask(ctx, name(ctx, 'A'));
        const d = editor(ctx, name(ctx, 'A'));
        await d.getByRole('button', { name: 'Delete a1.txt' }).click();
        const confirm = ctx.page.getByRole('alertdialog', { name: 'Delete a1.txt?' });
        await confirm.waitFor({ state: 'visible', timeout: 5_000 });
        await ctx.shot('file-delete-confirm');
        await confirm.getByRole('button', { name: 'Cancel' }).click();
        await confirm.waitFor({ state: 'hidden', timeout: 5_000 });
        const left = await ctx.api.reads.listAttachments(A.taskId);
        if (left.length !== 2) throw new Error(`after Cancel the task lists ${left.length} files`);
        await expectLive(ctx, A.a1.id, 'a1.txt after Cancel');
      },
    },
    {
      id: 'ui-delete-file',
      title:
        '[1][3] Files panel: ✕ then Delete removes the row and the bytes; the other file still downloads',
      async run(ctx) {
        const d = editor(ctx, name(ctx, 'A'));
        const before = await ctx.api.reads.getAttachmentDownloadUrl(A.a1.id);
        if ((await ctx.api.reads.probePresigned(before)) !== 200)
          throw new Error('a1.txt not downloadable before the delete');
        await d.getByRole('button', { name: 'Delete a1.txt' }).click();
        const confirm = ctx.page.getByRole('alertdialog', { name: 'Delete a1.txt?' });
        await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
        await d
          .getByRole('button', { name: 'Delete a1.txt' })
          .waitFor({ state: 'hidden', timeout: 10_000 });
        if ((await d.getByRole('alert').count()) > 0) throw new Error('an error alert showed');
        await ctx.ui.expectText('1/10 files');
        await ctx.shot('after-file-delete');
        const left = (await ctx.api.reads.listAttachments(A.taskId)).map((x) => x.id);
        if (left.join() !== A.a2.id) throw new Error(`server lists ${left.join(', ')}`);
        await expectGone(ctx, before, 'a1.txt');
        await expectLive(ctx, A.a2.id, 'a2.txt after a1.txt’s delete');
        await ctx.page.keyboard.press('Escape');
      },
    },
    {
      id: 'ui-reload',
      title: '[4] After a reload the deleted file stays gone and the other is still there',
      async run(ctx) {
        await ctx.page.reload({ waitUntil: 'load' });
        await openTask(ctx, name(ctx, 'A'));
        const d = editor(ctx, name(ctx, 'A'));
        await d
          .getByRole('button', { name: 'Delete a2.txt' })
          .waitFor({ state: 'visible', timeout: 10_000 });
        if ((await d.getByRole('button', { name: 'Delete a1.txt' }).count()) > 0)
          throw new Error('a1.txt is back after a reload');
        await ctx.shot('after-reload');
        await ctx.page.keyboard.press('Escape');
      },
    },
    {
      id: 'ui-delete-task',
      title:
        '[5][6][7] Delete task… on parent B removes B, its part, and every file’s bytes — pending and the part’s too',
      async run(ctx) {
        const urls: string[] = [];
        for (const f of B.files) {
          const url = await ctx.api.reads.getAttachmentDownloadUrl(f.id);
          const status = await ctx.api.reads.probePresigned(url);
          if (status !== 200) throw new Error(`${f.id}: GET before delete → ${status}`);
          urls.push(url);
        }
        await openTask(ctx, name(ctx, 'B'));
        const d = editor(ctx, name(ctx, 'B'));
        await d.getByRole('button', { name: 'Delete task…' }).click();
        const confirm = ctx.page.getByRole('alertdialog', { name: `Delete ${name(ctx, 'B')}?` });
        await confirm.waitFor({ state: 'visible', timeout: 5_000 });
        await ctx.shot('task-delete-confirm');
        await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
        await d.waitFor({ state: 'hidden', timeout: 10_000 });
        await ctx.shot('after-task-delete');
        for (const id of [B.taskId, B.partId])
          if (await ctx.api.reads.getTask(id)) throw new Error(`task ${id} survived the delete`);
        for (const [i, url] of urls.entries()) await expectGone(ctx, url, B.files[i]!.id);
      },
    },
    {
      id: 'idempotent',
      title: '[8] Deleting again is a quiet no-op; no console errors',
      async run(ctx) {
        await ctx.api.writes.deleteAttachment(A.taskId, A.a1.id);
        await ctx.api.writes.deleteTask(B.taskId);
        const errors = ctx.consoleErrors();
        if (errors.length) throw new Error(`console errors: ${errors.join(' | ')}`);
      },
    },
  ],
};
