import { describe, expect, it } from 'vitest';
import { coverageOf, matrixProblems, type MatrixFs } from './matrix';
import type { StepResult } from './report';
import type { Row, Scenario, Step } from './scenario';

const ROOT = '/repo';
const files: Record<string, string> = {
  '/repo/app/a.test.ts': `it('says so when the delete fails', () => {});`,
};
const fs: MatrixFs = { exists: (p) => p in files, read: (p) => files[p] ?? '' };

const step = (id: string, entry: Step['entry'], proves?: string[]): Step => ({
  id,
  title: id,
  entry,
  proves,
  run: async () => undefined,
});
const row = (id: string, over: Partial<Row> = {}): Row => ({
  id,
  entry: 'ui',
  kind: 'nominal',
  what: id,
  ...over,
});
const sc = (rows: Row[], steps: Step[], id = 'feat'): Scenario => ({
  id,
  title: id,
  tiers: ['full'],
  rows,
  steps,
});
const problems = (...s: Scenario[]) => matrixProblems(s, ROOT, fs);
const OFF = {
  file: 'app/a.test.ts',
  test: 'says so when the delete fails',
  why: 'dev can’t fail S3',
};

describe('matrixProblems', () => {
  it('a matrix every row of which is proven through its own entry holds', () => {
    expect(
      problems(
        sc(
          [
            row('del'),
            row('again', { entry: 'api' }),
            row('s3', { offDev: OFF }),
            row('ios', { entry: 'ios', needsYou: 'iOS Safari' }),
          ],
          [step('setup', 'api'), step('d', 'ui', ['del']), step('v', 'api', ['del', 'again'])],
        ),
      ),
    ).toEqual([]);
  });

  it('a feature scenario must declare rows; smoke is exempt', () => {
    expect(problems(sc([], [step('a', 'ui')]), sc([], [step('home', 'ui')], 'smoke'))).toEqual([
      'feat: declares no rows',
    ]);
  });

  it('a row with no proving step is a gap', () => {
    expect(problems(sc([row('del')], [step('a', 'ui')]))).toEqual([
      'feat: row del (ui) has no proving step through ui',
    ]);
  });

  it('a UI row proven only through the API is a gap, and says which step it had', () => {
    expect(problems(sc([row('del')], [step('v', 'api', ['del'])]))).toEqual([
      'feat: row del (ui) has no proving step through ui — only v (api)',
    ]);
  });

  it('a step proving a row that does not exist', () => {
    expect(problems(sc([row('del')], [step('d', 'ui', ['del', 'typo'])]))).toEqual([
      'feat: step d proves unknown row typo',
    ]);
  });

  it('steps drive mcp and ios (the Mac sim); none can drive raycast or the extension', () => {
    expect(problems(sc([row('m', { entry: 'mcp' })], [step('m', 'mcp', ['m'])]))).toEqual([]);
    expect(problems(sc([row('i', { entry: 'ios' })], [step('i', 'ios', ['i'])]))).toEqual([]);
    expect(
      problems(sc([row('r', { entry: 'raycast', needsYou: 'the Mac' })], [step('r', 'raycast')])),
    ).toEqual(['feat: step r claims entry raycast, which no step can drive yet']);
  });

  it('a row is off dev or needs you, never both, and needs you gives a reason', () => {
    expect(
      problems(
        sc(
          [row('x', { offDev: OFF, needsYou: 'camera' }), row('y', { needsYou: ' ' })],
          [step('a', 'ui')],
        ),
      ),
    ).toEqual([
      'feat: row x is both off dev and needs you',
      'feat: row y needs you but gives no reason',
    ]);
  });

  it('a row a step proves is not off dev or needs you — if dev can produce it, prove it on dev', () => {
    expect(
      problems(
        sc(
          [row('s3', { offDev: OFF }), row('y', { needsYou: 'camera' })],
          [step('d', 'ui', ['s3', 'y'])],
        ),
      ),
    ).toEqual([
      'feat: row s3 is off dev but step d proves it — if dev can produce it, prove it on dev',
      'feat: row y needs you but step d proves it',
    ]);
  });

  it('an off-dev row must name a test file that exists and a test title in it', () => {
    expect(
      problems(
        sc(
          [
            row('a', { offDev: { ...OFF, file: 'app/missing.test.ts' } }),
            row('b', { offDev: { ...OFF, test: 'something else' } }),
            row('c', { offDev: { ...OFF, why: '' } }),
          ],
          [],
        ),
      ),
    ).toEqual([
      "feat: row a names a test file that doesn't exist: app/missing.test.ts",
      'feat: row b: no it()/test() titled "something else" in app/a.test.ts',
      'feat: row c is off dev but its file, test or why is empty',
    ]);
  });

  it('“same path as <row>” must name a row of the same scenario that dev proves', () => {
    const same = (target: string) => ({ ...OFF, why: `same path as ${target} (proven on dev)` });
    expect(
      problems(
        sc(
          [
            row('shown'),
            row('other', { offDev: OFF }),
            row('ok', { offDev: same('shown') }),
            row('missing', { offDev: same('nope') }),
            row('via-off', { offDev: same('other') }),
          ],
          [step('s', 'ui', ['shown'])],
        ),
      ),
    ).toEqual([
      "feat: row missing is off dev as the same path as nope, which dev doesn't prove here",
      "feat: row via-off is off dev as the same path as other, which dev doesn't prove here",
    ]);
  });

  it('the named test must be a runnable it()/test() in a test file — not skipped, todo or a bare string', () => {
    files['/repo/app/b.test.ts'] =
      `it.skip('skipped one', () => {});\nit.todo('todo one');\nconst s = 'bare one';\n  // it('commented one', () => {});\ntest(\n  "multi line one", () => {});`;
    files['/repo/app/notes.ts'] = `it('in a source file', () => {});`;
    const off = (test: string, file = 'app/b.test.ts') => ({ ...OFF, file, test });
    expect(
      problems(
        sc(
          [
            row('a', { offDev: off('skipped one') }),
            row('b', { offDev: off('todo one') }),
            row('c', { offDev: off('bare one') }),
            row('f', { offDev: off('commented one') }),
            row('d', { offDev: off('multi line one') }),
            row('e', { offDev: off('in a source file', 'app/notes.ts') }),
          ],
          [],
        ),
      ),
    ).toEqual([
      'feat: row a: no it()/test() titled "skipped one" in app/b.test.ts',
      'feat: row b: no it()/test() titled "todo one" in app/b.test.ts',
      'feat: row c: no it()/test() titled "bare one" in app/b.test.ts',
      'feat: row f: no it()/test() titled "commented one" in app/b.test.ts',
      "feat: row e names app/notes.ts, which isn't a test file",
    ]);
  });

  it('row and step ids are unique', () => {
    expect(problems(sc([row('a'), row('a')], [step('s', 'ui', ['a']), step('s', 'ui')]))).toEqual([
      'feat: row a is declared twice',
      'feat: step s is declared twice',
    ]);
  });
});

