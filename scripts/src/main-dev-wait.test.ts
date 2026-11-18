import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OWNER, REPO } from './bot/config';
import type { Run } from './bot/dispatch';
import { fakeClock } from './bot/fakes';
import {
  CEILING_MS,
  FLOOR_MS,
  MAX_ERRORS,
  SETTLE_MS,
  WALK_MAX,
  cancelledBefore,
  deadlineOf,
  run,
} from './main-dev-wait';

// deploy.yml's wait jobs run this against the real API only on main; here a scripted fetch stands in for GitHub.
const R = `/repos/${OWNER}/${REPO}`;
const T0 = Date.parse('2026-11-17T20:00:00Z');
const MIN = 60_000;
const sha = 'a'.repeat(40);
const holder = (branch: string, expiresAt: number) =>
  JSON.stringify({ branch, sha, expiresAt: new Date(expiresAt).toISOString() });

type Answer = { status: number; body?: unknown };
// main's Deploy runs (the cap's anchor) and each run's job count; a bare Answer stands in for a failed listing.
interface Runs {
  runs?: Run[] | Answer;
  jobs?: Record<number, number>;
}
const mainRun = (id: number, at: number, conclusion: string | null, status = 'completed'): Run => ({
  id,
  display_title: `merge ${id}`,
  created_at: new Date(at).toISOString(),
  status,
  conclusion,
  html_url: `https://github.com/x/y/actions/runs/${id}`,
  head_sha: String(id).padStart(7, 'c') + 'f'.repeat(33),
});
// One answer per lock read: the ref and, when it's a tag, its message. `lock(n)` decides the nth read.
const lockFetch = (
  slot: string,
  lock: (n: number, now: number) => Answer | string | null,
  now: () => number,
  { runs = [], jobs = {} }: Runs = {},
) => {
  let n = 0;
  const paths: string[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const path = String(url).replace('https://api.github.com', '');
    paths.push(path);
    // every request carries its own timeout, so a hung read can't hold the job to its step timeout
    if (!(init?.signal instanceof AbortSignal)) throw new Error(`no signal on ${path}`);
    const reply = (a: Answer) =>
      new Response(a.body === undefined ? '' : JSON.stringify(a.body), { status: a.status });
    if (path === `${R}/git/ref/locks/${slot}`) {
      const a = lock(n++, now());
      if (a === null) return reply({ status: 404, body: { message: 'Not Found' } });
      if (typeof a !== 'string') return reply(a);
      return reply({ status: 200, body: { object: { sha: `tag${n}`, type: 'tag' } } });
    }
    const tag = /\/git\/tags\/tag(\d+)$/.exec(path);
    if (tag) return reply({ status: 200, body: { message: lock(Number(tag[1]) - 1, now()) } });
    if (path === `${R}/actions/workflows/deploy.yml/runs?per_page=30&event=push&branch=main`)
      return reply(Array.isArray(runs) ? { status: 200, body: { workflow_runs: runs } } : runs);
    const jobsOf = /\/actions\/runs\/(\d+)\/jobs\?per_page=50$/.exec(path);
    if (jobsOf) {
      const n = jobs[Number(jobsOf[1])] ?? 0;
      return reply({
        status: 200,
        body: { jobs: Array.from({ length: n }, (_, i) => ({ name: `j${i}` })) },
      });
    }
    return reply({ status: 599, body: { message: `unrouted ${path}` } });
  }) as typeof fetch;
  return { fetchImpl, paths, reads: () => n };
};

const ENV = { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: `${OWNER}/${REPO}` };
function harness(
  lock: (n: number, now: number) => Answer | string | null,
  argv: string[] = ['dev'],
  env: NodeJS.ProcessEnv = ENV,
  runs: Runs = {},
) {
  const clock = fakeClock(T0);
  const f = lockFetch(argv[0] ?? 'dev', lock, clock.now, runs);
  const lines: string[] = [];
  const summaries: string[] = [];
  const go = () =>
    run({
      argv,
      env,
      fetchImpl: f.fetchImpl,
      clock,
      log: (l) => lines.push(l),
      summary: (md) => summaries.push(md),
    });
  return { clock, lines, summaries, go, ...f };
}

