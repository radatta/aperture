import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MATRIX_EXEMPT, matrixProblems } from '../matrix';
import { SCENARIOS, globMatch, selectScenarios, slowScenarios } from './index';
import type { Scenario } from '../scenario';

// The gate's half of MATRIX_GAP: a scenario whose rows don't hold fails CI before any devcheck runs.
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const realFs = { exists: existsSync, read: (p: string) => readFileSync(p, 'utf8') };

describe('SCENARIOS', () => {
  it('every coverage matrix holds against the repo', () => {
    expect(matrixProblems(SCENARIOS, ROOT, realFs)).toEqual([]);
  });

  it('only smoke declares no rows', () => {
    expect(SCENARIOS.filter((s) => !s.rows.length).map((s) => s.id)).toEqual(MATRIX_EXEMPT);
  });
});

describe('the slow tier', () => {
  it('globs: ** crosses folders, * stays in one, dots are literal', () => {
    expect(globMatch('app/**', 'app/src/pages/Home/index.tsx')).toBe(true);
    expect(globMatch('app/**', 'apps/x.ts')).toBe(false);
    expect(globMatch('lambdas/src/push/**', 'lambdas/src/push/send.ts')).toBe(true);
    expect(globMatch('lambdas/src/*.ts', 'lambdas/src/pushDispatch.ts')).toBe(true);
    expect(globMatch('lambdas/src/*.ts', 'lambdas/src/push/send.ts')).toBe(false);
    expect(globMatch('lambdas/src/pushDispatch.ts', 'lambdas/src/pushDispatchXts')).toBe(false);
  });

  const slow = (id: string, paths: string[]): Scenario => ({
    id,
    title: id,
    tiers: ['full'],
    slowPaths: paths,
    rows: [],
    steps: [{ id: 'w', title: 'w', entry: 'api', cost: 'slow', run: async () => undefined }],
  });
  const ios = slow('ios', ['app/**']);
  const push = slow('push', ['lambdas/src/push/**']);
  const cheap: Scenario = {
    ...ios,
    id: 'cheap',
    slowPaths: undefined,
    steps: [{ ...ios.steps[0]!, cost: undefined }],
  };
  const all = [ios, push, cheap];

  it('a full run takes a scenario’s slow steps only when the branch touches its paths or --feature names it', () => {
    expect(slowScenarios('full', [], all, ['docs/x.md'])).toEqual([]);
    expect(slowScenarios('full', [], all, ['app/src/a.tsx'])).toEqual(['ios']);
    expect(slowScenarios('full', ['push'], all, ['app/src/a.tsx'])).toEqual(['ios', 'push']);
  });

  it('--tier all, a delta run (asked for by name) and an unreadable diff run every slow step', () => {
    expect(slowScenarios('all', [], all, [])).toEqual(['ios', 'push']);
    expect(slowScenarios('delta', [], all, [])).toEqual(['ios', 'push']);
    expect(slowScenarios('full', [], all, null)).toEqual(['ios', 'push']);
  });

  it('--tier all selects the full tier’s scenarios', () => {
    expect(selectScenarios('all', []).map((s) => s.id)).toEqual(
      selectScenarios('full', []).map((s) => s.id),
    );
  });

  it('ios-standalone is slow everywhere and covers app/** plus its own harness', () => {
    const sc = SCENARIOS.find((s) => s.id === 'ios-standalone')!;
    expect(sc.steps.every((s) => s.cost === 'slow')).toBe(true);
    expect(sc.slowPaths).toContain('app/**');
    expect(sc.slowPaths).toContain('tools/mailroom/jobs/sim.sh');
  });
});
