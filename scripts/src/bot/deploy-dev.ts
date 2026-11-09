// `pnpm bot deploy-dev` — put the current (pushed) feature commit on a dev stack: slot A (`dev`) or slot B (`devb`),
// whichever lock it holds or takes (lock.ts → acquireSlot). The lock's slot is the only thing that picks the stack.
// lock → dispatch deploy-dev.yml (on main, or on the branch when it changes .github/) with this sha → wait, renewing the lock while it waits. On success the
// lock is renewed once more and stays HELD for the devcheck; `pnpm bot lock release` frees it (TTL covers a
// crashed session). A run that finished unsuccessfully releases it; a timeout or API error leaves it to the TTL,
// since the run may still be deploying.
import type { Api } from './api.ts';
import type { Clock, Job, Run } from './dispatch.ts';
import { DispatchRejected, dispatchAndWait, listJobs, listRuns } from './dispatch.ts';
import { featureBranch, requirePushed, runKey } from './git.ts';
import { acquireSlot, release, renew } from './lock.ts';
import type { Holder, Slot } from './lock.ts';
import type { Run as Sh } from './sh.ts';

export const deployTitle = (sha: string, key: string) => `deploy-dev ${sha} ${key}`;
const TITLE_RE = /^deploy-dev ([0-9a-f]{40}) \S+$/;

const PAGE = 10;

// The newest run of `workflow` whose dev-stack job decides what dev's infrastructure is. Skipped: runs whose dev
// job never ran (verify or check failed — GitHub then lists the call unexpanded, or not at all; or the run was the
// other slot's), and runs that `setsInfra` rejects. A dev job still running → 'busy'. MAX_PAGES full pages with no
// answer → 'busy' too: the decider is further back than we looked, and guessing "never ran" would understate the
// change. Paged, since a slot's runs interleave with the other slot's (a devb dispatch can sit behind ten dev ones).
const MAX_PAGES = 5;
async function lastDevJob(
  api: Api,
  workflow: string,
  query: string,
  jobPrefix: string,
  setsInfra: (job: Job) => boolean,
): Promise<{ run: Run; job: Job } | 'busy' | undefined> {
  for (let page = 1; page <= MAX_PAGES; page++) {
    const runs = await listRuns(api, workflow, `per_page=${PAGE}&page=${page}&${query}`);
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
    if (runs.length < PAGE) return undefined;
  }
  return 'busy';
}

// A main deploy sets dev's infrastructure only when its `Deploy stacks` step ran: an app- or docs-only main
// merge leaves whatever infra a dispatch put there (its mode came from main's own lane, not from dev's dispatches).
// A dispatch always counts — its mode was computed against what dev served, so dev's infra matches its sha.
const ranCdk = (job: Job) =>
  job.steps?.some((s) => s.name === 'Deploy stacks' && s.conclusion === 'success') ?? false;

// The jobs that put code on each slot: main's lane (deploy.yml) and a dispatch (deploy-dev.yml). The names are a
// contract with those workflows; slot B's dispatch job is `deploy-b`, its main job `deploy-devb`.
const JOBS: Record<Slot, { main: string; dispatched: string }> = {
  dev: { main: 'deploy-dev /', dispatched: 'deploy /' },
  devb: { main: 'deploy-devb /', dispatched: 'deploy-b /' },
};

