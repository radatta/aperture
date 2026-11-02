// Deleting a file, or its task, deletes the bytes in S3 — driven the way a user does it: the task editor's
// Files panel (✕ → Delete / Cancel) and its Delete task…. Files are uploaded through the API exactly as
// the app does (mint → PUT to the presigned URL → confirm), on ledger-recorded tasks. The byte-level proof
// is a presigned GET: 200 before the delete, gone after (isGone — 403 on dev). Each URL is minted right
// before its probe (5-minute TTL). The rows are PR 80's dev-test matrix.
import { isGone, type DevAttachment } from '../api';
import { noConsoleErrors, type Ctx, type Scenario } from '../scenario';

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
  if (!isGone(status)) throw new Error(`${what}: GET after delete → ${status}`);
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
  rows: [
    {
      id: 'panel-delete',
      entry: 'ui',
      kind: 'nominal',
      what: 'Files panel ✕ → Delete: the row goes, the count drops, the bytes are gone',
    },
    {
      id: 'panel-cancel',
      entry: 'ui',
      kind: 'edge',
      what: 'Files panel ✕ → Cancel: nothing deleted, the file still downloads',
    },
    { id: 'neighbour', entry: 'ui', kind: 'edge', what: 'The task’s other file still downloads' },
    { id: 'reload', entry: 'ui', kind: 'edge', what: 'After a reload the deleted file stays gone' },
    {
      id: 'task-delete',
      entry: 'ui',
      kind: 'nominal',
      what: 'Delete task… removes the task and every file’s bytes',
    },
    {
      id: 'parent-part',
      entry: 'ui',
      kind: 'edge',
      what: 'Deleting a parent removes its part and the part’s file bytes',
    },
    {
      id: 'pending-upload',
      entry: 'ui',
      kind: 'edge',
      what: 'Deleting a task removes a never-confirmed upload’s bytes',
    },
    { id: 'idempotent', entry: 'api', kind: 'edge', what: 'Deleting again is a quiet no-op' },
    {
      id: 'mcp',
      entry: 'mcp',
      kind: 'nominal',
      what: 'MCP delete_attachment and delete_task delete the bytes',
      needsYou:
        'MCP as the test user is the next PR; until then run delete_attachment and delete_task on aperture-dev by hand, presigned GET 200 → 403',
    },
    {
      id: 's3-fails-panel',
      entry: 'ui',
      kind: 'edge',
      what: 'S3 refuses the delete: the panel says so and keeps the file',
      offDev: {
        file: 'app/src/modules/tasks/AttachmentsPanel.test.tsx',
        test: 'says so when the delete fails, and keeps the file',
        why: 'dev can’t make S3 refuse a delete',
      },
    },
    {
      id: 's3-fails-row',
      entry: 'api',
      kind: 'edge',
      what: 'S3 refuses the delete: the call fails and the row stays, so a retry finishes it',
      offDev: {
        file: 'lambdas/src/backend.test.ts',
        test: 'a failed S3 delete throws and leaves the row live, so a retry finishes it',
        why: 'dev can’t make S3 refuse a delete',
      },
    },
    {
      id: 's3-fails-cascade',
      entry: 'api',
      kind: 'edge',
      what: 'S3 refuses a task delete’s bytes: the task and its plans stay; the retry completes it',
      offDev: {
        file: 'lambdas/src/backend.test.ts',
        test: 'a failed S3 delete touches nothing else — task, plans intact; the retry completes the cascade',
        why: 'dev can’t make S3 refuse a delete',
      },
    },
  ],
  steps: [
    {
      id: 'setup',
      entry: 'api',
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
      entry: 'ui',
      proves: ['panel-cancel'],
      title: 'Files panel: ✕ then Cancel deletes nothing — the file still downloads',
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
      entry: 'ui',
      proves: ['panel-delete', 'neighbour'],
      title:
        'Files panel: ✕ then Delete removes the row and the bytes; the other file still downloads',
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
      entry: 'ui',
      proves: ['reload'],
      title: 'After a reload the deleted file stays gone and the other is still there',
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
      entry: 'ui',
      proves: ['task-delete', 'parent-part', 'pending-upload'],
      title:
        'Delete task… on parent B removes B, its part, and every file’s bytes — pending and the part’s too',
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
      entry: 'api',
      proves: ['idempotent'],
      title: 'Deleting again is a quiet no-op',
      async run(ctx) {
        await ctx.api.writes.deleteAttachment(A.taskId, A.a1.id);
        await ctx.api.writes.deleteTask(B.taskId);
      },
    },
    noConsoleErrors,
  ],
};
