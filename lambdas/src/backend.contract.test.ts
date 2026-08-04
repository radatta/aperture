import { API_METHODS } from '@aperture/shared';
import type { ApiClient } from '@aperture/shared';
import { runApiContract } from '@aperture/shared/contract';
import { InMemoryDoc } from './ddb/DocClient';
import { Repo } from './ddb/repo';
import { liveWrites } from './ddb/writes';
import { BackendClient } from './backend';
import { handleRpc } from './handler';

// The Lambda backend, run against the SAME contract suite as the stub — this is the parity proof the
// whole page-first architecture rests on. Two passes:
//   1. BackendClient directly (the business logic over the in-memory table)
//   2. through handleRpc — the real RPC dispatch (method validation + arg passing), end-to-end server-side
runApiContract('lambda (direct)', (now) => {
  const doc = new InMemoryDoc();
  return new BackendClient(new Repo(doc, liveWrites(doc), 'local'), { userId: 'local', now });
});

runApiContract('lambda (via handleRpc dispatch)', (now) => {
  const doc = new InMemoryDoc();
  const client: Record<string, unknown> = {};
  for (const method of API_METHODS) {
    client[method] = (...args: unknown[]) => handleRpc(doc, { userId: 'local', method, args, now });
  }
  return client as unknown as ApiClient;
});
