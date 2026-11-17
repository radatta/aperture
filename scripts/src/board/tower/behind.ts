// Is the web tower running older code than its checkout holds? (docs/ops/TOWER.md → Run it.) The one rule shared by
// the page's "behind main" chip and `pnpm board sync-main`'s restart: the commit the server started from against the
// checkout's HEAD now, counting only the files the tower runs. No timer: the page asks on each poll, and git runs once
// per HEAD move.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Everything the tower server loads: the board code and its two imports outside it (web/main.ts).
export const TOWER_PATHS = [
  'scripts/src/board',
  'scripts/board',
  'scripts/src/identifiers.ts',
  'scripts/src/mac-root.ts',
];

export type Git = (args: string[]) => string; // throws on a non-zero exit
export type Behind = { head: string; files: number };

const SHA = /^[0-9a-f]{40}$/;

// The tower files that differ between two commits; null when git can't tell (an unknown sha): treat as changed.
export function towerChanged(git: Git, from: string, to: string): string[] | null {
  try {
    return git(['diff', '--name-only', from, to, '--', ...TOWER_PATHS])
      .split('\n')
      .filter(Boolean);
  } catch {
    return null;
  }
}

// A detached checkout's HEAD file holds the sha itself (the cheap read); `ref: …` asks git once.
export function readHead(gitDir: string, git: Git, read = (f: string) => readFileSync(f, 'utf8')) {
  try {
    const h = read(join(gitDir, 'HEAD')).trim();
    if (SHA.test(h)) return h;
    const r = git(['rev-parse', 'HEAD']).trim();
    return SHA.test(r) ? r : null;
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
    const head = readHead(o.gitDir, o.git, o.read);
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
