import { isApiMethod } from '@aperture/shared';
import type { DocClient } from './ddb/DocClient';
import { Repo } from './ddb/repo';
import { liveWrites, noopWrites } from './ddb/writes';
import { noopGoogle } from './google/gateway';
import type { GoogleGateway } from './google/gateway';
import { BackendClient } from './backend';
import type { Presigner } from './s3/presigner';

export interface RpcCall {
  userId: string;
  method: string;
  args: unknown[];
  testMode?: boolean; // smoke path → write-free
  now?: () => number; // injectable clock (tests)
  google?: GoogleGateway; // live calendar seam (index.ts); ignored in testMode
  stateSecret?: string; // OAuth state HMAC key (ORIGIN_SECRET)
}

// Injected dependencies that outlive a single call (the S3 presigner is built once at cold start). Kept
// separate from RpcCall so the contract suite can supply a fake without a per-call field.
export interface RpcDeps {
  presigner?: Presigner;
}

// Transport-agnostic RPC core: validate the method against the shared allowlist, build a BackendClient
// (live writes, or write-free for a smoke call), and invoke it. The AWS handler and the httpClient's
// in-process test harness both go through here, so there's one dispatch path to trust.
export async function handleRpc(doc: DocClient, call: RpcCall, deps: RpcDeps = {}): Promise<unknown> {
  if (!isApiMethod(call.method)) throw new Error(`Unknown method: ${call.method}`);
  const writes = call.testMode ? noopWrites() : liveWrites(doc);
  // testMode forces the inert gateway too — a smoke run reads no SSM token and makes no Google fetch.
  const google = call.testMode ? noopGoogle() : (call.google ?? noopGoogle());
  const backend = new BackendClient(new Repo(doc, writes, call.userId), {
    userId: call.userId,
    now: call.now,
    google,
    stateSecret: call.stateSecret,
    presigner: deps.presigner,
  });
  const fn = (
    backend as unknown as Record<string, ((...a: unknown[]) => Promise<unknown>) | undefined>
  )[call.method];
  if (!fn) throw new Error(`Unknown method: ${call.method}`); // isApiMethod already ensured this
  return fn.apply(backend, call.args ?? []);
}
