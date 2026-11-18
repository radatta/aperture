import { describe, expect, it } from 'vitest';
import { FIXTURE_SUITE } from '../fixture-inputs.ts';
import { matches, modeOf, plan, type Change } from './plan.ts';
import { ALWAYS_RUN, MAX_CHANGED } from './rules.ts';

const TESTS = [
  'app/src/pages/Home/Home.test.tsx',
  'app/src/pages/Home/HomeCard.test.tsx',
  'app/src/pages/Settings/Settings.test.tsx',
  'app/src/styles/fieldSize.test.ts',
  'app/src/styles/theme.test.ts',
  'app/src/styles/tokens.test.ts',
  'lambdas/src/anthropic/parsePrompt.test.ts',
  'lambdas/src/local/edge.test.ts',
  'extension/test/libs.test.ts',
  'extension/test/overlay.test.ts',
  'scripts/src/lc-e2e/extension.test.ts',
  'scripts/src/board/board-cli.test.ts',
  'scripts/src/board/tower/queue.test.ts',
  'scripts/src/devcheck/run.test.ts',
  'scripts/src/devcheck/scenarios/index.test.ts',
  'scripts/src/workflow-triggers.test.ts',
  'scripts/src/checked-tree.test.ts',
  FIXTURE_SUITE,
  ...ALWAYS_RUN,
];
const ch = (...paths: string[]): Change[] => paths.map((path) => ({ path, deleted: false }));
const del = (path: string): Change => ({ path, deleted: true });
const pkg = (p: ReturnType<typeof plan>, dir: string) => p.packages[dir]!;
const fullPkgs = (p: ReturnType<typeof plan>) =>
  Object.keys(p.packages).filter((d) => modeOf(p, d) === 'full');

describe('matches', () => {
  it('prefix, exact, * within a segment, **/ across directories', () => {
    expect(matches('docs/', 'docs/ops/X.md')).toBe(true);
    expect(matches('docs/', 'docsx/a.md')).toBe(false);
    expect(matches('package.json', 'package.json')).toBe(true);
    expect(matches('package.json', 'app/package.json')).toBe(false);
    expect(matches('app/tsconfig*.json', 'app/tsconfig.app.json')).toBe(true);
    expect(matches('app/tsconfig*.json', 'app/src/tsconfig.json')).toBe(false);
    expect(matches('app/src/**/*.tsx', 'app/src/A.tsx')).toBe(true);
    expect(matches('app/src/**/*.tsx', 'app/src/a/b/C.tsx')).toBe(true);
    expect(matches('app/src/**/*.tsx', 'app/src/a/b/C.ts')).toBe(false);
    expect(matches('a.b', 'aXb')).toBe(false); // dots are literal
  });
});

