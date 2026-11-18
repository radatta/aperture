import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Source, parseConflicts } from './source.ts';

let dir = '';
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

const sample = (t: string, cpu = 1, name = 'a') =>
  JSON.stringify({
    t,
    cg: { anonMiB: 4000, pids: 400, cpuCores: cpu, highMiB: 18432, pidsMax: 4096 },
    mix: { working: 1, heavy: 0 },
    sessions: [{ name, state: 'working' }],
  }) + '\n';
const lock = (branch: string | null) =>
  JSON.stringify({
    v: 1,
    t: '2026-11-08T00:00:00Z',
    holder: branch ? { branch, expiresAt: '2026-11-08T01:00:00Z' } : null,
  });

function setup() {
  dir = mkdtempSync(join(tmpdir(), 'tower-source-'));
  const board = join(dir, 'board');
  mkdirSync(join(board, 'history'), { recursive: true });
  const src = new Source(
    {
      boardDir: board,
      limits: join(dir, 'none.json'),
      ledger: join(dir, 'ledger.jsonl'),
      ledgerB: join(dir, 'ledger.devb.jsonl'),
      bench: join(dir, 'bench'),
      cores: 9,
    },
    null,
  );
  return { board, hist: join(board, 'history'), src };
}

describe('Source', () => {
  it('follows the day files across UTC midnight, reading only what is new', () => {
    const { hist, src } = setup();
    writeFileSync(join(hist, 'samples-2026-11-07.jsonl'), sample('2026-11-07T23:59:30Z'));
    let s = src.refresh(Date.parse('2026-11-07T23:59:45Z'));
    expect(s.points.map((p) => p.t)).toEqual([Date.parse('2026-11-07T23:59:30Z')]);
    writeFileSync(join(hist, 'samples-2026-11-08.jsonl'), sample('2026-11-08T00:00:00Z', 2));
    appendFileSync(join(hist, 'samples-2026-11-08.jsonl'), sample('2026-11-08T00:00:30Z', 3));
    s = src.refresh(Date.parse('2026-11-08T00:00:40Z'));
    expect(s.points.map((p) => p.cpu)).toEqual([1, 2, 3]);
    expect(s.gauges!.cpu).toBe(3);
    // 24 h later the first day's tick has aged out
    s = src.refresh(Date.parse('2026-11-08T23:59:40Z'));
    expect(s.points.map((p) => p.cpu)).toEqual([2, 3]);
  });

  it('a bad cpu tick is unknown in the chart and the gauge', () => {
    const { hist, src } = setup();
    writeFileSync(join(hist, 'samples-2026-11-08.jsonl'), sample('2026-11-08T05:38:53Z', 62763.68));
    const s = src.refresh(Date.parse('2026-11-08T05:39:00Z'));
    expect(s.points[0]!.cpu).toBeNull();
    expect(s.gauges!.cpu).toBeNull();
  });

  it('feeds the lock changes it sees, and only for 24 h', () => {
    const { board, src } = setup();
    const t0 = Date.parse('2026-11-08T00:00:00Z');
    writeFileSync(join(board, 'devlock.json'), lock('a-branch'));
    expect(src.refresh(t0).lockFeed).toEqual([]); // the first read is the baseline, not a change
    writeFileSync(join(board, 'devlock.json'), lock(null));
    let s = src.refresh(t0 + 60000);
    expect(s.lockFeed.map((f) => f.text)).toEqual(['lock: free (was a-branch)']);
    writeFileSync(join(board, 'devlock.json'), lock('b-branch\n🚀'));
    s = src.refresh(t0 + 120000);
    expect(s.lockFeed.map((f) => f.text)).toEqual([
      'lock: free (was a-branch)',
      'lock: b-branch? until 17:00'.replace('17:00', s.lockFeed[1]!.text.slice(-5)),
    ]);
    expect(s.lock!.branch).toBe('b-branch?');
    expect(src.refresh(t0 + 25 * 3600000).lockFeed).toEqual([]);
  });

  it('carries why the last refresh failed, only while it is failing', () => {
    const { board, src } = setup();
    const t0 = Date.parse('2026-11-08T00:00:00Z');
    const f = { v: 1, t: '2026-11-08T00:00:00Z', holder: null, failedWhy: 'ls-remote: denied' };
    writeFileSync(
      join(board, 'devlock.json'),
      JSON.stringify({ ...f, failedAt: '2026-11-08T00:01:00Z' }),
    );
    expect(src.refresh(t0).lock).toMatchObject({ failed: true, failedWhy: 'ls-remote: denied' });
    writeFileSync(join(board, 'devlock.json'), JSON.stringify(f)); // a reason with no failedAt is not a failure
    expect(src.refresh(t0 + 60000).lock).toMatchObject({ failed: false, failedWhy: null });
  });

  it('a garbled read time is null (unknown), never NaN (which reads as fresh)', () => {
    const { board, src } = setup();
    writeFileSync(join(board, 'devlock.json'), JSON.stringify({ v: 1, t: 'soon', holder: null }));
    expect(src.refresh(Date.parse('2026-11-08T00:00:00Z')).lock!.asOf).toBeNull();
  });

  it("reads slot B's cache on its own, and feeds its changes as `lock devb:`", () => {
    const { board, src } = setup();
    const t0 = Date.parse('2026-11-08T00:00:00Z');
    writeFileSync(join(board, 'devlock.json'), lock('a-branch'));
    expect(src.refresh(t0).lockB).toBeNull(); // no devb cache yet
    writeFileSync(join(board, 'devlock.devb.json'), lock('b-branch'));
    let s = src.refresh(t0 + 60000);
    expect(s.lock!.branch).toBe('a-branch');
    expect(s.lockB!.branch).toBe('b-branch');
    expect(s.lockFeed).toEqual([]); // devb's first read is its baseline too
    writeFileSync(join(board, 'devlock.devb.json'), lock(null));
    s = src.refresh(t0 + 120000);
    expect(s.lockFeed.map((f) => f.text)).toEqual(['lock devb: free (was b-branch)']);
    expect(s.lock!.branch).toBe('a-branch');
  });

  it('lease events join the feed and age out after 24 h', () => {
    const { hist, src } = setup();
    writeFileSync(
      join(hist, 'events-2026-11-08.jsonl'),
      JSON.stringify({
        v: 1,
        t: '2026-11-08T01:00:00Z',
        kind: 'lease',
        lease: 'heavy',
        action: 'gaveUp',
        name: 'a',
        class: 'test',
      }) + '\n',
    );
    expect(src.refresh(Date.parse('2026-11-08T02:00:00Z')).leaseFeed).toMatchObject([
      { kind: 'lease', text: 'heavy gaveUp  a test', tone: 'bad' },
    ]);
    expect(src.refresh(Date.parse('2026-11-09T02:00:00Z')).leaseFeed).toEqual([]);
  });

  it('keeps full runs past 7 days for the TTL proof, pruning the rest', () => {
    const { src } = setup();
    const rec = (run: string, op: string, t: string, status?: string) =>
      JSON.stringify({ t, run, op, status }) + '\n';
    writeFileSync(
      join(dir, 'ledger.jsonl'),
      rec('2026-10-28T01-00-00-full', 'run-start', '2026-10-28T01:00:00Z') +
        rec('2026-10-28T01-00-00-full', 'run-end', '2026-10-28T01:10:00Z', 'PASS') +
        rec('2026-10-28T02-00-00-delta', 'run-start', '2026-10-28T02:00:00Z') +
        rec('2026-10-28T02-00-00-delta', 'run-end', '2026-10-28T02:10:00Z', 'PASS') +
        rec('2026-11-07T01-00-00-full', 'run-end', '2026-11-07T01:10:00Z', 'PASS'),
    );
    const s = src.refresh(Date.parse('2026-11-08T06:00:00Z'));
    expect(s.runs.map((r) => r.run)).toEqual([
      '2026-10-28T01-00-00-full',
      '2026-11-07T01-00-00-full',
    ]);
  });

  it("folds slot B's ledger in, each run tagged with its slot", () => {
    const { src } = setup();
    const rec = (run: string, op: string, t: string, status?: string) =>
      JSON.stringify({ t, run, op, status }) + '\n';
    writeFileSync(
      join(dir, 'ledger.jsonl'),
      rec('2026-11-08T01-00-00-full', 'run-end', '2026-11-08T01:10:00Z', 'PASS'),
    );
    writeFileSync(
      join(dir, 'ledger.devb.jsonl'),
      rec('2026-11-08T02-00-00-full', 'run-start', '2026-11-08T02:00:00Z'),
    );
    const s = src.refresh(Date.parse('2026-11-08T06:00:00Z'));
    expect(s.runs.map((r) => [r.run, r.slot])).toEqual([
      ['2026-11-08T01-00-00-full', 'dev'],
      ['2026-11-08T02-00-00-full', 'devb'],
    ]);
  });
});

