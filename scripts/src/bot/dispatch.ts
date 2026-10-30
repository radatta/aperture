// Dispatch a workflow (on main, or a branch ref) and wait for it. The dispatch call returns no run id, so the run is found by its
// exact run-name (display_title) among dispatch runs created since — the same title dev-e2e's devcheck matches
// (`deploy-dev <sha> <key>`; docs/ops/CI-BOT.md → Run-name contract).
import type { Api } from './api.ts';
import { OWNER, REPO } from './config.ts';

const R = `/repos/${OWNER}/${REPO}`;

export interface Run {
  id: number;
  display_title: string;
  created_at: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  head_sha?: string;
  updated_at?: string;
}

export interface Clock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface DispatchOptions {
  workflow: string; // file name, e.g. deploy-dev.yml
  ref?: string; // branch the run's YAML comes from; default main
  inputs: Record<string, string>; // everything but `key`, which is added per attempt
  key: string;
  title: (key: string) => string; // the workflow's run-name for that key
  timeoutMs: number;
  log?: (s: string) => void;
  onPoll?: () => Promise<void>; // between polls — deploy-dev renews its lock here
}

async function findRun(
  api: Api,
  workflow: string,
  title: string,
  ref: string,
  sinceMs: number,
): Promise<Run | undefined> {
  const res = await api<{ workflow_runs: Run[] }>(
    'GET',
    `${R}/actions/workflows/${workflow}/runs?event=workflow_dispatch&branch=${encodeURIComponent(ref)}&per_page=30`,
  );
  return res.workflow_runs.find(
    (r) => r.display_title === title && Date.parse(r.created_at) >= sinceMs,
  );
}

async function dispatchOnce(api: Api, clock: Clock, o: DispatchOptions, key: string): Promise<Run> {
  const log = o.log ?? console.log;
  const title = o.title(key);
  const since = clock.now() - 60_000; // GitHub's created_at vs our clock: allow a minute of skew
  try {
    await api('POST', `${R}/actions/workflows/${o.workflow}/dispatches`, {
      ref: o.ref ?? 'main',
      inputs: { ...o.inputs, key },
    });
  } catch (err) {
    throw new DispatchRejected(`dispatch refused: ${(err as Error).message}`, { cause: err });
  }
  const deadline = clock.now() + o.timeoutMs;
  let wait = 5000;
  let run: Run | undefined;
  while (clock.now() < deadline) {
    await clock.sleep(wait);
    wait = Math.min(wait * 2, 30_000);
    await o.onPoll?.();
    if (!run) {
      run = await findRun(api, o.workflow, title, o.ref ?? 'main', since);
      if (run) log(`run: ${run.html_url}`);
      continue;
    }
    run = await api<Run>('GET', `${R}/actions/runs/${run.id}`);
    if (run.status === 'completed') return run;
  }
  throw new Error(
    `${o.workflow} "${title}" ${run ? `still ${run.status} at ${run.html_url}` : 'never appeared'} after ${Math.round(o.timeoutMs / 60_000)} min`,
  );
}

// `cancelled` is retried once: GitHub evicts a pending run when another queues on the same concurrency group
// (e.g. a main merge). The retry gets its own key, so every run-name stays unique. Anything else is the
// caller's to report.
export async function dispatchAndWait(api: Api, clock: Clock, o: DispatchOptions): Promise<Run> {
  const run = await dispatchOnce(api, clock, o, o.key);
  if (run.conclusion !== 'cancelled') return run;
  (o.log ?? console.log)('run was cancelled — dispatching once more');
  return dispatchOnce(api, clock, o, `${o.key}-r`);
}

export interface Job {
  name: string;
  status: string;
  conclusion: string | null;
  completed_at: string | null;
  steps?: { name: string; conclusion: string | null }[];
}

// The dispatch itself was refused (bad input, no permission) — no run exists, so nothing is deploying.
export class DispatchRejected extends Error {}

export const listRuns = async (api: Api, workflow: string, query: string) =>
  (await api<{ workflow_runs: Run[] }>('GET', `${R}/actions/workflows/${workflow}/runs?${query}`))
    .workflow_runs;

export const listJobs = async (api: Api, runId: number) =>
  (await api<{ jobs: Job[] }>('GET', `${R}/actions/runs/${runId}/jobs?per_page=50`)).jobs;
