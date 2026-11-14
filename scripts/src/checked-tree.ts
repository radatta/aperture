// @aperture/scripts — whether a main push's tree was already checked, so deploy.yml can skip its own check run.
//
// A PR run tests refs/pull/N/merge. When main didn't move between that run and the squash-merge, the squash commit's
// tree is byte-identical to the tree the PR run tested — same code, same workflow files — so checking it again only
// bills minutes. ci.yml's `check` job prints that tree as a `tested-tree` notice (an inline YAML line, not a repo
// script, so the emitter is in the CODEOWNERS-reviewed workflow); this module finds it and compares. Batched merges
// never match: the combined tree was never tested, so it is checked. Every doubt is `check`:
//   the PR that introduced the commit           exactly one (merged with merge_commit_sha = sha; or, for the dispatch
//                                                preview, open with head.sha = sha)
//   its check runs on the PR head               by the github-actions app only — never the bot, never another app
//   the newest suite holding every REQUIRED_CHECKS name, each completed + success (newest attempt per name)
//   that suite's run                            pr.yml, pull_request, success, head_sha = the PR head
//   ci / check's annotations                    exactly one `tested-tree` notice on ci.yml, equal to this tree
//   ci / check's steps                          the secret scan success; the fixture suite decides the plan:
//                                                success → skip, skipped (the PR's paths didn't reach it) → fixtures
// `fixtures` runs the fixture suite alone on main: it is what catches a dependency or runner-image break the PR's
// paths can't show (ci.yml → Mailroom fixture inputs), and the PR run skipped it.
//
// Run: `node scripts/src/checked-tree.ts <40-hex sha>` prints skip | fixtures | check on stdout, the reasoning on
// stderr, with GITHUB_TOKEN (pull-requests: read, checks: read, actions: read) and GITHUB_REPOSITORY in the env. API
// trouble prints `check` with a ::warning; only misuse exits non-zero. Same constraint as deploy-base.ts: CI runs this
// with no install, so erasable syntax, and only node: builtins past the relative modules.
import { execFileSync } from 'node:child_process';
import { makeApi, type Api } from './bot/api.ts';
import { jobIdOf, withTimeout } from './deploy-base.ts';

export type Plan = 'skip' | 'fixtures' | 'check';

export const TRUSTED_APP = 'github-actions';
export const PR_WORKFLOW = '.github/workflows/pr.yml';
// The ruleset's required Actions checks (INFRA §9 — a test pins both lists to ci.yml and the doc).
export const REQUIRED_CHECKS = ['ci / check', 'ci / test-app-1', 'ci / test-app-2'];
export const CHECK_JOB = 'ci / check';
export const FIXTURE_STEP = 'Mailroom fixture suite'; // ci.yml step names; a test pins them
export const SCAN_STEP = 'Secret scan';
export const TREE_TITLE = 'tested-tree';
export const TREE_PATH = '.github/workflows/ci.yml';
const MAX_PAGES = 5;
const HEX = /^[0-9a-f]{40}$/;

interface Pull {
  number: number;
  state: string;
  merged_at: string | null;
  merge_commit_sha: string | null;
  head: { sha: string };
}
export interface CheckRun {
  id: number;
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  details_url?: string;
  app?: { slug?: string } | null;
  check_suite?: { id: number } | null;
}
interface WorkflowRun {
  path?: string;
  event?: string;
  conclusion?: string | null;
  head_sha?: string;
}
interface Annotation {
  path?: string;
  title?: string | null;
  annotation_level?: string;
  message?: string;
}
interface Job {
  conclusion?: string | null;
  steps?: { name: string; conclusion: string | null }[];
}

export const runIdOf = (detailsUrl: string | undefined) =>
  /\/actions\/runs\/(\d+)\//.exec(detailsUrl ?? '')?.[1];

