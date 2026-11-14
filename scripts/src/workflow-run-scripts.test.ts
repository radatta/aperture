import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GUARD_STEP, guardScript } from './workflow-fork-guard';
import { checkRunExpressions, runScripts } from './workflow-run-scripts';

const ROOT = new URL('../../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), 'utf8');
// Every workflow and every local action, so a file added later is checked without an edit here.
const repoFiles = () => {
  const files: Record<string, string> = {};
  for (const f of readdirSync(new URL('.github/workflows/', ROOT)))
    files[`.github/workflows/${f}`] = read(`.github/workflows/${f}`);
  for (const a of readdirSync(new URL('.github/actions/', ROOT)))
    files[`.github/actions/${a}/action.yml`] = read(`.github/actions/${a}/action.yml`);
  return files;
};

const E = '${{ inputs.stage }}';

describe('workflow-run-scripts', () => {
  it("finds no expression in this repo's run scripts", () => {
    expect(checkRunExpressions(repoFiles())).toEqual([]);
  });

  it('reads the scripts it guards: the fork guard and deploy-stage.yml', () => {
    const scripts = runScripts(read('.github/workflows/deploy-stage.yml')).map((s) => s.script);
    expect(scripts).toContain(guardScript().replace(/^/gm, '          ').replace(/^ +$/gm, ''));
    expect(scripts.some((s) => s.includes('cdk deploy --app cdk.out'))).toBe(true);
    expect(GUARD_STEP).toContain('${{'); // in its env:, which is fine
    expect(checkRunExpressions({ 'g.yml': `    steps:\n${GUARD_STEP}\n` })).toEqual([]);
  });

  it('reads inline and block scripts, at step and list-item columns, with their lines', () => {
    const text = [
      'jobs:', //                                1
      '  a:',
      '    steps:',
      '      - run: echo one', //                4
      '      - name: two',
      '        run: |', //                       6
      '          echo two',
      '',
      '          echo three',
      '        env:', //                         10
      '          X: y',
      '      - run: >-',
      '          echo four',
      '      - name: five',
      "        run: 'echo five'",
    ].join('\n');
    expect(runScripts(text)).toEqual([
      { line: 4, script: 'echo one' },
      { line: 7, script: '          echo two\n\n          echo three' },
      { line: 13, script: '          echo four' },
      { line: 15, script: "'echo five'" },
    ]);
  });

  it.each([
    ['an inline run', `      - run: echo ${E}\n`, 1],
    [
      'a block body',
      `      - name: x\n        run: |\n          echo ok\n          echo ${E}\n`,
      4,
    ],
    [
      'a shell comment in a block (GitHub interpolates it too)',
      `        run: |\n          # ${E}\n`,
      2,
    ],
    [
      'a composite action step',
      `  steps:\n    - shell: bash\n      run: echo \${{ inputs.x }}\n`,
      3,
    ],
    ['github context', `        run: echo \${{ github.ref }}\n`, 1],
    ['a matrix value', `        run: test --shard=\${{ matrix.shard }}/2\n`, 1],
    ['a secret', `        run: echo \${{ secrets.X }}\n`, 1],
  ])('flags %s', (_, text, line) => {
    expect(checkRunExpressions({ 'w.yml': text })).toEqual([
      `w.yml:${line}: expression in a run script — pass it through env:`,
    ]);
  });

  it('lets an expression sit anywhere but a script', () => {
    const text = [
      '    timeout-minutes: ${{ inputs.t }}',
      '    env:',
      `      STAGE: ${E}`,
      '    steps:',
      `      - name: deploy ${E}`,
      "        if: inputs.mode == 'full'",
      '        with:',
      `          ref: ${E}`,
      `      # run: echo ${E}`,
      '      - run: echo "$STAGE"',
      `        env: { S: ${E} }`,
    ].join('\n');
    expect(checkRunExpressions({ 'w.yml': text })).toEqual([]);
  });

  it.each([
    ['a quoted key', `      - "run": echo hi`],
    ['a single-quoted key', `        'run': echo hi`],
    ['a spaced key', `        run : echo hi`],
    ['no space after the colon', `        run:echo hi`],
    ['an empty value', `        run:`],
    ['a multi-line quoted value', `        run: "echo one\n          echo ${E}"`],
  ])('throws on %s rather than guess', (_, text) => {
    expect(() => runScripts(text, 'w.yml')).toThrow(/^w\.yml:1: /);
  });
});
