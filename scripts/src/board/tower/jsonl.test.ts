import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DayFiles, days, parseLines, readNew, tail } from './jsonl.ts';

let dir = '';
const fresh = () => (dir = mkdtempSync(join(tmpdir(), 'tower-jsonl-')));
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

describe('readNew', () => {
  it('reads only appended bytes and carries a torn last line', () => {
    const p = join(fresh(), 'a.jsonl');
    writeFileSync(p, '{"n":1}\n{"n":2}\n{"n":');
    const t = tail(p);
    expect(readNew(t)).toEqual(['{"n":1}', '{"n":2}']);
    expect(readNew(t)).toEqual([]);
    appendFileSync(p, '3}\n{"n":4}\n');
    expect(parseLines(readNew(t))).toEqual([{ n: 3 }, { n: 4 }]);
  });

  it('starts over when the file is replaced or truncated', () => {
    const p = join(fresh(), 'a.jsonl');
    writeFileSync(p, '{"n":1}\n');
    const t = tail(p);
    readNew(t);
    writeFileSync(join(dir, 'b.jsonl'), '{"n":9}\n');
    renameSync(join(dir, 'b.jsonl'), p);
    expect(readNew(t)).toEqual(['{"n":9}']);
    writeFileSync(p, '');
    expect(readNew(t)).toEqual([]);
    appendFileSync(p, '{"n":10}\n');
    expect(readNew(t)).toEqual(['{"n":10}']);
  });

  it('is empty for a missing file, and skips a foreign line', () => {
    expect(readNew(tail(join(fresh(), 'none.jsonl')))).toEqual([]);
    expect(parseLines(['{"a":1}', 'not json'])).toEqual([{ a: 1 }]);
  });
});

describe('days', () => {
  const at = (s: string) => Date.parse(s);
  it('names the UTC day files a window spans', () => {
    expect(days(at('2026-11-08T05:00:00Z'), at('2026-11-08T06:00:00Z'))).toEqual(['2026-11-08']);
    expect(days(at('2026-11-07T06:10:00Z'), at('2026-11-08T06:10:00Z'))).toEqual([
      '2026-11-07',
      '2026-11-08',
    ]);
    expect(days(at('2026-11-07T23:59:59Z'), at('2026-11-08T00:00:00Z'))).toEqual([
      '2026-11-07',
      '2026-11-08',
    ]);
  });

  it('DayFiles reads each day once, then only what is new', () => {
    fresh();
    writeFileSync(join(dir, 'samples-2026-11-07.jsonl'), '{"d":7}\n');
    writeFileSync(join(dir, 'samples-2026-11-08.jsonl'), '{"d":8}\n');
    const f = new DayFiles(dir, 'samples');
    const from = at('2026-11-07T12:00:00Z');
    const to = at('2026-11-08T06:00:00Z');
    expect(f.read(from, to)).toEqual([{ d: 7 }, { d: 8 }]);
    appendFileSync(join(dir, 'samples-2026-11-08.jsonl'), '{"d":9}\n');
    expect(f.read(from, to)).toEqual([{ d: 9 }]);
  });
});
