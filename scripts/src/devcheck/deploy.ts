// Waiting for dev to serve the commit under test. Two proofs, in order: the dispatched deploy for that SHA
// succeeded (gh), then the edge serves index.html with that SHA in its build marker (fetch, no service
// worker involved). A branch reaches dev only through `pnpm bot deploy-dev` (deploy-dev.yml) since dev-cutover. Its
// run is matched by its run name, `deploy-dev <sha> <key>`: a main-ref dispatch's headSha is main's, not the SHA.
import { slotOrigin } from './config';
import { DevcheckError } from './errors';

export interface DeployRun {
  databaseId: number;
  headSha: string;
  displayTitle: string;
  status: string; // queued | in_progress | completed
  conclusion: string; // success | failure | cancelled | '' while running
  url: string;
  createdAt: string;
}

export const RUN_FIELDS = 'databaseId,headSha,displayTitle,status,conclusion,url,createdAt';

// The newest dispatched run for `sha` (its title names the SHA).
export function pickDeployRun(runs: DeployRun[], sha: string): DeployRun | undefined {
  const forSha = runs.filter(
    (r) => r.displayTitle.split(/\s+/).slice(0, 2).join(' ') === `deploy-dev ${sha}`,
  );
  return forSha.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

export function parseMarker(html: string): string | undefined {
  return /<meta name="aperture-build" content="([^"]*)"/.exec(html)?.[1];
}

export interface DeployDeps {
  listRuns: () => Promise<DeployRun[]>; // gh run list over deploy-dev.yml
  fetchShell: () => Promise<string>; // GET the slot's origin / with no-store
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (msg: string) => void;
}

export interface DeployBudget {
  runMs: number; // a full deploy (cdk + publish) is ~10–15 min
  edgeMs: number;
  pollMs: number;
}
export const DEFAULT_BUDGET: DeployBudget = {
  runMs: 25 * 60_000,
  edgeMs: 3 * 60_000,
  pollMs: 15_000,
};

export async function waitForDeploy(
  sha: string,
  deps: DeployDeps,
  budget = DEFAULT_BUDGET,
): Promise<DeployRun> {
  const start = deps.now();
  let run: DeployRun | undefined;
  let ghErrors = 0;
  for (;;) {
    let runs: DeployRun[];
    try {
      runs = await deps.listRuns();
      ghErrors = 0;
    } catch (err) {
      // A gh hiccup mid-wait isn't a failed deploy; five in a row is a real problem.
      if (++ghErrors >= 5) throw err;
      deps.log(
        `gh failed (${ghErrors}/5), retrying: ${err instanceof Error ? err.message : String(err)}`,
      );
      await deps.sleep(budget.pollMs);
      continue;
    }
    run = pickDeployRun(runs, sha);
    if (run?.status === 'completed') break;
    // A run should exist within a minute of the dispatch; without one, waiting longer won't help.
    if (!run && deps.now() - start > 2 * 60_000) {
      const latest = runs[0];
      throw new DevcheckError(
        'DEPLOY_NOT_FOUND',
        `no dev deploy for ${sha.slice(0, 7)} (latest dispatch: ${latest?.displayTitle ?? 'none'}) — did \`pnpm bot deploy-dev\` run for it?`,
      );
    }
    if (deps.now() - start > budget.runMs)
      throw new DevcheckError(
        'DEPLOY_TIMEOUT',
        `deploy for ${sha.slice(0, 7)} still ${run?.status ?? 'missing'} — ${run?.url ?? ''}`,
      );
    deps.log(
      run ? `deploy ${run.status} — ${run.url}` : `waiting for a deploy run for ${sha.slice(0, 7)}`,
    );
    await deps.sleep(budget.pollMs);
  }
  if (run.conclusion !== 'success')
    throw new DevcheckError(
      'DEPLOY_FAILED',
      `deploy for ${sha.slice(0, 7)} ended ${run.conclusion} — ${run.url}`,
    );

  const edgeStart = deps.now();
  let fetchError = '';
  for (;;) {
    // A network blip is "not yet", like a stale shell; the edge budget still bounds it.
    const marker = parseMarker(
      await deps.fetchShell().then(
        (html) => ((fetchError = ''), html),
        (err: unknown) => ((fetchError = err instanceof Error ? err.message : String(err)), ''),
      ),
    );
    if (marker === sha) return run;
    if (deps.now() - edgeStart > budget.edgeMs)
      throw new DevcheckError(
        'DEPLOY_TIMEOUT',
        fetchError
          ? `${slotOrigin()} unreachable: ${fetchError}`
          : `${slotOrigin()} serves build ${marker ?? 'none'}, not ${sha.slice(0, 7)}`,
      );
    await deps.sleep(5_000);
  }
}