describe('main-dev-wait', () => {
  it('deploys at once when the lock is free (404), with nothing loud', async () => {
    const readAt: number[] = [];
    const h = harness((_n, now) => (readAt.push(now), null));
    expect(await h.go()).toBe(0);
    // the first read comes only after the settle, past any jobs-API lag the bot's guard reads through
    expect(readAt).toEqual([T0 + SETTLE_MS]);
    expect(h.clock.t).toBe(T0 + SETTLE_MS);
    expect(h.lines.at(-1)).toBe('dev lock free — deploying');
    expect(h.summaries).toEqual([]);
  });

  it('waits on a held lock, polling every 30 s, and deploys when it is released', async () => {
    const h = harness((n, now) => (n < 2 ? holder('lane-x', now + 40 * MIN) : null));
    expect(await h.go()).toBe(0);
    expect(h.clock.t).toBe(T0 + SETTLE_MS + 60_000);
    expect(h.lines.some((l) => l.startsWith('waiting: dev locked by lane-x @ aaaaaaa'))).toBe(true);
    expect(h.lines.at(-1)).toBe(
      '::notice title=dev deploy waited for its lock::1 min; released — deploying',
    );
    expect(h.summaries).toEqual([]);
  });

  it("wakes at the holder's expiry and deploys over a lapsed lock", async () => {
    const h = harness(() => holder('lane-x', T0 + 2 * MIN + 10_000));
    expect(await h.go()).toBe(0);
    // settles 20 s, polls at 0:50, 1:20, 1:50, then wakes 1 s past the expiry, not at the 2:20 tick
    expect(h.clock.t).toBe(T0 + 2 * MIN + 10_000 + 1000);
    expect(h.lines.at(-1)).toContain("lane-x @ aaaaaaa's lock lapsed — deploying");
  });

  it("waits on slot B's own lock for devb", async () => {
    const h = harness((n) => (n < 1 ? holder('lane-y', T0 + 40 * MIN) : null), ['devb']);
    expect(await h.go()).toBe(0);
    expect(h.paths.every((p) => p.includes('locks/devb') || p.includes('/git/tags/'))).toBe(true);
    expect(h.lines.at(-1)).toContain('devb deploy waited');
  });

  it('goes after the ceiling against a lock renewed past its TTL, loudly', async () => {
    const h = harness((_n, now) => holder('lane-x', now + 40 * MIN));
    expect(await h.go()).toBe(0);
    expect(h.clock.t).toBe(T0 + SETTLE_MS + CEILING_MS);
    const warn = h.lines.find((l) => l.startsWith('::warning '));
    expect(warn).toContain('dev deploy waited 60 min and went anyway');
    expect(warn).toContain('lane-x @ aaaaaaa');
    expect(h.summaries.join('')).toContain('mid-test');
  });

  it('treats a garbled lock as lapsed, never as held', async () => {
    const h = harness(() => 'not json');
    expect(await h.go()).toBe(0);
    expect(h.clock.t).toBe(T0 + SETTLE_MS);
    expect(h.lines.at(-1)).toContain("an unreadable holder's lock lapsed");
  });

  it(`deploys, loudly, after ${MAX_ERRORS} failed reads in a row`, async () => {
    const h = harness(() => ({ status: 502, body: { message: 'Bad Gateway' } }));
    expect(await h.go()).toBe(0);
    expect(h.reads()).toBe(MAX_ERRORS);
    expect(h.lines.find((l) => l.startsWith('::warning '))).toContain('could not read its lock');
    expect(h.summaries.join('')).toContain(`${MAX_ERRORS} failed reads`);
  });

  it('rides out fewer failed reads and keeps waiting', async () => {
    const h = harness((n) => (n < MAX_ERRORS - 1 ? { status: 502 } : null));
    expect(await h.go()).toBe(0);
    expect(h.lines.some((l) => l.startsWith('::warning '))).toBe(false);
    expect(h.lines.at(-1)).toContain('released — deploying');
  });

  it('neutralises a hostile holder in the log, the annotation and the summary', async () => {
    const evil = 'x\n::error::pwned\r%0A::add-mask::y';
    const h = harness((_n, now) => holder(evil, now + 40 * MIN));
    expect(await h.go()).toBe(0);
    for (const l of h.lines) {
      // eslint-disable-next-line no-control-regex -- asserting none got through
      expect(l).not.toMatch(/[\u0000-\u001f]/);
      expect(l.startsWith('::error') || l.startsWith('::add-mask')).toBe(false);
    }
    const loud = [...h.lines.filter((l) => l.startsWith('::')), ...h.summaries].join('\n');
    expect(loud).not.toContain('::error');
    expect(loud).not.toContain('::add-mask');
    expect(loud).toContain('x???error??pwned??0A??add-mask??y');
  });

  it('--once reads the lock once and never sleeps', async () => {
    const h = harness((_n, now) => holder('lane-x', now + 40 * MIN), ['dev', '--once']);
    expect(await h.go()).toBe(0);
    expect(h.reads()).toBe(1);
    expect(h.clock.t).toBe(T0);
    expect(h.lines).toEqual([
      'dev lock probe: lane-x @ aaaaaaa — read with the job token',
      'wait-cap probe: no main Deploy runs listed — read with the job token',
    ]);
  });

  it('--once warns, never fails, when the read fails', async () => {
    const h = harness(
      () => ({ status: 403, body: { message: 'Resource not accessible' } }),
      ['devb', '--once'],
    );
    expect(await h.go()).toBe(0);
    expect(h.lines[0]).toMatch(/^::warning title=devb lock probe failed::.*403/);
  });

  it('reads nothing and says so when the run is another repo', async () => {
    const h = harness(() => null, ['dev'], {
      GITHUB_TOKEN: 't',
      GITHUB_REPOSITORY: 'someone/fork',
    });
    expect(await h.go()).toBe(0);
    expect(h.paths).toEqual([]);
    expect(h.lines[0]).toMatch(/^::warning title=dev deploy did not wait::/);
    const probe = harness(() => null, ['dev', '--once'], {
      GITHUB_TOKEN: 't',
      GITHUB_REPOSITORY: 'someone/fork',
    });
    expect(await probe.go()).toBe(0);
    expect(probe.paths).toEqual([]);
    expect(probe.lines).toEqual([
      'dev lock probe skipped: this run is someone/fork, identifiers.json names another repo',
    ]);
    expect(probe.summaries).toEqual([]);
  });

  it.each([[[]], [['prod']], [['dev', '--wait']], [['dev', '--once', 'x']]])(
    'exits 1 on misuse: %j',
    async (argv) => {
      const h = harness(() => null, argv);
      expect(await h.go()).toBe(1);
      expect(h.paths).toEqual([]);
    },
  );

  it('exits 1 without a token', async () => {
    const h = harness(() => null, ['dev'], { GITHUB_REPOSITORY: `${OWNER}/${REPO}` });
    expect(await h.go()).toBe(1);
  });

  // CI runs it with no install: the import chain (bot/lock.ts → config.ts → identifiers.ts …) must load under plain node.
  it('loads and runs under plain node, with only PATH', () => {
    const cli = fileURLToPath(new URL('./main-dev-wait.ts', import.meta.url));
    let status = 0;
    let out = '';
    try {
      execFileSync(process.execPath, [cli, 'nope'], {
        env: { PATH: process.env.PATH },
        stdio: 'pipe',
      });
    } catch (err) {
      const e = err as { status: number; stdout: Buffer };
      status = e.status;
      out = e.stdout.toString();
    }
    expect(status).toBe(1);
    expect(out).toContain('usage: main-dev-wait.ts <dev|devb> [--once]');
  });
});

