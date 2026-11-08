import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateSimParams, type IosOp } from '../../mailroom/sim.ts';
import { MATRIX_EXEMPT, matrixProblems } from '../matrix';
import { SCENARIOS, globMatch, selectScenarios, slowScenarios } from './index';
import { NeedsYou, type Ctx, type Scenario } from '../scenario';

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

  it('ios-standalone is slow everywhere and covers what iOS can see plus its own harness', () => {
    const sc = SCENARIOS.find((s) => s.id === 'ios-standalone')!;
    const paths = sc.slowPaths!;
    const hit = (f: string) => paths.some((g) => globMatch(g, f));
    expect(sc.steps.every((s) => s.cost === 'slow')).toBe(true);
    expect(hit('app/src/lib/useKeyboardInset.ts')).toBe(true);
    expect(hit('app/src/auth/userStore.ts')).toBe(true);
    expect(hit('tools/mailroom/jobs/sim.sh')).toBe(true);
    expect(hit('app/src/pages/Home/index.tsx')).toBe(false);
  });

  describe('ios-standalone plans', () => {
    const steps = () => SCENARIOS.find((s) => s.id === 'ios-standalone')!.steps;
    const step = (id: string) => steps().find((s) => s.id === id)!;
    const sent: Record<string, IosOp[]> = {};
    let task: Record<string, unknown> = { status: 'in_progress' };
    const ctx = {
      nonce: 'x1full',
      ios: { run: async (name: string, ops: IosOp[]) => void (sent[name] = ops) },
      api: { reads: { getTask: async () => task } },
    } as unknown as Ctx;

    it('verify proves nothing, so says needs you, until the Done form step has completed', async () => {
      await expect(step('verify').run(ctx)).rejects.toBeInstanceOf(NeedsYou);
      // a real change fails, however far the sim got
      task = { status: 'in_progress', reflection: 'x' };
      await expect(step('verify').run(ctx)).rejects.toThrow('a reflection was saved');
      task = { status: 'in_progress' };
      await step('done-form').run(ctx);
      await expect(step('verify').run(ctx)).resolves.toBeUndefined();
    });

    it('every plan is valid, erases past a dropped tap, and the last shuts the sim down', async () => {
      for (const id of ['launch', 'capture', 'done-form', 'relaunch']) await step(id).run(ctx);
      for (const [name, plan] of Object.entries(sent)) {
        const params = { sha: 'a'.repeat(40), timeoutSec: 300, shutdown: false, steps: plan };
        expect(validateSimParams(params), name).toBeNull();
      }
      for (const name of ['capture', 'done-form'])
        expect(sent[name]!.find((o) => o.op === 'erase')).toEqual({ op: 'erase', n: 6 });
      // every typed key is read back where an earlier find/tap found its field
      for (const [name, plan] of Object.entries(sent))
        for (const [i, o] of plan.entries()) {
          if (o.op !== 'keys') continue;
          expect(o.in, `${name} op ${i}`).toBeDefined();
          expect(
            plan.slice(0, i).some((p) => (p.op === 'find' || p.op === 'tap') && p.as === o.in),
            `${name} op ${i}`,
          ).toBe(true);
          expect(o.text.length, `${name} op ${i}`).toBeLessThanOrEqual(6);
        }
      expect(
        Object.values(sent)
          .flat()
          .filter((o) => o.op === 'keys'),
      ).toHaveLength(3);
      expect(sent.relaunch!.at(-1)).toEqual({ op: 'shutdown' });
    });

    it('capture-long pads Tasks, asks for clearance above the accessory bar, and deletes the padding either way', async () => {
      const made: string[] = [];
      const gone: string[] = [];
      let plan: IosOp[] = [];
      const long = (note: string) =>
        ({
          nonce: 'x1full',
          log: () => {},
          api: {
            writes: {
              createTask: async () => ({ id: `t${made.push('x')}` }),
              deleteTask: async (id: string) => void gone.push(id),
            },
          },
          ios: {
            run: async (_: string, ops: IosOp[]) => {
              plan = ops;
              return { steps: [{ i: 5, op: 'expect', status: 'pass', ms: 1, note }] };
            },
          },
        }) as unknown as Ctx;
      await step('capture-long').run(long('long-bar bottom 490 vs keyboard top 558'));
      expect(
        validateSimParams({ sha: 'a'.repeat(40), timeoutSec: 300, shutdown: false, steps: plan }),
      ).toBeNull();
      expect(made.length).toBeGreaterThanOrEqual(12);
      expect(gone).toHaveLength(made.length);
      gone.length = 0;
      await expect(
        step('capture-long').run(long('long-bar bottom 548 vs keyboard top 558')),
      ).rejects.toThrow('the dock sits low on a long page');
      expect(gone).toHaveLength(16);
      gone.length = 0;
      await expect(step('capture-long').run(long('long-bar ok'))).rejects.toThrow('no clearance');
      expect(gone).toHaveLength(16);
    });
  });

  it('every ios-standalone slow path exists: a rename would silently stop the sim running', () => {
    const paths = SCENARIOS.find((s) => s.id === 'ios-standalone')!.slowPaths!;
    for (const g of paths) expect(existsSync(ROOT + g.replace(/\/\*\*$/, ''))).toBe(true);
  });
});
