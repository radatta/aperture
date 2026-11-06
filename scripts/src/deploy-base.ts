// @aperture/scripts — what a stage serves, so a main push is classified against that and not against the last push.
//
// deploy.yml used to diff github.event.before..sha and feed the one tier to both stages. That base is whatever main
// was, not what a stage runs: a failed prod deploy, or the older pending runs GitHub cancels when merges cluster, left
// a change no stage ever deployed outside the next run's diff. The next app-only merge then published a frontend
// against a backend that never got its half, and "Prod never moves backwards" refused the re-run.
//
// The answer comes from GitHub's deployment records for the stage's environment (`prod`; `dev-main` for main's dev
// lane). A run cancelled while pending never started its jobs, so it has no record; a job cancelled later leaves one
// that isn't a success. Walking newest → oldest:
//   failed or still running → unknown (possibly half-applied)
//   ran `Deploy stacks`     → infra = its sha, front = the newest publish seen so far or its sha; stop
//   ran only `Publish frontend` → front = its sha if none yet; go on
//   ran neither (docs-only) → never a base; go on
//   list exhausted, API error, a shape we can't read → unknown
// Unknown → full, always: a wrong `full` costs CI minutes, a wrong skip leaves a stage stale.
//
// Run: `node scripts/src/deploy-base.ts <environment> <head sha>` prints the tier on stdout, the reasoning on stderr,
// with GITHUB_TOKEN (deployments: read, actions: read) and GITHUB_REPOSITORY in the env. API trouble still prints a
// tier; only misuse exits non-zero. Same constraint as classify-changes: CI runs this with no install, so erasable
// syntax, and only node: builtins past the two relative modules below (`import type` is erased; bot/api.ts imports
// nothing).
import { execFileSync } from 'node:child_process';
import { makeApi, type Api } from './bot/api.ts';
import { classify, type Tier } from './classify-changes.ts';

export type Base = 'unknown' | { infra: string; front: string };
export type Diff = (from: string, to: string) => string[];

interface Status {
  state: string;
  log_url?: string;
}
interface JobSteps {
  steps?: { name: string; conclusion: string | null }[];
}

// Only the latest state decides, looking through `inactive`: GitHub lays that over a deployment it superseded.
export function outcome(statuses: Status[]): 'success' | 'failure' | 'running' {
  const latest = statuses.find((s) => s.state !== 'inactive')?.state;
  if (latest === 'failure' || latest === 'error') return 'failure';
  return latest === 'success' ? 'success' : 'running';
}

export const jobIdOf = (logUrl: string | undefined) => /\/job\/(\d+)/.exec(logUrl ?? '')?.[1];

// `none` needs both steps present and skipped, so a renamed step reads as unknown rather than as a docs-only run.
export function deployedTier(job: JobSteps): Tier | 'unknown' {
  const ran = (name: string) => job.steps?.find((s) => s.name === name)?.conclusion;
  const stacks = ran('Deploy stacks');
  const publish = ran('Publish frontend');
  if (stacks === 'success') return 'full';
  if (stacks === 'skipped' && publish === 'success') return 'app';
  if (stacks === 'skipped' && publish === 'skipped') return 'none';
  return 'unknown';
}

