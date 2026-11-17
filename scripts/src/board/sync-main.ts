// `pnpm board sync-main` (docs/ops/TOWER.md → Run it): the main checkout to origin/main, detached, then the web tower
// restarted only when the code it serves differs from the new HEAD in a file the tower runs. The base is the commit the
// tower serves (board.sh tower version), not the old HEAD: a checkout moved by `pnpm lane start` is caught too. Never
// starts a stopped tower. Idempotent: a second run says so and does nothing.
import { dirname, join } from 'node:path';
import { towerChanged } from './tower/behind.ts';

export type Run = (cmd: string, args: string[], cwd: string) => string; // throws on a non-zero exit

const short = (s: string) => s.slice(0, 7);

export function syncMain(run: Run, here: string): string {
  const git = (args: string[]) => run('git', args, mainRoot).trim();
  const mainRoot = dirname(
    run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], here).trim(),
  );
  const dirty = run('git', ['status', '--porcelain', '--untracked-files=no'], mainRoot) // untrimmed: XY columns
    .split('\n')
    .filter(Boolean);
  if (dirty.length)
    throw new Error(
      `the main checkout (${mainRoot}) has tracked changes — nothing moved:\n${dirty.slice(0, 10).join('\n')}`,
    );
  let branch = '';
  try {
    branch = git(['symbolic-ref', '-q', '--short', 'HEAD']);
  } catch {
    // detached: the expected state
  }
  if (branch)
    throw new Error(`the main checkout is on branch ${branch}, not detached — nothing moved`);
  try {
    git(['fetch', 'origin']);
  } catch (e) {
    throw new Error(`git fetch failed — nothing moved: ${(e as Error).message}`, { cause: e });
  }
  const old = git(['rev-parse', 'HEAD']);
  const target = git(['rev-parse', 'origin/main']);
  if (old !== target)
    try {
      git(['switch', '--detach', target]); // the sha: a concurrent fetch can't split it
    } catch (e) {
      // git aborts a switch whole (an untracked file it would overwrite): HEAD is where it was
      throw new Error(`git switch failed — nothing moved: ${(e as Error).message}`, { cause: e });
    }
  const moved =
    old === target
      ? `main checkout: already at ${short(target)}`
      : `main checkout: moved ${short(old)} → ${short(target)}`;

  const board = (args: string[]) =>
    run('bash', [join(mainRoot, 'scripts/board/board.sh'), 'tower', ...args], mainRoot).trim();
  try {
    board(['status']);
  } catch {
    return `${moved}\ntower: not running (board.sh tower start)`;
  }
  let served = '';
  try {
    served = board(['version']);
  } catch {
    // an older server records no commit: unknown, so restart
  }
  let why: string | null;
  if (!/^[0-9a-f]{40}$/.test(served)) why = 'served commit unknown';
  else {
    const files = towerChanged(git, served, target);
    why =
      files === null
        ? `served ${short(served)} unknown to git`
        : files.length
          ? `${files.length} tower file${files.length === 1 ? '' : 's'} changed since ${short(served)}`
          : null;
  }
  if (!why) return `${moved}\ntower: restart not needed (serving ${short(served)})`;
  try {
    board(['restart']);
  } catch (e) {
    throw new Error(`${moved}\ntower: restart failed (${why}): ${(e as Error).message}`, {
      cause: e,
    });
  }
  return `${moved}\ntower: restarted (${why})`;
}
