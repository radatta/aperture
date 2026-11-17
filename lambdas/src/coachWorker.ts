<<<<<<< HEAD
// @aperture/lambdas — the coach worker Lambda (cdk/src/lib/coach-worker.ts): the LeetCode coach's AI pick runs here,
// invoked async (InvocationType 'Event') by the BFF or the MCP function, at most once a day a user. It never serves
// HTTP. Not wired yet: this body only checks the event and logs that it arrived; the pick replaces it.
import { isDayKey } from '@aperture/shared';

export interface CoachWorkerEvent {
  userId: string;
  day: string; // YYYY-MM-DD, the user's local day the pick is for
  claimId: string; // the caller's claim on that day's pick
}

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

// One line a run, no user text (and no user id, as finance-sync's lines).
export async function handler(event: unknown): Promise<void> {
  const e = parseCoachWorkerEvent(event);
  console.log(
    JSON.stringify({ event: 'coach_worker', wired: false, day: e.day, claimId: e.claimId }),
  );
=======
// @aperture/lambdas — the coach worker (cdk/src/lib/coach-worker.ts): the LeetCode coach's daily AI pick, invoked
// asynchronously by the BFF or the MCP edge once a day's pick is claimed (docs/areas/recruiting/coach.md → The AI
// pick). It never serves HTTP. Its role reads the table and the Anthropic key, nothing else. The logic is
// coach/pick.ts; this is the AWS edge.
import { createLiveAnthropic } from './anthropic/liveAnthropic';
import type { AnthropicGateway } from './anthropic/gateway';
import { runCoachPick, parseCoachPickEvent } from './coach/pick';
import type { CoachPickRun } from './coach/pick';
import { createLiveDoc } from './ddb/LiveDoc';
import type { DocClient } from './ddb/DocClient';
import { Repo } from './ddb/repo';
import { liveWrites } from './ddb/writes';

const doc = createLiveDoc(process.env.TABLE_NAME ?? 'aperture');
const anthropic = createLiveAnthropic({ stage: process.env.STAGE ?? 'dev' });

// The core, AWS-free for tests. A malformed event is refused before the table is touched.
export async function handleCoachPick(
  table: DocClient,
  gateway: AnthropicGateway,
  raw: unknown,
  opts: { now?: () => number } = {},
): Promise<CoachPickRun> {
  const e = parseCoachPickEvent(raw);
  const run = await runCoachPick(
    {
      repo: new Repo(table, liveWrites(table), e.userId),
      anthropic: gateway,
      now: opts.now ?? Date.now,
    },
    e,
  );
  console.log(JSON.stringify({ event: 'coach_worker', run }));
  return run;
}

export async function handler(event: unknown): Promise<CoachPickRun> {
  return handleCoachPick(doc, anthropic, event);
>>>>>>> 9c7897bd (added ai pick backend worker)
}
