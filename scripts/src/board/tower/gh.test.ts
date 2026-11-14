import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ChecksCache,
  FilesCache,
  MinutesCache,
  Poller,
  jobMinutes,
  monthKey,
  parseRuns,
} from './gh.ts';

const runJson = (o: object) => ({
  id: 1,
  name: 'PR',
  event: 'pull_request',
  head_branch: 'x',
  head_sha: 'e'.repeat(40),
  status: 'completed',
  conclusion: 'success',
  run_started_at: '2026-11-13T19:00:00Z',
  created_at: '2026-11-13T19:00:00Z',
  html_url: 'https://github.com/radatta/aperture/actions/runs/1',
  run_number: 3,
  ...o,
});
const page = (runs: object[]) => JSON.stringify({ total_count: runs.length, workflow_runs: runs });

describe('parseRuns', () => {
  it('reads the fields the tower uses and drops a non-GitHub url', () => {
    const [r] = parseRuns(page([runJson({ html_url: 'https://evil.example/x' })]));
    expect(r).toMatchObject({
      id: 1,
      name: 'PR',
      sha: 'e'.repeat(40),
      status: 'completed',
      url: null,
      number: 3,
    });
    expect(() => parseRuns('{}')).toThrow(/no workflow_runs/);
  });
});

describe('Poller', () => {
  it('one at a time, at most once per interval; a failure keeps the last value with the error', async () => {
    let n = 0;
    let fail = false;
    const p = new Poller<number>(
      0,
      async () => {
        if (fail) throw new Error('HTTP 502: Bad Gateway\nmore');
        return ++n;
      },
      60000,
    );
    await p.poll(0);
    await p.poll(30000);
    expect(p.state).toMatchObject({ value: 1, at: 0, error: null });
    fail = true;
    await p.poll(60000);
    expect(p.state).toMatchObject({ value: 1, at: 0, error: 'HTTP 502: Bad Gateway' });
  });
});

describe('ChecksCache', () => {
  it('keeps the newest run per workflow and re-reads every minute until all finished, then every 10 min', async () => {
    const calls: string[] = [];
    let runs = [
      runJson({ id: 1, name: 'PR', conclusion: 'failure', created_at: '2026-11-13T18:00:00Z' }),
      runJson({ id: 2, name: 'PR', status: 'in_progress', conclusion: null }),
    ];
    const c = new ChecksCache(async (a) => (calls.push(a.join(' ')), page(runs)));
    const sha = 'e'.repeat(40);
    await c.want(sha, 0);
    expect(c.get(sha)!.runs.map((r) => r.id)).toEqual([2]);
    expect(calls[0]).toContain(`head_sha=${sha}&event=pull_request`);
    await c.want(sha, 30000);
    expect(calls).toHaveLength(1);
    runs = [runJson({ id: 2 })];
    await c.want(sha, 60000);
    expect(calls).toHaveLength(2);
    await c.want(sha, 120000);
    expect(calls).toHaveLength(2);
    await c.want(sha, 660000);
    expect(calls).toHaveLength(3);
  });
});

describe('FilesCache', () => {
  it('reads a PR’s files once per head sha; a moved head is an error, read again next time', async () => {
    let head = 'a'.repeat(40);
    let n = 0;
    const f = new FilesCache(
      async () => (n++, JSON.stringify({ headRefOid: head, files: [{ path: 'cdk/x.ts' }] })),
    );
    await f.want(5, 'a'.repeat(40));
    await f.want(5, 'a'.repeat(40));
    expect(f.get('a'.repeat(40))).toEqual({ files: ['cdk/x.ts'], error: null });
    expect(n).toBe(1);
    head = 'c'.repeat(40);
    await f.want(5, 'b'.repeat(40));
    expect(f.get('b'.repeat(40))).toEqual({ files: null, error: 'head moved' });
  });
});

describe('Actions minutes estimate', () => {
  it('rounds each job up to a whole minute', () => {
    const jobs = JSON.stringify({
      jobs: [
        { started_at: '2026-11-13T19:00:00Z', completed_at: '2026-11-13T19:00:05Z' },
        { started_at: '2026-11-13T19:00:00Z', completed_at: '2026-11-13T19:02:00Z' },
        { started_at: '2026-11-13T19:00:00Z', completed_at: null },
      ],
    });
    expect(jobMinutes(jobs)).toBe(3);
  });
  it('counts at most perCycle new runs per load, caches them on disk, and starts over each month', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'min-')), 'tower/actions-runs.json');
    const ids = [11, 12, 13];
    const calls: string[] = [];
    const gh = async (a: string[]) => {
      const route = a[1]!;
      calls.push(route);
      if (route.includes('/jobs'))
        return JSON.stringify({
          jobs: [{ started_at: '2026-11-13T19:00:00Z', completed_at: '2026-11-13T19:01:30Z' }],
        });
      return page(ids.map((id) => runJson({ id })));
    };
    const now = Date.parse('2026-11-13T20:00:00Z');
    const m = new MinutesCache(file, gh, 2);
    expect(await m.load(now)).toEqual({
      month: '2026-11',
      minutes: 4,
      counted: 2,
      total: 3,
      capped: false,
    });
    expect(calls[0]).toContain(`created=>=2026-11-01`);
    expect(await new MinutesCache(file, gh, 2).load(now)).toMatchObject({ minutes: 6, counted: 3 });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ v: 1, month: '2026-11' });
    calls.length = 0;
    await new MinutesCache(file, gh, 5).load(Date.parse('2026-12-01T09:00:00Z'));
    expect(calls.filter((c) => c.includes('/jobs'))).toHaveLength(3);
    expect(monthKey(Date.parse('2026-12-01T09:00:00Z'))).toBe('2026-12');
  });
});
