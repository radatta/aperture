import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TOOLS_DIR } from './mailroom/fixtures.ts';
import { FIXTURE_INPUTS, FIXTURE_SUITE, touchesFixtureInputs } from './fixture-inputs.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const repoPath = (abs: string) => relative(ROOT, abs).split('\\').join('/');
const runs = (...files: string[]) => touchesFixtureInputs(files).run;

describe('touchesFixtureInputs', () => {
  it('runs the suite when one of its inputs changed', () => {
    expect(runs('tools/mailroom/jobs/sim.sh')).toBe(true);
    expect(runs('tools/mailroom/testdata/jobs.jsonl')).toBe(true);
    expect(runs('scripts/src/mailroom/sim.ts')).toBe(true);
    expect(runs('scripts/vitest.config.ts')).toBe(true);
    expect(runs('scripts/src/fixture-inputs.ts')).toBe(true);
    expect(runs('.github/workflows/ci.yml')).toBe(true);
    expect(runs('.github/actions/setup/action.yml')).toBe(true);
    expect(touchesFixtureInputs(['app/src/x.ts', 'tools/mailroom/runner.sh']).hits).toEqual([
      'tools/mailroom/runner.sh',
    ]);
  });

  it('skips it when none did', () => {
    expect(
      runs('app/src/pages/Home/index.tsx', 'lambdas/src/handler.ts', 'docs/ops/MAILROOM.md'),
    ).toBe(false);
    expect(runs('pnpm-lock.yaml', '.github/workflows/deploy.yml')).toBe(false);
    expect(runs('scripts/src/mailroomx.ts', 'tools/mailroom-old/a.sh')).toBe(false); // a prefix is a directory
    expect(runs('scripts/src/fixture-inputs.test.ts')).toBe(false);
  });

  it('runs it on an empty or blank changeset — a diff that failed', () => {
    expect(runs()).toBe(true);
    expect(runs('', '  ')).toBe(true);
  });
});

// The list is only as good as its coverage of what the suite really reads: walk the suite's runtime imports
// (type-only ones are erased) and the tools dir it executes, and require each to be an input.
describe('FIXTURE_INPUTS covers the suite', () => {
  const runtimeImports = (file: string): string[] =>
    [
      ...readFileSync(file, 'utf8').matchAll(
        // import/export … from, a side-effect import, a dynamic import; an inline `{ type X }` over-counts, safely
        /^(?:import|export) (?!type\b)[^;]*?from '(\.[^']+)'|^import '(\.[^']+)'|import\('(\.[^']+)'\)/gm,
      ),
    ].map((m) => resolve(dirname(file), (m[1] ?? m[2] ?? m[3])!));

  it('every module the suite loads at runtime is an input', () => {
    const seen = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      runtimeImports(file).forEach(walk);
    };
    walk(join(ROOT, FIXTURE_SUITE));
    const files = [...seen].map(repoPath);
    expect(files).toContain('scripts/src/mailroom/fixtures.ts'); // the walk found the graph
    expect(files.filter((f) => !runs(f))).toEqual([]);
  });

  it('the tools dir it executes is an input', () => {
    expect(runs(`${repoPath(TOOLS_DIR)}/run-fixtures.sh`)).toBe(true);
  });

  it('every input still exists', () => {
    expect(FIXTURE_INPUTS.filter((i) => !existsSync(join(ROOT, i)))).toEqual([]);
  });
});

