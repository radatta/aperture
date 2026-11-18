import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadRules, planWithBase, RULES_PATH, union } from './base.ts';
import { modeOf, plan, type Change, type Rules } from './plan.ts';
import * as HEAD from './rules.ts';

const TEXT = readFileSync(fileURLToPath(new URL('./rules.ts', import.meta.url)), 'utf8');
const TESTS = [
  'scripts/src/docs-reader.test.ts',
  'scripts/src/checked-tree.test.ts',
  ...HEAD.ALWAYS_RUN,
];
const ch = (...paths: string[]): Change[] => paths.map((path) => ({ path, deleted: false }));
const withRules = (r: Partial<Rules>) => async () => ({ ...HEAD, ...r }) as Rules;
const fullPkgs = (p: ReturnType<typeof plan>) =>
  Object.keys(p.packages).filter((d) => modeOf(p, d) === 'full');
const never = (): string => {
  throw new Error('readBase called');
};

describe('loadRules', () => {
  it('loads the tracked rules.ts on its own (a temp .mts)', async () => {
    const r = await loadRules(TEXT);
    expect(r.PACKAGES).toEqual(HEAD.PACKAGES);
    expect(r.REPO_FULL).toEqual(HEAD.REPO_FULL);
    expect(String(r.MODULE_EXT)).toBe(String(HEAD.MODULE_EXT));
  });

  it('refuses an import, a missing export and a broken file', async () => {
    await expect(loadRules(`import { x } from './x.ts';\n${TEXT}`)).rejects.toThrow(/imports/);
    await expect(loadRules(`export * from './x.ts';\n`)).rejects.toThrow(/imports/);
    await expect(loadRules(`const m = await import('./x.ts');\n`)).rejects.toThrow(/imports/);
    await expect(
      loadRules(TEXT.replace('export const ALWAYS_RUN', 'const ALWAYS_RUN')),
    ).rejects.toThrow(/no ALWAYS_RUN/);
    await expect(loadRules('export const PACKAGES = [;')).rejects.toThrow();
  });
});

describe('planWithBase', () => {
  it('no rules.ts change: HEAD’s plan alone, the base never read', async () => {
    const p = await planWithBase(ch('docs/ops/LANES.md'), TESTS, never);
    expect(p).toEqual(plan(ch('docs/ops/LANES.md'), TESTS));
  });

  it('a rule HEAD dropped still runs its tests: the base named them', async () => {
    // HEAD has no rule for docs-reader; the base reads docs/ with it
    const base = withRules({
      INPUT_RULES: [
        ...HEAD.INPUT_RULES,
        { inputs: ['docs/'], tests: ['scripts/src/docs-reader.test.ts'], why: 'old rule' },
      ],
    });
    const diff = ch(RULES_PATH, 'docs/ops/LANES.md');
    const p = await planWithBase(diff, TESTS, () => TEXT, base);
    expect(plan(diff, TESTS).packages.scripts!.tests).not.toContain(
      'scripts/src/docs-reader.test.ts',
    );
    expect(p.packages.scripts!.tests).toContain('scripts/src/docs-reader.test.ts');
    expect(p.packages.scripts!.why['scripts/src/docs-reader.test.ts']).toBe(
      'docs/ops/LANES.md → old rule (the merge-base rules)',
    );
    expect(p.notes).toContain(
      `${RULES_PATH} changed: planned with the merge-base's rules too; the union runs`,
    );
    expect(p.full).toEqual([]);
  });

  it('what the base ran whole stays whole (this lane: limits.json was REPO_FULL)', async () => {
    const base = withRules({
      REPO_FULL: [...HEAD.REPO_FULL, { match: ['scripts/board/limits.json'], why: 'old trigger' }],
    });
    const p = await planWithBase(
      ch(RULES_PATH, 'scripts/board/limits.json'),
      TESTS,
      () => TEXT,
      base,
    );
    expect(p.full).toEqual(['scripts/board/limits.json: old trigger (the merge-base rules)']);
    // HEAD alone keeps it narrow
    expect(plan(ch('scripts/board/limits.json'), TESTS).full).toEqual([]);
  });

  it('the union keeps HEAD’s tests and reasons first', async () => {
    const p = await planWithBase(ch(RULES_PATH, 'docs/ops/LANES.md'), TESTS, () => TEXT);
    expect(p.packages).toEqual(plan(ch(RULES_PATH, 'docs/ops/LANES.md'), TESTS).packages);
  });

  const cases: [string, () => string, ReturnType<typeof withRules> | undefined, RegExp][] = [
    ['unreadable', never, undefined, /couldn't be loaded \(readBase called\)/],
    ['not loadable', () => 'export const PACKAGES = [;', undefined, /couldn't be loaded/],
    [
      'with another package list',
      () => TEXT,
      withRules({ PACKAGES: HEAD.PACKAGES.slice(1) }),
      /package list changed/,
    ],
  ];
  it.each(cases)('a base copy %s runs the whole suite', async (_, read, load, why) => {
    const p = await planWithBase(ch(RULES_PATH), TESTS, read, load);
    expect(p.full).toEqual([expect.stringMatching(why)]);
  });

  it('rules.ts deleted runs the whole suite; added (no base copy) too', async () => {
    const del = await planWithBase([{ path: RULES_PATH, deleted: true }], TESTS, () => TEXT);
    expect(del.full).toEqual([expect.stringMatching(/deleted/)]);
    const added = await planWithBase(ch(RULES_PATH), TESTS, () => {
      throw new Error(`fatal: path '${RULES_PATH}' exists on disk, but not in 'abc'`);
    });
    expect(added.full).toEqual([expect.stringMatching(/couldn't be loaded/)]);
  });
});

describe('union', () => {
  it('per package: whole suites, related modules and named tests from both, deduped', () => {
    const a = plan(ch('app/src/a.ts'), TESTS);
    const b = plan(ch('app/package.json', 'app/src/a.ts'), TESTS);
    const u = union(a, b);
    expect(fullPkgs(u)).toEqual(['app']);
    expect(u.packages.app!.full).toEqual([expect.stringMatching(/\(the merge-base rules\)$/)]);
    expect(u.packages.app!.related).toEqual(['app/src/a.ts', 'app/package.json']);
    expect(u.packages.scripts!.tests).toEqual(a.packages.scripts!.tests);
  });
});
