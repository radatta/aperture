// Is a main Deploy run still going to put main on this dev slot? deploy.yml's `wait-dev` / `wait-devb` jobs hold a
// merge's slot deploy while a lane's lock is live (docs/ops/CI-BOT.md → Dev deploys → A merge waits for the lock); this
// is the other half: a lane that doesn't already hold the slot is refused it while main is pending there, so it can't
// slip in between main's wait reading "free" and main's deploy landing (lock.ts → acquireSlot's `pending`).
//
// Pending for slot S: a deploy.yml push run on main that isn't completed, unless
//   - its `wait-<S>` job was skipped (main isn't deploying S: a docs-only `none`, or devb's shape didn't change), or
//   - its slot job (`deploy-<S> / …`, or the bare `deploy-<S>` GitHub lists for a skipped call) has completed —
//     main is done with S (prod may still be running).
// Anything else is pending, a run still queued in the concurrency group with no jobs listed yet included. A run from
// before the wait jobs has only the second rule. Errors propagate: the caller fails closed.
import type { Api } from './api.ts';
import { listJobs, listRuns } from './dispatch.ts';
import type { Job, Run } from './dispatch.ts';
import type { Slot } from './lock.ts';

const NEWEST = 10;

const doneWith = (jobs: Job[], slot: Slot) =>
  jobs.some(
    (j) =>
      (j.name === `wait-${slot}` && j.conclusion === 'skipped') ||
      ((j.name === `deploy-${slot}` || j.name.startsWith(`deploy-${slot} / `)) &&
        j.status === 'completed'),
  );

// The oldest pending run (the one that deploys first), or null.
export async function pendingMainDeploy(api: Api, slot: Slot): Promise<Run | null> {
  const runs = await listRuns(api, 'deploy.yml', `per_page=${NEWEST}&event=push&branch=main`);
  let found: Run | null = null;
  for (const run of runs) {
    if (run.status === 'completed') continue;
    if (!doneWith(await listJobs(api, run.id), slot)) found = run; // newest first: the last hit is the oldest
  }
  return found;
}

// acquireSlot's guard: the pending run's URL, or null.
export const mainPendingGuard = (api: Api) => async (slot: Slot) =>
  (await pendingMainDeploy(api, slot))?.html_url ?? null;
