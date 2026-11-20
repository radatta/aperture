import { beforeEach, describe, expect, it } from 'vitest';
import { PULSE_NOTE_MAX } from '@aperture/shared';
import type { ApiMethod, PulseResult } from '@aperture/shared';
import { InMemoryDoc } from '../ddb/DocClient';
import { Repo } from '../ddb/repo';
import { liveWrites } from '../ddb/writes';
import { BackendClient } from '../backend';
import { handleRpc } from '../handler';
import { ShapeError } from '../rpc/shape';
import { TOOLS } from './tools';
import { RpcParamError } from './types';
import type { ToolContext } from './types';

// pulse over MCP (docs/areas/mcp/pulse.md): its arguments, and the real handleRpc path behind it.
const U = 'local';
const DAY = '2023-11-14';
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
const pulse = (args: Record<string, unknown>) =>
  TOOLS.find((t) => t.name === 'pulse')!.run(args, ctx) as Promise<PulseResult>;

describe('pulse', () => {
  it('times a task from its pulses and returns the answer', async () => {
    const t = await setup.createTask({ title: 'Mock prep', estimateMin: 30 });
    const first = await pulse({ taskId: t.id, note: 'behavioral stories' });
    expect(first).toMatchObject({
      counted: true,
      opened: true,
      task: { id: t.id, status: 'in_progress' },
    });
    clock += 5 * 60_000;
    expect(await pulse({ taskId: ` ${t.id} ` })).toMatchObject({
      opened: false,
      sessionMin: 5,
    });
  });

  it('cuts a long note to one line rather than refusing it', async () => {
    const t = await setup.createTask({ title: 'Notes', estimateMin: 30 });
    await pulse({ taskId: t.id, note: `line one\nline two ${'x'.repeat(400)}` });
    const [row] = (await setup.listSessionsForDay(DAY)).filter((s) => s.source === 'pulse');
    expect(row!.pulseNotes![0]!.text).toHaveLength(PULSE_NOTE_MAX);
    expect(row!.pulseNotes![0]!.text.startsWith('line one line two')).toBe(true);
  });

  it('refuses bad arguments as param errors, before anything is written', async () => {
    const t = await setup.createTask({ title: 'X', estimateMin: 30 });
    const before = doc.snapshot();
    for (const args of [
      {},
      { taskId: '' },
      { taskId: 7 },
      { taskId: t.id, note: 5 },
      { taskId: t.id, done: 'yes' },
      { taskId: t.id, minutes: 10 },
    ])
      await expect(pulse(args)).rejects.toBeInstanceOf(RpcParamError);
    expect(doc.snapshot()).toEqual(before);
  });

  it('an unknown task is an execution error the model reads, and nothing is written', async () => {
    const before = doc.snapshot();
    await expect(pulse({ taskId: 'no-such-task' })).rejects.toThrow('Not found');
    expect(doc.snapshot()).toEqual(before);
  });

  it('the RPC edge refuses a malformed pulse body by shape, before anything is read or written', async () => {
    const t = await setup.createTask({ title: 'X', estimateMin: 30 });
    const before = doc.snapshot();
    for (const bad of [[{ taskId: t.id, done: 1 }], [{ taskId: t.id, extra: true }], [t.id]])
      await expect(
        handleRpc(doc, { userId: U, method: 'pulseTask', args: bad, now }),
      ).rejects.toBeInstanceOf(ShapeError);
    expect(doc.snapshot()).toEqual(before);
  });

  it("advertises itself as a write that isn't destructive", () => {
    const tool = TOOLS.find((t) => t.name === 'pulse')!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(tool.inputSchema.required).toEqual(['taskId']);
  });
});
