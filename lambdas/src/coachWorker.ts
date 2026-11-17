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
}
