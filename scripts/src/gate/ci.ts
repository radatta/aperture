// @aperture/scripts — `pnpm gate:ci [--wait] [--sha <sha>]` (docs/ops/GATE.md): the full suite's verdict on GitHub
// for this branch's head, which the all-clear needs (docs/ops/FEATURE-WORKFLOW.md → phase 9). The PR run when the
// branch has a PR (it tests the merge with main, and it's the required check), else the Branch workflow's push run.
// Read-only, through the container's `gh` (no bot token). Plain `node`: erasable syntax, node: builtins only.
import { fileURLToPath } from 'node:url';
import { run as execRun, type Run } from '../bot/sh.ts';

export const USAGE = `pnpm gate:ci [--wait] [--sha <sha>] [--timeout <s>]
  the GitHub CI verdict for <sha> (default HEAD): the PR run if there is one, else the Branch push run.
  --wait     poll every 30 s until it finishes (default timeout 1500 s)
  Exit: 0 green · 1 red, cancelled or failed (names the jobs) · 75 still running, or no run yet (not pushed?)
        · 2 a bad argument, or git/gh failed (no verdict; --wait retries gh until its timeout)`;

export interface GhRun {
  databaseId: number;
  workflowName: string;
  event: string;
  status: string;
  conclusion: string;
  createdAt: string;
  url: string;
}

// The run that speaks for this sha: the newest PR run, else the newest Branch run.
export function pick(runs: GhRun[]): GhRun | undefined {
  const newest = (rs: GhRun[]) => [...rs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return (
    newest(runs.filter((r) => r.workflowName === 'PR' && r.event === 'pull_request')) ??
    newest(runs.filter((r) => r.workflowName === 'Branch' && r.event === 'push'))
  );
}

export interface Verdict {
  code: 0 | 1 | 75;
  line: string;
}

export function verdict(sha: string, r: GhRun | undefined, failedJobs: string[] = []): Verdict {
  const short = sha.slice(0, 8);
  if (!r)
    return {
      code: 75,
      line: `${short}: no PR or Branch run yet (pushed? GitHub can take ~10 s to start one)`,
    };
  const what = `${r.workflowName} run ${r.databaseId} on ${short}`;
  if (r.status !== 'completed') return { code: 75, line: `${what}: ${r.status} — ${r.url}` };
  if (r.conclusion === 'success') return { code: 0, line: `${what}: green — ${r.url}` };
  const jobs = failedJobs.length ? ` (${failedJobs.join(', ')})` : '';
  return { code: 1, line: `${what}: ${r.conclusion}${jobs} — ${r.url}` };
}

const FIELDS = 'databaseId,workflowName,event,status,conclusion,createdAt,url';

export function check(run: Run, sha: string): Verdict {
  const runs = JSON.parse(
    run('gh', ['run', 'list', '--commit', sha, '--limit', '20', '--json', FIELDS]),
  ) as GhRun[];
  const r = pick(runs);
  let failed: string[] = [];
  if (r?.status === 'completed' && r.conclusion !== 'success') {
    const jobs = JSON.parse(run('gh', ['run', 'view', String(r.databaseId), '--json', 'jobs'])) as {
      jobs: { name: string; conclusion: string }[];
    };
    failed = jobs.jobs
      .filter((j) => j.conclusion && j.conclusion !== 'success' && j.conclusion !== 'skipped')
      .map((j) => j.name);
  }
  return verdict(sha, r, failed);
}

export async function main(
  argv: string[],
  run: Run = execRun,
  sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
  log = console.log,
): Promise<number> {
  if (argv.some((a) => a === '-h' || a === '--help')) return (log(USAGE), 0);
  let wait = false;
  let sha = '';
  let timeoutSec = 1500;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--wait') wait = true;
    else if (a === '--sha' && /^[0-9a-f]{7,40}$/.test(argv[i + 1] ?? '')) sha = argv[++i]!;
    else if (a === '--timeout' && /^[1-9][0-9]*$/.test(argv[i + 1] ?? ''))
      timeoutSec = Number(argv[++i]);
    else return (log(`unknown argument ${JSON.stringify(a)}\n${USAGE}`), 2);
  }
  const msg = (err: unknown) => (err as Error).message.split('\n')[0];
  try {
    // The full sha: `gh run list --commit` matches the whole sha, so an abbreviation would find no run.
    sha = run('git', ['rev-parse', '--verify', `${sha || 'HEAD'}^{commit}`]);
  } catch (err) {
    return (log(`gate:ci — not a commit here: ${msg(err)}`), 2);
  }
  for (let waited = 0; ; waited += 30) {
    let v: Verdict | undefined;
    try {
      v = check(run, sha);
    } catch (err) {
      // gh down or unauthenticated is no verdict, never red.
      if (!wait || waited >= timeoutSec) return (log(`gate:ci — gh failed: ${msg(err)}`), 2);
      log(`gate:ci — gh failed (${msg(err)}): retrying in 30 s`);
    }
    if (v && (v.code !== 75 || !wait || waited >= timeoutSec)) return (log(v.line), v.code);
    await sleep(30_000);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main(process.argv.slice(2)).then((c) => process.exit(c));
