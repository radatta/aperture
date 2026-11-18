import { describe, expect, it } from 'vitest';
import { liveCatalogInvoker } from './invoker';

describe('liveCatalogInvoker', () => {
  it('sends an async Event invoke with the event as its payload', async () => {
    const sent: unknown[] = [];
    const inv = liveCatalogInvoker('worker-fn', {
      send: async (cmd: { input: unknown }) => {
        sent.push(cmd.input);
        return { StatusCode: 202 };
      },
    } as never);
    await inv.invoke({ kind: 'catalog-import', runId: 'r1', limit: 3 });
    const input = sent[0] as { FunctionName: string; InvocationType: string; Payload: Uint8Array };
    expect(input).toMatchObject({ FunctionName: 'worker-fn', InvocationType: 'Event' });
    expect(JSON.parse(new TextDecoder().decode(input.Payload))).toEqual({
      kind: 'catalog-import',
      runId: 'r1',
      limit: 3,
    });
  });

  it('throws when Lambda doesn’t accept the event', async () => {
    const inv = liveCatalogInvoker('worker-fn', {
      send: async () => ({ StatusCode: 500 }),
    } as never);
    await expect(inv.invoke({ kind: 'catalog-import', runId: 'r1' })).rejects.toThrow(
      /catalog import \(500\)/,
    );
  });
});
