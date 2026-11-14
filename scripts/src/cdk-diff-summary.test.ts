import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resourceLine, run, summarize, type Result } from './cdk-diff-summary';
import { runScripts } from './workflow-run-scripts';

const STACKS = ['ApertureData-dev', 'ApertureApp-dev'];
// Planted in every synthetic diff body, as a property value: it must never reach the log.
const SECRET = 'sentinel-0123456789';

// Shaped like CDK 2.1135's output (a devb run's log, 2026-11-14), with synthetic content: a resource header, then its
// property tree, an IAM table and an output — everything but the header stays off the log.
const RES = '[~] AWS::CloudFront::Distribution Site/Distribution SiteDistributionABC123';
const section = (stack: string, changed: boolean) =>
  changed
    ? [
        `Stack ${stack}`,
        'IAM Statement Changes',
        `│ + │ arn:aws:s3:::${SECRET} │ Allow │ s3:GetObject │`,
        'Resources',
        RES,
        ` └─ [~] DistributionConfig`,
        `     └─ [~] OriginCustomHeaders: x-origin-verify: ${SECRET}`,
        'Outputs',
        `[~] Output SiteUrl SiteUrl: {"Value":"https://${SECRET}.example"}`,
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
const changed = { verdict: 'changed', resources: [RES], withheld: 0 };
const unchanged = { verdict: 'unchanged', resources: [], withheld: 0 };

describe('resourceLine', () => {
  it.each([
    ['an update', RES, RES],
    [
      'an addition',
      '[+] AWS::IAM::Role Bff/Role BffRole1A2B',
      '[+] AWS::IAM::Role Bff/Role BffRole1A2B',
    ],
    ['a removal', '[-] AWS::SQS::Queue Q Q1234', '[-] AWS::SQS::Queue Q Q1234'],
    ['an import', '[←] AWS::S3::Bucket B B1234 import', '[←] AWS::S3::Bucket B B1234 (import)'],
    [
      'no construct path',
      '[~] AWS::Lambda::Function Bff4A420414',
      '[~] AWS::Lambda::Function Bff4A420414',
    ],
    ['a replacement', `${RES} replace`, `${RES} (replace)`],
    ['a possible replacement', `${RES} may be replaced`, `${RES} (may be replaced)`],
    ['a destroy', `${RES} destroy`, `${RES} (destroy)`],
    [
      'a custom resource',
      '[+] Custom::CDKBucketDeployment Deploy/Custom DeployCustom9F',
      '[+] Custom::CDKBucketDeployment Deploy/Custom DeployCustom9F',
    ],
    [
      'a move suffix, by dropping the name',
      `${RES} (OR move from Other.X via refactoring)`,
      '[~] AWS::CloudFront::Distribution',
    ],
    [
      'a value where the name goes, by dropping it',
      `[~] AWS::X::Y {"h":"${SECRET}"}`,
      '[~] AWS::X::Y',
    ],
  ])('rebuilds %s', (_, line, want) => {
    expect(resourceLine(line)).toBe(want);
  });

  it.each([
    ['a property', ` └─ [~] OriginCustomHeaders: x-origin-verify: ${SECRET}`],
    ['an output', `[~] Output SiteUrl SiteUrl: {"Value":"${SECRET}"}`],
    ['a parameter', `[~] Parameter BootstrapVersion BootstrapVersion: {"Default":"${SECRET}"}`],
    ['an IAM row', `│ + │ arn:aws:s3:::${SECRET} │ Allow │`],
    ['a stack header', 'Stack ApertureApp-dev'],
  ])('ignores %s', (_, line) => {
    expect(resourceLine(line)).toBeUndefined();
  });
});

describe('summarize', () => {
  it.each([
    [true, true, changed, changed],
    [false, false, unchanged, unchanged],
    [true, false, changed, unchanged],
    [false, true, unchanged, changed],
  ] as const)('data %s, app %s', (data, app, d, a) => {
    expect(summarize(diffOf(data, app), STACKS)).toEqual({
      'ApertureData-dev': d,
      'ApertureApp-dev': a,
    });
  });

  it('reads stacks in any order', () => {
    const text = [section('ApertureApp-dev', true), section('ApertureData-dev', false)].join('\n');
    expect(summarize(`${text}\nNumber of stacks with differences: 1`, STACKS)).toEqual({
      'ApertureData-dev': unchanged,
      'ApertureApp-dev': changed,
    });
  });

  it('reads a first deploy, every resource added', () => {
    const text = [
      'Stack ApertureData-dev',
      'Resources',
      '[+] AWS::DynamoDB::Table Table TableCD117FA1',
      ' └─ [+] TableName: aperture-dev',
      section('ApertureApp-dev', false),
      'Number of stacks with differences: 1',
    ].join('\n');
    expect(summarize(text, STACKS)?.['ApertureData-dev']).toEqual({
      verdict: 'changed',
      resources: ['[+] AWS::DynamoDB::Table Table TableCD117FA1'],
      withheld: 0,
    });
  });

  it('reads coloured output, CRLF, an environment after the name, and the metadata hint', () => {
    const text = [
      '\x1b[1mStack ApertureData-dev (aws://123456789012/us-west-1)\x1b[22m\r',
      '\x1b[32mThere were no differences\x1b[39m\x1b[90m (CDK metadata changes were hidden, run cdk diff --strict to show)\x1b[39m\r',
      'Stack ApertureApp-dev\r',
      `\x1b[33m[~]\x1b[39m \x1b[36mAWS::CloudFront::Distribution\x1b[39m Site/Distribution \x1b[90mSiteDistributionABC123\x1b[39m \x1b[3m\x1b[1m\x1b[31mreplace\x1b[39m\x1b[22m\x1b[23m\r`,
      '✨  Number of stacks with differences: 1',
    ].join('\n');
    expect(summarize(text, STACKS)).toEqual({
      'ApertureData-dev': unchanged,
      'ApertureApp-dev': { verdict: 'changed', resources: [`${RES} (replace)`], withheld: 0 },
    });
  });

  it.each([
    ['no summary line', diffOf(true, true).replace(/^.*Number of stacks.*$/m, '')],
    ['two summary lines', `${diffOf(true, true)}\n✨  Number of stacks with differences: 2`],
    ['a missing header', diffOf(true, true).replace('Stack ApertureApp-dev', 'Stack Other')],
    ['a repeated header', `${diffOf(true, false)}\nStack ApertureData-dev`],
    ['a count the sections disagree with', diffOf(true, false, 2)],
    [
      '"There were no differences" inside a changed body',
      diffOf(true, true).replace(RES, `${RES}\nThere were no differences`),
    ],
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

  it('prints each verdict and the changed resource headers only, and saves the whole diff, from either stream', () => {
    for (const r of [{ stderr: diffOf(false, true) }, { stdout: diffOf(false, true) }]) {
      const d = deps(r);
      expect(run(['dev'], d.deps)).toBe(0);
      expect(d.asked).toEqual([STACKS]);
      expect(d.out).toEqual([
        'ApertureData-dev: unchanged',
        'ApertureApp-dev: changed',
        `  ${RES}`,
      ]);
      expect(d.out.join('\n')).not.toContain(SECRET);
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
      `::error::cdk diff failed (${code}); its output stays off the public log (INFRA §9 → Public repo)`,
    ]);
    expect(d.saved[0]![1]).toContain(SECRET);
  });

  it('counts the resource headers it cannot rebuild, and prints none of them', () => {
    const odd = [
      `[~] Org::Third::Party X X1`,
      `[+] Custom::My-Thing ${SECRET} Y1`,
      '[~] Fn::ForEach::Loop',
    ];
    const d = deps({ stderr: diffOf(false, true).replace(RES, [RES, ...odd].join('\n')) });
    expect(run(['dev'], d.deps)).toBe(0);
    expect(d.out).toEqual([
      'ApertureData-dev: unchanged',
      'ApertureApp-dev: changed',
      `  ${RES}`,
      '  (3 more resource header(s) withheld)',
    ]);
  });

  it("warns and reads unknown on output it can't read, without failing or printing it", () => {
    const d = deps({ stderr: `${SECRET}\n${RES}\nsomething new` });
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

// The real entry point, with a fake `pnpm` first on PATH writing the sentinel to both streams (the diff on stderr):
// the step's log is the child's stdout and stderr, and neither may carry it, on success or failure.
describe('the script as the deploy runs it', () => {
  const script = fileURLToPath(new URL('./cdk-diff-summary.ts', import.meta.url));
  const runAs = (exit: number) => {
    const dir = mkdtempSync(join(tmpdir(), 'cdk-diff-summary-'));
    writeFileSync(join(dir, 'diff.txt'), diffOf(true, false));
    const pnpm = join(dir, 'pnpm');
    writeFileSync(
      pnpm,
      `#!/bin/sh\necho "pnpm says ${SECRET}"\ncat "$(dirname "$0")/diff.txt" >&2\nexit ${exit}\n`,
    );
    chmodSync(pnpm, 0o755);
    try {
      const r = spawnSync(process.execPath, [script, 'dev'], {
        env: { PATH: `${dir}:${process.env.PATH ?? ''}`, RUNNER_TEMP: dir },
        encoding: 'utf8',
      });
      return { ...r, saved: readFileSync(join(dir, 'aperture-cdk-diff.dev.txt'), 'utf8') };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it.each([
    [0, 0, ['ApertureData-dev: changed', `  ${RES}`, 'ApertureApp-dev: unchanged']],
    [
      2,
      1,
      [
        `::error::cdk diff failed (exit 2); its output stays off the public log (INFRA §9 → Public repo)`,
      ],
    ],
  ])(
    'pnpm exiting %i → exit %i, the summary only, the diff in RUNNER_TEMP',
    (exit, status, lines) => {
      const r = runAs(exit);
      expect(r.status).toBe(status);
      expect(r.stdout.trimEnd().split('\n')).toEqual(lines);
      expect(r.stdout + r.stderr).not.toContain(SECRET);
      expect(r.saved).toContain(SECRET);
    },
  );
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
