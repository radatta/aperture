// @aperture/lambdas — the reminder poller (the fourth function; cdk/src/lib/push-dispatch.ts). EventBridge
// Scheduler invokes it every minute with `{"mode":"tick"}` — no user id: it ticks over the push registry
// (reminders.md). It never serves HTTP. The logic lives in push/dispatch.ts; this is the AWS edge.
import { createLiveDoc } from './ddb/LiveDoc';
import type { DocClient } from './ddb/DocClient';
import { liveWrites, noopWrites } from './ddb/writes';
import { runPushTick } from './push/dispatch';
import type { PushTickReport } from './push/dispatch';
import { noopPush } from './push/gateway';
import type { PushGateway } from './push/gateway';
import { createLivePush } from './push/livePush';

const APP_URL = process.env.APP_URL ?? '';
const doc = createLiveDoc(process.env.TABLE_NAME ?? 'aperture');
const push = createLivePush({ stage: process.env.STAGE ?? 'dev', appUrl: APP_URL });

// Anything else is a malformed invoke — refuse it before touching the table or a push service.
export function parseTickEvent(raw: unknown): { testMode?: true } {
  const e = (raw ?? {}) as Record<string, unknown>;
  if (e.mode !== 'tick') throw new Error('Invalid push dispatch event: mode');
  return e.testMode === true ? { testMode: true } : {};
}

// The core, AWS-free for tests. testMode (the CI smoke path) runs the same selection over the write-free
// table seam and the inert push gateway: nothing persists, nothing is sent.
export async function handlePushTick(
  table: DocClient,
  gateway: PushGateway,
  raw: unknown,
  opts: {
    now?: () => number;
    deadline?: number;
    appUrl?: string;
    log?: (line: string) => void;
  } = {},
): Promise<PushTickReport> {
  const e = parseTickEvent(raw);
  return runPushTick({
    doc: table,
    writes: e.testMode ? noopWrites() : liveWrites(table),
    push: e.testMode ? noopPush() : gateway,
    now: opts.now ?? Date.now,
    appUrl: opts.appUrl ?? APP_URL,
    deadline: opts.deadline,
    log: opts.log,
  });
}

// Only what the handler reads from the Lambda context (no @types/aws-lambda for one method).
export interface TickContext {
  getRemainingTimeInMillis(): number;
}
// Start no send past this much before Lambda's own timeout: one send may take its full 5 s cap
// (livePush.ts), then the stamps and the heartbeat.
export const TICK_SAFETY_MS = 7_000;

export const tickDeadline = (ctx: TickContext | undefined, now: number): number | undefined =>
  ctx ? now + ctx.getRemainingTimeInMillis() - TICK_SAFETY_MS : undefined;

export async function handler(event: unknown, ctx?: TickContext): Promise<PushTickReport> {
  return handlePushTick(doc, push, event, { deadline: tickDeadline(ctx, Date.now()) });
}
