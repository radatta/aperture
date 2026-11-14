import { describe, expect, it } from 'vitest';
import type { Attachment, Task } from '@aperture/shared';
import { InMemoryDoc } from './ddb/DocClient';
import { handleRpc } from './handler';
import { ShapeError } from './rpc/shape';
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

  it('checks the arguments before anything is built, read or written (a ShapeError)', async () => {
    const doc = new InMemoryDoc();
    const call = (method: string, args: unknown[]) =>
      handleRpc(doc, { userId: 'local', method, args });
    await expect(call('createTask', [null])).rejects.toThrow(ShapeError);
    await expect(call('createTask', [{ title: 'x', userId: 'mallory' }])).rejects.toThrow(
      'Unknown task field: userId',
    );
    await expect(
      call('upsertSeries', [
        {
          title: 'x',
          categoryId: null,
          defaultEstimateMin: null,
          rule: 'daily',
          anchorDate: '2026-11-13',
        },
      ]),
    ).rejects.toThrow('rule must be an object');
    expect(doc.size).toBe(0);
    // Legal shapes still land: a weekly series, and settings carrying calendar refs.
    await call('upsertSeries', [
      {
        title: 'Gym',
        categoryId: null,
        defaultEstimateMin: null,
        rule: { kind: 'weekly', daysOfWeek: [1] },
        anchorDate: '2026-11-13',
      },
    ]);
    const ref = { accountSub: 'g', calendarId: 'primary' };
    const s = (await call('updateSettings', [{ calendarShapeRefs: [ref] }])) as {
      calendarShapeRefs: unknown;
    };
    expect(s.calendarShapeRefs).toEqual([ref]);
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

  it('testMode never mints a presigned URL, even with a live presigner injected', async () => {
    const doc = new InMemoryDoc();
    const minted: string[] = [];
    const presigner = {
      putUrl: async (key: string) => (minted.push(`put ${key}`), 'https://put'),
      getUrl: async (key: string) => (minted.push(`get ${key}`), 'https://get'),
    };
    const call = (method: string, args: unknown[], testMode = false) =>
      handleRpc(doc, { userId: 'local', method, args, testMode }, { presigner });
    const task = (await call('createTask', [{ title: 'has a file' }])) as Task;
    const input = { taskId: task.id, filename: 'a.txt', contentType: 'text/plain', size: 5 };
    await expect(call('createAttachmentUploadUrl', [input], true)).rejects.toThrow(
      /Attachments unavailable/,
    );
    expect(minted).toHaveLength(0);
    // ...and outside testMode the same deps do reach it.
    const { attachment } = (await call('createAttachmentUploadUrl', [input])) as {
      attachment: Attachment;
    };
    expect(minted).toEqual([`put ${attachment.s3Key}`]);
    await expect(call('getAttachmentDownloadUrl', [attachment.id], true)).rejects.toThrow(
      /Attachments unavailable/,
    );
    expect(minted).toHaveLength(1);
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