// Only a real CI run exercises the wiring, so pin it: the non-app step leaves the suite out, the suite's own step
// runs it on every main push and on a PR the rule says yes to, and the rule's step sees the PR's diff.
describe('ci.yml wiring', () => {
  const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const suite = FIXTURE_SUITE.replace('scripts/', '');

  // Every package's tests run in exactly one job: app in test-app, scripts (the suite aside) in test-scripts, the
  // rest in test-packages, the suite in its three slices.
  it('the package test commands cover every package once, the suite left out of scripts', () => {
    expect(ci.split('\n').filter((l) => l.includes('test --exclude'))).toEqual([
      `        run: pnpm --filter @aperture/scripts test --exclude ${suite} --shard="$SHARD/2"`,
    ]);
    expect(
      ci.split('\n').filter((l) => /^ {6,8}(- )?run: pnpm (-r )?--filter .*test\b/.test(l)),
    ).toEqual([
      `        run: pnpm --filter @aperture/scripts test ${suite}`,
      '        run: pnpm --filter @aperture/app test --shard="$SHARD/2"',
      `        run: pnpm --filter @aperture/scripts test --exclude ${suite} --shard="$SHARD/2"`,
      "      - run: pnpm -r --filter '!@aperture/app' --filter '!@aperture/scripts' test",
      `        run: pnpm --filter @aperture/scripts test ${suite}`,
    ]);
    expect(ci.match(/^ {8}shard: \[1, 2\]$/gm)).toHaveLength(2);
  });

  // The suite runs as 3 slices: 1 in `check` (checked-tree.ts reads its step there), 2 and 3 in `fixtures`. Each
  // slice's step is the same text, gated the same, so no slice skips while another runs.
  const suiteStep = (slice: string) =>
    [
      '      - name: Mailroom fixture suite',
      "        if: ${{ !cancelled() && (github.event_name != 'pull_request' || steps.fixtures.outputs.run != 'false') }}",
      `        run: pnpm --filter @aperture/scripts test ${suite}`,
      '        env:',
      `          MAILROOM_FIXTURE_SLICE: ${slice}\n`,
    ].join('\n');
  // One job's text, from its id line to the next job's (the id line may carry a comment).
  const job = (id: string) => {
    const start = ci.search(new RegExp(`\\n {2}${id}:( #[^\\n]*)?\\n`));
    if (start < 0) return '';
    const next = ci.slice(start + 1).search(/\n {2}[a-z-]+:( #[^\n]*)?\n/);
    return next < 0 ? ci.slice(start) : ci.slice(start, start + 1 + next);
  };

  it('the suite steps run it on a main push and unless the rule says no — 3 slices, never allowed to fail', () => {
    expect(job('check')).toContain(suiteStep('1/3'));
    expect(job('fixtures')).toContain(suiteStep('${{ matrix.slice }}/3'));
    expect(job('fixtures')).toMatch(/^ {8}slice: \[2, 3\]$/m);
    // The rule step needs HEAD^1 (full history), and the suite needs the toolchain, in the fixtures job too.
    expect(job('fixtures')).toMatch(
      /- uses: actions\/checkout@v7\n {8}with:\n {10}fetch-depth: 0\n/,
    );
    const f = job('fixtures');
    expect(f.indexOf('- uses: ./.github/actions/setup')).toBeGreaterThan(
      f.indexOf('name: Mailroom fixture inputs'),
    );
    expect(f.indexOf('- uses: ./.github/actions/setup')).toBeLessThan(
      f.indexOf('name: Mailroom fixture suite'),
    );
    expect(ci.split('- name: Mailroom fixture suite')).toHaveLength(3);
    expect(ci).not.toContain('continue-on-error');
  });

  it('both rule steps are the same text', () => {
    const rule = (text: string) =>
      text.slice(
        text.indexOf('      - name: Mailroom fixture inputs'),
        text.indexOf('echo "run=$run"'),
      );
    expect(rule(job('check')).length).toBeGreaterThan(100);
    expect(rule(job('fixtures'))).toBe(rule(job('check')));
  });

  it('fixtures_only skips every test job but the suite slices', () => {
    for (const id of ['test-app', 'test-scripts', 'test-packages'])
      expect(job(id)).toMatch(/^ {4}if: \$\{\{ !inputs\.fixtures_only \}\}$/m);
    expect(job('fixtures')).not.toMatch(/^ {4}if:/m);
  });

  // One saver of the per-commit key (the comment on `check`'s cache step).
  it('only check restores and saves the incremental cache', () => {
    expect(ci.split('uses: actions/cache@')).toHaveLength(2);
    expect(job('check')).toContain('uses: actions/cache@');
  });

  it('the rule runs on PRs only, against the merge commit’s first parent', () => {
    expect(ci).toMatch(/id: fixtures\n {8}if: \$\{\{ github\.event_name == 'pull_request' \}\}/);
    expect(ci).toContain(
      'git rev-parse -q --verify HEAD^2 >/dev/null && files=$(git diff --name-only --no-renames HEAD^1 HEAD)',
    );
    expect(ci).toContain('node scripts/src/fixture-inputs.ts');
    // Full history (the secret scan's), which includes the merge commit's first parent.
    expect(ci).toMatch(/- uses: actions\/checkout@v7\n {8}with:\n {10}fetch-depth: 0 /);
  });
});
