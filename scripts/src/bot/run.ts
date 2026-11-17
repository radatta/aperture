// `pnpm bot run cancel <run-id>` / `run rerun <run-id> [--failed]`: a lane cancels its own superseded PR check run, or
// reruns a flaky one, as the bot (Actions: write), instead of asking the user. Only a check run qualifies: the `PR`
// workflow by its file path on event pull_request, or the `Branch` workflow (the full suite on a pushed feature branch,
// INFRA §9) on event push — from this repo, on a feature branch. A deploy run, a main run, a fork's run or anything
// else is refused before any write (docs/ops/CI-BOT.md → Commands).
import type { Api } from './api.ts';
import { GitHubError } from './api.ts';
import { PROTECTED, REPO_SLUG } from './config.ts';

export const PR_WORKFLOW = '.github/workflows/pr.yml';
export const BRANCH_WORKFLOW = '.github/workflows/branch.yml';
// Each check workflow with the one event its runs may have.
const CHECK_RUNS: Record<string, string> = {
  [PR_WORKFLOW]: 'pull_request',
  [BRANCH_WORKFLOW]: 'push',
};
const RUN_ID_RE = /^[1-9][0-9]{0,19}$/;

export interface WorkflowRun {
  id: number;
  path?: string | null; // e.g. .github/workflows/pr.yml, sometimes with an @ref suffix
  event?: string | null;
  head_branch?: string | null;
  head_repository?: { full_name?: string | null } | null;
  status?: string | null;
  conclusion?: string | null;
  html_url?: string;
}

export class RunRefused extends Error {}

// Why this run isn't a lane's own check run, or null when it is.
export function refusal(r: WorkflowRun): string | null {
  const path = (r.path ?? '').split('@')[0]!;
  const event = Object.hasOwn(CHECK_RUNS, path) ? CHECK_RUNS[path] : undefined;
  if (!event) return `not a PR or Branch check run (workflow ${r.path ?? 'unknown'})`;
  if (r.event !== event) return `not a ${event} run (event ${r.event ?? 'unknown'})`;
  if (r.head_repository?.full_name !== REPO_SLUG)
    return `not from this repo (head ${r.head_repository?.full_name ?? 'unknown'})`;
  if (!r.head_branch || PROTECTED.has(r.head_branch))
    return `not a feature branch's run (branch ${r.head_branch ?? 'unknown'})`;
  return null;
}

export async function runCommand(
  api: Api,
  action: string | undefined,
  id: string | undefined,
  failedOnly: boolean,
  log: (s: string) => void,
): Promise<number> {
  if ((action !== 'cancel' && action !== 'rerun') || !id || !RUN_ID_RE.test(id))
    throw new RunRefused('usage: pnpm bot run cancel <run-id> | run rerun <run-id> [--failed]');
  if (action === 'cancel' && failedOnly) throw new RunRefused('--failed goes with rerun');
  const base = `/repos/${REPO_SLUG}/actions/runs/${id}`;
  let r: WorkflowRun;
  try {
    r = await api<WorkflowRun>('GET', base);
  } catch (err) {
    if (err instanceof GitHubError && err.status === 404)
      throw new RunRefused(`no run ${id} in ${REPO_SLUG}`);
    throw err;
  }
  const why = refusal(r);
  if (why)
    throw new RunRefused(
      `refused: run ${id} is ${why} — only a PR or Branch check run on a feature branch`,
    );
  const what = `run ${id} (${r.head_branch}, ${r.status}${r.conclusion ? `/${r.conclusion}` : ''})`;

  if (action === 'cancel') {
    if (r.status === 'completed') {
      log(`${what}: already finished, nothing to cancel`);
      return 0;
    }
    try {
      await api('POST', `${base}/cancel`);
    } catch (err) {
      if (err instanceof GitHubError && err.status === 409) {
        log(`${what}: finished before the cancel landed`);
        return 0;
      }
      throw err;
    }
    log(`cancelled ${what} ${r.html_url ?? ''}`.trim());
    return 0;
  }
  if (r.status !== 'completed')
    throw new RunRefused(`${what} is still going — wait for it, or cancel it first`);
  await api('POST', `${base}/${failedOnly ? 'rerun-failed-jobs' : 'rerun'}`);
  log(`rerunning ${failedOnly ? 'the failed jobs of ' : ''}${what} ${r.html_url ?? ''}`.trim());
  return 0;
}
