import { isApiMethod } from '@aperture/shared';
import type { DocClient } from './ddb/DocClient';
import { Repo } from './ddb/repo';
import { liveWrites, noopWrites } from './ddb/writes';
import { noopGoogle } from './google/gateway';
import type { GoogleGateway } from './google/gateway';
import { BackendClient } from './backend';
import type { Presigner } from './s3/presigner';
import { noopObjectStore } from './s3/objects';
import type { ObjectStore } from './s3/objects';
import { noopInvoker } from './finance/invoker';
import type { FinanceSyncInvoker } from './finance/invoker';
import { noopPlaid } from './plaid/gateway';
import type { PlaidGateway } from './plaid/gateway';
import { noopAnthropic } from './anthropic/gateway';
import type { AnthropicGateway } from './anthropic/gateway';

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
  objects?: ObjectStore; // deletes attachment bytes in S3; ignored in testMode
  plaid?: PlaidGateway; // live Plaid seam (index.ts); ignored in testMode
  financeInvoker?: FinanceSyncInvoker; // starts the sync Lambda; ignored in testMode
  anthropic?: AnthropicGateway; // live Claude API seam (index.ts, mcp/index.ts); ignored in testMode
}

// Transport-agnostic RPC core: validate the method against the shared allowlist, build a BackendClient
// (live writes, or write-free for a smoke call), and invoke it. The AWS handler and the httpClient's
// in-process test harness both go through here, so there's one dispatch path to trust.
export async function handleRpc(
  doc: DocClient,
  call: RpcCall,
  deps: RpcDeps = {},
): Promise<unknown> {
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
    // testMode forces these inert too — a smoke run deletes no S3 object, reads no Plaid token or API
    // key, starts no sync, and makes no Claude call.
    objects: call.testMode ? noopObjectStore() : deps.objects,
    plaid: call.testMode ? noopPlaid() : (deps.plaid ?? noopPlaid()),
    financeInvoker: call.testMode ? noopInvoker() : (deps.financeInvoker ?? noopInvoker()),
    anthropic: call.testMode ? noopAnthropic() : (deps.anthropic ?? noopAnthropic()),
  });
  const fn = (
    backend as unknown as Record<string, ((...a: unknown[]) => Promise<unknown>) | undefined>
  )[call.method];
  if (!fn) throw new Error(`Unknown method: ${call.method}`); // isApiMethod already ensured this
  return fn.apply(backend, call.args ?? []);
}
