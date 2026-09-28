import type { FinanceSyncEvent } from './sync';

// How the BFF starts a sync. Live: an async (Event) invoke of the sync Lambda (liveInvoker.ts), so an
// RPC returns at once and the page polls `syncing`. Tests: inline — the run completes before the RPC
// returns, like the stub. testMode: nothing.
export interface FinanceSyncInvoker {
  invoke(e: FinanceSyncEvent): Promise<void>;
}

export function noopInvoker(): FinanceSyncInvoker {
  return { invoke: async () => {} };
}

export function inlineInvoker(run: (e: FinanceSyncEvent) => Promise<unknown>): FinanceSyncInvoker {
  return {
    invoke: async (e) => {
      await run(e);
    },
  };
}
