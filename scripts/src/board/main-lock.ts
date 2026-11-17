// One lock around git writes in the main checkout (F155): `pnpm board sync-main` (also the end of `lanes end` and
// `lanes start`) and `lanes start`'s fetch → worktree add both move /workspace's HEAD and refs, and two at once failed
// with "cannot lock ref" or an index.lock. flock(1) on an fd this process keeps open: the lock is the open file
// description's, so it holds across every git child after the flock child exits, and node opens fds close-on-exec,
// so a git child never carries it. Released on close or process death: never stale. Same-process nesting is free.
// The file lives on the rootfs like lib.sh's flocks: one container is every session that can race.
import { execFileSync } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';

export const MAIN_LOCK = process.env.APERTURE_MAIN_LOCK || '/tmp/aperture-main-checkout.lock';

export class MainBusy extends Error {}

let depth = 0;

export type LockOpts = { waitSec?: number; file?: string; warn?: (s: string) => void };

export function withMainLock<T>(fn: () => T, o: LockOpts = {}): T {
  if (depth) return nest(fn);
  const file = o.file ?? MAIN_LOCK;
  const wait = o.waitSec ?? 120;
  const warn = o.warn ?? ((s: string) => console.error(s));
  const fd = openSync(file, 'a', 0o666);
  try {
    const take = (args: string[]) =>
      execFileSync('flock', [...args, '3'], { stdio: ['ignore', 'ignore', 'pipe', fd] });
    try {
      take(['-n']);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT')
        warn(`warning: no flock(1); ${file} not locked`);
      else {
        warn(`main checkout busy (another lanes start or sync-main): waiting up to ${wait} s`);
        try {
          take(['-w', String(wait)]);
        } catch {
          throw new MainBusy(
            `main checkout busy: another lanes start or sync-main held ${file} for ${wait} s`,
          );
        }
      }
    }
    return nest(fn);
  } finally {
    closeSync(fd);
  }
}

function nest<T>(fn: () => T): T {
  depth++;
  try {
    return fn();
  } finally {
    depth--;
  }
}