describe('plan', () => {
  it('an empty diff runs everything (an empty diff is a broken diff)', () => {
    expect(plan([], TESTS).full).toEqual([expect.stringMatching(/^empty diff/)]);
  });

  it(`more than ${MAX_CHANGED} changed paths runs everything`, () => {
    const many = Array.from({ length: MAX_CHANGED + 1 }, (_, i) => `app/src/f${i}.ts`);
    expect(plan(ch(...many), TESTS).full[0]).toMatch(/over 150/);
    expect(plan(ch(...many.slice(1)), TESTS).full).toEqual([]);
  });

  it.each([
    ['pnpm-lock.yaml'],
    ['package.json'],
    ['tsconfig.base.json'],
    ['identifiers.json'],
    ['eslint.config.js'],
    ['scripts/board/heavy.sh'],
    ['scripts/src/gate/plan.ts'],
  ])('%s → the whole suite', (path) => {
    const p = plan(ch(path), TESTS);
    expect(p.full).toEqual([expect.stringContaining(path)]);
    expect(p.notes).toEqual([]); // claimed: not an unknown path
  });

  it.each([
    ['app/package.json', 'app'],
    ['lambdas/tsconfig.json', 'lambdas'],
    ['app/tsconfig.app.json', 'app'],
    ['scripts/vitest.config.ts', 'scripts'],
    ['app/vite.config.ts', 'app'],
    ['app/src/test/setup.ts', 'app'],
    ['lambdas/src/test/setup.ts', 'lambdas'],
  ])('%s → %s whole, the rest by rule', (path, dir) => {
    const p = plan(ch(path), TESTS);
    expect(p.full).toEqual([]);
    expect(fullPkgs(p)).toEqual([dir]);
  });

  it('near misses stay fast: a nested tsconfig-like or package-like name is just a file', () => {
    expect(fullPkgs(plan(ch('app/src/package.json.ts'), TESTS))).toEqual([]);
    expect(fullPkgs(plan(ch('docs/package.json'), TESTS))).toEqual([]);
  });

  it('a changed module goes to `related` in its package and in each package that reaches it', () => {
    const p = plan(ch('packages/shared/src/coach.ts'), TESTS);
    for (const d of ['packages/shared', 'app', 'lambdas', 'cdk', 'extension'])
      expect(pkg(p, d).related, d).toEqual(['packages/shared/src/coach.ts']);
    // scripts has no static import of shared: its runtime readers of shared come by rule, not by the graph
    expect(pkg(p, 'scripts').related).toEqual([]);
    expect(pkg(p, 'scripts').tests).toEqual(
      expect.arrayContaining([
        'scripts/src/smoke.test.ts',
        'scripts/src/devcheck/scenarios/siri-capture.ts',
      ]),
    );
    const a = plan(ch('app/src/pages/Home/HomeCard.tsx'), TESTS);
    expect(pkg(a, 'app').related).toEqual(['app/src/pages/Home/HomeCard.tsx']);
    expect(pkg(a, 'lambdas').related).toEqual([]);
  });

  it('a changed test runs; a sibling test of a changed source runs by name', () => {
    const p = plan(
      ch('app/src/pages/Home/Home.test.tsx', 'app/src/pages/Home/HomeCard.tsx'),
      TESTS,
    );
    expect(pkg(p, 'app').tests).toEqual(
      expect.arrayContaining([
        'app/src/pages/Home/Home.test.tsx',
        'app/src/pages/Home/HomeCard.test.tsx',
      ]),
    );
  });

  it('a snapshot selects only its owning test; an orphan snapshot runs its package', () => {
    const p = plan(ch('lambdas/src/anthropic/__snapshots__/parsePrompt.test.ts.snap'), TESTS);
    expect(fullPkgs(p)).toEqual([]);
    expect(pkg(p, 'lambdas').tests).toEqual(['lambdas/src/anthropic/parsePrompt.test.ts']);
    expect(pkg(p, 'lambdas').related).toEqual([]);
    const o = plan(ch('lambdas/src/anthropic/__snapshots__/gone.test.ts.snap'), TESTS);
    expect(fullPkgs(o)).toEqual(['lambdas']);
  });

  it('a graph-blind input adds the tests that read it', () => {
    const p = plan(ch('cdk/src/lib/app-stack.ts'), TESTS);
    expect(pkg(p, 'lambdas').tests).toContain('lambdas/src/local/edge.test.ts');
    const e = plan(ch('extension/src/overlay.js'), TESTS);
    expect(pkg(e, 'extension').tests).toEqual(
      expect.arrayContaining(['extension/test/libs.test.ts', 'extension/test/overlay.test.ts']),
    );
    expect(pkg(e, 'scripts').tests).toContain('scripts/src/lc-e2e/extension.test.ts');
    const w = plan(ch('.github/workflows/pr.yml'), TESTS);
    expect(pkg(w, 'scripts').tests).toEqual(
      expect.arrayContaining([
        'scripts/src/workflow-triggers.test.ts',
        'scripts/src/checked-tree.test.ts',
      ]),
    );
    expect(fullPkgs(w)).toEqual([]);
  });

  it('the extension’s version runs the app’s Settings and the dev check’s scenarios, which read it', () => {
    const m = plan(ch('extension/manifest.json'), TESTS);
    expect(pkg(m, 'app').tests).toContain('app/src/pages/Settings/Settings.test.tsx');
    expect(pkg(m, 'scripts').tests).toEqual(
      expect.arrayContaining([
        'scripts/src/devcheck/scenarios/index.test.ts',
        'scripts/src/lc-e2e/extension.test.ts',
      ]),
    );
    expect(pkg(m, 'extension').tests).toContain('extension/test/overlay.test.ts');
    const v = plan(ch('app/pwa/extensionVersion.ts'), TESTS);
    expect(pkg(v, 'app').tests).toContain('app/src/pages/Settings/Settings.test.tsx');
    expect(pkg(v, 'scripts').tests).toContain('scripts/src/devcheck/scenarios/index.test.ts');
  });

  it('what a setupFile imports runs its packages whole: no test imports a setupFile, so the graph never sees it', () => {
    expect(fullPkgs(plan(ch('packages/shared/src/consoleGuard.ts'), TESTS)).sort()).toEqual([
      'app',
      'lambdas',
    ]);
    expect(fullPkgs(plan(ch('app/src/modules/push/browserPush.ts'), TESTS))).toEqual(['app']);
    // A rule's `pkgs` replaces the owning package: shared isn't run whole for a guard change.
    expect(
      modeOf(plan(ch('packages/shared/src/consoleGuard.ts'), TESTS), 'packages/shared'),
    ).not.toBe('full');
  });

  it('app sources run the raw-glob scanners', () => {
    const p = plan(ch('app/src/pages/Home/HomeCard.tsx'), TESTS);
    expect(pkg(p, 'app').tests).toEqual(
      expect.arrayContaining(['app/src/styles/fieldSize.test.ts', 'app/src/styles/theme.test.ts']),
    );
  });

  it('a same-area change runs the area’s tests (spawned CLIs)', () => {
    const p = plan(ch('scripts/src/devcheck/scenarios/new.ts'), TESTS);
    expect(pkg(p, 'scripts').tests).toContain('scripts/src/devcheck/run.test.ts');
    expect(fullPkgs(p)).toEqual([]);
  });

  it('renaming a Lambda entry file runs the stacks that name it', () => {
    const p = plan([del('lambdas/src/coachWorker.ts')], TESTS);
    expect(pkg(p, 'cdk').tests).toContain('cdk/src/lib/coach-worker.ts');
    const s = plan(ch('packages/shared/src/x.ts'), TESTS);
    expect(pkg(s, 'scripts').tests).toContain('scripts/src/lc-e2e/extension.test.ts');
  });

  it('the always-run scanners run on every plan', () => {
    const p = plan(ch('docs/ops/LANES.md'), TESTS);
    for (const t of ALWAYS_RUN) expect(pkg(p, 'scripts').tests).toContain(t);
  });

  it('the mailroom fixture suite runs exactly when fixture-inputs.ts says so', () => {
    expect(pkg(plan(ch('tools/mailroom/runner.sh'), TESTS), 'scripts').tests).toContain(
      FIXTURE_SUITE,
    );
    expect(pkg(plan(ch('docs/ops/LANES.md'), TESTS), 'scripts').tests).not.toContain(FIXTURE_SUITE);
  });

  it('a path outside every package that no rule names runs every file-reading test, with a note', () => {
    const p = plan(ch('tools/raycast/x.sh'), TESTS);
    expect(p.notes).toEqual([expect.stringContaining('tools/raycast/x.sh')]);
    expect(pkg(p, 'lambdas').tests).toContain('lambdas/src/local/edge.test.ts');
    expect(pkg(p, 'scripts').tests).toContain('scripts/src/workflow-triggers.test.ts');
    expect(fullPkgs(p)).toEqual([]);
  });

  it('a file under a package that neither a rule nor the graph sees runs that package', () => {
    const p = plan(ch('app/public/robots.txt'), TESTS);
    expect(fullPkgs(p)).toEqual(['app']);
  });

  it('deletions: a module leans on typecheck, an unseen non-module runs its package, a deleted test is dropped', () => {
    const m = plan([del('app/src/pages/Home/Old.tsx')], TESTS);
    expect(fullPkgs(m)).toEqual([]);
    expect(fullPkgs(plan([del('app/public/old.txt')], TESTS))).toEqual(['app']);
    // a deleted stylesheet or JSON: an ambient declaration can still type its import, so tsc can't vouch for it
    expect(fullPkgs(plan([del('app/src/pages/Home/old.css')], TESTS))).toEqual(['app']);
    const t = plan([del('app/src/pages/Home/Home.test.tsx')], TESTS);
    expect(pkg(t, 'app').tests).not.toContain('app/src/pages/Home/Home.test.tsx');
    // a deleted .css/.json widens even when a rule claims it: the rule's tests aren't its importers
    expect(fullPkgs(plan([del('app/src/styles/old.css')], TESTS))).toEqual(['app']);
    // any other deleted file a rule claims is read from disk, so the rule's tests are its readers
    expect(fullPkgs(plan([del('app/pages/old.html')], TESTS))).toEqual([]);
    // a deleted file outside every package: the rule's tests run, nothing wider
    expect(fullPkgs(plan([del('tools/mailroom/bench/old.json')], TESTS))).toEqual([]);
  });

  it('modeOf: skip a package nothing reaches', () => {
    const p = plan(ch('docs/ops/LANES.md'), TESTS);
    expect(modeOf(p, 'app')).toBe('skip');
    expect(modeOf(p, 'scripts')).toBe('fast');
  });
});
