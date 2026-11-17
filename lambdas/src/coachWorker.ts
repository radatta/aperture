// @aperture/lambdas — the coach worker Lambda (cdk/src/lib/coach-worker.ts): the LeetCode coach's AI pick runs here,
// invoked async (InvocationType 'Event') by the BFF or the MCP function, at most once a day a user
// (docs/areas/recruiting/coach.md → The AI pick). It never serves HTTP. Its role reads the table and the Anthropic
// key, nothing else. The logic is coach/pick.ts; this is the AWS edge.
import { isDayKey } from '@aperture/shared';
import { createLiveAnthropic } from './anthropic/liveAnthropic';
import type { AnthropicGateway } from './anthropic/gateway';
import type { CoachPickEvent } from './coach/invoker';
import { runCoachPick } from './coach/pick';
import type { CoachPickRun } from './coach/pick';
import { createLiveDoc } from './ddb/LiveDoc';
import type { DocClient } from './ddb/DocClient';
import { Repo } from './ddb/repo';
import { liveWrites } from './ddb/writes';

const doc = createLiveDoc(process.env.TABLE_NAME ?? 'aperture');
const anthropic = createLiveAnthropic({ stage: process.env.STAGE ?? 'dev' });

export type CoachWorkerEvent = CoachPickEvent;

// Anything else is a malformed invoke — refuse it before doing any work.
export function parseCoachWorkerEvent(raw: unknown): CoachWorkerEvent {
  const e = (raw ?? {}) as Record<string, unknown>;
  if (typeof e.userId !== 'string' || e.userId.trim() === '')
    throw new Error('Invalid coach worker event: userId');
  if (typeof e.day !== 'string' || !isDayKey(e.day))
    throw new Error('Invalid coach worker event: day');
  if (typeof e.claimId !== 'string' || e.claimId.trim() === '')
    throw new Error('Invalid coach worker event: claimId');
  return { userId: e.userId, day: e.day, claimId: e.claimId };
}

// The core, AWS-free for tests. One line a run, no user text (and no user id, as finance-sync's lines).
export async function handleCoachPick(
  table: DocClient,
  gateway: AnthropicGateway,
  raw: unknown,
  opts: { now?: () => number } = {},
): Promise<CoachPickRun> {
  const e = parseCoachWorkerEvent(raw);
  const run = await runCoachPick(
    {
      repo: new Repo(table, liveWrites(table), e.userId),
      anthropic: gateway,
      now: opts.now ?? Date.now,
    },
    e,
  );
  console.log(JSON.stringify({ event: 'coach_worker', run, day: e.day, claimId: e.claimId }));
  return run;
}

export async function handler(event: unknown): Promise<CoachPickRun> {
  return handleCoachPick(doc, anthropic, event);
}
