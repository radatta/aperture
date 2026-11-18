import { describe, expect, it } from 'vitest';
import { fakeRun } from '../bot/fakes.ts';
import {
  BUDGET,
  WIDE_WORKERS,
  isWide,
  main,
  outerEnv,
  parseArgs,
  readDiff,
  schedule,
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
const INNER = { GATE_INNER: '1', PATH: '/bin' };
const noSignal = () => () => {};
const step = (label: string, cost: number): Step => ({ label, argv: [], env: {}, cost });

describe('parseArgs', () => {
  it('flags, a base, and a refusal for anything else', () => {
    expect(parseArgs([])).toEqual({ full: false, dryRun: false, base: 'origin/main' });
    expect(parseArgs(['--full', '--dry-run', '--base', 'abc'])).toEqual({
      full: true,
      dryRun: true,
      base: 'abc',
    });
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
    });
  });
});

describe('steps', () => {
  it('a narrow plan: typecheck, lint and a related run per reached package, each slotless, env not argv', () => {
    const p = plan([{ path: 'docs/ops/LANES.md', deleted: false }], ALWAYS_RUN);
    const s = steps(p, ROOT, { full: false });
    expect(s.map((x) => x.label)).toEqual(['typecheck', 'lint', 'test-fast:scripts']);
    expect(s[0]).toEqual({
      label: 'typecheck',
      argv: ['pnpm', 'typecheck'],
      env: { HEAVY_CLASS: 'gate-typecheck', HEAVY_LABEL: 'typecheck', HEAVY_NOSLOT: '1' },
      cost: 1,
    });
    expect(s[1]!.env.HEAVY_CLASS).toBe('gate-lint');
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
      HEAVY_CLASS: 'test-fast',
      HEAVY_LABEL: 'test-fast:scripts',
      HEAVY_NOSLOT: '1',
      VITEST_MAX_WORKERS: '2', // pinned, as its own test script does
    });
    expect(t.cost).toBe(2);
    expect(isWide(s)).toBe(false);
  });

  it('narrow keeps the container cap (4) per package', () => {
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

  it('wide (3+ packages): the workers split by WIDE_WORKERS, costs to match, every test on the list', () => {
    const p = plan([{ path: 'packages/shared/src/x.ts', deleted: false }], ALWAYS_RUN);
    const s = steps(p, ROOT, { full: false });
    expect(isWide(s)).toBe(true);
    const tests = s.filter((x) => x.label.startsWith('test-fast:'));
    expect(tests.length).toBeGreaterThanOrEqual(3);
    for (const t of tests) {
      const dir = t.label.slice('test-fast:'.length);
      expect(t.env.VITEST_MAX_WORKERS).toBe(String(WIDE_WORKERS[dir]));
      expect(t.cost).toBe(WIDE_WORKERS[dir]);
      expect(t.env.HEAVY_NOSLOT).toBe('1');
    }
    // the same tests a narrow plan of these packages would run: only the workers change
    const app = s.find((x) => x.label === 'test-fast:app')!;
    expect(app.argv).toContain('--passWithNoTests=true'); // reached only through changed modules
    expect(app.argv).toContain(`${ROOT}/packages/shared/src/x.ts`);
  });

  it('every package in WIDE_WORKERS, and the wide total no more than the budget can hold beside tsc + eslint', () => {
    for (const pkg of PACKAGES) expect(WIDE_WORKERS[pkg.dir], pkg.dir).toBeGreaterThan(0);
    expect(WIDE_WORKERS.app).toBe(Math.max(...Object.values(WIDE_WORKERS)));
  });

  it('a package-full plan runs that package’s own test script under the test class, and counts as wide', () => {
    const p = plan([{ path: 'app/package.json', deleted: false }], ALWAYS_RUN);
    const s = steps(p, ROOT, { full: false });
    expect(s.find((x) => x.label === 'test:app')).toEqual({
      label: 'test:app',
      argv: ['pnpm', '--filter', '@aperture/app', 'test'],
      env: {
        HEAVY_CLASS: 'test',
        HEAVY_LABEL: 'test:app',
        HEAVY_NOSLOT: '1',
        VITEST_MAX_WORKERS: '4',
      },
      cost: 4,
    });
    expect(isWide(s)).toBe(true);
  });

  it('a repo-full plan, or --full, is one `pnpm test` that costs the whole budget (it runs alone)', () => {
    const p = plan([{ path: 'pnpm-lock.yaml', deleted: false }], ALWAYS_RUN);
    const s = steps(p, ROOT, { full: false });
    expect(s.map((x) => x.argv.join(' '))).toEqual(['pnpm typecheck', 'pnpm lint', 'pnpm test']);
    expect(s[2]).toMatchObject({ cost: BUDGET, env: { HEAVY_CLASS: 'test', HEAVY_NOSLOT: '1' } });
    expect(s[2]!.env.VITEST_MAX_WORKERS).toBeUndefined(); // heavy.sh's tuning, per package, as a plain suite
    expect(isWide(s)).toBe(true);
    const fast = plan([{ path: 'docs/x.md', deleted: false }], ALWAYS_RUN);
    expect(steps(fast, ROOT, { full: true }).at(-1)!.argv).toEqual(['pnpm', 'test']);
  });
});

