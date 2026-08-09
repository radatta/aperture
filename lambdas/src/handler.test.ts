import { describe, expect, it } from 'vitest';
import type { Task } from '@aperture/shared';
import { InMemoryDoc } from './ddb/DocClient';
import { handleRpc } from './handler';

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
