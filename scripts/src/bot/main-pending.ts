// Is a main Deploy run still going to put main on this dev slot? deploy.yml's `wait-dev` / `wait-devb` jobs hold a
// merge's slot deploy while a lane's lock is live (docs/ops/CI-BOT.md → Dev deploys → A merge waits for the lock); this
// is the other half: a lane that doesn't already hold the slot is refused it while main is pending there, so it can't
// slip in between main's wait reading "free" and main's deploy landing (lock.ts → acquireSlot's `pending`).
//
// Pending for slot S: a deploy.yml push run on main, not completed, whose `wait-<S>` job has started (in progress, or
// completed other than skipped) and whose slot job (`deploy-<S> / …`, or the bare `deploy-<S>` GitHub lists for a
// skipped call) hasn't completed. A wait not started yet reads the lock after any lock written now, so it needs no
// refusal: main then waits for that lane (at most one holder's turn), and a run queued behind another, or one whose
// wait is skipped (a docs-only `none`, devb's shape unchanged), never holds a slot up. A run from before the wait jobs
// (no `wait-` job once its slot job is listed) is pending while that job runs. Errors propagate: the caller fails closed.
import type { Api } from './api.ts';
import { listJobs, listRuns } from './dispatch.ts';
import type { Job, Run } from './dispatch.ts';
import type { Slot } from './lock.ts';

const NEWEST = 10;

export function pendingOn(jobs: Job[], slot: Slot): boolean {
  const deploys = jobs.filter(
    (j) => j.name === `deploy-${slot}` || j.name.startsWith(`deploy-${slot} / `),
  );
  if (deploys.some((j) => j.status === 'completed')) return false;
  const wait = jobs.find((j) => j.name === `wait-${slot}`);
  if (wait)
    return wait.status === 'completed'
      ? wait.conclusion !== 'skipped'
      : wait.status === 'in_progress';
  return !jobs.some((j) => j.name.startsWith('wait-')) && deploys.length > 0;
}

// The oldest pending run (the one that deploys first), or null.
export async function pendingMainDeploy(api: Api, slot: Slot): Promise<Run | null> {
  const runs = await listRuns(api, 'deploy.yml', `per_page=${NEWEST}&event=push&branch=main`);
  let found: Run | null = null;
  for (const run of runs) {
    if (run.status === 'completed') continue;
    if (pendingOn(await listJobs(api, run.id), slot)) found = run; // newest first: the last hit is the oldest
  }
  return found;
}

// Main's run is still to put its commit on this slot at all — queued, checking, waiting or deploying (wider than
// pending: a run whose wait hasn't started holds nothing up, but it hasn't landed either). currentBase reads it: while
// one is in flight, `origin/main` isn't what the slot serves, so a dispatch must not diff against it.
export const inFlightOn = (jobs: Job[], slot: Slot) =>
  !jobs.some(
    (j) =>
      (j.name === `deploy-${slot}` || j.name.startsWith(`deploy-${slot} / `)) &&
      j.status === 'completed',
  );

export async function mainInFlight(api: Api, slot: Slot): Promise<boolean> {
  const runs = await listRuns(api, 'deploy.yml', `per_page=${NEWEST}&event=push&branch=main`);
  for (const run of runs)
    if (run.status !== 'completed' && inFlightOn(await listJobs(api, run.id), slot)) return true;
  return false;
}

// acquireSlot's guard: the pending run's URL, or null.
export const mainPendingGuard = (api: Api) => async (slot: Slot) =>
  (await pendingMainDeploy(api, slot))?.html_url ?? null;
