// The registry check on made-up trees (the real tree: rules.test.ts). Each case is a file a lane could add that the
// gate would never run or never reach, which main's gate only found after a whole run, through rules.test.ts.
import { describe, expect, it } from 'vitest';
import { braces, checkRegistry, formatProblems, globMatch, projectsFor } from './registry.ts';
import { ALWAYS_RUN, PACKAGES, type Project } from './rules.ts';

const PLAIN = "import { it } from 'vitest';\nit('x', () => {});\n";
// A tree: path → text (plain by default).
const check = (tree: Record<string, string>) =>
  checkRegistry(Object.keys(tree), (p) => {
    if (!(p in tree)) throw new Error(`read outside the tree: ${p}`);
    return tree[p]!;
  });
const files = (ps: string[]) => Object.fromEntries(ps.map((p) => [p, PLAIN]));

describe('checkRegistry', () => {
  it('a test file in every package’s include passes, as do ALWAYS_RUN’s graph-blind scanners', () => {
    expect(
      check(
        files([
          'app/src/a/b.test.tsx',
          'app/src/a.test.ts',
          'app/pwa/x.test.ts',
          'app/src/auth/auth.test.tsx',
          'lambdas/src/x.test.ts',
          'packages/shared/src/x.test.ts',
          'cdk/src/lib/x.test.ts',
          'extension/test/x.test.ts',
          'scripts/src/x.test.ts',
          ...ALWAYS_RUN,
        ]),
      ),
    ).toEqual([]);
  });

  it.each([
    [
      'scripts/board/x.test.ts',
      /no vitest project in scripts includes it/,
      /scripts\/vitest\.config/,
    ],
    ['app/test/x.test.tsx', /no vitest project in app includes it/, /PACKAGES\[\]\.projects/],
    ['app/pwa/x.test.tsx', /no vitest project in app/, /widen the include/], // pwa takes .ts only
    ['app/src/a.spec.ts', /no vitest project in app/, /move or rename/],
    ['lambdas/src/x.test.mjs', /no vitest project in lambdas/, /rename/],
    ['tools/x.test.ts', /outside every vitest package/, /move it under a package/],
  ])('%s: never run, named with why and the fix', (file, why, fix) => {
    const ps = check(files([file]));
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatchObject({ kind: 'include', file });
    expect(ps[0]!.why).toMatch(why);
    expect(ps[0]!.fix).toMatch(fix);
  });

  it('a file under node_modules or a snapshot is no test', () => {
    expect(
      check({
        ...files(['app/node_modules/x/a.test.ts', 'lambdas/src/a.test.ts']),
        'lambdas/src/__snapshots__/a.test.ts.snap': '',
      }),
    ).toEqual([]);
  });

  it('a graph-blind test or module no rule names is refused, with the list to add it to', () => {
    const blind = "import { readFileSync } from 'node:fs';\nreadFileSync('x');\n";
    const ps = check({ 'scripts/src/new.test.ts': blind, 'app/src/lib/reads.ts': blind });
    expect(ps.map((p) => [p.kind, p.file])).toEqual([
      ['blind', 'scripts/src/new.test.ts'],
      ['blind', 'app/src/lib/reads.ts'],
    ]);
    expect(ps[0]!.fix).toMatch(/INPUT_RULES entry .*ALWAYS_RUN or SELF_CONTAINED/);
    expect(ps[1]!.fix).toMatch(/MODULE_READERS/);
    // Each API the graph can't follow counts.
    for (const body of [
      "spawn('x')",
      "import.meta.glob('./*.ts')",
      "import x from './a.css?raw'",
      'await import(name)',
      "new URL('./x', import.meta.url)",
    ])
      expect(check({ 'lambdas/src/b.test.ts': body }), body).toHaveLength(1);
    // A static dynamic import is graph-visible.
    expect(check({ 'lambdas/src/b.test.ts': "await import('./a.ts')" })).toEqual([]);
  });

  it('the gate’s own files, a dir claimed whole and files outside the packages are exempt from the blind scan', () => {
    const blind = 'readFileSync(x)';
    expect(
      check({
        'scripts/src/gate/x.test.ts': blind,
        'extension/test/x.test.ts': blind,
        'tools/mailroom/x.sh.ts': blind,
      }),
    ).toEqual([]);
  });

  it('an orphan snapshot and an unclaimed fixtures folder are named', () => {
    const ps = check({
      ...files(['lambdas/src/a.test.ts']),
      'lambdas/src/__snapshots__/gone.test.ts.snap': '',
      'app/testdata/a.json': '{}', // lambdas/src/ is a rule input; app/testdata/ isn't
    });
    expect(ps.map((p) => [p.kind, p.file])).toEqual([
      ['snapshot', 'lambdas/src/__snapshots__/gone.test.ts.snap'],
      ['fixtures', 'app/testdata/'],
    ]);
  });

  it('the output gives each problem its file, why and fix', () => {
    expect(formatProblems(check(files(['tools/x.test.ts'])))).toMatch(
      /^ {2}tools\/x\.test\.ts: outside every vitest package.*\n {4}fix: move it/,
    );
  });
});

describe('the globs', () => {
  it('braces expand; `**/` takes zero or more dirs, dot dirs too; `*` stays in one segment', () => {
    expect(braces('src/**/*.test.{ts,tsx}')).toEqual(['src/**/*.test.ts', 'src/**/*.test.tsx']);
    expect(braces('{a,b}/{c,d}')).toEqual(['a/c', 'a/d', 'b/c', 'b/d']);
    expect(globMatch('src/**/*.test.{ts,tsx}', 'src/a.test.tsx')).toBe(true);
    expect(globMatch('src/**/*.test.ts', 'src/a/b/c.test.ts')).toBe(true);
    expect(globMatch('src/**/*.test.ts', 'src/.hidden/c.test.ts')).toBe(true); // vitest globs with dot: true
    expect(globMatch('src/*.test.ts', 'src/a/c.test.ts')).toBe(false);
    expect(globMatch('src/**/*.test.ts', 'srcx/c.test.ts')).toBe(false);
  });

  it('a file in two projects is in both; an exclude takes it out of one', () => {
    const two: Project[] = [
      { name: 'a', include: ['src/**/*.test.ts'] },
      { name: 'b', include: ['src/x.test.ts'] },
    ];
    expect(projectsFor(two, 'src/x.test.ts').map((p) => p.name)).toEqual(['a', 'b']);
    two[0]!.exclude = ['src/x.test.ts'];
    expect(projectsFor(two, 'src/x.test.ts').map((p) => p.name)).toEqual(['b']);
  });

  it('every real include uses only syntax the check reads (an extglob would be refused as a `glob` problem)', () => {
    expect(check({}).filter((p) => p.kind === 'glob')).toEqual([]);
    const app = PACKAGES.find((p) => p.dir === 'app')!;
    const saved = app.projects;
    app.projects = [{ include: ['src/**/*.test.?(c|m)ts'] }];
    try {
      expect(check({}).map((p) => [p.kind, p.why])).toEqual([
        [
          'glob',
          expect.stringMatching(/^app: the glob src\/\*\*\/\*\.test\.\?\(c\|m\)ts uses syntax/),
        ],
      ]);
    } finally {
      app.projects = saved;
    }
  });
});
