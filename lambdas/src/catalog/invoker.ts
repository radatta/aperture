import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';

// How the BFF and the MCP edge start the full catalog's import (catalog/import.ts) on the coach worker: an async
// (Event) invoke, the same function and grant as the AI pick (coach/liveInvoker.ts), told apart by `kind`. Tests and
// the local server run it inline; testMode and stages without the worker: disabled, and an import is refused.
export interface CatalogImportEvent {
  kind: 'catalog-import';
  runId: string;
  limit?: number;
}
export interface CatalogImportInvoker {
  enabled: boolean;
  invoke(e: CatalogImportEvent): Promise<void>;
}

export const noopCatalogInvoker = (): CatalogImportInvoker => ({
  enabled: false,
  invoke: async () => {},
});

export const inlineCatalogInvoker = (
  run: (e: CatalogImportEvent) => Promise<unknown>,
): CatalogImportInvoker => ({
  enabled: true,
  invoke: async (e) => {
    await run(e);
  },
});

type LambdaLike = Pick<LambdaClient, 'send'>;
export function liveCatalogInvoker(
  functionName: string,
  client: LambdaLike = new LambdaClient({}),
): CatalogImportInvoker {
  return {
    enabled: true,
    async invoke(e) {
      const res = await client.send(
        new InvokeCommand({
          FunctionName: functionName,
          InvocationType: 'Event',
          Payload: new TextEncoder().encode(JSON.stringify(e)),
        }),
      );
      if (res.StatusCode !== 202)
        throw new Error(`Couldn’t start the catalog import (${res.StatusCode ?? '?'})`);
    },
  };
}