// The cap is shared by the merges a run carries (CI-BOT.md → A merge waits for the lock): tonight's shape (2026-11-17)
// was one run waiting, four merges superseded while pending (cancelled, no jobs), and the newest carrying them all.
describe('main-dev-wait: the cap counts from the oldest merge riding in the run', () => {
  const SELF = 100;
  const START = T0 + SETTLE_MS;
  const RUN_ENV = { ...ENV, GITHUB_RUN_ID: String(SELF), GITHUB_RUN_ATTEMPT: '1' };
  const tonight = () => [
    mainRun(101, T0 - 1 * MIN, null, 'pending'), // the next merge, queued behind this run
    mainRun(SELF, T0 - 12 * MIN, null, 'in_progress'),
    mainRun(99, T0 - 15 * MIN, 'cancelled'),
    mainRun(98, T0 - 25 * MIN, 'cancelled'),
    mainRun(97, T0 - 30 * MIN, 'cancelled'),
    mainRun(96, T0 - 31 * MIN, 'cancelled'),
    mainRun(95, T0 - 32 * MIN, 'success'), // waited, then deployed: the queue starts after it
    mainRun(94, T0 - 90 * MIN, 'cancelled'), // behind a finished run: never reached
  ];
  const held = (_n: number, now: number) => holder('lane-x', now + 40 * MIN);
  const jobReads = (paths: string[]) =>
    paths.flatMap((p) => /\/runs\/(\d+)\/jobs/.exec(p)?.[1] ?? []).map(Number);

  it('cancelledBefore: the cancelled runs just before this one, newest first, in id order whatever the listing', () => {
    const ids = (rs: Run[]) => rs.map((r) => r.id);
    expect(ids(cancelledBefore(tonight(), SELF))).toEqual([99, 98, 97, 96]);
    expect(ids(cancelledBefore(tonight().reverse(), SELF))).toEqual([99, 98, 97, 96]);
    expect(
      cancelledBefore([mainRun(99, T0, 'failure'), mainRun(98, T0, 'cancelled')], SELF),
    ).toEqual([]);
    expect(cancelledBefore([mainRun(99, T0, null, 'in_progress')], SELF)).toEqual([]);
    expect(cancelledBefore([mainRun(101, T0, 'cancelled')], SELF)).toEqual([]);
  });

  it('deadlineOf: 60 min from the oldest merge, never under 15 from the start, 60 from the start without one', () => {
    expect(deadlineOf(null, START)).toBe(START + CEILING_MS);
    expect(deadlineOf(START - 10 * MIN, START)).toBe(START + 50 * MIN);
    expect(deadlineOf(START - 50 * MIN, START)).toBe(START + FLOOR_MS);
    expect(deadlineOf(START - 90 * MIN, START)).toBe(START + FLOOR_MS);
    expect(deadlineOf(START + 5 * MIN, START)).toBe(START + CEILING_MS); // a runner clock behind GitHub's
  });

  it("gives up 60 min after the oldest superseded merge, not 60 after this run's own wait starts", async () => {
    const h = harness(held, ['dev'], RUN_ENV, { runs: tonight() });
    expect(await h.go()).toBe(0);
    expect(h.clock.t).toBe(T0 - 31 * MIN + CEILING_MS);
    expect(jobReads(h.paths)).toEqual([99, 98, 97, 96]);
    expect(h.lines).toContain(
      'dev: cap 20:29 UTC — 60 min from the oldest merge riding here, ccccc96 at 19:29 UTC (4 superseded runs ride here)',
    );
    const warn = h.lines.find((l) => l.startsWith('::warning '));
    expect(warn).toContain('dev deploy waited 29 min and went anyway');
    expect(warn).toContain('ccccc96 at 19:29 UTC');
    expect(h.summaries.join('')).toContain('mid-test');
  });

  it('stops the walk at a run cancelled with jobs (cancelled mid-run, not superseded)', async () => {
    const h = harness(held, ['dev'], RUN_ENV, { runs: tonight(), jobs: { 98: 3 } });
    expect(await h.go()).toBe(0);
    expect(jobReads(h.paths)).toEqual([99, 98]);
    expect(h.clock.t).toBe(T0 - 15 * MIN + CEILING_MS);
    expect(h.lines).toContain(
      'dev: cap 20:45 UTC — 60 min from the oldest merge riding here, ccccc99 at 19:45 UTC (1 superseded run ride here)',
    );
  });

  it('with nothing superseded, counts from its own merge', async () => {
    const runs = [
      mainRun(SELF, T0 - 5 * MIN, null, 'in_progress'),
      mainRun(99, T0 - 9 * MIN, 'success'),
    ];
    const h = harness(held, ['dev'], RUN_ENV, { runs });
    expect(await h.go()).toBe(0);
    expect(jobReads(h.paths)).toEqual([]);
    expect(h.clock.t).toBe(T0 + 55 * MIN);
  });

  it(`reads at most ${WALK_MAX} superseded runs' jobs, then waits from the oldest it read`, async () => {
    const runs = [
      mainRun(SELF, T0 - 2 * MIN, null, 'in_progress'),
      ...Array.from({ length: 15 }, (_, i) => mainRun(99 - i, T0 - (3 + i) * MIN, 'cancelled')),
    ];
    const h = harness(held, ['dev'], RUN_ENV, { runs });
    expect(await h.go()).toBe(0);
    expect(jobReads(h.paths)).toHaveLength(WALK_MAX);
    expect(h.clock.t).toBe(T0 - (3 + WALK_MAX - 1) * MIN + CEILING_MS);
  });

  it('a queue already past the cap still waits the 15-minute minimum for a held lock', async () => {
    const runs = [
      mainRun(SELF, T0 - 70 * MIN, null, 'in_progress'),
      mainRun(99, T0 - 120 * MIN, 'cancelled'),
    ];
    const h = harness(held, ['dev'], RUN_ENV, { runs });
    expect(await h.go()).toBe(0);
    expect(h.clock.t).toBe(START + FLOOR_MS);
    expect(h.lines.find((l) => l.startsWith('::warning '))).toContain(
      'the 15-minute minimum (the oldest merge riding here, ccccc99, merged at 18:00 UTC)',
    );
  });

  it('a queue past the cap deploys quietly when the lock is free', async () => {
    const runs = [mainRun(SELF, T0 - 120 * MIN, null, 'in_progress')];
    const h = harness(() => null, ['dev'], RUN_ENV, { runs });
    expect(await h.go()).toBe(0);
    expect(h.lines.at(-1)).toBe('dev lock free — deploying');
    expect(h.summaries).toEqual([]);
  });

  it(`a queue past the cap still gets ${MAX_ERRORS} tries at a failing lock read`, async () => {
    const runs = [mainRun(SELF, T0 - 120 * MIN, null, 'in_progress')];
    const h = harness(() => ({ status: 502 }), ['dev'], RUN_ENV, { runs });
    expect(await h.go()).toBe(0);
    expect(h.reads()).toBe(MAX_ERRORS);
    expect(h.lines.find((l) => l.startsWith('::warning '))).toContain('could not read its lock');
  });

  it('falls back to 60 min from its own start, with a warning, when the runs listing fails', async () => {
    const h = harness(held, ['dev'], RUN_ENV, {
      runs: { status: 403, body: { message: 'Resource not accessible' } },
    });
    expect(await h.go()).toBe(0);
    expect(h.lines.find((l) => l.startsWith('::warning title=dev wait cap fell back::'))).toContain(
      '403',
    );
    expect(h.clock.t).toBe(START + CEILING_MS);
    expect(h.lines.find((l) => l.startsWith('::warning title=dev deploy waited'))).toContain(
      'dev deploy waited 60 min and went anyway',
    );
  });

  it('falls back, with a warning, when this run is not in the listing', async () => {
    const h = harness(held, ['dev'], { ...RUN_ENV, GITHUB_RUN_ID: '555' }, { runs: tonight() });
    expect(await h.go()).toBe(0);
    expect(h.lines.find((l) => l.startsWith('::warning title=dev wait cap fell back::'))).toContain(
      "run 555 isn't among main's newest 30 Deploy runs",
    );
    expect(h.clock.t).toBe(START + CEILING_MS);
  });

  it.each([
    [
      'a re-run',
      { ...RUN_ENV, GITHUB_RUN_ATTEMPT: '2' },
      "dev: a re-run — the cap counts from this wait's start",
    ],
    ['no run id', ENV, "dev: no GITHUB_RUN_ID — the cap counts from this wait's start"],
    [
      'a garbled run id',
      { ...RUN_ENV, GITHUB_RUN_ID: '12abc' },
      "dev: no GITHUB_RUN_ID — the cap counts from this wait's start",
    ],
  ])('%s: never lists runs, and counts 60 min from its own start', async (_name, env, line) => {
    const h = harness(held, ['dev'], env, { runs: tonight() });
    expect(await h.go()).toBe(0);
    expect(h.paths.some((p) => p.includes('/actions/'))).toBe(false);
    expect(h.lines).toContain(line);
    expect(h.clock.t).toBe(START + CEILING_MS);
  });

  it("neutralises a hostile run's head_sha in every line", async () => {
    const runs = tonight().map((r) => (r.id === 96 ? { ...r, head_sha: 'x\n::error::pwned' } : r));
    const h = harness(held, ['dev'], RUN_ENV, { runs });
    expect(await h.go()).toBe(0);
    for (const l of [...h.lines, ...h.summaries]) {
      expect(l).not.toContain('::error');
      expect(l).not.toContain('pwned');
    }
    expect(h.lines).toContain(
      'dev: cap 20:29 UTC — 60 min from the oldest merge riding here, ??????? at 19:29 UTC (4 superseded runs ride here)',
    );
  });

  it("--once also lists main's runs and says what the newest would wait from", async () => {
    const h = harness(() => null, ['devb', '--once'], ENV, { runs: tonight() });
    expect(await h.go()).toBe(0);
    expect(h.clock.t).toBe(T0);
    expect(h.lines).toEqual([
      'devb lock probe: free — read with the job token',
      "wait-cap probe: 8 main Deploy runs listed; the newest (cccc101) would wait from cccc101's merge at 19:59 UTC, 0 superseded riding — read with the job token",
    ]);
  });

  it('--once warns, never fails, when the runs listing fails', async () => {
    const h = harness(() => null, ['dev', '--once'], ENV, { runs: { status: 403 } });
    expect(await h.go()).toBe(0);
    expect(h.lines[1]).toMatch(/^::warning title=wait-cap probe failed::.*403/);
  });
});