// What dev serves now, so the workflow classifies the change against it. Judged by the dev-stack JOB (when it
// finished, how), not the run — a main run finishes with prod, long after dev. The newest deciding dev job wins:
// main's → '' (diff vs main); a dispatch's → its sha. Anything uncertain — a dev job still running, a failed one
// (a half-applied stack), history beyond the page, an unparsable title, an API error — is 'unknown' → full
// deploy: a wrong 'app' would leave another branch's infra on dev.
// Slot B differs in two ways: main's lane deploys it only on a shape change (in full), so a main job's base is the sha
// it deployed (head_sha), not '' (main's head — devb's code may be older); and a slot B with no deploy at all is
// 'unknown' (its first dispatch creates it in full). No `dev` branch push ever deployed devb.
export async function currentBase(api: Api, slot: Slot = 'dev'): Promise<string> {
  try {
    const jobs = JOBS[slot];
    const [main, dispatched, devPush] = await Promise.all([
      lastDevJob(api, 'deploy.yml', 'event=push&branch=main', jobs.main, ranCdk),
      lastDevJob(api, 'deploy-dev.yml', 'event=workflow_dispatch', jobs.dispatched, () => true),
      // `dev` pushes: the path was retired at dev-cutover, but the admin bypass can still recreate the branch and every
      // older commit's deploy.yml deploys it. Whatever branch that was, its diff is unknown here — so a dev push
      // newer than both others means a full deploy.
      slot === 'dev'
        ? lastDevJob(api, 'deploy.yml', 'event=push&branch=dev', 'deploy-dev', () => true)
        : undefined,
    ]);
    if (main === 'busy' || dispatched === 'busy' || devPush === 'busy') return 'unknown';
    const at = (d?: { job: Job }) => (d ? Date.parse(d.job.completed_at ?? '') : -Infinity);
    if (at(devPush) > Math.max(at(main), at(dispatched))) return 'unknown';
    const last = at(dispatched) > at(main) ? dispatched : main;
    if (!last) return slot === 'dev' ? '' : 'unknown';
    if (last.job.conclusion !== 'success') return 'unknown';
    if (last === main) return slot === 'dev' ? '' : (last.run.head_sha ?? 'unknown');
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
  onLock: (h: Holder | null, slot: Slot) => void = () => undefined, // each lock change (the board's lock cache)
  only?: Slot, // `lock acquire --slot` already chose; deploy-dev itself never takes a flag
): Promise<Run> {
  let slot: Slot = only ?? 'dev';
  // Best effort: a cache that can't be written never changes what the deploy reports.
  const lockChanged = (h: Holder | null) => {
    try {
      onLock(h, slot);
    } catch {
      // the board is advisory
    }
  };
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
  const took = await acquireSlot(api, branch, sha, clock.now(), only);
  slot = took.slot;
  let holder = took.holder;
  lockChanged(holder);
  log(`${slot} lock: ${branch} until ${holder.expiresAt}`);
  // Renewal starts with 15 minutes left, so a transient failure just retries on the next poll.
  const keepLock = async () => {
    if (Date.parse(holder.expiresAt) - clock.now() >= RENEW_BELOW_MS) return;
    try {
      holder = await renew(api, branch, clock.now(), slot);
      lockChanged(holder);
    } catch (err) {
      log(`${slot} lock renewal failed (${(err as Error).message}) — retrying on the next poll`);
    }
  };
  let run: Run;
  try {
    const base = await currentBase(api, slot);
    run = await dispatchAndWait(api, clock, {
      workflow: 'deploy-dev.yml',
      ref,
      // Slot A sends no `slot` (the workflow's default), so a main YAML from before slot B still accepts the dispatch.
      inputs: slot === 'dev' ? { sha, base } : { sha, base, slot },
      key: runKey(branch, clock.now()),
      title: (key) => deployTitle(sha, key),
      timeoutMs: 45 * 60_000,
      log,
      onPoll: keepLock,
    });
  } catch (err) {
    if (err instanceof DispatchRejected) {
      await release(api, branch, slot).then(
        () => lockChanged(null),
        () => undefined,
      );
      throw new Error(`${err.message} — no run started; lock released`, { cause: err });
    }
    throw new Error(
      `${(err as Error).message} — ${slot} lock left to expire at ${holder.expiresAt} (the run may still be deploying)`,
      { cause: err },
    );
  }
  if (run.conclusion !== 'success') {
    await release(api, branch, slot).then(
      () => lockChanged(null),
      () => undefined,
    );
    throw new Error(`deploy-dev ${run.conclusion}: ${run.html_url} — lock released`);
  }
  try {
    holder = await renew(api, branch, clock.now(), slot); // the devcheck gets a full TTL
    lockChanged(holder);
  } catch (err) {
    log(
      `warning: the deploy succeeded but the final lock renewal failed (${(err as Error).message}) — check \`pnpm bot lock status\``,
    );
  }
  log(
    `${slot} now serves ${sha} (build marker APERTURE_BUILD_SHA). Lock held until ${holder.expiresAt} — \`pnpm bot lock release\` after the devcheck, \`pnpm bot lock renew\` to extend; \`pnpm devcheck\` aims at ${slot} because this branch holds its lock.`,
  );
  return run;
}
