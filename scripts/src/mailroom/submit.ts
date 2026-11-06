// The container's half of the mailroom's file drop: write a job to staging/, rename it into inbox/ (atomic, so the
// Mac never sees half a file), poll results/<id>/result.json, and withdraw a job the Mac never picked up. Plain fs —
// no sockets (COI). The fs and the clock are injected so tests touch neither. docs/ops/MAILROOM.md.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Clock } from '../bot/dispatch.ts';
import type { Run } from '../bot/sh.ts';

export interface Fs {
  writeNew: (path: string, data: string) => void; // fails if the path exists
  rename: (from: string, to: string) => void;
  read: (path: string) => string | null; // null when missing
  mkdirp: (path: string) => void;
  isDir: (path: string) => boolean;
  mtimeMs: (path: string) => number | null;
  list: (path: string) => string[];
}

const code = (err: unknown) => (err as NodeJS.ErrnoException).code;
export const nodeFs: Fs = {
  writeNew: (p, data) => writeFileSync(p, data, { flag: 'wx', mode: 0o600 }),
  rename: (a, b) => renameSync(a, b),
  read: (p) => {
    try {
      return readFileSync(p, 'utf8');
    } catch (err) {
      if (code(err) === 'ENOENT') return null;
      throw err;
    }
  },
  mkdirp: (p) => mkdirSync(p, { recursive: true }),
  isDir: (p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  mtimeMs: (p) => {
    try {
      return statSync(p).mtimeMs;
    } catch {
      return null;
    }
  },
  list: (p) => {
    try {
      return readdirSync(p);
    } catch {
      return [];
    }
  },
};

export interface Result {
  v: 1;
  id: string;
  job: string;
  status: 'opened' | 'exists' | 'rejected' | 'error' | 'expired';
  reason: string | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  runnerVersion: string;
  bodySha256?: string;
  tokenExpiresAt?: string;
  tokenWarning?: 'TOKEN_EXPIRING';
  pr?: { number: number; url: string; headSha: string; author: string };
}

// `.hostjobs/` at the main checkout's root, shared by every worktree (same anchor as the bot's secretsDir()).
export const hostjobsDir = (run: Run) =>
  join(
    dirname(run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'])),
    '.hostjobs',
  );

export class NotInstalled extends Error {}

export function submit(fs: Fs, dir: string, job: { id: string }): void {
  if (!fs.isDir(join(dir, 'inbox')))
    throw new NotInstalled(`${join(dir, 'inbox')} is missing — the Mac mailroom isn't installed`);
  fs.mkdirp(join(dir, 'staging'));
  const staged = join(dir, 'staging', `${job.id}.json`);
  fs.writeNew(staged, JSON.stringify(job));
  fs.rename(staged, join(dir, 'inbox', `${job.id}.json`));
}

// The result once it parses (the runner writes it in one go; a partial read just waits a poll), or null by the deadline.
export async function waitForResult(
  fs: Fs,
  clock: Clock,
  dir: string,
  id: string,
  timeoutMs: number,
  pollMs = 2000,
): Promise<Result | null> {
  const path = join(dir, 'results', id, 'result.json');
  const deadline = clock.now() + timeoutMs;
  for (;;) {
    const raw = fs.read(path);
    if (raw) {
      try {
        const r = JSON.parse(raw) as Result;
        if (r.id === id) return r;
      } catch {
        // partial write — next poll
      }
    }
    if (clock.now() >= deadline) return null;
    await clock.sleep(pollMs);
  }
}

// Take an unclaimed job back out of the inbox. False when the Mac already moved it (it is running or ran).
export function withdraw(fs: Fs, dir: string, id: string): boolean {
  try {
    fs.rename(join(dir, 'inbox', `${id}.json`), join(dir, 'staging', `${id}.withdrawn.json`));
    return true;
  } catch (err) {
    if (code(err) === 'ENOENT') return false;
    throw err;
  }
}

// What the container can see of the Mac side: the installer's stamp and the newest result's age.
export function lastSeen(
  fs: Fs,
  dir: string,
): { installedAt: string | null; runnerVersion: string | null; lastResultMs: number | null } {
  let installed: { installedAt?: string; runnerVersion?: string } = {};
  try {
    installed = JSON.parse(fs.read(join(dir, 'installed.json')) ?? '{}') as typeof installed;
  } catch {
    // unreadable stamp = not installed
  }
  const times = fs
    .list(join(dir, 'results'))
    .map((n) => fs.mtimeMs(join(dir, 'results', n, 'result.json')))
    .filter((t): t is number => t !== null);
  return {
    installedAt: installed.installedAt ?? null,
    runnerVersion: installed.runnerVersion ?? null,
    lastResultMs: times.length ? Math.max(...times) : null,
  };
}

// The repo's runner version, computed as install.sh does: sha256 over runner.sh then jobs/*.sh in name order.
export function repoRunnerVersion(root: string, read = (p: string) => readFileSync(p)): string {
  const dir = join(root, 'tools', 'mailroom');
  const jobs = readdirSync(join(dir, 'jobs'))
    .filter((n) => n.endsWith('.sh'))
    .sort();
  const h = createHash('sha256');
  for (const p of [join(dir, 'runner.sh'), ...jobs.map((n) => join(dir, 'jobs', n))])
    h.update(read(p));
  return h.digest('hex');
}