describe('stepEnv / outerEnv', () => {
  it("drops the caller's HEAVY_*, GATE_INNER and VITEST_MAX_WORKERS; the step's own win", () => {
    const fast: Step = {
      label: 'test-fast:app',
      argv: [],
      env: { HEAVY_CLASS: 'test-fast' },
      cost: 4,
    };
    const inherited = {
      PATH: '/bin',
      VITEST_MAX_WORKERS: '9',
      GATE_INNER: '1',
      HEAVY_CLASS: 'gate-wide',
      HEAVY_SLOT_CLASS: 'test',
      HEAVY_LABEL: 'gate:wide',
    };
    expect(stepEnv(inherited, fast)).toEqual({ PATH: '/bin', HEAVY_CLASS: 'test-fast' });
    const scripts: Step = { ...fast, env: { VITEST_MAX_WORKERS: '2' } };
    expect(stepEnv({ VITEST_MAX_WORKERS: '9' }, scripts, true)).toEqual({
      VITEST_MAX_WORKERS: '2',
      FORCE_COLOR: '1',
    });
  });

  it('wide holds a `test` slot under its own event class; narrow a `test-fast` one', () => {
    expect(outerEnv(true)).toEqual({
      GATE_INNER: '1',
      HEAVY_CLASS: 'gate-wide',
      HEAVY_SLOT_CLASS: 'test',
      HEAVY_LABEL: 'gate:wide',
    });
    expect(outerEnv(false)).toMatchObject({
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
      'test-fast:scripts',
      'lint',
    ]);
    kids.get('lint')!.finish(0); // 1 free: shared (1) fits, cdk (2) doesn't
    await Promise.resolve();
    await Promise.resolve();
    expect(started.at(-1)).toBe('test-fast:packages/shared');
    for (const l of ['typecheck', 'test-fast:scripts', 'test-fast:extension'])
      kids.get(l)!.finish(0);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(started).toHaveLength(8);
    for (const c of kids.values()) c.finish(0);
    const results = await h.done;
    expect(results.map((r) => r.code)).toEqual(new Array(8).fill(0));
    expect(peak).toBeLessThanOrEqual(10);
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
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(order).toEqual(['typecheck', 'lint']);
    kids[1]!.finish(0);
    for (let i = 0; i < 5; i++) await Promise.resolve();
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

  it('stop: TERM to every running step, nothing new starts, the rest read as interrupted', async () => {
    const kids: ReturnType<typeof child>[] = [];
    const h = schedule(
      [step('test-fast:app', 4), step('test-fast:cdk', 4), step('lint', 4)],
      () => {
        const c = child();
        kids.push(c);
        return c;
      },
      quiet,
      8,
    );
    expect(kids).toHaveLength(2);
    h.stop();
    const results = await h.done;
    expect(kids.every((c) => c.stopped)).toBe(true);
    expect(kids).toHaveLength(2);
    expect(results.map((r) => r.code)).toEqual([143, 143, 143]);
    expect(results[1]!.out).toMatch(/not started/); // cdk ranks after lint, so it never got a slot
    expect(results[2]!.out).toBe('stopped');
  });
});

describe('main', () => {
  it('the caller pass prints the plan and re-runs itself under one heavy.sh slot, its exit passed through', async () => {
    const { ran, exec } = record();
    const calls: { argv: string[]; env: NodeJS.ProcessEnv }[] = [];
    const out: string[] = [];
    const code = await main(['--base', 'origin/main'], {
      run: git(z('M', 'docs/a.md')).run,
      exec,
      outer: (heavy, root, argv, env) => {
        expect([heavy, root]).toEqual([`${ROOT}/scripts/board/heavy.sh`, ROOT]);
        calls.push({ argv, env });
        return 75; // the cap gave up: a failure, never a pass
      },
      log: (l) => out.push(l),
      env: { PATH: '/bin', HEAVY_LABEL: 'stale' },
    });
    expect(code).toBe(75);
    expect(ran).toEqual([]);
    expect(calls).toEqual([
      {
        argv: ['--base', 'origin/main'],
        env: {
          PATH: '/bin',
          GATE_INNER: '1',
          HEAVY_CLASS: 'gate-narrow',
          HEAVY_SLOT_CLASS: 'test-fast',
          HEAVY_LABEL: 'gate:narrow',
        },
      },
    ]);
    expect(out.join('\n')).toMatch(/gate:fast — 1 changed path/);
  });

  it('a wide diff takes a `test` slot', async () => {
    let env: NodeJS.ProcessEnv = {};
    await main([], {
      run: git(z('M', 'packages/shared/src/x.ts')).run,
      outer: (_h, _r, _a, e) => ((env = e), 0),
      log: quiet,
      env: {},
    });
    expect(env).toMatchObject({
      HEAVY_CLASS: 'gate-wide',
      HEAVY_SLOT_CLASS: 'test',
      HEAVY_LABEL: 'gate:wide',
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
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect([...kids.keys()].sort()).toEqual(['lint', 'test-fast:scripts', 'typecheck']);
    kids.get('test-fast:scripts')!.finish(2); // finishes first, but comes later in the order
    kids.get('lint')!.finish(1);
    kids.get('typecheck')!.finish(0);
    expect(await p).toBe(1);
    expect(out.join('\n')).not.toMatch(/changed path/);
    expect(out.at(-1)).toMatch(
      /^gate:fast — typecheck ok · lint exit 1 · test-fast:scripts exit 2 · \d+ s$/,
    );
  });

  it('a signal stops every step and exits 128+n', async () => {
    let fire!: (code: number) => void;
    const kids: ReturnType<typeof child>[] = [];
    const p = main([], {
      run: git(z('M', 'docs/a.md')).run,
      exec: () => {
        const c = child();
        kids.push(c);
        return c;
      },
      onSignal: (fn) => ((fire = fn), () => {}),
      log: quiet,
      env: INNER,
    });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    fire(130);
    expect(await p).toBe(130);
    expect(kids.length).toBe(3);
    expect(kids.every((c) => c.stopped)).toBe(true);
  });

  it('--dry-run prints the plan and runs nothing, neither pass', async () => {
    const { ran, exec } = record();
    const out: string[] = [];
    const outer = () => {
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
    expect(out.join('\n')).toMatch(/at once: one `test-fast` slot, uncapped/);
  });

  it('a diff it can’t read runs the full suite', async () => {
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
    expect(await main([], { run, exec, onSignal: noSignal, log: quiet, env: INNER })).toBe(0);
    expect(ran.at(-1)!.argv).toEqual(['pnpm', 'test']);
    const out: string[] = [];
    await main([], { run, outer: () => 0, log: (l) => out.push(l), env: {} });
    expect(out[0]).toMatch(/couldn't read the diff/);
  });

  it('--help prints usage and runs nothing; a bad flag exits 2', async () => {
    const { ran, exec } = record();
    expect(await main(['--help'], { run: git('').run, exec, log: quiet, env: {} })).toBe(0);
    expect(await main(['--nope'], { run: git('').run, exec, log: quiet, env: {} })).toBe(2);
    expect(ran).toEqual([]);
  });
});
