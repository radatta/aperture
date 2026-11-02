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

  it('no step can drive mcp yet', () => {
    expect(problems(sc([row('m', { entry: 'mcp' })], [step('m', 'mcp', ['m'])]))).toEqual([
      'feat: step m claims entry mcp, which no step can drive yet',
    ]);
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
      'feat: row b: test "something else" not found in app/a.test.ts',
      'feat: row c is off dev but its file, test or why is empty',
    ]);
  });

  it('row and step ids are unique', () => {
    expect(problems(sc([row('a'), row('a')], [step('s', 'ui', ['a']), step('s', 'ui')]))).toEqual([
      'feat: row a is declared twice',
      'feat: step s is declared twice',
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

  it('with no step results at all (setup failed) nothing is proven', () => {
    expect(coverageOf(s, []).map((x) => x.status)).toEqual([
      'skipped',
      'skipped',
      'off-dev',
      'needs-you',
    ]);
  });

  it('ignores another scenario’s step of the same id', () => {
    expect(coverageOf(s, [{ ...res('d', 'pass'), scenario: 'other' }])[1]!.status).toBe('skipped');
  });
});
