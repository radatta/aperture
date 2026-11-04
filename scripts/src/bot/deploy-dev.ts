// `pnpm bot deploy-dev` — put the current (pushed) feature commit on the dev stack.
// lock → dispatch deploy-dev.yml (on main, or on the branch when it changes .github/) with this sha → wait, renewing the lock while it waits. On success the
// lock is renewed once more and stays HELD for the devcheck; `pnpm bot lock release` frees it (TTL covers a
// crashed session). A run that finished unsuccessfully releases it; a timeout or API error leaves it to the TTL,
// since the run may still be deploying.
import type { Api } from './api.ts';
import type { Clock, Job, Run } from './dispatch.ts';
import { DispatchRejected, dispatchAndWait, listJobs, listRuns } from './dispatch.ts';
import { featureBranch, requirePushed, runKey } from './git.ts';
import { acquire, release, renew } from './lock.ts';
import type { Holder } from './lock.ts';
import type { Run as Sh } from './sh.ts';

export const deployTitle = (sha: string, key: string) => `deploy-dev ${sha} ${key}`;
const TITLE_RE = /^deploy-dev ([0-9a-f]{40}) \S+$/;

const PAGE = 10;

// The newest run of `workflow` whose dev-stack job decides what dev's infrastructure is. Skipped: runs whose dev
// job never ran (verify or check failed — GitHub then lists the call unexpanded, or not at all), and runs that
// `setsInfra` rejects. A dev job still running → 'busy'. A full page with no answer → 'busy' too: the decider is
// further back than we looked, and guessing "never ran" would understate the change.
async function lastDevJob(
  api: Api,
  workflow: string,
  query: string,
  jobPrefix: string,
  setsInfra: (job: Job) => boolean,
): Promise<{ run: Run; job: Job } | 'busy' | undefined> {
  const runs = await listRuns(api, workflow, `per_page=${PAGE}&${query}`);
  for (const run of runs) {
    // A run may carry several matching jobs (an old `dev` push run: deploy-dev or deploy-dev-fast) — take the one that ran.
    const job = (await listJobs(api, run.id)).find(
      (j) => j.name.startsWith(jobPrefix) && j.conclusion !== 'skipped',
    );
    if (!job) continue;
    if (job.status !== 'completed' || !job.completed_at) return 'busy';
    if (job.conclusion === 'success' && !setsInfra(job)) continue;
    return { run, job };
  }
  return runs.length >= PAGE ? 'busy' : undefined;
}

// A main deploy sets dev's infrastructure only when its `Deploy stacks` step ran: an app- or docs-only main
// merge leaves whatever infra a dispatch put there (its mode came from main's own diff, not from dev).
// A dispatch always counts — its mode was computed against what dev served, so dev's infra matches its sha.
const ranCdk = (job: Job) =>
  job.steps?.some((s) => s.name === 'Deploy stacks' && s.conclusion === 'success') ?? false;

