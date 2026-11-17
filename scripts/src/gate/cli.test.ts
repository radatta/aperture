import { describe, expect, it } from 'vitest';
import { fakeRun } from '../bot/fakes.ts';
import { main, parseArgs, readDiff, stepEnv, steps, type Step } from './cli.ts';
import { plan } from './plan.ts';
import { ALWAYS_RUN } from './rules.ts';

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
const record = (codes: Record<string, number> = {}) => {
  const ran: Step[] = [];
  const exec = (s: Step, heavy: string) => {
    expect(heavy).toBe(`${ROOT}/scripts/board/heavy.sh`);
    ran.push(s);
    return codes[s.label] ?? 0;
  };
  return { ran, exec };
};
const quiet = () => {};

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
  it('a fast plan: typecheck, lint, then a related run per reached package under its own class, env not argv', () => {
    const p = plan([{ path: 'docs/ops/LANES.md', deleted: false }], ALWAYS_RUN);
    const s = steps(p, ROOT, { full: false });
    expect(s.map((x) => x.label)).toEqual(['typecheck', 'lint', 'test-fast:scripts']);
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
      VITEST_MAX_WORKERS: '2',
    });
  });

  it('a package reached only through changed modules may select nothing', () => {
    const p = plan([{ path: 'packages/shared/src/x.ts', deleted: false }], ALWAYS_RUN);
    const app = steps(p, ROOT, { full: false }).find((x) => x.label === 'test-fast:app')!;
    expect(app.argv).toContain('--passWithNoTests=true');
    expect(app.env.VITEST_MAX_WORKERS).toBeUndefined(); // heavy.sh sets the container cap
  });

  it("the caller's VITEST_MAX_WORKERS never reaches a step; a step's own wins", () => {
    const fast: Step = { label: 'test-fast:app', argv: [], env: { HEAVY_CLASS: 'test-fast' } };
    expect(stepEnv({ PATH: '/bin', VITEST_MAX_WORKERS: '9' }, fast)).toEqual({
      PATH: '/bin',
      HEAVY_CLASS: 'test-fast',
    });
    const scripts: Step = { ...fast, env: { VITEST_MAX_WORKERS: '2' } };
    expect(stepEnv({ VITEST_MAX_WORKERS: '9' }, scripts)).toEqual({ VITEST_MAX_WORKERS: '2' });
  });

  it('a package-full plan runs that package’s own test script under the test class (the cap applies)', () => {
    const p = plan([{ path: 'app/package.json', deleted: false }], ALWAYS_RUN);
    const s = steps(p, ROOT, { full: false });
    expect(s.find((x) => x.label === 'test:app')).toEqual({
      label: 'test:app',
      argv: ['pnpm', '--filter', '@aperture/app', 'test'],
      env: { HEAVY_CLASS: 'test', HEAVY_LABEL: 'test:app' },
    });
  });

  it('a repo-full plan, or --full, is one `pnpm test`', () => {
    const p = plan([{ path: 'pnpm-lock.yaml', deleted: false }], ALWAYS_RUN);
    expect(steps(p, ROOT, { full: false }).map((x) => x.argv.join(' '))).toEqual([
      'pnpm typecheck',
      'pnpm lint',
      'pnpm test',
    ]);
    const fast = plan([{ path: 'docs/x.md', deleted: false }], ALWAYS_RUN);
    expect(steps(fast, ROOT, { full: true }).at(-1)!.argv).toEqual(['pnpm', 'test']);
  });
});

describe('main', () => {
  it('runs every step and exits with the first failure; later steps still run', () => {
    const { ran, exec } = record({ lint: 1, 'test-fast:scripts': 2 });
    expect(main([], git(z('M', 'docs/a.md')).run, exec, quiet)).toBe(1);
    expect(ran.map((s) => s.label)).toEqual(['typecheck', 'lint', 'test-fast:scripts']);
  });

  it('heavy.sh giving up (75) is a failure, never a pass', () => {
    const { exec } = record({ 'test-fast:scripts': 75 });
    expect(main([], git(z('M', 'docs/a.md')).run, exec, quiet)).toBe(75);
  });

  it('--dry-run prints the plan and runs nothing', () => {
    const { ran, exec } = record();
    const out: string[] = [];
    expect(main(['--dry-run'], git(z('M', 'docs/a.md')).run, exec, (l) => out.push(l))).toBe(0);
    expect(ran).toEqual([]);
    expect(out.join('\n')).toMatch(/app: skipped — nothing in the diff reaches it/);
    expect(out.join('\n')).toMatch(/would run: test-fast:scripts/);
  });

  it('a diff it can’t read runs the full suite', () => {
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
    expect(main([], run, exec, (l) => out.push(l))).toBe(0);
    expect(ran.at(-1)!.argv).toEqual(['pnpm', 'test']);
    expect(out[0]).toMatch(/couldn't read the diff/);
  });

  it('--help prints usage and runs nothing; a bad flag exits 2', () => {
    const { ran, exec } = record();
    expect(main(['--help'], git('').run, exec, quiet)).toBe(0);
    expect(main(['--nope'], git('').run, exec, quiet)).toBe(2);
    expect(ran).toEqual([]);
  });
});
