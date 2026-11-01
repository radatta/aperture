import { describe, expect, it } from 'vitest';
import type { Attachment, Task } from '@aperture/shared';
import { InMemoryDoc } from './ddb/DocClient';
import { handleRpc } from './handler';
import { FakeAnthropic } from './anthropic/gateway';
import { fakePresigner } from './s3/presigner';
import { fakeObjectStore } from './s3/objects';

describe('handleRpc dispatch', () => {
  it('routes a known method with its args', async () => {
    const doc = new InMemoryDoc();
    const task = (await handleRpc(doc, {
      userId: 'local',
      method: 'createTask',
      args: [{ title: 'x' }],
    })) as Task;
    expect(task.title).toBe('x');
    expect(doc.size).toBe(1);
  });

  it('rejects an unknown method (never invokes an arbitrary property)', async () => {
    await expect(
      handleRpc(new InMemoryDoc(), { userId: 'local', method: 'constructor', args: [] }),
    ).rejects.toThrow(/Unknown method/);
    await expect(
      handleRpc(new InMemoryDoc(), { userId: 'local', method: 'dropEverything', args: [] }),
    ).rejects.toThrow(/Unknown method/);
  });

  it('testMode never reaches the Claude API, even with a live gateway injected', async () => {
    const anthropic = new FakeAnthropic();
    anthropic.next = { ok: true, fields: { title: 'parsed' } };
    const r = await handleRpc(
      new InMemoryDoc(),
      { userId: 'local', method: 'parseTask', args: ['fix it 30m'], testMode: true },
      { anthropic },
    );
    expect(r).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(anthropic.calls).toHaveLength(0);
    // ...and outside testMode the same deps do reach it.
    await handleRpc(
      new InMemoryDoc(),
      { userId: 'local', method: 'parseTask', args: ['fix it'] },
      { anthropic },
    );
    expect(anthropic.calls).toHaveLength(1);
  });

  it('testMode never deletes an S3 object, even with a live store injected', async () => {
    const doc = new InMemoryDoc();
    const objects = fakeObjectStore();
    const deps = { presigner: fakePresigner(), objects };
    const call = (method: string, args: unknown[], testMode = false) =>
      handleRpc(doc, { userId: 'local', method, args, testMode }, deps);
    const task = (await call('createTask', [{ title: 'has a file' }])) as Task;
    const { attachment } = (await call('createAttachmentUploadUrl', [
      { taskId: task.id, filename: 'a.txt', contentType: 'text/plain', size: 5 },
    ])) as { attachment: Attachment };
    await call('deleteAttachment', [attachment.id], true);
    await call('deleteTask', [task.id], true);
    expect(objects.deleted).toHaveLength(0);
    // ...and outside testMode the same deps do reach it.
    await call('deleteAttachment', [attachment.id]);
    expect(objects.deleted).toEqual([attachment.s3Key]);
  });

  it('testMode runs the logic but persists nothing (the smoke guarantee)', async () => {
    const doc = new InMemoryDoc();
    const task = (await handleRpc(doc, {
      userId: 'local',
      method: 'createTask',
      args: [{ title: 'ghost' }],
      testMode: true,
    })) as Task;
    expect(task.title).toBe('ghost'); // a real object comes back...
    expect(doc.size).toBe(0); // ...but nothing was written
    const tasks = await handleRpc(doc, { userId: 'local', method: 'listTasks', args: [] });
    expect(tasks).toEqual([]);
  });

  it('scopes data by userId (one user cannot read another)', async () => {
    const doc = new InMemoryDoc();
    await handleRpc(doc, { userId: 'alice', method: 'createTask', args: [{ title: 'a-task' }] });
    const bobTasks = (await handleRpc(doc, {
      userId: 'bob',
      method: 'listTasks',
      args: [],
    })) as Task[];
    expect(bobTasks).toEqual([]);
    const aliceTasks = (await handleRpc(doc, {
      userId: 'alice',
      method: 'listTasks',
      args: [],
    })) as Task[];
    expect(aliceTasks.map((t) => t.title)).toEqual(['a-task']);
  });
});
