import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { fakeRun } from '../bot/fakes.ts';
import {
  BUDGET,
  NARROW_BUDGET,
  NARROW_WORKERS,
  SCRIPTS_COST,
  WIDE_WORKERS,
  isWide,
  main,
  outerEnv,
  reconcile,
  parseArgs,
  readDiff,
  schedule,
  spawnExec,
  spawnOuter,
  stepEnv,
  steps,
  type Step,
} from './cli.ts';
import { plan } from './plan.ts';
import { ALWAYS_RUN, PACKAGES } from './rules.ts';

const ROOT = '/repo';
// git -z output: name-status is status NUL path NUL; ls-files is path NUL.
const z = (...xs: string[]) => xs.map((x) => `${x}\0`).join('');
const git = (diff: string, untracked = '', files = z(...ALWAYS_RUN)) =>
  fakeRun([
    ['git rev-parse --show-toplevel', ROOT],
    ['git merge-base origin/main HEAD', 'abc'],
    ['git diff --name-status --no-renames -z abc', diff],
    ['git ls-files -z --others --exclude-standard', untracked],
    ['git ls-files -z', files],
  ]);
// A child that finishes when told to (or at once with `code`); `stopped` records a TERM.
const child = (code?: number) => {
  let finish!: (c: number, out?: string) => void;
  const done = new Promise<{ code: number; out: string }>(
    (r) => (finish = (c, out = '') => r({ code: c, out })),
  );
  const c = {
    done,
    stopped: false,
    finish,
    stop: () => ((c.stopped = true), finish(143, 'stopped')),
  };
  if (code !== undefined) finish(code);
  return c;
};
const record = (codes: Record<string, number> = {}) => {
  const ran: Step[] = [];
  const exec = (s: Step, heavy: string) => {
    expect(heavy).toBe(`${ROOT}/scripts/board/heavy.sh`);
    ran.push(s);
    return child(codes[s.label] ?? 0);
  };
  return { ran, exec };
};
const quiet = () => {};
const INNER = { GATE_INNER: '1', GATE_WIDE: '0', HEAVY_WRAPPER: '4242', PATH: '/bin' };
const noSignal = () => () => {};
// A macrotask: every promise callback already queued has run, however many hops the scheduler takes.
const flush = () => new Promise((r) => setImmediate(r));
// A stand-in heavy.sh in a temp dir, removed after the file.
const stubs: string[] = [];
afterAll(() => stubs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const stub = (body: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-cli-'));
  stubs.push(dir);
  const f = join(dir, 'heavy.sh');
  writeFileSync(f, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(f, 0o755);
  return { dir, f };
};
const step = (label: string, cost: number): Step => ({ label, argv: [], env: {}, cost });

describe('parseArgs', () => {
  it('flags, a base, and a refusal for anything else', () => {
    expect(parseArgs([])).toEqual({ full: false, dryRun: false, base: 'origin/main' });
    expect(parseArgs(['--full', '--dry-run', '--base', 'abc'])).toEqual({
      full: true,
      dryRun: true,
      base: 'abc',
    });
    expect(parseArgs(['--wait', '300'])).toMatchObject({ wait: '300' });
    expect(parseArgs(['--wait', 'x'])).toMatch(/unknown argument "--wait"/);
    expect(parseArgs(['--base'])).toMatch(/unknown argument/);
    expect(parseArgs(['--fast'])).toMatch(/unknown argument "--fast"/);
  });
});

describe('readDiff', () => {
  it('committed, staged and unstaged in one diff, deletions marked, untracked added', () => {
    const { run } = git(
      z('M', 'app/src/a.ts', 'D', 'app/src/b.ts', 'A', 'docs/x.md', 'M', 'app/src/ünï code.ts'),
      z('app/src/new.test.ts'),
      z('app/src/a.test.ts', 'app/src/a.ts'),
    );
    expect(readDiff(run, 'origin/main')).toEqual({
      changes: [
        { path: 'app/src/a.ts', deleted: false },
        { path: 'app/src/b.ts', deleted: true },
        { path: 'docs/x.md', deleted: false },
        { path: 'app/src/ünï code.ts', deleted: false }, // raw, not git's quoted form
        { path: 'app/src/new.test.ts', deleted: false },
      ],
      testFiles: ['app/src/a.test.ts', 'app/src/new.test.ts'],
      mb: 'abc',
    });
  });
});

describe('steps', () => {
  it('one package: typecheck, lint and a related run, each under a gate-* class, env not argv', () => {
    const p = plan([{ path: 'docs/ops/LANES.md', deleted: false }], ALWAYS_RUN);
    const s = steps(p, ROOT, { full: false });
    expect(s.map((x) => x.label)).toEqual(['typecheck', 'lint', 'test-fast:scripts']);
    expect(s[0]).toEqual({
      label: 'typecheck',
      argv: ['pnpm', 'typecheck'],
      env: { HEAVY_CLASS: 'gate-typecheck', HEAVY_LABEL: 'typecheck' },
      cost: 1,
    });
    expect(s[1]!.env).toEqual({ HEAVY_CLASS: 'gate-lint', HEAVY_LABEL: 'lint' });
    const t = s[2]!;
    expect(t.argv.slice(0, 7)).toEqual([
      'pnpm',
      '--filter',
      '@aperture/scripts',
      'exec',
      'vitest',
      'related',
      '--run',
    ]);
    expect(t.argv).toContain(`${ROOT}/${ALWAYS_RUN[0]}`);
    expect(t.argv).toContain('--passWithNoTests=false'); // named tests: zero files is a drift, not a pass
    expect(t.env).toEqual({
      HEAVY_CLASS: 'gate-test-fast',
      HEAVY_LABEL: 'test-fast:scripts',
      VITEST_MAX_WORKERS: '2', // pinned, as its own test script does
    });
    expect(t.cost).toBe(SCRIPTS_COST); // its spawned shells weigh like an app run
    expect(isWide(s)).toBe(false);
  });

  it('one package besides scripts keeps the container cap (4); narrow', () => {
    const p = plan([{ path: 'app/src/lib/x.ts', deleted: false }], ALWAYS_RUN);
    const s = steps(p, ROOT, { full: false });
    expect(s.filter((x) => x.label.startsWith('test')).map((x) => x.label)).toEqual([
      'test-fast:app',
      'test-fast:scripts',
    ]);
    expect(isWide(s)).toBe(false);
    const app = s.find((x) => x.label === 'test-fast:app')!;
    expect([app.env.VITEST_MAX_WORKERS, app.cost]).toEqual(['4', 4]);
  });

  it('narrow: 4 workers a package, scripts costed as an app run, within the narrow budget at most one at a time', () => {
    const changes = [
      { path: 'app/src/lib/x.ts', deleted: false },
      { path: 'lambdas/src/y.ts', deleted: false },
    ];
    // scripts reaches into most diffs; drop it to get exactly two packages besides it
    const p = plan(changes, []);
    p.packages.scripts = { full: [], related: [], tests: [], why: {} };
    const s = steps(p, ROOT, { full: false });
    expect(isWide(s)).toBe(false);
    expect(s.filter((x) => x.label.startsWith('test')).map((x) => [x.label, x.cost])).toEqual([
      ['test-fast:app', 4],
      ['test-fast:lambdas', 4],
    ]);
    // tsc + eslint + one 4-worker package fill it: the second package waits, as the sequential gate ran them
    expect(1 + 1 + 4).toBe(NARROW_BUDGET);
    const scripts = steps(plan([{ path: 'docs/a.md', deleted: false }], ALWAYS_RUN), ROOT, {
      full: false,
    }).at(-1)!;
    expect([scripts.env.VITEST_MAX_WORKERS, scripts.cost]).toEqual(['2', SCRIPTS_COST]);
  });

  it('exactly 3 packages is wide', () => {
    const changes = [
      { path: 'app/src/lib/x.ts', deleted: false },
      { path: 'lambdas/src/y.ts', deleted: false },
    ];
    const s = steps(plan(changes, ALWAYS_RUN), ROOT, { full: false });
    expect(s.filter((x) => x.label.startsWith('test')).map((x) => x.label)).toEqual([
      'test-fast:app',
      'test-fast:lambdas',
      'test-fast:scripts',
    ]);
    expect(isWide(s)).toBe(true);
  });

  it('wide: the workers split by WIDE_WORKERS, costs to match, the same files as a narrow run would take', () => {
    const p = plan([{ path: 'packages/shared/src/x.ts', deleted: false }], ALWAYS_RUN);
    const s = steps(p, ROOT, { full: false });
    expect(isWide(s)).toBe(true);
    const tests = s.filter((x) => x.label.startsWith('test-fast:'));
    expect(tests.length).toBeGreaterThanOrEqual(3);
    for (const t of tests) {
      const dir = t.label.slice('test-fast:'.length);
      expect(t.env.VITEST_MAX_WORKERS).toBe(String(WIDE_WORKERS[dir]));
      expect(t.cost).toBe(dir === 'scripts' ? SCRIPTS_COST : WIDE_WORKERS[dir]);
    }
    const app = s.find((x) => x.label === 'test-fast:app')!;
    expect(app.argv).toContain('--passWithNoTests=true'); // reached only through changed modules
    expect(app.argv).toContain(`${ROOT}/packages/shared/src/x.ts`);
  });

  it('WIDE_WORKERS: every package, app the most, scripts at its pin of 2', () => {
    for (const pkg of PACKAGES) expect(WIDE_WORKERS[pkg.dir], pkg.dir).toBeGreaterThan(0);
    expect(WIDE_WORKERS.app).toBe(Math.max(...Object.values(WIDE_WORKERS)));
    expect(WIDE_WORKERS.scripts).toBe(2);
    expect(SCRIPTS_COST).toBe(BUDGET - WIDE_WORKERS.app! + 1); // never beside app
    expect(SCRIPTS_COST).toBeGreaterThan(NARROW_BUDGET); // alone in a narrow gate
  });

  it('NARROW_WORKERS is the container cap heavy.sh gives a plain suite (limits.json)', () => {
    const limits = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../board/limits.json', import.meta.url)), 'utf8'),
    );
    expect(NARROW_WORKERS).toBe(limits.tuning.test.maxWorkers);
  });

  it('a package-full plan runs that package’s own test script, and counts as wide', () => {
    const p = plan([{ path: 'app/package.json', deleted: false }], ALWAYS_RUN);
    const s = steps(p, ROOT, { full: false });
    expect(s.find((x) => x.label === 'test:app')).toEqual({
      label: 'test:app',
      argv: ['pnpm', '--filter', '@aperture/app', 'test'],
      env: { HEAVY_CLASS: 'gate-test', HEAVY_LABEL: 'test:app', VITEST_MAX_WORKERS: '4' },
      cost: 4,
    });
    expect(isWide(s)).toBe(true);
  });

  it('a repo-full plan, or --full, is one `pnpm test` that costs the whole budget (it runs alone)', () => {
    const p = plan([{ path: 'pnpm-lock.yaml', deleted: false }], ALWAYS_RUN);
    const s = steps(p, ROOT, { full: false });
    expect(s.map((x) => x.argv.join(' '))).toEqual(['pnpm typecheck', 'pnpm lint', 'pnpm test']);
    expect(s[2]).toMatchObject({
      cost: BUDGET,
      env: { HEAVY_CLASS: 'gate-test', VITEST_MAX_WORKERS: String(NARROW_WORKERS) },
    });
    expect(isWide(s)).toBe(true);
    const fast = plan([{ path: 'docs/x.md', deleted: false }], ALWAYS_RUN);
    expect(steps(fast, ROOT, { full: true }).at(-1)!.argv).toEqual(['pnpm', 'test']);
  });
});

describe('stepEnv / outerEnv', () => {
  it("drops the caller's HEAVY_*, GATE_* and VITEST_MAX_WORKERS; names the outer slot; the step's own win", () => {
    const fast: Step = {
      label: 'test-fast:app',
      argv: [],
      env: { HEAVY_CLASS: 'gate-test-fast' },
      cost: 4,
    };
    const inherited = {
      PATH: '/bin',
      VITEST_MAX_WORKERS: '9',
      GATE_INNER: '1',
      GATE_WIDE: '1',
      HEAVY_CLASS: 'gate-wide',
      HEAVY_SLOT_CLASS: 'test',
      HEAVY_LABEL: 'gate:wide',
      HEAVY_WRAPPER: '4242',
    };
    expect(stepEnv(inherited, fast)).toEqual({
      PATH: '/bin',
      HEAVY_NOSLOT: '4242',
      HEAVY_CLASS: 'gate-test-fast',
    });
    const scripts: Step = { ...fast, env: { VITEST_MAX_WORKERS: '2' } };
    expect(stepEnv({ VITEST_MAX_WORKERS: '9' }, scripts, true)).toEqual({
      VITEST_MAX_WORKERS: '2',
      FORCE_COLOR: '1',
    });
  });

  it('wide holds a `test` slot under its own event class; narrow a `test-fast` one', () => {
    expect(outerEnv(true)).toEqual({
      GATE_INNER: '1',
      GATE_WIDE: '1',
      HEAVY_CLASS: 'gate-wide',
      HEAVY_SLOT_CLASS: 'test',
      HEAVY_LABEL: 'gate:wide',
    });
    expect(outerEnv(false)).toMatchObject({
      GATE_WIDE: '0',
      HEAVY_CLASS: 'gate-narrow',
      HEAVY_SLOT_CLASS: 'test-fast',
    });
  });
});

describe('schedule', () => {
  it('never runs more than the budget; longest first, smaller steps fill the gaps', async () => {
    const todo = [
      step('typecheck', 1),
      step('lint', 1),
      step('test-fast:app', 4),
      step('test-fast:lambdas', 2),
      step('test-fast:packages/shared', 1),
      step('test-fast:cdk', 2),
      step('test-fast:extension', 2),
      step('test-fast:scripts', 2),
    ];
    const kids = new Map<string, ReturnType<typeof child>>();
    let running = 0;
    let peak = 0;
    const started: string[] = [];
    const h = schedule(
      todo,
      (s) => {
        started.push(s.label);
        running += s.cost;
        peak = Math.max(peak, running);
        const c = child();
        void c.done.then(() => (running -= s.cost));
        kids.set(s.label, c);
        return c;
      },
      quiet,
      10,
    );
    expect(started).toEqual([
      'test-fast:app',
      'test-fast:extension',
      'typecheck',
      'lint',
      'test-fast:cdk',
    ]);
    kids.get('lint')!.finish(0); // 1 free: shared (1) fits, lambdas and scripts (2) don't
    await flush();
    expect(started.slice(5)).toEqual(['test-fast:packages/shared']);
    kids.get('typecheck')!.finish(0); // 1 free: still nothing fits
    await flush();
    expect(started).toHaveLength(6);
    kids.get('test-fast:cdk')!.finish(0); // 3 free: lambdas (2) by rank, scripts waits for 1 more
    await flush();
    expect(started.slice(6)).toEqual(['test-fast:lambdas']);
    for (const c of kids.values()) c.finish(0);
    await flush();
    expect(started.at(-1)).toBe('test-fast:scripts'); // last by rank
    expect(started).toHaveLength(8);
    for (const c of kids.values()) c.finish(0);
    const results = await h.done;
    expect(results.map((r) => r.code)).toEqual(new Array(8).fill(0));
    expect(peak).toBeLessThanOrEqual(10);
  });

  it('the narrow budget: one 4-worker package beside tsc + eslint, the second after it', async () => {
    const started: string[] = [];
    const kids = new Map<string, ReturnType<typeof child>>();
    const h = schedule(
      [
        step('typecheck', 1),
        step('lint', 1),
        step('test-fast:app', 4),
        step('test-fast:lambdas', 4),
      ],
      (s) => {
        started.push(s.label);
        const c = child();
        kids.set(s.label, c);
        return c;
      },
      quiet,
      NARROW_BUDGET,
    );
    expect(started).toEqual(['test-fast:app', 'typecheck', 'lint']);
    kids.get('typecheck')!.finish(0);
    kids.get('lint')!.finish(0);
    await flush();
    expect(started).toHaveLength(3); // 2 free: lambdas (4) waits for app
    kids.get('test-fast:app')!.finish(0);
    await flush();
    expect(started.at(-1)).toBe('test-fast:lambdas');
    kids.get('test-fast:lambdas')!.finish(0);
    await h.done;
  });

  it('a step costing the whole budget waits for the rest, then runs alone; one costing more still runs', async () => {
    const order: string[] = [];
    const kids: ReturnType<typeof child>[] = [];
    const h = schedule(
      [step('typecheck', 1), step('lint', 1), step('test', 99)],
      (s) => {
        order.push(s.label);
        const c = child();
        kids.push(c);
        return c;
      },
      quiet,
      10,
    );
    expect(order).toEqual(['typecheck', 'lint']);
    kids[0]!.finish(0);
    await flush();
    expect(order).toEqual(['typecheck', 'lint']);
    kids[1]!.finish(0);
    await flush();
    expect(order).toEqual(['typecheck', 'lint', 'test']);
    kids[2]!.finish(3);
    expect((await h.done).map((r) => r.code)).toEqual([0, 0, 3]);
  });

  it('prints each finished step as one block with its label, exit and output', async () => {
    const lines: string[] = [];
    const h = schedule(
      [step('typecheck', 1)],
      () => {
        const c = child();
        c.finish(2, 'error TS1: nope\n');
        return c;
      },
      (l) => lines.push(l),
      10,
      () => 0,
    );
    await h.done;
    expect(lines).toEqual(['▶ typecheck', '── typecheck · exit 2 · 0 s ──', 'error TS1: nope']);
  });

  it('a step that throws on start fails as 127, gives its budget back, and the rest still run', async () => {
    const h = schedule(
      [step('test-fast:app', 10), step('lint', 10)],
      (s) => {
        if (s.label === 'test-fast:app') throw new Error('spawn EMFILE');
        return child(0);
      },
      quiet,
      10,
    );
    const r = await h.done;
    expect(r.map((x) => x.code)).toEqual([127, 0]);
    expect(r[0]!.out).toMatch(/EMFILE/);
  });

  it('stop: TERM to every running step, nothing new starts, the rest read as interrupted; twice is once', async () => {
    const kids: ReturnType<typeof child>[] = [];
    let stops = 0;
    const h = schedule(
      [step('test-fast:app', 4), step('test-fast:cdk', 4), step('lint', 4)],
      () => {
        const c = child();
        const stop = c.stop;
        c.stop = () => (stops++, stop());
        kids.push(c);
        return c;
      },
      quiet,
      8,
    );
    expect(kids).toHaveLength(2);
    h.stop();
    h.stop();
    const results = await h.done;
    await flush();
    expect(stops).toBe(2);
    expect(kids).toHaveLength(2); // the freed budget started nothing
    expect(results.map((r) => r.code)).toEqual([143, 143, 143]);
    expect(results[1]!.out).toMatch(/not started/); // cdk ranks after lint, so it never got a slot
    expect(results[2]!.out).toBe('stopped');
  });
});

describe('spawnExec / spawnOuter (real processes, a stand-in heavy.sh)', () => {
  const s: Step = { label: 'lint', argv: ['pnpm', 'lint'], env: { HEAVY_LABEL: 'lint' }, cost: 1 };

  it('stdout and stderr in one block, the exit code, the argv after `--`, the step env', async () => {
    const { dir, f } = stub('echo "args: $*"; echo "label: $HEAVY_LABEL"; echo oops >&2; exit 3');
    const r = await spawnExec(s, f, dir).done;
    expect(r.code).toBe(3);
    expect(r.out).toMatch(/args: -- sh \S+\/gate\/step\.sh pnpm lint/);
    expect(r.out).toMatch(/label: lint/);
    expect(r.out).toMatch(/oops/);
  });

  it('killed by a signal is 128+n; one that can’t start is 127', async () => {
    const { dir, f } = stub('kill -TERM $$');
    expect((await spawnExec(s, f, dir).done).code).toBe(143);
    const r = await spawnExec(s, join(dir, 'missing.sh'), dir).done;
    expect(r.code).toBe(127);
    expect(r.out).toMatch(/couldn't start heavy\.sh/);
  });

  // The step reports its own code through step.sh: heavy.sh's 0 alone is never a pass.
  it('a heavy.sh that runs the step: its code comes through, even when heavy.sh itself says 0', async () => {
    const passes = stub('shift; "$@"');
    expect(
      (await spawnExec({ ...s, argv: ['sh', '-c', 'exit 5'] }, passes.f, passes.dir).done).code,
    ).toBe(5);
    expect((await spawnExec({ ...s, argv: ['true'] }, passes.f, passes.dir).done).code).toBe(0);
    const swallows = stub('shift; "$@"; exit 0');
    const r = await spawnExec({ ...s, argv: ['false'] }, swallows.f, swallows.dir).done;
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/heavy\.sh exited 0, but lint exited 1/);
  });

  it('a heavy.sh that exits 0 without running the step: 2, never a pass', async () => {
    const { dir, f } = stub('exit 0');
    const r = await spawnExec(s, f, dir).done;
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/heavy\.sh exited 0, but lint never reported/);
  });

  it('stop sends TERM', async () => {
    const { dir, f } = stub("trap 'kill $!; exit 99' TERM; sleep 30 & wait");
    const c = spawnExec(s, f, dir);
    await new Promise((r) => setTimeout(r, 200));
    c.stop();
    expect((await c.done).code).toBe(99);
  });

  it('a pipe held open past exit ends the step within the drain bound, not with the holder', async () => {
    const { dir, f } = stub('shift; sleep 8 & "$@"'); // holds the pipes 8 s
    const t0 = Date.now();
    expect((await spawnExec({ ...s, argv: ['true'] }, f, dir).done).code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(6000); // the 2 s bound, not the holder
  }, 10000);

  it('the outer run: heavy.sh gets the args and env, its exit comes back; one that can’t start is 127', async () => {
    const { dir, f } = stub(`echo "$* $GATE_WIDE" >${'${0%/*}'}/seen; exit 75`);
    expect(
      await spawnOuter(f, dir, ['--wait', '5', '--', 'x'], {
        GATE_WIDE: '1',
        PATH: process.env.PATH,
      }),
    ).toBe(75);
    expect(readFileSync(join(dir, 'seen'), 'utf8').trim()).toBe('--wait 5 -- x 1');
    const said: unknown[] = [];
    const err = vi.spyOn(console, 'error').mockImplementation((s) => void said.push(s));
    const code = await spawnOuter(join(dir, 'missing.sh'), dir, [], {}).finally(() =>
      err.mockRestore(),
    );
    expect(code).toBe(127);
    expect(String(said[0])).toMatch(/couldn't start heavy\.sh: .*ENOENT/);
  });

  it('the outer run: a signal to the gate is passed on to heavy.sh, and the gate exits 128+n', async () => {
    const { dir, f } = stub(
      `trap 'echo got >${'${0%/*}'}/term; kill $!; exit 0' TERM; sleep 30 & wait`,
    );
    let fire!: (sig: NodeJS.Signals, code: number) => void;
    let removed = false;
    const p = spawnOuter(
      f,
      dir,
      [],
      { PATH: process.env.PATH },
      (fn) => ((fire = fn), () => (removed = true)),
    );
    await new Promise((r) => setTimeout(r, 300));
    fire('SIGTERM', 143);
    expect(await p).toBe(143); // heavy.sh's own 0 doesn't mask the interrupt
    expect(readFileSync(join(dir, 'term'), 'utf8').trim()).toBe('got');
    expect(removed).toBe(true);
  });
});

describe('main', () => {
  it('the caller pass prints the plan and re-runs itself under one heavy.sh slot, its exit passed through', async () => {
    const { ran, exec } = record();
    const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const out: string[] = [];
    const code = await main(['--base', 'origin/main', '--wait', '120'], {
      run: git(z('M', 'docs/a.md')).run,
      exec,
      outer: async (heavy, root, args, env) => {
        expect([heavy, root]).toEqual([`${ROOT}/scripts/board/heavy.sh`, ROOT]);
        calls.push({ args, env });
        return 75; // the cap gave up: a failure, never a pass
      },
      log: (l) => out.push(l),
      // stale from the caller's own shell: none may reach the outer run, or it could skip its slot
      env: {
        PATH: '/bin',
        HEAVY_LABEL: 'stale',
        HEAVY_NOSLOT: '1',
        HEAVY_WRAPPER: '1',
        HEAVY_SLOT_CLASS: 'other',
        GATE_INNER: '0',
      },
    });
    expect(code).toBe(75);
    expect(ran).toEqual([]);
    expect(calls).toHaveLength(1);
    const [heavyArgs, sep, node, cli, ...rest] = calls[0]!.args.slice(2);
    expect(calls[0]!.args.slice(0, 2)).toEqual(['--wait', '120']);
    expect([heavyArgs, sep]).toEqual(['--', process.execPath]);
    expect(node).toMatch(/scripts\/src\/gate\/cli\.ts$/);
    expect([cli, ...rest]).toEqual(['--base', 'origin/main', '--wait', '120']);
    expect(calls[0]!.env).toEqual({
      PATH: '/bin',
      GATE_INNER: '1',
      GATE_WIDE: '0',
      HEAVY_CLASS: 'gate-narrow',
      HEAVY_SLOT_CLASS: 'test-fast',
      HEAVY_LABEL: 'gate:narrow',
      GATE_RESULT: expect.stringMatching(/gate-result-[^/]+\/code$/),
    });
    expect(out.join('\n')).toMatch(/gate:fast — 1 changed path/);
    expect(out.at(-1)).toMatch(
      /no slot in time: run `pnpm gate:fast --wait 600` in the background/,
    );
  });

  // The inner pass reports its exit code through GATE_RESULT: heavy.sh's 0 alone is never a pass.
  it.each([
    ['writes nothing', undefined, 2, /never reported: nothing was checked/],
    ['reports 0', '0', 0, null],
    ['reports 1', '1', 1, /heavy.sh exited 0, but the gate’s inner pass exited 1/],
  ] as const)('heavy.sh exits 0 and the inner pass %s', async (_, wrote, want, msg) => {
    const out: string[] = [];
    let file = '';
    const code = await main([], {
      run: git(z('M', 'docs/a.md')).run,
      outer: async (_h, _r, _a, e) => {
        file = e.GATE_RESULT!;
        if (wrote !== undefined) writeFileSync(file, wrote);
        return 0;
      },
      log: (l) => out.push(l),
      env: {},
    });
    expect(code).toBe(want);
    if (msg) expect(out.at(-1)).toMatch(msg);
    else expect(out.join('\n')).not.toMatch(/heavy.sh exited 0/);
    expect(existsSync(file)).toBe(false); // the temp dir is gone
  });

  it('reconcile: heavy.sh’s failure wins; else the report; a missing or garbled one is 2', () => {
    expect(reconcile(75, () => '0')).toBe(75);
    expect(reconcile(0, () => '0\n')).toBe(0);
    expect(reconcile(0, () => '1')).toBe(1);
    expect(reconcile(0, () => 'x')).toBe(2);
    expect(
      reconcile(0, () => {
        throw new Error('ENOENT');
      }),
    ).toBe(2);
  });

  it('a wide diff takes a `test` slot; --full too', async () => {
    const envs: NodeJS.ProcessEnv[] = [];
    const outer = async (_h: string, _r: string, _a: string[], e: NodeJS.ProcessEnv) => (
      envs.push(e),
      0
    );
    await main([], {
      run: git(z('M', 'packages/shared/src/x.ts')).run,
      outer,
      log: quiet,
      env: {},
    });
    await main(['--full'], { run: git(z('M', 'docs/a.md')).run, outer, log: quiet, env: {} });
    for (const e of envs)
      expect(e).toMatchObject({
        GATE_WIDE: '1',
        HEAVY_CLASS: 'gate-wide',
        HEAVY_SLOT_CLASS: 'test',
      });
  });

  it('the inner pass runs every step, prints no plan, and exits with the first failure in the printed order', async () => {
    const kids = new Map<string, ReturnType<typeof child>>();
    const out: string[] = [];
    const p = main([], {
      run: git(z('M', 'docs/a.md')).run,
      exec: (s) => {
        const c = child();
        kids.set(s.label, c);
        return c;
      },
      onSignal: noSignal,
      log: (l) => out.push(l),
      env: INNER,
    });
    await flush();
    expect([...kids.keys()].sort()).toEqual(['lint', 'typecheck']); // scripts runs alone in a narrow gate
    kids.get('lint')!.finish(1);
    kids.get('typecheck')!.finish(0);
    await flush();
    kids.get('test-fast:scripts')!.finish(2); // finishes last, and comes last in the order
    expect(await p).toBe(1);
    expect(out.join('\n')).not.toMatch(/changed path/);
    expect(out.at(-1)).toMatch(
      /^gate:fast — typecheck ok · lint exit 1 · test-fast:scripts exit 2 · \d+ s$/,
    );
  });

  it('a narrow inner pass runs within NARROW_BUDGET: app beside tsc + eslint, scripts after app', async () => {
    const kids = new Map<string, ReturnType<typeof child>>();
    const started: string[] = [];
    const p = main([], {
      run: git(z('M', 'app/src/lib/x.ts')).run,
      exec: (s) => {
        started.push(s.label);
        const c = child();
        kids.set(s.label, c);
        return c;
      },
      onSignal: noSignal,
      log: quiet,
      env: INNER,
    });
    await flush();
    expect(started).toEqual(['test-fast:app', 'typecheck', 'lint']);
    kids.get('typecheck')!.finish(0);
    kids.get('lint')!.finish(0);
    await flush();
    expect(started).toHaveLength(3); // scripts runs alone
    kids.get('test-fast:app')!.finish(0);
    await flush();
    expect(started.at(-1)).toBe('test-fast:scripts');
    kids.get('test-fast:scripts')!.finish(0);
    expect(await p).toBe(0);
  });

  it('the inner pass refuses outside heavy.sh, and a plan that widened past its narrow slot', async () => {
    const { ran, exec } = record();
    const out: string[] = [];
    const log = (l: string) => out.push(l);
    const bare = { GATE_INNER: '1' };
    expect(await main([], { run: git(z('M', 'docs/a.md')).run, exec, log, env: bare })).toBe(2);
    expect(out.at(-1)).toMatch(/runs only under heavy\.sh/);
    const wide = git(z('M', 'packages/shared/src/x.ts')).run;
    expect(await main([], { run: wide, exec, onSignal: noSignal, log, env: INNER })).toBe(2);
    expect(out.at(-1)).toMatch(/widened since the plan/);
    expect(ran).toEqual([]);
  });

  it('a signal stops every step and exits 128+n; one after the end changes nothing', async () => {
    let fire!: (sig: NodeJS.Signals, code: number) => void;
    let removed = false;
    const kids: ReturnType<typeof child>[] = [];
    const p = main([], {
      run: git(z('M', 'docs/a.md')).run,
      exec: () => {
        const c = child();
        kids.push(c);
        return c;
      },
      onSignal: (fn) => ((fire = fn), () => (removed = true)),
      log: quiet,
      env: INNER,
    });
    await flush();
    fire('SIGINT', 130);
    expect(await p).toBe(130);
    expect(kids.length).toBe(2); // scripts never started
    expect(kids.every((c) => c.stopped)).toBe(true);
    expect(removed).toBe(true);
  });

  it('--dry-run prints the plan and runs nothing, neither pass', async () => {
    const { ran, exec } = record();
    const out: string[] = [];
    const outer = async () => {
      throw new Error('re-ran');
    };
    const code = await main(['--dry-run'], {
      run: git(z('M', 'docs/a.md')).run,
      exec,
      outer,
      log: (l) => out.push(l),
      env: {},
    });
    expect(code).toBe(0);
    expect(ran).toEqual([]);
    expect(out.join('\n')).toMatch(/app: skipped — nothing in the diff reaches it/);
    expect(out.join('\n')).toMatch(/would run: test-fast:scripts/);
    expect(out.join('\n')).toMatch(/at once: one `test-fast` slot, uncapped, up to 6 tokens/);
  });

  // A rules.ts change plans with the merge-base's copy too (base.ts): here that copy is today's rules.ts.
  const RULES_TEXT = readFileSync(fileURLToPath(new URL('./rules.ts', import.meta.url)), 'utf8');
  const noOuter = async () => {
    throw new Error('re-ran');
  };
  const withBase = (show: () => string) => {
    const g = git(z('M', 'scripts/src/gate/rules.ts', 'M', 'scripts/board/limits.json'));
    const calls: string[][] = [];
    const run: typeof g.run = (cmd, args, o) => {
      if (args[0] === 'show') return (calls.push(args), show());
      return g.run(cmd, args, o);
    };
    return { run, calls };
  };

  it('a rules.ts change reads the merge-base copy and runs the union (rules.ts + limits.json: narrow)', async () => {
    const { run, calls } = withBase(() => RULES_TEXT);
    const out: string[] = [];
    const code = await main(['--dry-run'], {
      run,
      exec: record().exec,
      outer: noOuter,
      log: (l) => out.push(l),
      env: {},
    });
    expect(code).toBe(0);
    expect(calls).toEqual([['show', 'abc:scripts/src/gate/rules.ts']]);
    const text = out.join('\n');
    expect(text).toMatch(/planned with the merge-base's rules too; the union runs/);
    expect(text).toMatch(/at once: one `test-fast` slot/);
    expect(text).not.toMatch(/would run: test$/m);
  });

  it('a merge-base copy git can’t show runs the full suite', async () => {
    const { run } = withBase(() => {
      throw new Error("fatal: invalid object name 'abc'");
    });
    const out: string[] = [];
    await main(['--dry-run'], {
      run,
      exec: record().exec,
      outer: noOuter,
      log: (l) => out.push(l),
      env: {},
    });
    const text = out.join('\n');
    expect(text).toMatch(
      /merge-base's copy couldn't be loaded \(fatal: invalid object name 'abc'\)/,
    );
    expect(text).toMatch(/would run: test$/m);
  });

  it('a diff it can’t read runs the full suite, in a wide slot', async () => {
    const { ran, exec } = record();
    const { run } = fakeRun([
      ['git rev-parse --show-toplevel', ROOT],
      [
        'git merge-base',
        () => {
          throw new Error('git merge-base failed: no merge base');
        },
      ],
    ]);
    const out: string[] = [];
    let env: NodeJS.ProcessEnv = {};
    await main([], {
      run,
      outer: async (_h, _r, _a, e) => ((env = e), 0),
      log: (l) => out.push(l),
      env: {},
    });
    expect(out[0]).toMatch(/couldn't read the diff/);
    expect(out.join('\n')).toMatch(/typecheck and lint at once, then the suite alone/);
    expect(env.GATE_WIDE).toBe('1');
    const inner = { ...INNER, GATE_WIDE: '1' };
    expect(await main([], { run, exec, onSignal: noSignal, log: quiet, env: inner })).toBe(0);
    // the inner pass reports its code where the caller asked
    const d = mkdtempSync(join(tmpdir(), 'gate-res-'));
    const res = join(d, 'code');
    await main([], {
      run,
      exec,
      onSignal: noSignal,
      log: quiet,
      env: { ...inner, GATE_RESULT: res },
    });
    expect(readFileSync(res, 'utf8')).toBe('0');
    rmSync(d, { recursive: true, force: true });
    expect(ran.at(-1)!.argv).toEqual(['pnpm', 'test']);
  });

  it('--help prints usage and runs nothing; a bad flag exits 2', async () => {
    const { ran, exec } = record();
    expect(await main(['--help'], { run: git('').run, exec, log: quiet, env: {} })).toBe(0);
    expect(await main(['--nope'], { run: git('').run, exec, log: quiet, env: {} })).toBe(2);
    expect(ran).toEqual([]);
  });
});

describe('main: the registry check, first', () => {
  const roots: string[] = [];
  afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
  // A real root on disk (listFiles keeps only files that exist), its files listed by the fake git.
  const tree = (paths: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), 'gate-registry-'));
    roots.push(root);
    for (const [p, text] of Object.entries(paths)) {
      mkdirSync(join(root, p, '..'), { recursive: true });
      writeFileSync(join(root, p), text);
    }
    return fakeRun([
      ['git rev-parse --show-toplevel', root],
      ['git ls-files -z --cached --others --exclude-standard', z(...Object.keys(paths))],
      ['git merge-base origin/main HEAD', 'abc'],
      ['git diff --name-status --no-renames -z abc', z('A', Object.keys(paths)[0]!)],
      ['git ls-files -z', ''],
    ]);
  };
  const never = async () => {
    throw new Error('ran a step');
  };
  const exec = () => {
    throw new Error('ran a step');
  };

  it.each([[[]], [['--dry-run']], [['--full']]])(
    'a test no vitest project includes exits 1 before any step, naming it with why and the fix (%j)',
    async (argv) => {
      const out: string[] = [];
      const code = await main(argv, {
        run: tree({ 'scripts/board/new.test.ts': "it('x', () => {});\n" }).run,
        exec,
        outer: never,
        log: (l) => out.push(l),
        env: {},
      });
      expect(code).toBe(1);
      const said = out.join('\n');
      expect(said).toMatch(/1 file\(s\) the gate can't pick up \(registry check, [\d.]+ s/);
      expect(said).toMatch(
        /scripts\/board\/new\.test\.ts: no vitest project in scripts includes it[^\n]*\n {4}fix: /,
      );
      expect(said).toMatch(/nothing ran/);
      expect(said).not.toMatch(/changed path/); // no plan: it stops first
    },
  );

  it('an unregistered graph-blind test exits 1 too, pointing at the rules.ts lists', async () => {
    const out: string[] = [];
    const code = await main([], {
      run: tree({
        'scripts/src/new.test.ts': "import { readFileSync } from 'node:fs';\nreadFileSync('x');\n",
      }).run,
      exec,
      outer: never,
      log: (l) => out.push(l),
      env: {},
    });
    expect(code).toBe(1);
    expect(out.join('\n')).toMatch(
      /scripts\/src\/new\.test\.ts: a test that reads files.*\n {4}fix: add it to an INPUT_RULES entry/,
    );
  });

  it('a clean tree goes on to the plan, with the check’s line in it', async () => {
    const out: string[] = [];
    const code = await main(['--dry-run'], {
      run: tree({ 'scripts/src/new.test.ts': "it('x', () => {});\n" }).run,
      exec,
      outer: never,
      log: (l) => out.push(l),
      env: {},
    });
    expect(code).toBe(0);
    expect(out.join('\n')).toMatch(
      /registry check: 1 test files, each in one vitest project and reachable \([\d.]+ s\)/,
    );
  });

  it('a listing that fails skips the check aloud, and the gate goes on', async () => {
    const { run } = fakeRun([
      ['git rev-parse --show-toplevel', ROOT],
      [
        'git ls-files -z --cached',
        () => {
          throw new Error('git ls-files failed: index locked');
        },
      ],
      ['git merge-base origin/main HEAD', 'abc'],
      ['git diff --name-status --no-renames -z abc', z('M', 'docs/a.md')],
      ['git ls-files -z', z(...ALWAYS_RUN)],
    ]);
    const out: string[] = [];
    expect(
      await main(['--dry-run'], { run, exec, outer: never, log: (l) => out.push(l), env: {} }),
    ).toBe(0);
    expect(out.join('\n')).toMatch(
      /registry check skipped: couldn't list files \(git ls-files failed: index locked\)/,
    );
  });

  it('an empty listing, or a file that won’t read, skips the check aloud: never a clean pass', async () => {
    const said = async (run: ReturnType<typeof tree>['run'], read?: (abs: string) => string) => {
      const out: string[] = [];
      const code = await main(['--dry-run'], {
        run,
        exec,
        outer: never,
        log: (l) => out.push(l),
        env: {},
        ...(read ? { read } : {}),
      });
      expect(code).toBe(0);
      return out.join('\n');
    };
    expect(await said(tree({}).run)).toMatch(/registry check skipped: git listed no files/);
    const eacces = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    expect(
      await said(tree({ 'scripts/src/a.ts': '' }).run, () => {
        throw eacces;
      }),
    ).toMatch(
      /registry check skipped: couldn't read scripts\/src\/a\.ts \(EACCES: permission denied\)/,
    );
    // A file gone since the listing (ENOENT) is skipped, not the check.
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    expect(
      await said(tree({ 'scripts/src/a.ts': '' }).run, () => {
        throw enoent;
      }),
    ).toMatch(/registry check: 0 test files/);
  });

  it('git lists from the repo root, whatever the cwd, and each path once', async () => {
    const fake = tree({ 'scripts/src/new.test.ts': "it('x', () => {});\n" }).run;
    const cwds: [string, string | undefined][] = [];
    // fakeRun keeps no cwd: record it here. The listing comes back twice, as an unmerged path's stages would.
    const run = ((cmd: string, args: string[], opts?: { cwd?: string }) => {
      if (args[0] === 'ls-files') cwds.push([args.join(' '), opts?.cwd]);
      const r = fake(cmd, args, opts);
      return args.includes('--cached') ? r + r : r;
    }) as typeof fake;
    const out: string[] = [];
    await main(['--dry-run'], { run, exec, outer: never, log: (l) => out.push(l), env: {} });
    const root = fake('git', ['rev-parse', '--show-toplevel']);
    expect(cwds.length).toBe(3); // the registry listing, then readDiff's two
    for (const [args, cwd] of cwds) expect(cwd, args).toBe(root);
    expect(out.join('\n')).toMatch(/registry check: 1 test files/);
  });

  it('the inner pass doesn’t check again: the caller did, and rules.test.ts covers a file added since', async () => {
    const { run, calls } = tree({ 'scripts/board/new.test.ts': '' });
    const code = await main([], {
      run,
      exec: () => child(0),
      onSignal: noSignal,
      log: quiet,
      env: INNER,
    });
    expect(code).toBe(0);
    expect(calls.some((c) => c.args.includes('--cached'))).toBe(false);
  });
});
