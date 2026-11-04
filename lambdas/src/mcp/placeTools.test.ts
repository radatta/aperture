import { beforeEach, describe, expect, it } from 'vitest';
import { placeUnknownError } from '@aperture/shared';
import type { ApiMethod, Place, Task } from '@aperture/shared';
import { InMemoryDoc } from '../ddb/DocClient';
import { Repo } from '../ddb/repo';
import { liveWrites } from '../ddb/writes';
import { BackendClient } from '../backend';
import { handleRpc } from '../handler';
import { TOOLS } from './tools';
import { RpcParamError } from './types';
import type { ToolContext } from './types';

// Places over MCP (places.md): the two reads, `place` on the task tools, and complete_task's errand
// exemption — all through the real handleRpc path.
const U = 'local';
let clock = 1_700_000_000_000;
const now = () => clock;
let doc: InMemoryDoc;
let setup: BackendClient;
let ctx: ToolContext;

beforeEach(() => {
  clock = 1_700_000_000_000;
  doc = new InMemoryDoc();
  setup = new BackendClient(new Repo(doc, liveWrites(doc), U), { userId: U, now });
  ctx = {
    dispatch: (method: ApiMethod, args: unknown[]) =>
      handleRpc(doc, { userId: U, method, args, now }),
    upload: async () => {},
    now,
  };
});
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool.run(args, ctx);
};

describe('list_places / list_place_tasks', () => {
  it('lists places in add order, and one list as the notification text plus ids', async () => {
    await setup.upsertPlace({ name: 'Safeway' });
    clock += 1;
    await setup.upsertPlace({ name: 'Target' });
    expect(((await call('list_places')) as Place[]).map((p) => p.slug)).toEqual([
      'safeway',
      'target',
    ]);
    const a = await setup.createTask({ title: 'shampoo', place: 'safeway' });
    clock += 1;
    const b = await setup.createTask({ title: 'nails', place: 'safeway' });
    await setup.createTask({ title: 'socks', place: 'target' });
    const out = await call('list_place_tasks', { place: '@Safeway' });
    expect(out).toEqual({
      place: 'Safeway',
      slug: 'safeway',
      count: 2,
      titles: ['shampoo', 'nails'],
      text: 'Safeway · 2 — shampoo, nails',
      tasks: [
        { id: a.id, title: 'shampoo', status: 'backlog' },
        { id: b.id, title: 'nails', status: 'backlog' },
      ],
    });
  });

  it('is a pure read: no heartbeat on the place', async () => {
    await setup.upsertPlace({ name: 'Safeway' });
    const before = doc.snapshot();
    await call('list_place_tasks', { place: 'safeway' });
    expect(doc.snapshot()).toEqual(before);
    expect((await setup.listPlaces())[0]!.lastReadAt).toBeNull();
  });

  it('refuses a missing place and names an unknown one', async () => {
    await expect(call('list_place_tasks', {})).rejects.toBeInstanceOf(RpcParamError);
    await expect(call('list_place_tasks', { place: 3 })).rejects.toBeInstanceOf(RpcParamError);
    await expect(call('list_place_tasks', { place: 'target' })).rejects.toThrow(
      placeUnknownError('target'),
    );
  });
});

describe('place on the task tools', () => {
  beforeEach(async () => {
    await setup.upsertPlace({ name: 'Safeway' });
  });

  it('create_task / create_tasks take a place (as the model may say it); an unknown one creates none', async () => {
    const t = (await call('create_task', { title: 'shampoo', place: 'Safeway' })) as Task;
    expect(t.place).toBe('safeway');
    const many = (await call('create_tasks', {
      tasks: [{ title: 'nails', place: 'safeway' }, { title: 'plain' }],
    })) as Task[];
    expect(many.map((x) => x.place)).toEqual(['safeway', null]);
    const before = (await setup.listTasks()).length;
    await expect(
      call('create_tasks', { tasks: [{ title: 'ok' }, { title: 'bad', place: 'target' }] }),
    ).rejects.toThrow(placeUnknownError('target'));
    expect(await setup.listTasks()).toHaveLength(before);
    await expect(call('create_task', { title: 'x', place: 5 })).rejects.toBeInstanceOf(
      RpcParamError,
    );
  });

  it('update_task sets and clears the place, at any status', async () => {
    const t = (await call('create_task', { title: 'shampoo' })) as Task;
    expect(((await call('update_task', { id: t.id, place: 'safeway' })) as Task).place).toBe(
      'safeway',
    );
    await call('complete_task', { id: t.id });
    expect(((await call('update_task', { id: t.id, place: null })) as Task).place).toBeNull();
    await expect(call('update_task', { id: t.id, place: 'target' })).rejects.toThrow(
      /No place "target".*already applied: none/,
    );
  });

  it('complete_task checks off an errand without actualMin — and no calibration point', async () => {
    const t = (await call('create_task', {
      title: 'shampoo',
      place: 'safeway',
      estimateMin: 5,
    })) as Task;
    const res = (await call('complete_task', { id: t.id })) as { task: Task };
    expect(res.task.status).toBe('done');
    expect(res.task.actualAccruedMin).toBe(0);
    expect(await setup.getCalibration({ from: '2000-01-01', to: '2100-01-01' })).toEqual([]);
    // An actual given anyway is recorded; a plain task still needs one.
    const u = (await call('create_task', { title: 'nails', place: 'safeway' })) as Task;
    expect(
      ((await call('complete_task', { id: u.id, actualMin: 3 })) as { task: Task }).task
        .actualAccruedMin,
    ).toBe(3);
    const plain = (await call('create_task', { title: 'pset' })) as Task;
    await expect(call('complete_task', { id: plain.id })).rejects.toThrow(/actualMin/);
  });
});
