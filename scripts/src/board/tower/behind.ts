// Is the web tower running older code than its checkout holds? (docs/ops/TOWER.md → Run it.) The one rule shared by
// the page's "behind main" chip and `pnpm board sync-main`'s restart: the commit the server started from against the
// checkout's HEAD now, counting only the files the tower runs. No timer: the page asks on each poll, and git runs once
// per HEAD move.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Everything the tower server loads: the board code, its imports outside it (behind.test.ts walks web/main.ts's import
// graph and holds this list to it) and the config identifiers.ts reads at load. Tests and fixtures never run in it.
export const TOWER_PATHS = [
  'scripts/src/board',
  'scripts/board',
  'scripts/src/identifiers.ts',
  'scripts/src/mac-root.ts',
  'scripts/src/deploy-base.ts',
  'scripts/src/bot/api.ts',
  'scripts/src/classify-changes.ts',
  'identifiers.json',
];
const NOT_RUN = [':(exclude,glob)**/*.test.ts', ':(exclude)scripts/src/board/tower/fixtures'];

export type Git = (args: string[]) => string; // throws on a non-zero exit
export type Behind = { head: string; files: number };

const SHA = /^[0-9a-f]{40}$/;

// The tower files that differ between two commits; null when git can't tell (an unknown sha): treat as changed.
export function towerChanged(git: Git, from: string, to: string): string[] | null {
  try {
    return git(['diff', '--name-only', from, to, '--', ...TOWER_PATHS, ...NOT_RUN])
      .split('\n')
      .filter(Boolean);
  } catch {
    return null;
  }
}

// A detached checkout's HEAD file holds the sha itself: one small file read, no git. Only a detached checkout is
// compared (the board's tower serves /workspace, always detached); a checkout on a branch (a worktree's hand-run
// tower) gives null, so no chip and no git call per poll there.
export function readHead(gitDir: string, read = (f: string) => readFileSync(f, 'utf8')) {
  try {
    const h = read(join(gitDir, 'HEAD')).trim();
    return SHA.test(h) ? h : null;
  } catch {
    return null;
  }
}

// Per request: null while current (or HEAD unreadable), else the checkout's HEAD and how many tower files moved.
export function behindCheck(o: {
  version: string;
  gitDir: string;
  git: Git;
  read?: (f: string) => string;
}): () => Behind | null {
  let memo: { head: string; out: Behind | null } | null = null;
  return () => {
    const head = readHead(o.gitDir, o.read);
    if (!head || head === o.version) return null;
    if (memo?.head !== head) {
      const files = towerChanged(o.git, o.version, head);
      memo = {
        head,
        out:
          files === null
            ? { head, files: -1 }
            : files.length
              ? { head, files: files.length }
              : null,
      };
    }
    return memo.out;
  };
}
