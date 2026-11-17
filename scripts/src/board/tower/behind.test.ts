import { describe, expect, it } from 'vitest';
import { TOWER_PATHS, behindCheck, readHead, towerChanged, type Git } from './behind.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

describe('readHead', () => {
  it('reads a detached HEAD from the file, without git', () => {
    const git: Git = () => {
      throw new Error('git called');
    };
    expect(readHead('/r/.git', git, () => `${A}\n`)).toBe(A);
  });
  it('asks git when HEAD is a ref, and gives null when nothing reads', () => {
    expect(
      readHead(
        '/r/.git',
        () => `${B}\n`,
        () => 'ref: refs/heads/x\n',
      ),
    ).toBe(B);
    const none = () => {
      throw new Error('ENOENT');
    };
    expect(readHead('/r/.git', none, none)).toBeNull();
  });
});

describe('towerChanged', () => {
  it('diffs only the files the tower runs; null when git fails', () => {
    let seen: string[] = [];
    const git: Git = (args) => ((seen = args), 'scripts/board/board.sh\n');
    expect(towerChanged(git, A, B)).toEqual(['scripts/board/board.sh']);
    expect(seen).toEqual(['diff', '--name-only', A, B, '--', ...TOWER_PATHS]);
    expect(
      towerChanged(
        () => {
          throw new Error('bad object');
        },
        A,
        B,
      ),
    ).toBeNull();
  });
});

describe('behindCheck', () => {
  it('is null while HEAD is the served commit, or HEAD moved without tower changes', () => {
    let head = A;
    let diff = '';
    const check = behindCheck({ version: A, gitDir: '/g', git: () => diff, read: () => head });
    expect(check()).toBeNull();
    head = B;
    expect(check()).toBeNull();
    diff = 'scripts/src/board/tower/derive.ts\nscripts/src/mac-root.ts';
    head = 'c'.repeat(40);
    expect(check()).toEqual({ head, files: 2 });
  });
  it('runs git once per HEAD move, however often the page asks', () => {
    let n = 0;
    const check = behindCheck({ version: A, gitDir: '/g', git: () => (n++, 'x'), read: () => B });
    for (let i = 0; i < 5; i++) expect(check()).toEqual({ head: B, files: 1 });
    expect(n).toBe(1);
  });
  it('counts a served commit git cannot diff as behind (files -1), and an unreadable HEAD as current', () => {
    const fail: Git = () => {
      throw new Error('bad object');
    };
    expect(behindCheck({ version: A, gitDir: '/g', git: fail, read: () => B })()).toEqual({
      head: B,
      files: -1,
    });
    expect(
      behindCheck({
        version: A,
        gitDir: '/g',
        git: fail,
        read: () => {
          throw new Error('ENOENT');
        },
      })(),
    ).toBeNull();
  });
});
