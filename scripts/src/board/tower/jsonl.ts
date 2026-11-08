// Incremental JSONL tails: each refresh reads only the bytes appended since the last one, keeps a torn
// last line for the next read, and starts over when the file is replaced (inode change) or truncated.
import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type Tail = { path: string; ino: number; offset: number; carry: string };

export const tail = (path: string, offset = 0): Tail => ({ path, ino: -1, offset, carry: '' });

const CHUNK = 1 << 20;

// New complete lines since the last call; [] when the file is missing.
export function readNew(t: Tail): string[] {
  let fd: number;
  try {
    fd = openSync(t.path, 'r');
  } catch {
    return [];
  }
  try {
    const st = fstatSync(fd);
    if (st.ino !== t.ino || st.size < t.offset) {
      if (t.ino !== -1) t.offset = 0; // replaced or truncated: read it again
      t.ino = st.ino;
      t.carry = '';
    }
    if (st.size === t.offset) return [];
    const parts: Buffer[] = [];
    const buf = Buffer.allocUnsafe(Math.min(CHUNK, st.size - t.offset));
    while (t.offset < st.size) {
      const n = readSync(fd, buf, 0, Math.min(buf.length, st.size - t.offset), t.offset);
      if (n <= 0) break;
      parts.push(Buffer.from(buf.subarray(0, n)));
      t.offset += n;
    }
    const text = t.carry + Buffer.concat(parts).toString('utf8');
    const lines = text.split('\n');
    t.carry = lines.pop() ?? '';
    return lines.filter((l) => l.length > 0);
  } finally {
    closeSync(fd);
  }
}

export function parseLines(lines: string[]): unknown[] {
  const out: unknown[] = [];
  for (const l of lines) {
    try {
      out.push(JSON.parse(l));
    } catch {
      // a torn or foreign line: skip it, like the other board readers
    }
  }
  return out;
}

// UTC day stamps (the history files' names) covering [from, to].
export function days(from: number, to: number): string[] {
  const out: string[] = [];
  const d = new Date(Math.floor(from / 86400000) * 86400000);
  while (d.getTime() <= to) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

// A set of tails over `<dir>/<prefix>-<day>.jsonl`, opened as the window reaches each day.
export class DayFiles {
  private tails = new Map<string, Tail>();
  private dir: string;
  private prefix: string;
  constructor(dir: string, prefix: string) {
    this.dir = dir;
    this.prefix = prefix;
  }

  // New records from every day file in [from, to]; days that left the window are dropped.
  read(from: number, to: number): unknown[] {
    const want = days(from, to);
    for (const k of [...this.tails.keys()]) if (!want.includes(k)) this.tails.delete(k);
    const out: unknown[] = [];
    for (const day of want) {
      let t = this.tails.get(day);
      if (!t) {
        t = tail(join(this.dir, `${this.prefix}-${day}.jsonl`));
        this.tails.set(day, t);
      }
      out.push(...parseLines(readNew(t)));
    }
    return out;
  }
}

// mtime+size of a file, or null; the cheap "did it change" check for whole-file reads.
export function stamp(path: string): string | null {
  try {
    const s = statSync(path);
    return `${s.mtimeMs}:${s.size}:${s.ino}`;
  } catch {
    return null;
  }
}
