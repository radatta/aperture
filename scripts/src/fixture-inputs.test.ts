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

  it('the non-app step excludes the suite, once', () => {
    expect(ci.split('\n').filter((l) => l.endsWith(`test --exclude ${suite}`))).toHaveLength(1);
    expect(ci).toMatch(/^ {6}- run: pnpm -r --filter '!@aperture\/app' test --exclude /m);
  });

  it('the suite step runs it on a main push and unless the rule says no — one step, never allowed to fail', () => {
    expect(ci).toContain(
      [
        '      - name: Mailroom fixture suite',
        "        if: ${{ !cancelled() && (github.event_name != 'pull_request' || steps.fixtures.outputs.run != 'false') }}",
        `        run: pnpm --filter @aperture/scripts test ${suite}\n`,
      ].join('\n'),
    );
    expect(ci).not.toContain('continue-on-error');
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