describe('parseConflicts (overlap.json)', () => {
  const file = (o: Record<string, unknown>) => JSON.stringify({ v: 1, pairs: [], ...o });
  it('reads the merge-tree conflicts and the file time', () => {
    expect(
      parseConflicts(
        file({
          t: '2026-11-08T06:08:00.123Z',
          conflicts: [{ a: 'x', b: 'main', files: ['a.ts'] }],
        }),
      ),
    ).toEqual({
      at: Date.parse('2026-11-08T06:08:00.123Z'),
      list: [{ a: 'x', b: 'main', files: ['a.ts'] }],
    });
  });
  it('is null for a file from before the check, undefined for one that is not JSON', () => {
    expect(parseConflicts(file({ t: '2026-11-08T06:08:00Z' }))).toBeNull();
    expect(parseConflicts(file({ conflicts: {} }))).toBeNull();
    expect(parseConflicts('[]')).toBeNull();
    expect(parseConflicts('null')).toBeNull();
    expect(parseConflicts('{')).toBeUndefined();
    expect(parseConflicts('')).toBeUndefined();
  });
  it('drops malformed entries, cleans what it prints, and reads a garbled time as none', () => {
    expect(
      parseConflicts(
        file({
          t: 'soon',
          conflicts: [
            null,
            { a: 'x', b: 'main' },
            { a: 'x', b: 2, files: [] },
            { a: 'x', b: 'y', files: ['ok.ts', 3] },
            { a: 'x\u001b[31m', b: 'y\tz', files: ['f\u0007.ts'] },
          ],
        }),
      ),
    ).toEqual({ at: null, list: [{ a: 'x[31m', b: 'y z', files: ['f.ts'] }] });
  });
});

