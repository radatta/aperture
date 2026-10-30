// Read-only git questions every command asks first. `run` is injectable for tests.
import { PROTECTED } from './config.ts';
import type { Run } from './sh.ts';

// The current branch, refusing detached HEAD and the deploy branches.
export function featureBranch(run: Run): string {
  let branch: string;
  try {
    branch = run('git', ['symbolic-ref', '--short', '-q', 'HEAD']);
  } catch {
    throw new Error('detached HEAD — switch to a feature branch first');
  }
  if (!branch) throw new Error('detached HEAD — switch to a feature branch first');
  if (PROTECTED.has(branch))
    throw new Error(
      `refusing: \`${branch}\` is a deploy branch — the bot only works on feature branches`,
    );
  return branch;
}

export const headSha = (run: Run) => run('git', ['rev-parse', 'HEAD']);

// The branch's sha on GitHub right now ('' when it isn't pushed). ls-remote reads with the container's
// read-only credential — no bot token needed.
export function remoteSha(run: Run, branch: string): string {
  return run('git', ['ls-remote', 'origin', `refs/heads/${branch}`]).split(/\s+/)[0] ?? '';
}

export function requirePushed(run: Run, branch: string): string {
  const head = headSha(run);
  if (remoteSha(run, branch) !== head)
    throw new Error(
      `origin/${branch} is not at HEAD (${head.slice(0, 7)}) — run \`pnpm bot push\` first`,
    );
  return head;
}

// `<branch>-<base36 ms>`, safe for a run-name and an artifact name.
export const runKey = (branch: string, nowMs: number) =>
  `${branch.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 60)}-${nowMs.toString(36)}`;
