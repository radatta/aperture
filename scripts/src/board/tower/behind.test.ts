import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOWER_PATHS, behindCheck, readHead, towerChanged, type Git } from './behind.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

describe('readHead', () => {
  it('reads a detached HEAD from the file; a branch checkout or no file gives null, never a git call', () => {
    expect(readHead('/r/.git', () => `${A}\n`)).toBe(A);
    expect(readHead('/r/.git', () => 'ref: refs/heads/x\n')).toBeNull();
    expect(
      readHead('/r/.git', () => {
        throw new Error('ENOENT');
      }),
    ).toBeNull();
  });
});

describe('TOWER_PATHS', () => {
  it("covers every file web/main.ts's static import graph reaches", () => {
    const root = resolve(import.meta.dirname, '../../../..');
    const seen = new Set<string>();
    const walk = (f: string) => {
      if (seen.has(f)) return;
      seen.add(f);
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/^(?:import|export)\b[^;]*?from '(\.[^']+)'/gms))
        walk(resolve(dirname(f), m[1]!));
    };
    walk(join(import.meta.dirname, 'web/main.ts'));
    const outside = [...seen]
      .map((f) => relative(root, f))
      .filter((f) => !TOWER_PATHS.some((p) => f === p || f.startsWith(`${p}/`)));
    expect(outside).toEqual([]);
    expect(seen.size).toBeGreaterThan(15); // the walk found the graph, not just main.ts
    expect(TOWER_PATHS).toContain('identifiers.json'); // read at load by identifiers.ts, not imported
  });
});

describe('towerChanged', () => {
  it('diffs only the files the tower runs; null when git fails', () => {
    let seen: string[] = [];
    const git: Git = (args) => ((seen = args), 'scripts/board/board.sh\n');
    expect(towerChanged(git, A, B)).toEqual(['scripts/board/board.sh']);
    expect(seen.slice(0, 5 + TOWER_PATHS.length)).toEqual([
      'diff',
      '--name-only',
      A,
      B,
      '--',
      ...TOWER_PATHS,
    ]);
    // tests and fixtures never run in the server: a merge touching only them restarts nothing
    expect(seen.slice(5 + TOWER_PATHS.length)).toEqual([
      ':(exclude,glob)**/*.test.ts',
      ':(exclude)scripts/src/board/tower/fixtures',
    ]);
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
