// @aperture/lambdas — the finance sync Lambda (the third function; cdk/src/lib/finance-sync.ts). Invoked two
// ways, both with a FinanceSyncEvent: by EventBridge Scheduler (5:15 / 15:15 / 20:15 LA, the
// schedule's fixed input carries the user id) and asynchronously by the BFF after Refresh / connect /
// reconnect. It never serves HTTP. The logic lives in finance/sync.ts; this is the AWS edge.
import { createLiveDoc } from './ddb/LiveDoc';
import type { DocClient } from './ddb/DocClient';
import { Repo } from './ddb/repo';
import { liveWrites, noopWrites } from './ddb/writes';
import { runFinanceSync } from './finance/sync';
import type { FinanceSyncEvent, ItemSyncReport } from './finance/sync';
import { noopPlaid } from './plaid/gateway';
import type { PlaidGateway } from './plaid/gateway';
import { createLivePlaid } from './plaid/livePlaid';

const doc = createLiveDoc(process.env.TABLE_NAME ?? 'aperture');
const plaid = createLivePlaid({
  stage: process.env.STAGE ?? 'dev',
  env: process.env.PLAID_ENV === 'production' ? 'production' : 'sandbox',
});

const MODES = new Set(['scheduled', 'manual', 'post-link']);

// Anything else is a malformed invoke — refuse it before touching the table or Plaid. A `refresh` flag
// from an older caller is ignored: whether to refresh is decided from the stored request.
export function parseSyncEvent(raw: unknown): FinanceSyncEvent & { testMode?: boolean } {
  const e = (raw ?? {}) as Record<string, unknown>;
  if (typeof e.userId !== 'string' || e.userId.trim() === '')
    throw new Error('Invalid finance sync event: userId');
  if (typeof e.mode !== 'string' || !MODES.has(e.mode))
    throw new Error('Invalid finance sync event: mode');
  if (e.itemId !== undefined && typeof e.itemId !== 'string')
    throw new Error('Invalid finance sync event: itemId');
  return {
    userId: e.userId,
    mode: e.mode as FinanceSyncEvent['mode'],
    ...(e.itemId !== undefined ? { itemId: e.itemId as string } : {}),
    ...(e.testMode === true ? { testMode: true } : {}),
  };
}

// The core, AWS-free for tests. testMode (the CI smoke path) runs the same code over the inert Plaid
// gateway and write-free table seam: nothing is read from Plaid, nothing persists.
export async function handleFinanceSync(
  table: DocClient,
  gateway: PlaidGateway,
  raw: unknown,
  opts: { now?: () => number; sleep?: (ms: number) => Promise<void>; deadline?: number } = {},
): Promise<ItemSyncReport[]> {
  const e = parseSyncEvent(raw);
  const repo = new Repo(table, e.testMode ? noopWrites() : liveWrites(table), e.userId);
  const report = await runFinanceSync(
    {
      repo,
      plaid: e.testMode ? noopPlaid() : gateway,
      now: opts.now ?? Date.now,
      sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      userId: e.userId,
      deadline: opts.deadline,
    },
    e,
  );
  for (const r of report)
    console.log(
      JSON.stringify({ event: 'finance_sync', mode: e.mode, testMode: e.testMode === true, ...r }),
    );
  return report;
}

// Only what the handler reads from the Lambda context (no @types/aws-lambda for one method).
export interface SyncContext {
  getRemainingTimeInMillis(): number;
}
export const RUN_SAFETY_MS = 10_000; // finish stamps + logs before Lambda's own timeout

export async function handler(event: unknown, ctx?: SyncContext): Promise<ItemSyncReport[]> {
  const deadline = ctx ? Date.now() + ctx.getRemainingTimeInMillis() - RUN_SAFETY_MS : undefined;
  return handleFinanceSync(doc, plaid, event, { deadline });
}
