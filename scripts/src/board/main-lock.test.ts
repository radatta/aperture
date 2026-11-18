import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MainBusy, withMainLock } from './main-lock.ts';

const lockFile = () => join(mkdtempSync(join(tmpdir(), 'main-lock-')), 'main.lock');

// Another process holding the lock for `sec` seconds; resolves once it holds it.
function holder(file: string, sec: number): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const p = spawn('flock', ['-o', file, 'sh', '-c', `echo held; sleep ${sec}`], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    p.on('error', reject);
    p.stdout.once('data', () => resolve(() => p.kill()));
  });
}

describe('withMainLock', () => {
  it('runs fn and releases, also when fn throws', () => {
    const file = lockFile();
    expect(withMainLock(() => 7, { file, waitSec: 1 })).toBe(7);
    expect(() =>
      withMainLock(
        () => {
          throw new Error('boom');
        },
        { file, waitSec: 1 },
      ),
    ).toThrow('boom');
    expect(withMainLock(() => 'again', { file, waitSec: 1 })).toBe('again'); // nothing left held
  });

  it("a lock file it can't write (made by a sudo run) still locks, read-only", () => {
    const file = lockFile();
    writeFileSync(file, '');
    chmodSync(file, 0o444);
    expect(withMainLock(() => 'ro', { file, waitSec: 1 })).toBe('ro');
  });

  it('nests in one process without waiting on itself', () => {
    const file = lockFile();
    expect(
      withMainLock(() => withMainLock(() => 1, { file, waitSec: 1 }) + 1, { file, waitSec: 1 }),
    ).toBe(2);
  });

  it('nesting is per lock file: inside one, another held elsewhere is still waited for', async () => {
    const outer = lockFile();
    const inner = lockFile();
    const release = await holder(inner, 5);
    try {
      expect(() =>
        withMainLock(() => withMainLock(() => 1, { file: inner, waitSec: 1, warn: () => {} }), {
          file: outer,
          waitSec: 1,
        }),
      ).toThrow(MainBusy);
    } finally {
      release();
    }
  });

  it('a lock held elsewhere times out with the busy message, after saying it waits', async () => {
    const file = lockFile();
    const stop = await holder(file, 10);
    const said: string[] = [];
    try {
      expect(() => withMainLock(() => 1, { file, waitSec: 1, warn: (s) => said.push(s) })).toThrow(
        MainBusy,
      );
      expect(said).toEqual([
        'main checkout busy (another lanes start or sync-main): waiting up to 1 s',
      ]);
      // another lock says what it is (the tower restart's): never the main checkout's words
      expect(() =>
        withMainLock(() => 1, {
          file,
          waitSec: 1,
          warn: () => undefined,
          what: 'tower restart busy',
        }),
      ).toThrow(`tower restart busy: ${file} held for 1 s`);
      // the main sync loop's shorter wait comes from the environment
      vi.stubEnv('APERTURE_MAIN_LOCK_WAIT', '1');
      said.length = 0;
      expect(() => withMainLock(() => 1, { file, warn: (s) => said.push(s) })).toThrow(MainBusy);
      expect(said[0]).toMatch(/waiting up to 1 s$/);
    } finally {
      vi.unstubAllEnvs();
      stop();
    }
  });

  it('waits for a holder that lets go', async () => {
    const file = lockFile();
    await holder(file, 1);
    expect(withMainLock(() => 'mine', { file, waitSec: 10, warn: () => {} })).toBe('mine');
  });

  it('a child started inside does not keep the lock after fn returns', async () => {
    const file = lockFile();
    let child: ReturnType<typeof spawn> | null = null;
    withMainLock(
      () => {
        child = spawn('sleep', ['5'], { stdio: 'ignore' });
      },
      { file, waitSec: 1 },
    );
    try {
      // a second process gets it at once although the child is still alive
      const stop = await holder(file, 0);
      stop();
    } finally {
      child!.kill();
    }
  });
});
