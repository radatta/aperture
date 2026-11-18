import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SEEN_FILE, TITLE_MAX, mergedRows, recordMerges } from './merge-record.ts';
const ctl = (s: string) => [...s].some((c) => c.charCodeAt(0) < 32 && c !== '\n'); // a control byte other than newline

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);
const NOW = new Date('2026-11-19T03:00:30.250Z'); // 11-18 in Pacific time: the file is named by the UTC day

const line = (sha: string, epoch: number, subject: string) => `${sha}\t${epoch}\t${subject}`;

function world(
  o: {
    seen?: string;
    log?: string;
    notAncestor?: boolean;
    gitBroken?: boolean;
    gone?: boolean;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'merge-record-'));
  if (o.seen !== undefined) writeFileSync(join(dir, SEEN_FILE), o.seen);
  const calls: string[][] = [];
  const git = (args: string[]) => {
    calls.push(args);
    if (args[0] === 'merge-base') {
      if (o.notAncestor) throw Object.assign(new Error('exit 1'), { status: 1 });
      if (o.gitBroken) throw Object.assign(new Error('fatal: bad object'), { status: 128 });
      return '';
    }
    if (args[0] === 'log') return o.log ?? '';
    if (args[0] === 'cat-file') {
      if (o.gone) throw Object.assign(new Error('fatal: Not a valid object name'), { status: 128 });
      return '';
    }
    throw new Error(`unexpected git ${args[0]}`);
  };
  const rec = { dir, now: () => NOW };
  const seen = () => readFileSync(join(dir, SEEN_FILE), 'utf8').trim();
  const events = (): ({ file: string } & Record<string, unknown>)[] => {
    const h = join(dir, 'history');
    if (!existsSync(h)) return [];
    return readdirSync(h).flatMap((f) =>
      readFileSync(join(h, f), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => ({ file: f, ...(JSON.parse(l) as Record<string, unknown>) })),
    );
  };
  return { dir, git, rec, calls, seen, events };
}

describe('mergedRows', () => {
  it('keeps squash merges, oldest first as given, and skips a direct commit', () => {
    const rows = mergedRows(
      [
        line(A, 1763500000, 'Board brief, QUEUED and a merge watch (#231)'),
        line(B, 1763500100, 'a direct commit with no PR'),
        line(C, 1763500200, 'Second thing (#232)'),
      ].join('\n'),
      NOW,
    );
    expect(rows).toEqual([
      {
        v: 1,
        t: '2026-11-19T03:00:30Z',
        kind: 'merged',
        pr: 231,
        sha: A,
        mergedAt: '2025-11-18T21:06:40Z',
        title: 'Board brief, QUEUED and a merge watch',
      },
      expect.objectContaining({ pr: 232, sha: C, title: 'Second thing' }),
    ]);
  });
  it('cleans control bytes out of a title and caps its length', () => {
    const [r] = mergedRows(line(A, 1, `bell\u0007 esc\u001b[31m ${'x'.repeat(300)} (#9)`), NOW);
    expect(ctl(r!.title)).toBe(false);
    expect(r!.title.length).toBe(TITLE_MAX);
  });
  it('an empty log is no rows', () => expect(mergedRows('', NOW)).toEqual([]));
});

describe('recordMerges', () => {
  it('a first run sets the baseline and back-fills nothing', () => {
    const w = world({ log: line(A, 1, 'old (#1)') });
    expect(recordMerges(w.git, B, w.rec)).toMatch(
      /baseline set at bbbbbbb \(nothing back-filled\)/,
    );
    expect(w.seen()).toBe(B);
    expect(w.events()).toEqual([]);
    expect(w.calls).toEqual([]); // no git log: nothing to record
  });
  it('a malformed baseline is a first run', () => {
    const w = world({ seen: 'not a sha' });
    expect(recordMerges(w.git, B, w.rec)).toMatch(/baseline set/);
    expect(w.seen()).toBe(B);
  });
  it('no new commits: nothing, and no git call', () => {
    const w = world({ seen: `${B}\n` });
    expect(recordMerges(w.git, B, w.rec)).toBeNull();
    expect(w.calls).toEqual([]);
  });
  it('two merges in one round: both rows, oldest first, into the UTC day file; the baseline moves', () => {
    const w = world({
      seen: A,
      log: [line(B, 1763500000, 'one (#231)'), line(C, 1763500100, 'two (#232)')].join('\n'),
    });
    expect(recordMerges(w.git, C, w.rec)).toBe('merged: PR 231 (bbbbbbb), PR 232 (ccccccc)');
    expect(w.events().map((e) => [e.file, e.kind, e.pr, e.sha])).toEqual([
      ['events-2026-11-19.jsonl', 'merged', 231, B],
      ['events-2026-11-19.jsonl', 'merged', 232, C],
    ]);
    expect(w.calls).toContainEqual([
      'log',
      '--first-parent',
      '--reverse',
      '--format=%H%x09%ct%x09%s',
      `${A}..${C}`,
    ]);
    expect(w.seen()).toBe(C);
    // a second round is quiet
    expect(recordMerges(w.git, C, w.rec)).toBeNull();
    expect(w.events()).toHaveLength(2);
  });
  it('only direct commits: no row, the baseline still moves', () => {
    const w = world({ seen: A, log: line(B, 1, 'direct') });
    expect(recordMerges(w.git, B, w.rec)).toBeNull();
    expect(w.events()).toEqual([]);
    expect(w.seen()).toBe(B);
  });
  it('a baseline main no longer descends from resets, back-filling nothing', () => {
    const w = world({ seen: A, notAncestor: true, log: line(C, 1, 'x (#5)') });
    expect(recordMerges(w.git, D, w.rec)).toMatch(
      /aaaaaaa is not under origin\/main: baseline reset at ddddddd/,
    );
    expect(w.seen()).toBe(D);
    expect(w.events()).toEqual([]);
  });
  it('a git error that is not "not an ancestor" throws and keeps the baseline (no gap is skipped)', () => {
    const w = world({ seen: A, gitBroken: true });
    expect(() => recordMerges(w.git, D, w.rec)).toThrow(/bad object/);
    expect(w.seen()).toBe(A);
  });
  it('a baseline commit the checkout no longer has is reset, never a round that fails for good', () => {
    const w = world({ seen: A, gitBroken: true, gone: true });
    expect(recordMerges(w.git, D, w.rec)).toMatch(/baseline reset at ddddddd /);
    expect([w.seen(), w.events()]).toEqual([D, []]);
  });
  it('events are written before the baseline moves: an append that fails leaves the baseline where it was', () => {
    const w = world({ seen: A, log: line(B, 1, 'x (#5)') });
    writeFileSync(join(w.dir, 'history'), 'a file where the dir should be');
    expect(() => recordMerges(w.git, B, w.rec)).toThrow();
    expect(w.seen()).toBe(A);
  });
  // root writes through the mode bit: the container user and CI's runner aren't root
  it.skipIf(process.getuid?.() === 0)(
    'a baseline that cannot be written throws (sync-main turns it into a line)',
    () => {
      const w = world({ seen: A, log: '' });
      chmodSync(w.dir, 0o500);
      try {
        expect(() => recordMerges(w.git, B, w.rec)).toThrow();
      } finally {
        chmodSync(w.dir, 0o700);
      }
    },
  );
});