export const treeOf = (sha: string, cwd?: string) =>
  execFileSync('git', ['rev-parse', '--verify', `${sha}^{tree}`], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

// The PR head's green suite: within a suite the newest check run per name (a re-run adds newer runs to the same
// suite), and only the newest suite holding any required name may answer.
export function greenSuite(runs: CheckRun[], head: string): Map<string, CheckRun> | undefined {
  const suites = new Map<number, Map<string, CheckRun>>();
  for (const r of runs) {
    if (r.app?.slug !== TRUSTED_APP || r.head_sha !== head || r.check_suite?.id === undefined)
      continue;
    const byName = suites.get(r.check_suite.id) ?? new Map<string, CheckRun>();
    const seen = byName.get(r.name);
    if (!seen || r.id > seen.id) byName.set(r.name, r);
    suites.set(r.check_suite.id, byName);
  }
  // The newest suite with any required check decides: one still missing a name (jobs not created yet) is no
  // answer, never a reason to fall back to an older green suite.
  const full = [...suites.entries()]
    .filter(([, byName]) => REQUIRED_CHECKS.some((n) => byName.has(n)))
    .sort(([a], [b]) => b - a)[0]?.[1];
  if (!full || !REQUIRED_CHECKS.every((n) => full.has(n))) return undefined;
  const green = REQUIRED_CHECKS.every((n) => {
    const r = full.get(n);
    return r?.status === 'completed' && r.conclusion === 'success';
  });
  return green ? full : undefined;
}

export async function plan(
  api: Api,
  repo: string,
  sha: string,
  tree: string,
  log: (line: string) => void = () => undefined,
): Promise<{ plan: Plan; why: string }> {
  const check = (why: string) => ({ plan: 'check' as const, why });
  try {
    if (!HEX.test(tree)) return check(`tree of ${sha} unreadable`);
    const pulls = await api<Pull[]>('GET', `/repos/${repo}/commits/${sha}/pulls?per_page=100`);
    const prs = pulls.filter(
      (p) =>
        (p.merged_at && p.merge_commit_sha === sha) || (p.state === 'open' && p.head.sha === sha),
    );
    if (prs.length !== 1) return check(`${prs.length} pull requests own ${sha}`);
    const pr = prs[0]!;
    const head = pr.head.sha;
    log(`PR ${pr.number} (${pr.merged_at ? 'merged' : 'open'}), head ${head}`);

    const runs: CheckRun[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { check_runs } = await api<{ check_runs: CheckRun[] }>(
        'GET',
        `/repos/${repo}/commits/${head}/check-runs?filter=all&per_page=100&page=${page}`,
      );
      runs.push(...check_runs);
      if (check_runs.length < 100) break;
      if (page === MAX_PAGES) return check(`more than ${MAX_PAGES * 100} check runs on ${head}`);
    }
    const suite = greenSuite(runs, head);
    if (!suite)
      return check(`no green ${REQUIRED_CHECKS.join(' + ')} by ${TRUSTED_APP} on ${head}`);

    const checkRun = suite.get(CHECK_JOB)!;
    const runId = runIdOf(checkRun.details_url);
    const jobId = jobIdOf(checkRun.details_url);
    if (!runId || jobId !== String(checkRun.id)) return check(`${CHECK_JOB} names no run/job`);
    const run = await api<WorkflowRun>('GET', `/repos/${repo}/actions/runs/${runId}`);
    if (
      run.path !== PR_WORKFLOW ||
      run.event !== 'pull_request' ||
      run.conclusion !== 'success' ||
      run.head_sha !== head
    )
      return check(
        `run ${runId} is ${run.path} on ${run.event} (${run.conclusion}), not a green PR run`,
      );

    const notes = (
      await api<Annotation[]>('GET', `/repos/${repo}/check-runs/${jobId}/annotations?per_page=100`)
    ).filter((a) => a.title === TREE_TITLE);
    if (notes.length !== 1) return check(`${notes.length} ${TREE_TITLE} notices on job ${jobId}`);
    const [note] = notes;
    if (
      note!.path !== TREE_PATH ||
      note!.annotation_level !== 'notice' ||
      !HEX.test(note!.message ?? '')
    )
      return check(`job ${jobId}'s ${TREE_TITLE} notice is malformed`);
    if (note!.message !== tree)
      return check(`tree differs: PR run tested ${note!.message}, ${sha} has ${tree}`);

    const job = await api<Job>('GET', `/repos/${repo}/actions/jobs/${jobId}`);
    const step = (name: string) => job.steps?.find((s) => s.name === name)?.conclusion;
    if (job.conclusion !== 'success') return check(`job ${jobId} is ${job.conclusion}`);
    if (step(SCAN_STEP) !== 'success')
      return check(`job ${jobId}'s ${SCAN_STEP} is ${step(SCAN_STEP)}`);
    const fixtures = step(FIXTURE_STEP);
    if (fixtures === 'success') return { plan: 'skip', why: `run ${runId} checked tree ${tree}` };
    if (fixtures === 'skipped')
      return {
        plan: 'fixtures',
        why: `run ${runId} checked tree ${tree}, without the fixture suite`,
      };
    return check(`job ${jobId}'s ${FIXTURE_STEP} is ${fixtures}`);
  } catch (err) {
    log(`::warning::tree lookup failed, so check — ${(err as Error).message}`);
    return check((err as Error).message);
  }
}

export interface Deps {
  argv: string[];
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
  tree: (sha: string) => string;
  write: (plan: string) => void;
  log: (line: string) => void;
  requestMs?: number;
  walkMs?: number;
}

// Returns the exit code. Only misuse is non-zero; `write` runs once, with the plan and nothing else.
export async function run({ argv, env, fetchImpl, tree, write, log, requestMs, walkMs }: Deps) {
  const [sha] = argv;
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repo } = env;
  if (!sha || !HEX.test(sha) || argv.length !== 1 || !token || !repo) {
    log('usage: checked-tree.ts <40-hex sha>, with GITHUB_TOKEN and GITHUB_REPOSITORY set');
    return 1;
  }
  let t = '';
  try {
    t = tree(sha);
  } catch (err) {
    log(`::warning::git rev-parse failed — ${(err as Error).message}`);
  }
  const api = makeApi(token, withTimeout(fetchImpl, requestMs, walkMs));
  const result = await plan(api, repo, sha, t, log);
  log(`Check plan: ${result.plan} — ${result.why}`);
  write(result.plan);
  return 0;
}

if (process.argv[1]?.endsWith('checked-tree.ts'))
  process.exitCode = await run({
    argv: process.argv.slice(2),
    env: process.env,
    fetchImpl: fetch,
    tree: (sha) => treeOf(sha),
    write: (p) => process.stdout.write(p),
    log: (line) => console.error(line),
  });
