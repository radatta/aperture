import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { run, summarize, type Result } from './cdk-diff-summary';
import { runScripts } from './workflow-run-scripts';

const STACKS = ['ApertureData-dev', 'ApertureApp-dev'];
// Planted in every synthetic diff body: it must never reach the log.
const SECRET = 'x-origin-verify: sentinel-0123456789';

// Shaped like CDK 2.1135's output (a devb run's log, 2026-11-14), with synthetic content.
const section = (stack: string, changed: boolean) =>
  changed
    ? [
        `Stack ${stack}`,
        'Resources',
        `[~] AWS::CloudFront::Distribution Site SiteABC123`,
        ` └─ [~] OriginCustomHeaders: ${SECRET}`,
        '',
      ].join('\n')
    : [`Stack ${stack}`, 'There were no differences', ''].join('\n');
const diffOf = (data: boolean, app: boolean, n = Number(data) + Number(app)) =>
  [
    'start: Building ApertureData-dev Template',
    section('ApertureData-dev', data),
    section('ApertureApp-dev', app),
    `\n✨  Number of stacks with differences: ${n}\n`,
  ].join('\n');

describe('summarize', () => {
  it.each([
    [true, true, 'changed', 'changed'],
    [false, false, 'unchanged', 'unchanged'],
    [true, false, 'changed', 'unchanged'],
    [false, true, 'unchanged', 'changed'],
  ] as const)('data %s, app %s → %s, %s', (data, app, d, a) => {
    expect(summarize(diffOf(data, app), STACKS)).toEqual({
      'ApertureData-dev': d,
      'ApertureApp-dev': a,
    });
  });

  it('reads coloured output, CRLF, an environment after the name, and the metadata hint', () => {
    const text = [
      '\x1b[1mStack ApertureData-dev (aws://123456789012/us-west-1)\x1b[22m\r',
      '\x1b[32mThere were no differences\x1b[39m\x1b[90m (CDK metadata changes were hidden, run cdk diff --strict to show)\x1b[39m\r',
      section('ApertureApp-dev', true),
      '✨  Number of stacks with differences: 1',
    ].join('\n');
    expect(summarize(text, STACKS)).toEqual({
      'ApertureData-dev': 'unchanged',
      'ApertureApp-dev': 'changed',
    });
  });

  it.each([
    ['no summary line', diffOf(true, true).replace(/^.*Number of stacks.*$/m, '')],
    ['two summary lines', `${diffOf(true, true)}\n✨  Number of stacks with differences: 2`],
    ['a missing header', diffOf(true, true).replace('Stack ApertureApp-dev', 'Stack Other')],
    ['a repeated header', `${diffOf(true, false)}\nStack ApertureData-dev`],
    ['a count the sections disagree with', diffOf(true, false, 2)],
    ['another stage', diffOf(true, true).replace(/-dev\b/g, '-prod')],
    ['nothing', ''],
  ])('reads %s as unknown', (_, text) => {
    expect(summarize(text, STACKS)).toBeUndefined();
  });
});

describe('run', () => {
  const deps = (r: Partial<Result>) => {
    const out: string[] = [];
    const saved: [string, string][] = [];
    const asked: string[][] = [];
    return {
      out,
      saved,
      asked,
      deps: {
        diff: (stacks: string[]) => (
          asked.push(stacks),
          { status: 0, stdout: '', stderr: '', ...r }
        ),
        save: (stage: string, text: string) => void saved.push([stage, text]),
        log: (l: string) => void out.push(l),
      },
    };
  };

  it('prints one line per stack and saves the whole diff, whichever stream it came on', () => {
    for (const r of [{ stderr: diffOf(true, false) }, { stdout: diffOf(true, false) }]) {
      const d = deps(r);
      expect(run(['dev'], d.deps)).toBe(0);
      expect(d.asked).toEqual([STACKS]);
      expect(d.out).toEqual(['ApertureData-dev: changed', 'ApertureApp-dev: unchanged']);
      expect(d.saved).toHaveLength(1);
      expect(d.saved[0]![0]).toBe('dev');
      expect(d.saved[0]![1]).toContain(SECRET);
    }
  });

  it.each([
    ['a non-zero exit', { status: 1 }, 'exit 1'],
    ['a signal or spawn error', { status: null }, 'exit none'],
  ])('fails on %s with a fixed error, saving but not printing the output', (_, r, code) => {
    const d = deps({ ...r, stdout: diffOf(true, true), stderr: `Error: ${SECRET}` });
    expect(run(['dev'], d.deps)).toBe(1);
    expect(d.out).toEqual([
      `::error::cdk diff failed (${code}); its output stays off the public log — run cdk diff locally (INFRA §9)`,
    ]);
    expect(d.saved[0]![1]).toContain(SECRET);
  });

  it("warns and reads unknown on output it can't read, without failing or printing it", () => {
    const d = deps({ stderr: `${SECRET}\nsomething new` });
    expect(run(['dev'], d.deps)).toBe(0);
    expect(d.out).toEqual([
      "::warning::couldn't read cdk diff's output (a CDK upgrade?) — fix scripts/src/cdk-diff-summary.ts",
      'ApertureData-dev: unknown',
      'ApertureApp-dev: unknown',
    ]);
  });

  it.each([[[]], [['']], [['dev', 'x']], [['../dev']], [['Dev']]])('refuses argv %j', (argv) => {
    const d = deps({});
    expect(() => run(argv, d.deps)).toThrow('usage: cdk-diff-summary.ts <stage>');
    expect(d.asked).toEqual([]);
  });
});

describe('workflows never print a cdk diff', () => {
  const DIR = new URL('../../.github/workflows/', import.meta.url);
  const read = (f: string) => readFileSync(new URL(f, DIR), 'utf8');
  const stage = read('deploy-stage.yml');
  const step = (name: string) => {
    const from = stage.indexOf(`- name: ${name}`);
    expect(from, name).toBeGreaterThan(-1);
    return stage.slice(from, stage.indexOf('\n      - ', from + 1) + 1);
  };

  it('deploy-stage.yml runs the diff only through this module, between synth and deploy', () => {
    const diff = step('CDK diff (informational)');
    expect(diff).toContain("if: inputs.mode == 'full'");
    expect(diff).toContain('run: node scripts/src/cdk-diff-summary.ts "$APERTURE_STAGE"\n');
    expect(stage.indexOf('- name: CDK synth')).toBeLessThan(stage.indexOf(diff));
    expect(stage.indexOf(diff)).toBeLessThan(stage.indexOf('- name: Deploy stacks'));
  });

  it('no run script in any workflow calls cdk diff or reads its file, and no deploy uploads one', () => {
    for (const f of readdirSync(DIR))
      for (const { script } of runScripts(read(f), f))
        expect(script, f).not.toMatch(/\bcdk diff\b|aperture-cdk-diff|GITHUB_STEP_SUMMARY/);
    for (const f of ['deploy-stage.yml', 'deploy.yml', 'deploy-dev.yml'])
      expect(read(f), f).not.toMatch(/upload-artifact/);
  });
});
