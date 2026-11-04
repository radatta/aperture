// An in-memory Fs for the mailroom tests, with a hook that plays the Mac: it sees each rename into inbox/.
import type { Fs } from './submit.ts';

const enoent = (p: string) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
const eexist = (p: string) => Object.assign(new Error(`EEXIST: ${p}`), { code: 'EEXIST' });

export function memFs(dirs: string[] = []): Fs & {
  files: Map<string, string>;
  dirs: Set<string>;
  mtimes: Map<string, number>;
  onRename?: (from: string, to: string) => void;
} {
  const files = new Map<string, string>();
  const ds = new Set(dirs);
  const mtimes = new Map<string, number>();
  const fs = {
    files,
    dirs: ds,
    mtimes,
    onRename: undefined as ((from: string, to: string) => void) | undefined,
    writeNew: (p: string, data: string) => {
      if (files.has(p)) throw eexist(p);
      files.set(p, data);
    },
    rename: (a: string, b: string) => {
      const v = files.get(a);
      if (v === undefined) throw enoent(a);
      files.delete(a);
      files.set(b, v);
      fs.onRename?.(a, b);
    },
    read: (p: string) => files.get(p) ?? null,
    mkdirp: (p: string) => {
      ds.add(p);
    },
    isDir: (p: string) => ds.has(p),
    mtimeMs: (p: string) => mtimes.get(p) ?? (files.has(p) ? 0 : null),
    list: (p: string) => [
      ...new Set(
        [...files.keys(), ...ds]
          .filter((k) => k.startsWith(`${p}/`))
          .map((k) => k.slice(p.length + 1).split('/')[0] ?? ''),
      ),
    ],
  };
  return fs;
}