export async function servedBy(
  api: Api,
  repo: string,
  environment: string,
  log: (line: string) => void = () => undefined,
): Promise<Base> {
  const unknown = (why: string): Base => {
    log(`::warning::${environment}: unknown, so full — ${why}`); // an annotation: a walk that always fails shows up
    return 'unknown';
  };
  try {
    const list = await api<{ id: number; sha: string }[]>(
      'GET',
      `/repos/${repo}/deployments?environment=${environment}&per_page=100`,
    );
    let front: string | undefined;
    for (const { id, sha } of list) {
      const statuses = await api<Status[]>(
        'GET',
        `/repos/${repo}/deployments/${id}/statuses?per_page=20`,
      );
      const state = outcome(statuses);
      if (state !== 'success') return unknown(`deployment ${id} at ${sha} is ${state}`);
      const jobId = jobIdOf(statuses.find((s) => s.state === 'success')?.log_url);
      if (!jobId) return unknown(`deployment ${id} at ${sha} names no job`);
      const tier = deployedTier(await api<JobSteps>('GET', `/repos/${repo}/actions/jobs/${jobId}`));
      if (tier === 'unknown') return unknown(`job ${jobId} at ${sha} has unreadable steps`);
      log(`${environment}: ${sha} deployed ${tier}`);
      if (tier === 'app') front ??= sha;
      if (tier === 'full') return { infra: sha, front: front ?? sha };
    }
    return unknown(`no full deploy in the last ${list.length} deployments`);
  } catch (err) {
    return unknown((err as Error).message);
  }
}

// `infra` answers whether the backend must move, `front` whether the frontend must. Front is at or after infra, so
// its diff is the smaller one: a docs merge after an app merge is `none`, with no redundant publish. An empty diff
// (a re-run of what is already served) classifies as full.
export function modeFor(
  base: Base,
  head: string,
  diff: Diff,
  log: (line: string) => void = () => undefined,
): Tier {
  if (base === 'unknown') return 'full';
  try {
    if (classify(diff(base.infra, head)) === 'full') return 'full';
    return classify(diff(base.front, head));
  } catch (err) {
    log(`diff failed, so full — ${(err as Error).message}`);
    return 'full';
  }
}

// --no-renames lists both sides: a move out of lambdas/ into docs/ must still classify by where it came from.
export const gitDiff =
  (cwd?: string): Diff =>
  (from, to) =>
    execFileSync('git', ['diff', '--name-only', '--no-renames', from, to], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).split('\n');

// A hang or a slow walk must end in `full` like any other API trouble, not in the job being killed: two walks of
// WALK_MS fit well inside the jobs' 5-minute limits, and any one abort ends the walk.
const REQUEST_MS = 20_000;
const WALK_MS = 90_000;
export function withTimeout(
  fetchImpl: typeof fetch,
  requestMs = REQUEST_MS,
  walkMs = WALK_MS,
): typeof fetch {
  const walk = AbortSignal.timeout(walkMs);
  return (url, init) =>
    fetchImpl(url, { ...init, signal: AbortSignal.any([AbortSignal.timeout(requestMs), walk]) });
}

export interface Deps {
  argv: string[];
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
  diff: Diff;
  write: (mode: string) => void;
  log: (line: string) => void;
  requestMs?: number;
  walkMs?: number;
}

// Returns the exit code. Only misuse is non-zero; `write` runs once, with the tier and nothing else.
export async function run({ argv, env, fetchImpl, diff, write, log, requestMs, walkMs }: Deps) {
  const [environment, head] = argv;
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repo } = env;
  if (
    !environment ||
    !head ||
    !/^[a-z-]+$/.test(environment) ||
    !/^[0-9a-f]{40}$/.test(head) ||
    !token ||
    !repo
  ) {
    log(
      'usage: deploy-base.ts <environment> <40-hex head>, with GITHUB_TOKEN and GITHUB_REPOSITORY set',
    );
    return 1;
  }
  const api = makeApi(token, withTimeout(fetchImpl, requestMs, walkMs));
  const base = await servedBy(api, repo, environment, log);
  const mode = modeFor(base, head, diff, log);
  log(`${environment}: base ${JSON.stringify(base)} → ${mode}`);
  write(mode);
  return 0;
}

if (process.argv[1]?.endsWith('deploy-base.ts'))
  process.exitCode = await run({
    argv: process.argv.slice(2),
    env: process.env,
    fetchImpl: fetch,
    diff: gitDiff(),
    write: (mode) => process.stdout.write(mode),
    log: (line) => console.error(line),
  });
