// The real LaneFs (node:fs), and the archive copy: a tree copied to a new destination and checked file by file
// (relative path, size, sha256; a symlink by its target). start.ts and end.ts reach the disk only through this.
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { LaneFs } from './state.ts';

// relative path → a fingerprint; `ignore` names top-level entries left out.
export function digest(root: string, ignore: string[] = []): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (rel: string) => {
    const abs = join(root, rel);
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) out.set(rel, `link:${readlinkSync(abs)}`);
    else if (st.isDirectory()) {
      if (rel) out.set(rel, 'dir');
      for (const f of readdirSync(abs).sort())
        if (!(rel === '' && ignore.includes(f))) walk(rel ? join(rel, f) : f);
    } else if (!st.isFile()) throw new Error(`${abs}: not a file, directory or symlink`);
    else out.set(rel, `${st.size}:${createHash('sha256').update(readFileSync(abs)).digest('hex')}`);
  };
  walk('');
  return out;
}

// An unreadable tree (a broken entry on the shared mount) is never "the same".
export function sameTree(a: string, b: string, ignore: string[] = []): boolean {
  try {
    const x = digest(a, ignore);
    const y = digest(b, ignore);
    return x.size === y.size && [...x].every(([k, v]) => y.get(k) === v);
  } catch {
    return false;
  }
}

// Our own walk, not cpSync: on the /workspace virtiofs mount (shared with the Mac) cpSync leaves zero-byte,
// write-only files the container can't read or remove (seen 2026-11-15); copyFileSync works there.
function copyTree(src: string, dst: string): void {
  const st = lstatSync(src);
  if (st.isSymbolicLink()) symlinkSync(readlinkSync(src), dst);
  else if (st.isDirectory()) {
    mkdirSync(dst);
    for (const f of readdirSync(src)) copyTree(join(src, f), join(dst, f));
  } else if (!st.isFile())
    throw new Error(`${src}: not a file, directory or symlink`); // a FIFO would block a read
  else copyFileSync(src, dst);
}

// Copies src to dst (which must not exist), then compares; a mismatch removes nothing and throws.
export function archiveTree(src: string, dst: string): number {
  if (existsSync(dst)) throw new Error(`${dst} exists`);
  if (!lstatSync(src).isDirectory()) throw new Error(`${src} is not a directory`);
  mkdirSync(dirname(dst), { recursive: true });
  copyTree(src, dst);
  const want = digest(src);
  const got = digest(dst);
  const bad = [...want].filter(([k, v]) => got.get(k) !== v).map(([k]) => k);
  if (bad.length || got.size !== want.size)
    throw new Error(`the copy in ${dst} differs: ${bad.slice(0, 5).join(', ') || 'extra files'}`);
  return [...want.values()].filter((v) => v !== 'dir').length;
}

export const realFs: LaneFs = {
  read: (p) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  },
  write: (p, s) => {
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp.${process.pid}`;
    writeFileSync(tmp, s);
    renameSync(tmp, p);
  },
  writeNew: (p, s) => {
    mkdirSync(dirname(p), { recursive: true });
    try {
      writeFileSync(p, s, { flag: 'wx' });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw e;
    }
  },
  exists: (p) => existsSync(p),
  rm: (p) => rmSync(p, { force: true }), // files only: never a recursive delete
  mkdirp: (p) => {
    mkdirSync(p, { recursive: true });
  },
  list: (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
  archive: archiveTree,
  sameTree,
};
