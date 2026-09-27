import { describe, expect, it } from 'vitest';
import type { InvokeCommand } from '@aws-sdk/client-lambda';
import { liveInvoker } from './liveInvoker';

describe('liveInvoker', () => {
  it('sends an async Event invoke with the JSON event, and requires a 202', async () => {
    const sent: InvokeCommand[] = [];
    let status = 202;
    const client = {
      send: async (cmd: InvokeCommand) => {
        sent.push(cmd);
        return { StatusCode: status };
      },
    } as unknown as Parameters<typeof liveInvoker>[1];
    const inv = liveInvoker('aperture-finance-sync-dev', client);
    await inv.invoke({ userId: 'u1', mode: 'manual', refresh: true });
    expect(sent[0]!.input.FunctionName).toBe('aperture-finance-sync-dev');
    expect(sent[0]!.input.InvocationType).toBe('Event');
    expect(JSON.parse(new TextDecoder().decode(sent[0]!.input.Payload as Uint8Array))).toEqual({
      userId: 'u1',
      mode: 'manual',
      refresh: true,
    });
    status = 500;
    await expect(inv.invoke({ userId: 'u1', mode: 'manual' })).rejects.toThrow(/500/);
  });
});
