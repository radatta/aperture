import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MainBusy, withMainLock } from './main-lock.ts';

const lockFile = () => join(mkdtempSync(join(tmpdir(), 'main-lock-')), 'main.lock');

// Another process holding the lock for `sec` seconds; resolves once it holds it.
function holder(file: string, sec: number): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const p = spawn('flock', [file, 'sh', '-c', `echo held; sleep ${sec}`], {
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

  it('nests in one process without waiting on itself', () => {
    const file = lockFile();
    expect(
      withMainLock(() => withMainLock(() => 1, { file, waitSec: 1 }) + 1, { file, waitSec: 1 }),
    ).toBe(2);
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
    } finally {
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
