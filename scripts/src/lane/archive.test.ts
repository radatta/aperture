import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { archiveTree, digest, realFs, sameTree } from './archive.ts';

function tree() {
  const root = mkdtempSync(join(tmpdir(), 'lane-arch-'));
  const src = join(root, 'src');
  mkdirSync(join(src, 'screenshots/round-1'), { recursive: true });
  writeFileSync(join(src, 'plan.md'), 'plan\n');
  writeFileSync(join(src, 'screenshots/round-1/a.png'), Buffer.from([0, 1, 2, 255]));
  symlinkSync('plan.md', join(src, 'link.md'));
  return { root, src };
}

describe('archiveTree', () => {
  it('copies nested files and symlinks, and counts the files', () => {
    const { root, src } = tree();
    const dst = join(root, 'archive/b');
    expect(archiveTree(src, dst)).toBe(3);
    expect(readFileSync(join(dst, 'screenshots/round-1/a.png'))).toEqual(
      Buffer.from([0, 1, 2, 255]),
    );
    expect(readlinkSync(join(dst, 'link.md'))).toBe('plan.md');
    expect(sameTree(src, dst)).toBe(true);
  });

  it('an empty source copies to an empty archive', () => {
    const root = mkdtempSync(join(tmpdir(), 'lane-arch-'));
    mkdirSync(join(root, 'src'));
    expect(archiveTree(join(root, 'src'), join(root, 'dst'))).toBe(0);
  });

  it('refuses an existing destination and a missing source', () => {
    const { root, src } = tree();
    mkdirSync(join(root, 'dst'));
    expect(() => archiveTree(src, join(root, 'dst'))).toThrow(/exists/);
    expect(() => archiveTree(join(root, 'nope'), join(root, 'dst2'))).toThrow();
  });
});

describe('archive on the shared mount', () => {
  it('never uses cpSync (it breaks files on the /workspace virtiofs mount)', () => {
    const src = readFileSync(new URL('archive.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/import \{[^}]*\bcpSync\b[^}]*\} from 'node:fs'/);
  });

  it('an unreadable tree is never the same', () => {
    const { root, src } = tree();
    expect(sameTree(src, join(root, 'missing'))).toBe(false);
  });
});

describe('sameTree', () => {
  it('sees a changed byte, an extra file and a missing one; ignores named top-level files', () => {
    const { root, src } = tree();
    const dst = join(root, 'dst');
    archiveTree(src, dst);
    writeFileSync(join(dst, 'mac-cleanup.txt'), 'x');
    expect(sameTree(src, dst)).toBe(false);
    expect(sameTree(src, dst, ['mac-cleanup.txt'])).toBe(true);
    writeFileSync(join(dst, 'plan.md'), 'plaN\n');
    expect(sameTree(src, dst, ['mac-cleanup.txt'])).toBe(false);
  });

  it('fingerprints by path, size and content', () => {
    const { src } = tree();
    expect(digest(src).get('plan.md')).toMatch(/^5:[0-9a-f]{64}$/);
    expect(digest(src).get('link.md')).toBe('link:plan.md');
  });
});

describe('realFs', () => {
  it('writeNew refuses an existing file; read is null when missing; list is [] when missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'lane-fs-'));
    const p = join(root, 'a/b.json');
    expect(realFs.writeNew(p, '1')).toBe(true);
    expect(realFs.writeNew(p, '2')).toBe(false);
    expect(realFs.read(p)).toBe('1');
    expect(realFs.read(join(root, 'nope'))).toBeNull();
    expect(realFs.list(join(root, 'nope'))).toEqual([]);
    realFs.write(p, '3');
    expect(realFs.read(p)).toBe('3');
  });
});