describe('Source: overlap.json', () => {
  const overlap = (a: string) =>
    JSON.stringify({
      v: 1,
      t: '2026-11-08T00:00:00Z',
      conflicts: [{ a, b: 'main', files: ['f'] }],
    });
  it('reads it on refresh, keeps the last list over a torn read, and clears on delete or an old file', () => {
    const { board, src } = setup();
    const t0 = Date.parse('2026-11-08T00:01:00Z');
    const f = join(board, 'overlap.json');
    expect(src.refresh(t0).conflicts).toBeNull(); // no file
    writeFileSync(f, overlap('lane-a'));
    expect(src.refresh(t0).conflicts!.list.map((c) => c.a)).toEqual(['lane-a']);
    writeFileSync(f, '{"v":1,"conf'); // torn: the last list stays
    expect(src.refresh(t0).conflicts!.list.map((c) => c.a)).toEqual(['lane-a']);
    writeFileSync(f, overlap('lane-bb'));
    expect(src.refresh(t0).conflicts!.list.map((c) => c.a)).toEqual(['lane-bb']);
    writeFileSync(f, JSON.stringify({ v: 1, pairs: [] })); // written before the check: nothing to show
    expect(src.refresh(t0).conflicts).toBeNull();
    writeFileSync(f, overlap('lane-ccc'));
    expect(src.refresh(t0).conflicts).not.toBeNull();
    rmSync(f);
    expect(src.refresh(t0).conflicts).toBeNull();
  });
});