describe('matrixProblems: the slow tier', () => {
  const slow = (id: string, proves?: string[]): Step => ({
    ...step(id, 'api', proves),
    cost: 'slow',
  });
  it('a slow step needs the scenario’s slowPaths, and slowPaths need a slow step', () => {
    expect(problems(sc([row('a', { entry: 'api' })], [slow('w', ['a'])]))).toEqual([
      'feat: step w is slow but the scenario declares no slowPaths',
    ]);
    expect(
      problems({ ...sc([row('a', { entry: 'api' })], [slow('w', ['a'])]), slowPaths: [' '] }),
    ).toEqual(['feat: step w is slow but the scenario declares no slowPaths']);
    expect(
      problems({ ...sc([row('a', { entry: 'api' })], [slow('w', ['a'])]), slowPaths: ['app/**'] }),
    ).toEqual([]);
    expect(
      problems({
        ...sc([row('a', { entry: 'api' })], [step('w', 'api', ['a'])]),
        slowPaths: ['app/**'],
      }),
    ).toEqual(['feat: declares slowPaths but no slow step']);
  });
});

describe('coverageOf: deferred slow steps', () => {
  const s = sc(
    [row('slow', { entry: 'api' }), row('mixed', { entry: 'api' }), row('broke', { entry: 'api' })],
    [
      step('w', 'api', ['slow', 'mixed', 'broke']),
      step('q', 'api', ['mixed']),
      step('f', 'api', ['broke']),
    ],
  );
  const res = (step: string, status: StepResult['status']): StepResult => ({
    scenario: 'feat',
    step,
    title: step,
    status,
    ms: 0,
    note: status === 'deferred' ? 'slow tier' : undefined,
  });
  it('all proving steps deferred → deferred; a run step decides otherwise, and failedSteps name the right one', () => {
    const c = coverageOf(s, [res('w', 'deferred'), res('q', 'pass'), res('f', 'fail')]);
    expect(c.map((x) => [x.row, x.status, x.failedSteps, x.note])).toEqual([
      ['slow', 'deferred', undefined, 'slow tier'],
      ['mixed', 'pass', undefined, undefined],
      ['broke', 'fail', ['f'], undefined],
    ]);
  });
  it('a row whose own-entry steps were all deferred is deferred, never proven by another entry’s step alone', () => {
    const m = sc(
      [row('form', { entry: 'ios' }), row('saved', { entry: 'api' })],
      [step('sim', 'ios', ['form', 'saved']), step('read', 'api', ['form', 'saved'])],
    );
    const c = coverageOf(m, [res('sim', 'deferred'), res('read', 'pass')]);
    expect(c.map((x) => [x.row, x.status])).toEqual([
      ['form', 'deferred'],
      ['saved', 'pass'],
    ]);
    const broke = coverageOf(m, [res('sim', 'deferred'), res('read', 'fail')]);
    expect(broke.map((x) => [x.row, x.status])).toEqual([
      ['form', 'fail'], // a failure still shows on its row
      ['saved', 'fail'],
    ]);
  });
});

