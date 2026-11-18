// One lock around git writes in the main checkout (F155): `pnpm board sync-main` (also the end of `lanes end` and
// `lanes start`) and `lanes start`'s fetch → worktree add both move /workspace's HEAD and refs, and two at once failed
// with "cannot lock ref" or an index.lock. flock(1) on an fd this process keeps open: the lock is the open file
// description's, so it holds across every git child after the flock child exits, and node opens fds close-on-exec,
// so a git child never carries it. Released on close or process death: never stale. Same-process nesting is free.
// The file lives on the rootfs like lib.sh's flocks: one container is every session that can race. `fn` must be
// synchronous: the lock is let go when it returns.
import { execFileSync } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';

export const MAIN_LOCK = process.env.APERTURE_MAIN_LOCK || '/tmp/aperture-main-checkout.lock';

// The web tower's restart (sync-main.ts): two callers that both see a stale tower (the main-sync loop and a lanes
// end) restart it one at a time, and the second re-reads what it serves and finds nothing to do.
export const TOWER_RESTART_LOCK =
  process.env.APERTURE_TOWER_RESTART_LOCK || '/tmp/aperture-tower-restart.lock';

export class MainBusy extends Error {
  file: string | null; // the lock it waited on (node strips types only: no parameter properties)
  constructor(msg: string, file: string | null = null) {
    super(msg);
    this.file = file;
  }
}

const depth = new Map<string, number>(); // per lock file: nesting one lock never skips taking another

// what holds it, for the busy message; waitSec defaults to APERTURE_MAIN_LOCK_WAIT (the main sync loop's 20 s) or 120
export type LockOpts = {
  waitSec?: number;
  file?: string;
  warn?: (s: string) => void;
  what?: string;
};

export function withMainLock<T>(fn: () => T, o: LockOpts = {}): T {
  const file = o.file ?? MAIN_LOCK;
  if (depth.get(file)) return nest(file, fn);
  const wait = o.waitSec ?? (Number(process.env.APERTURE_MAIN_LOCK_WAIT) || 120);
  const what = o.what ?? 'main checkout busy (another lanes start or sync-main)';
  const warn = o.warn ?? ((s: string) => console.error(s));
  let fd: number;
  try {
    fd = openSync(file, 'a', 0o666);
  } catch (e) {
    // made by someone else (a sudo run) without write for us: flock(2) works on a read-only fd too
    if ((e as NodeJS.ErrnoException).code !== 'EACCES') throw e;
    fd = openSync(file, 'r');
  }
  try {
    const take = (args: string[]) =>
      execFileSync('flock', [...args, '3'], { stdio: ['ignore', 'ignore', 'pipe', fd] });
    try {
      take(['-n']);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT')
        warn(`warning: no flock(1); ${file} not locked`);
      else if ((e as { status?: number }).status !== 1)
        throw e; // only 1 is "held": a usage error isn't busy
      else {
        warn(`${what}: waiting up to ${wait} s`);
        try {
          take(['-w', String(wait)]);
        } catch (e2) {
          if ((e2 as { status?: number }).status !== 1) throw e2;
          throw new MainBusy(`${what}: ${file} held for ${wait} s`, file);
        }
      }
    }
    return nest(file, fn);
  } finally {
    closeSync(fd);
  }
}

export const withRestartLock = <T>(fn: () => T): T =>
  withMainLock(fn, {
    file: TOWER_RESTART_LOCK,
    waitSec: 30,
    warn: () => undefined,
    what: 'tower restart busy (another sync-main restarting it)',
  });

function nest<T>(file: string, fn: () => T): T {
  depth.set(file, (depth.get(file) ?? 0) + 1);
  try {
    return fn();
  } finally {
    depth.set(file, depth.get(file)! - 1);
  }
}
