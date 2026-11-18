import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OWNER, REPO } from './bot/config';
import { fakeClock } from './bot/fakes';
import { CEILING_MS, MAX_ERRORS, SETTLE_MS, run } from './main-dev-wait';

// deploy.yml's wait jobs run this against the real API only on main; here a scripted fetch stands in for GitHub.
const R = `/repos/${OWNER}/${REPO}`;
const T0 = Date.parse('2026-11-17T20:00:00Z');
const MIN = 60_000;
const sha = 'a'.repeat(40);
const holder = (branch: string, expiresAt: number) =>
  JSON.stringify({ branch, sha, expiresAt: new Date(expiresAt).toISOString() });

type Answer = { status: number; body?: unknown };
// One answer per lock read: the ref and, when it's a tag, its message. `lock(n)` decides the nth read.
const lockFetch = (
  slot: string,
  lock: (n: number, now: number) => Answer | string | null,
  now: () => number,
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
    return reply({ status: 599, body: { message: `unrouted ${path}` } });
  }) as typeof fetch;
  return { fetchImpl, paths, reads: () => n };
};

function harness(
  lock: (n: number, now: number) => Answer | string | null,
  argv: string[] = ['dev'],
  env: NodeJS.ProcessEnv = { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: `${OWNER}/${REPO}` },
) {
  const clock = fakeClock(T0);
  const f = lockFetch(argv[0] ?? 'dev', lock, clock.now);
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
    expect(h.lines).toEqual(['dev lock probe: lane-x @ aaaaaaa — read with the job token']);
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