// What dev serves now, so the workflow classifies the change against it. Judged by the dev-stack JOB (when it
// finished, how), not the run — a main run finishes with prod, long after dev. The newest deciding dev job wins:
// main's → '' (diff vs main); a dispatch's → its sha. Anything uncertain — a dev job still running, a failed one
// (a half-applied stack), history beyond the page, an unparsable title, an API error — is 'unknown' → full
// deploy: a wrong 'app' would leave another branch's infra on dev.
export async function currentBase(api: Api): Promise<string> {
  try {
    const [main, dispatched, devPush] = await Promise.all([
      lastDevJob(api, 'deploy.yml', 'event=push&branch=main', 'deploy-dev /', ranCdk),
      lastDevJob(api, 'deploy-dev.yml', 'event=workflow_dispatch', 'deploy /', () => true),
      // `dev` pushes: the path was retired at dev-cutover, but the admin bypass can still recreate the branch and every
      // older commit's deploy.yml deploys it. Whatever branch that was, its diff is unknown here — so a dev push
      // newer than both others means a full deploy.
      lastDevJob(api, 'deploy.yml', 'event=push&branch=dev', 'deploy-dev', () => true),
    ]);
    if (main === 'busy' || dispatched === 'busy' || devPush === 'busy') return 'unknown';
    const at = (d?: { job: Job }) => (d ? Date.parse(d.job.completed_at ?? '') : -Infinity);
    if (at(devPush) > Math.max(at(main), at(dispatched))) return 'unknown';
    const last = at(dispatched) > at(main) ? dispatched : main;
    if (!last) return '';
    if (last.job.conclusion !== 'success') return 'unknown';
    if (last === main) return '';
    return TITLE_RE.exec(last.run.display_title)?.[1] ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

const RENEW_BELOW_MS = 15 * 60_000;

export async function deployDev(
  sh: Sh,
  api: Api,
  clock: Clock,
  log: (s: string) => void = console.log,
  onLock: (h: Holder | null) => void = () => undefined, // each lock change (the board's lock cache)
): Promise<Run> {
  const branch = featureBranch(sh);
  const sha = requirePushed(sh, branch);
  sh('git', ['fetch', '-q', 'origin', 'main']);
  try {
    sh('git', ['merge-base', '--is-ancestor', 'origin/main', 'HEAD']);
  } catch {
    throw new Error(
      'HEAD is behind origin/main — rebase (read the merged PRs first), `pnpm bot push --after-rebase`, then deploy',
    );
  }
  // A branch that changes .github/ deploys on its own ref, so its workflows are what run on dev. The `dev` environment
  // admits only `main` and branches the user named (CI-BOT.md → Commands → workflow changes), so say so. Everything
  // else runs main's YAML.
  let ref = 'main';
  try {
    sh('git', ['diff', '--quiet', 'origin/main', 'HEAD', '--', '.github']);
  } catch {
    ref = branch;
    log(
      `${branch} changes .github/ — dispatching on ${branch}, so its own workflows run on dev. The \`dev\` environment must admit ${branch} by name first (docs/ops/CI-BOT.md → Commands → workflow changes), else its deploy job is refused.`,
    );
  }
  let holder = await acquire(api, branch, sha, clock.now());
  onLock(holder);
  log(`dev lock: ${branch} until ${holder.expiresAt}`);
  // Renewal starts with 15 minutes left, so a transient failure just retries on the next poll.
  const keepLock = async () => {
    if (Date.parse(holder.expiresAt) - clock.now() >= RENEW_BELOW_MS) return;
    try {
      holder = await renew(api, branch, clock.now());
      onLock(holder);
    } catch (err) {
      log(`dev lock renewal failed (${(err as Error).message}) — retrying on the next poll`);
    }
  };
  let run: Run;
  try {
    const base = await currentBase(api);
    run = await dispatchAndWait(api, clock, {
      workflow: 'deploy-dev.yml',
      ref,
      inputs: { sha, base },
      key: runKey(branch, clock.now()),
      title: (key) => deployTitle(sha, key),
      timeoutMs: 45 * 60_000,
      log,
      onPoll: keepLock,
    });
  } catch (err) {
    if (err instanceof DispatchRejected) {
      await release(api, branch).then(
        () => onLock(null),
        () => undefined,
      );
      throw new Error(`${err.message} — no run started; lock released`, { cause: err });
    }
    throw new Error(
      `${(err as Error).message} — dev lock left to expire at ${holder.expiresAt} (the run may still be deploying)`,
      { cause: err },
    );
  }
  if (run.conclusion !== 'success') {
    await release(api, branch).then(
      () => onLock(null),
      () => undefined,
    );
    throw new Error(`deploy-dev ${run.conclusion}: ${run.html_url} — lock released`);
  }
  try {
    holder = await renew(api, branch, clock.now()); // the devcheck gets a full TTL
    onLock(holder);
  } catch (err) {
    log(
      `warning: the deploy succeeded but the final lock renewal failed (${(err as Error).message}) — check \`pnpm bot lock status\``,
    );
  }
  log(
    `dev now serves ${sha} (build marker APERTURE_BUILD_SHA). Lock held until ${holder.expiresAt} — \`pnpm bot lock release\` after the devcheck, \`pnpm bot lock renew\` to extend.`,
  );
  return run;
}
