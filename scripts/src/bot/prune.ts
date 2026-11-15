// `pnpm bot prune-branches [--dry-run]`: the end-of-wave branch cleanup, in the container. A squash merge leaves the
// local branch behind and makes `git branch -d` refuse, so the user used to run `git branch -D` per branch. This deletes a
// local branch only when its PR is merged and the local tip is exactly that PR's head: nothing unpushed or unmerged can
// go. It reads PRs with the container's read-only gh, never the bot token, and deletes with a compare-and-delete
// (`git update-ref -d <ref> <tip>`), so a tip that moves meanwhile is refused. Everything else is kept, with the
// reason (docs/ops/CI-BOT.md → Commands; CLAUDE.md → the one sanctioned branch delete).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROTECTED } from './config.ts';
import type { Run } from './sh.ts';

export type Read = (path: string) => string | null; // null when missing
const readFs: Read = (p) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

interface Pr {
  number: number;
  state: string; // OPEN | CLOSED | MERGED
  headRefName: string;
  headRefOid: string;
  isCrossRepository: boolean;
}

export interface Verdict {
  branch: string;
  deleted: boolean;
  why: string;
}

const SHA_RE = /^[0-9a-f]{40}$/;
export const PR_LIMIT = 1000; // gh's page; a branch whose PR is older than that is kept ("no PR"), never guessed at

// The branch → tip map of refs/heads, and the branches some worktree has checked out — or is rebasing or bisecting,
// which `git worktree list` shows as detached, so its git dir's state files name the branch instead.
function locals(run: Run, read: Read): { tips: Map<string, string>; checkedOut: Set<string> } {
  const tips = new Map<string, string>();
  for (const line of run('git', [
    'for-each-ref',
    '--format=%(refname) %(objectname)',
    'refs/heads/',
  ]).split('\n')) {
    const [ref, sha] = line.split(' ');
    if (ref?.startsWith('refs/heads/') && sha && SHA_RE.test(sha))
      tips.set(ref.slice('refs/heads/'.length), sha);
  }
  const checkedOut = new Set<string>();
  for (const line of run('git', ['worktree', 'list', '--porcelain']).split('\n')) {
    if (line.startsWith('branch refs/heads/'))
      checkedOut.add(line.slice('branch refs/heads/'.length));
    if (!line.startsWith('worktree ')) continue;
    let gitDir: string;
    try {
      gitDir = run('git', [
        '-C',
        line.slice('worktree '.length),
        'rev-parse',
        '--absolute-git-dir',
      ]);
    } catch {
      continue; // a worktree whose dir is gone: `git worktree prune` territory, and it holds no branch
    }
    for (const f of ['rebase-merge/head-name', 'rebase-apply/head-name', 'BISECT_START']) {
      const name = read(join(gitDir, f))
        ?.trim()
        .replace(/^refs\/heads\//, '');
      if (name) checkedOut.add(name);
    }
  }
  return { tips, checkedOut };
}

export function verdict(branch: string, tip: string, prs: Pr[], checkedOut: boolean): Verdict {
  const keep = (why: string): Verdict => ({ branch, deleted: false, why });
  if (PROTECTED.has(branch)) return keep('a deploy branch');
  if (checkedOut) return keep('checked out, rebasing or bisecting in a worktree');
  const mine = prs.filter((p) => p.headRefName === branch);
  if (!mine.length) return keep('no PR from it');
  if (mine.length > 1)
    return keep(`${mine.length} PRs from it (${mine.map((p) => p.number).join(', ')})`);
  const pr = mine[0] as Pr;
  if (pr.isCrossRepository) return keep(`PR ${pr.number} is from a fork`);
  if (pr.state !== 'MERGED') return keep(`PR ${pr.number} is ${pr.state.toLowerCase()}`);
  if (pr.headRefOid !== tip)
    return keep(
      `the local tip ${tip.slice(0, 7)} isn't PR ${pr.number}'s head ${pr.headRefOid.slice(0, 7)}`,
    );
  return { branch, deleted: true, why: `PR ${pr.number} merged at this tip` };
}

export function pruneBranches(
  run: Run,
  dryRun: boolean,
  log: (s: string) => void,
  read: Read = readFs,
): Verdict[] {
  const { tips, checkedOut } = locals(run, read);
  const prs = JSON.parse(
    run('gh', [
      'pr',
      'list',
      '--state',
      'all',
      '--limit',
      String(PR_LIMIT),
      '--json',
      'number,state,headRefName,headRefOid,isCrossRepository',
    ]),
  ) as Pr[];
  const out: Verdict[] = [];
  for (const [branch, tip] of [...tips].sort(([a], [b]) => a.localeCompare(b))) {
    const v = verdict(branch, tip, prs, checkedOut.has(branch));
    if (v.deleted && !dryRun) {
      try {
        run('git', ['update-ref', '-d', `refs/heads/${branch}`, tip]);
      } catch (err) {
        v.deleted = false;
        v.why = `the delete was refused (${err instanceof Error ? err.message.split('\n')[0] : 'git'})`;
      }
    }
    out.push(v);
    log(
      `${v.deleted ? (dryRun ? 'would delete' : 'deleted') : 'kept'} ${branch} — ${v.why}${v.deleted ? ` (was ${tip.slice(0, 7)})` : ''}`,
    );
  }
  const n = out.filter((v) => v.deleted).length;
  log(`${dryRun ? 'would delete' : 'deleted'} ${n} of ${out.length} local branches`);
  return out;
}
