import { isApiMethod } from '@aperture/shared';
import type { DocClient } from './ddb/DocClient';
import { Repo } from './ddb/repo';
import { liveWrites, noopWrites } from './ddb/writes';
import { BackendClient } from './backend';

export interface RpcCall {
  userId: string;
  method: string;
  args: unknown[];
  testMode?: boolean; // smoke path → write-free
  now?: () => number; // injectable clock (tests)
}

// Transport-agnostic RPC core: validate the method against the shared allowlist, build a BackendClient
// (live writes, or write-free for a smoke call), and invoke it. The AWS handler and the httpClient's
// in-process test harness both go through here, so there's one dispatch path to trust.
export async function handleRpc(doc: DocClient, call: RpcCall): Promise<unknown> {
  if (!isApiMethod(call.method)) throw new Error(`Unknown method: ${call.method}`);
  const writes = call.testMode ? noopWrites() : liveWrites(doc);
  const backend = new BackendClient(new Repo(doc, writes, call.userId), {
    userId: call.userId,
    now: call.now,
  });
  const fn = (
    backend as unknown as Record<string, ((...a: unknown[]) => Promise<unknown>) | undefined>
  )[call.method];
  if (!fn) throw new Error(`Unknown method: ${call.method}`); // isApiMethod already ensured this
  return fn.apply(backend, call.args ?? []);
}
