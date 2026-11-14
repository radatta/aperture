import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IosAssert, validateSimParams, type IosOp } from '../../mailroom/sim.ts';
import { MATRIX_EXEMPT, matrixProblems } from '../matrix';
import {
  PROBE_COVERED,
  SCENARIOS,
  globMatch,
  probeSkip,
  selectScenarios,
  slowScenarios,
} from './index';
import { NeedsYou, type Ctx, type Scenario } from '../scenario';
import { IOS_SLOW_PATHS } from './ios-paths';

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

  it("the bot's iOS routing list is exactly every iOS scenario's slowPaths", () => {
    const ios = SCENARIOS.filter((s) => s.steps.some((x) => x.entry === 'ios'));
    expect(ios.map((s) => s.id).sort()).toEqual([
      'category-suggest',
      'ios-probe',
      'ios-standalone',
    ]);
    expect([...IOS_SLOW_PATHS].sort()).toEqual(ios.flatMap((s) => s.slowPaths ?? []).sort());
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
      // every erase reads its field back where the keys before it did (found empty, before typing)
      for (const name of ['capture', 'done-form']) {
        const plan = sent[name]!;
        const i = plan.findIndex((o) => o.op === 'erase');
        const before = plan.slice(0, i).filter((o) => o.op === 'keys');
        expect(plan[i], name).toEqual({
          op: 'erase',
          n: 6,
          in: (before.at(-1) as { in?: string }).in,
        });
      }
      // only the done form's Cancel must go away after its tap
      const closing = Object.values(sent)
        .flat()
        .filter((o) => o.op === 'tap' && 'closes' in o);
      expect(closing).toEqual([
        expect.objectContaining({ label: 'Cancel', role: 'AXButton', closes: true }),
      ]);
      // and the modal is positively gone: the search field is found, keyboard down, right after Cancel (a modal covers it)
      const form = sent['done-form']!;
      const cancel = form.findIndex((o) => o.op === 'tap' && 'closes' in o);
      expect(form[cancel + 1]).toMatchObject({
        op: 'find',
        label: 'Search tasks',
        near: { x: 200, y: 332 },
        role: 'AXTextField',
      });
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
      // only the run's last job skips readBuild's trip back Home (launch's next job starts on Home)
      const reads = Object.entries(sent).flatMap(([n, p]) =>
        p.filter((o) => o.op === 'readBuild').map((o) => [n, o]),
      );
      expect(reads).toEqual([
        ['launch', { op: 'readBuild' }],
        ['relaunch', { op: 'readBuild', stay: true }],
      ]);
      // no hint on a label the plan itself uses for two roles (long-field/long-preview): the scan's order tells those
      // apart. A plan-level check only: it can't see the screen, so a hinted label must also be unique there (by hand)
      for (const [name, plan] of Object.entries(sent))
        for (const o of plan) {
          if ((o.op !== 'find' && o.op !== 'tap') || !('hint' in o)) continue;
          const roles = new Set(
            plan
              .filter((p) => 'label' in p && p.label === o.label)
              .map((p) => ('role' in p ? p.role : '')),
          );
          expect(roles.size, `${name} ${o.label}`).toBe(1);
        }
    });

    it('capture-long pads Tasks, asks for clearance above the accessory bar, and deletes the padding either way', async () => {
      const made: string[] = [];
      const gone: string[] = [];
      const planned: { taskId: string; day: string }[] = [];
      let plan: IosOp[] = [];
      const ctxWith = (run: () => Promise<unknown>) =>
        ({
          nonce: 'x1full',
          log: () => {},
          api: {
            reads: { getSettings: async () => ({ dayStartHour: 4 }) },
            writes: {
              upsertPlan: async (p: { taskId: string; day: string }) => void planned.push(p),
              createTask: async () => ({ id: `t${made.push('x')}` }),
              deleteTask: async (id: string) => void gone.push(id),
            },
          },
          ios: {
            run: async (_: string, ops: IosOp[]) => {
              plan = ops;
              return run();
            },
          },
        }) as unknown as Ctx;
      const good: Record<string, string> = {
        'long-bar': 'long-bar bottom 498 vs keyboard top 556',
        'long-bar-task': 'long-bar-task bottom 498 vs keyboard top 556',
        'long-field': 'long-field bottom 468 vs keyboard top 556',
        'long-preview': 'long-preview bottom 490 vs keyboard top 556',
      };
      const passing = (over: Record<string, string> = {}) =>
        ctxWith(async () => ({
          steps: Object.values({ ...good, ...over }).map((note, i) => ({
            i,
            op: 'expect',
            status: 'pass',
            ms: 1,
            note,
          })),
        }));
      // a failed job: the expects before `at` passed with these notes, the op at `at` failed
      const failing = (
        detail: string,
        at: (ops: IosOp[]) => number,
        note: string,
        over: Record<string, string> = {},
      ) =>
        ctxWith(async () => {
          const i = at(plan);
          const notes: Record<string, string> = { ...good, ...over };
          const steps = plan.slice(0, i).flatMap((o, j) =>
            o.op === 'expect' && 'as' in o && notes[o.as]
              ? [
                  {
                    i: j,
                    op: 'expect',
                    status: 'pass',
                    ms: 1,
                    note: notes[o.as],
                  },
                ]
              : [],
          );
          steps.push({ i, op: plan[i]!.op, status: 'fail', ms: 1, note });
          const result = { status: 'fail', reason: 'ASSERT', detail, steps };
          throw new Error('iOS: failed', { cause: new IosAssert('failed', result as never) });
        });
      const opAs = (op: string, as: string) => (ops: IosOp[]) =>
        ops.findIndex((o) => o.op === op && 'as' in o && o.as === as);
      const knownLow = (p: Promise<unknown>) =>
        expect(p).rejects.toSatisfy(
          (e: unknown) =>
            e instanceof NeedsYou &&
            e.stepOnly === true &&
            e.reason.startsWith('known issue, still live'),
        );
      const deletedAll = () => {
        expect(gone).toHaveLength(16);
        gone.length = 0;
      };

      await step('capture-long').run(passing());
      expect(
        validateSimParams({ sha: 'a'.repeat(40), timeoutSec: 300, shutdown: false, steps: plan }),
      ).toBeNull();
      for (const o of plan) if (o.op === 'keys') expect(o.text.length).toBeLessThanOrEqual(6);
      // a fresh start, whatever the Done form step left on screen
      expect(plan.slice(0, 2)).toEqual([{ op: 'kill', method: 'terminate' }, { op: 'launch' }]);
      // the field is measured at focus (after it's found, before anything is typed) and after the Review
      const keys = plan.findIndex((o) => o.op === 'keys');
      expect(opAs('find', 'long-bar')(plan)).toBeLessThan(opAs('expect', 'long-bar')(plan));
      expect(opAs('expect', 'long-bar')(plan)).toBeLessThan(keys);
      expect(opAs('expect', 'long-field')(plan)).toBeLessThan(opAs('find', 'long-preview')(plan));
      // the cleanup's deletes are read back: the Task field re-found (the dock moves after them) and empty
      const erase = plan.findIndex((o) => o.op === 'erase');
      expect(plan.slice(erase + 1, erase + 3)).toEqual([
        expect.objectContaining({
          op: 'find',
          label: 'Capture task',
          role: 'AXTextArea',
          as: 'long-erased',
        }),
        { op: 'expect', as: 'long-erased', valueIs: 'New task…' },
      ]);
      expect(plan[erase + 1]).not.toHaveProperty('hint');
      expect(made).toHaveLength(16);
      // planned for one day, every one: backlog-only padding isn't on Tasks' Today list (run 19-19-51's short page)
      expect(planned.map((p) => p.taskId)).toEqual(made.map((_, i) => `t${i + 1}`));
      expect(new Set(planned.map((p) => p.day)).size).toBe(1);
      deletedAll();

      // the edge: exactly 30 pt clears; under it, on any measured element, is the known low dock
      await step('capture-long').run(
        passing({ 'long-preview': 'long-preview bottom 526 vs keyboard top 556' }),
      );
      deletedAll();
      await knownLow(
        step('capture-long').run(
          passing({ 'long-preview': 'long-preview bottom 527 vs keyboard top 556' }),
        ),
      );
      deletedAll();
      await knownLow(
        step('capture-long').run(
          passing({ 'long-bar': 'long-bar bottom 540 vs keyboard top 556' }),
        ),
      );
      deletedAll();
      // a long-* element under the keyboard (the sim's own assert)
      await knownLow(
        step('capture-long').run(
          failing(
            'BELOW_KEYBOARD',
            opAs('expect', 'long-bar'),
            'long-bar bottom 566 vs keyboard top 556',
          ),
        ),
      );
      deletedAll();
      // the preview row missing while the field sat low enough to put it under the bar
      const missPreview = (field: string) =>
        failing('MISS', opAs('find', 'long-preview'), 'no "vacuum" found', { 'long-field': field });
      await knownLow(
        step('capture-long').run(missPreview('long-field bottom 520 vs keyboard top 556')),
      );
      deletedAll();
      // …but a missing preview under a field that sits right is a broken Review: a failure
      await expect(
        step('capture-long').run(missPreview('long-field bottom 468 vs keyboard top 556')),
      ).rejects.toThrow('iOS: failed');
      deletedAll();
      // another element's BELOW_KEYBOARD, and another assert on a long-* element, still fail
      await expect(
        step('capture-long').run(
          failing('BELOW_KEYBOARD', () => 0, 'box bottom 700 vs keyboard top 556'),
        ),
      ).rejects.toThrow('iOS: failed');
      deletedAll();
      await expect(
        step('capture-long').run(
          failing(
            'TYPED',
            (ops) => ops.findIndex((o) => o.op === 'keys'),
            'long-bar-task reads "vac"',
          ),
        ),
      ).rejects.toThrow('iOS: failed');
      deletedAll();
      // a delete that dropped in the cleanup is a failure, never the known low dock
      await expect(
        step('capture-long').run(
          failing(
            'VALUE',
            opAs('expect', 'long-erased'),
            'long-erased value is "va", want "New task…"',
          ),
        ),
      ).rejects.toThrow('iOS: failed');
      deletedAll();
      await expect(step('capture-long').run(ctxWith(async () => ({ steps: [] })))).rejects.toThrow(
        'no clearance',
      );
      deletedAll();
      // a lapsed token on the padding's delete leaves it to the run's sweep, never fails the row
      const lapsed = passing();
      (lapsed as unknown as { api: { writes: Record<string, unknown> } }).api.writes.deleteTask =
        async () => {
          throw new Error('deleteTask → HTTP 401');
        };
      await expect(step('capture-long').run(lapsed)).resolves.toBeUndefined();
    });
  });

  it('probeSkip defers the probe job only when ios-standalone runs in full', () => {
    expect(probeSkip(['ios-standalone', 'ios-probe'])('ios-probe')).toBe(PROBE_COVERED);
    expect(probeSkip(['ios-standalone', 'ios-probe'])('ios-standalone')).toBeNull();
    expect(probeSkip(['ios-probe'])('ios-probe')).toBeNull();
    expect(probeSkip(['ios-standalone'])('ios-probe')).toBeNull();
  });

  it('the probe job is opt-in: an app change selects ios-standalone at most, never the probe job', () => {
    const slow = (changed: string[], feature: string[] = []) =>
      slowScenarios('full', feature, SCENARIOS, changed).filter((id) => id.startsWith('ios-'));
    expect(slow(['app/src/pages/Home/index.tsx'])).toEqual([]);
    expect(slow(['app/src/modules/capture/CaptureBar.tsx'])).toEqual(['ios-standalone']);
    expect(slow(['docs/x.md'], ['ios-probe'])).toEqual(['ios-probe']);
    expect(slow(['scripts/src/devcheck/probe-only.ts'])).toEqual(['ios-probe']);
  });

  it('every ios-standalone slow path exists: a rename would silently stop the sim running', () => {
    const paths = SCENARIOS.find((s) => s.id === 'ios-standalone')!.slowPaths!;
    for (const g of paths) expect(existsSync(ROOT + g.replace(/\/\*\*$/, ''))).toBe(true);
  });
});