describe('coverageOf', () => {
  const s = sc(
    [
      row('both'),
      row('one'),
      row('s3', { kind: 'edge', offDev: OFF }),
      row('ios', { entry: 'ios', needsYou: 'iOS Safari' }),
    ],
    [step('d', 'ui', ['both', 'one']), step('v', 'api', ['both'])],
  );
  const res = (step: string, status: StepResult['status']): StepResult => ({
    scenario: 'feat',
    step,
    title: step,
    status,
    ms: 0,
  });

  it('a row passes only when every step naming it passed', () => {
    const c = coverageOf(s, [res('d', 'pass'), res('v', 'pass')]);
    expect(c.map((x) => [x.row, x.status, x.provenBy])).toEqual([
      ['both', 'pass', 'steps d (ui), v (api)'],
      ['one', 'pass', 'steps d (ui)'],
      ['s3', 'off-dev', 'off dev: app/a.test.ts › says so when the delete fails'],
      ['ios', 'needs-you', 'needs you: iOS Safari'],
    ]);
  });

  it('one failed step fails the row and is named; a skipped one leaves it unproven', () => {
    const c = coverageOf(s, [res('d', 'pass'), res('v', 'fail')]);
    expect(c[0]).toMatchObject({ status: 'fail', failedSteps: ['v'] });
    expect(c[1]!.status).toBe('pass');
    expect(coverageOf(s, [res('d', 'pass'), res('v', 'skipped')])[0]!.status).toBe('skipped');
  });

  it('a step that said needs-you makes its rows needs-you with the reason; a failed sibling still fails', () => {
    const why = 'link the fixture bank';
    const c = coverageOf(s, [
      { ...res('d', 'needs-you'), note: why },
      { ...res('v', 'needs-you'), note: why },
    ]);
    expect(c[0]).toMatchObject({
      status: 'needs-you',
      note: why,
      provenBy: 'steps d (ui), v (api)',
    });
    expect(c[1]).toMatchObject({ status: 'needs-you', note: why });
    // one proving step passed before another said so: still needs-you, not pass
    expect(
      coverageOf(s, [res('d', 'pass'), { ...res('v', 'needs-you'), note: why }])[0]!.status,
    ).toBe('needs-you');
    expect(
      coverageOf(s, [res('d', 'fail'), { ...res('v', 'needs-you'), note: why }])[0]!.status,
    ).toBe('fail');
    // a step skipped for another reason (a failure earlier) leaves the row unproven, not needs-you
    expect(
      coverageOf(s, [res('d', 'skipped'), { ...res('v', 'needs-you'), note: why }])[0]!.status,
    ).toBe('skipped');
  });

  it('with no step results at all (setup failed) nothing is proven', () => {
    expect(coverageOf(s, []).map((x) => x.status)).toEqual([
      'skipped',
      'skipped',
      'off-dev',
      'needs-you',
    ]);
  });

  it('a build change mid-run unproves every passing row, and says why', () => {
    const c = coverageOf(s, [res('d', 'pass'), res('v', 'pass')], true);
    expect(c.map((x) => x.status)).toEqual(['skipped', 'skipped', 'off-dev', 'needs-you']);
    expect(c[0]!.note).toBe('dev’s build changed mid-run');
  });

  it('a row no step names reads "no proving step"', () => {
    expect(coverageOf(sc([row('x')], []), [])[0]!.provenBy).toBe('no proving step');
  });

  it('ignores another scenario’s step of the same id', () => {
    expect(coverageOf(s, [{ ...res('d', 'pass'), scenario: 'other' }])[1]!.status).toBe('skipped');
  });
});
