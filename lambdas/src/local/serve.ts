// The local devcheck server — `pnpm devcheck:local` spawns it (scripts/src/devcheck/local/server.ts) and kills it
// by PID; never run by hand against anything real. Reads the run's auth from env, listens on an ephemeral
// loopback port, and prints one `{"ready":…,"port":…}` line. The run's table dies with the process.
// docs/ops/LOCAL-CHECK.md.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createBffHandler } from '../index';
import { createMcpHandler } from '../mcp/index';
import { localDeps } from './deps';
import { createEdge } from './edge';
import type { EdgeEvent, EdgeResult } from './edge';

const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`local server: ${k} is not set`);
  return v;
};
// The deployed stage env the edges read per call — and never the live table/pool, so nothing live is wired.
if (process.env.TABLE_NAME || process.env.USER_POOL_ID || process.env.FILES_BUCKET)
  throw new Error('local server: refusing a live TABLE_NAME / USER_POOL_ID / FILES_BUCKET');

const deps = localDeps({
  poolId: need('LOCAL_POOL_ID'),
  claudeClientId: need('LOCAL_CLAUDE_CLIENT_ID'),
  jwks: JSON.parse(need('LOCAL_JWKS')) as Parameters<typeof localDeps>[0]['jwks'],
});
const bff = createBffHandler(deps.bff) as (e: EdgeEvent) => Promise<EdgeResult>;
const mcp = createMcpHandler(deps.mcp) as (e: EdgeEvent) => Promise<EdgeResult>;
const server = createServer(createEdge({ bff, mcp }, need('ORIGIN_SECRET')));
server.listen(0, '127.0.0.1', () => {
  const { port } = server.address() as AddressInfo;
  console.log(JSON.stringify({ ready: true, port }));
});
// The harness kills by PID; exit cleanly on its signal rather than leaving the listener.
for (const sig of ['SIGTERM', 'SIGINT'] as const)
  process.once(sig, () => server.close(() => process.exit(0)));
