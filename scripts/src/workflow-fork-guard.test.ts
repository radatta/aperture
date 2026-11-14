import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkForkGuard, GUARD_STEP, guardScript } from './workflow-fork-guard';

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

// As GitHub runs a `run:` step with no `shell:` on ubuntu: the script in a file, `bash -e {0}` (an explicit `shell: bash`
// would add --noprofile --norc -o pipefail).
const SCRIPT = join(mkdtempSync(join(tmpdir(), 'fork-guard-')), 'guard.sh');
writeFileSync(SCRIPT, guardScript());
const runGuard = (env: Record<string, string>) => {
  const r = spawnSync('bash', ['-e', SCRIPT], {
    env: { PATH: process.env.PATH ?? '', GITHUB_REPOSITORY: 'acme/aperture', ...env },
    encoding: 'utf8',
  });
  return { status: r.status, out: r.stdout };
};

const wf = (on: string, job: string) => `on:\n${on}permissions:\n  contents: read\njobs:\n${job}`;
const PR = '  pull_request:\n    branches: [main]\n';
const stepsJob = (steps: string, head = '') =>
  `  a:\n${head}    runs-on: ubuntu-latest\n    steps:\n${steps}\n      - uses: actions/checkout@v7\n`;
const ACTION = `name: setup\nruns:\n  using: composite\n  steps:\n    - uses: actions/setup-node@v7\n`;
// The allowlist must all be used somewhere, so fixtures carry a file that uses the rest.
const REST = wf(
  '  push:\n    branches: [main]\n',
  stepsJob(
    `${GUARD_STEP}\n      - uses: actions/cache@v6\n      - uses: actions/upload-artifact@v7\n      - uses: aws-actions/configure-aws-credentials@v6\n      - uses: gitleaks/gitleaks-action@v3`,
  ),
);
const check = (files: Record<string, string>) =>
  checkForkGuard({
    '.github/workflows/rest.yml': REST,
    '.github/actions/setup/action.yml': ACTION,
    ...files,
  });

describe('workflow-fork-guard', () => {
  it("passes on this repo's workflows and actions", () => {
    expect(checkForkGuard(repoFiles())).toEqual([]);
  });

  it('the guard is a plain run step: no shell override, no if, no continue-on-error', () => {
    expect(GUARD_STEP).not.toMatch(/shell:|\bif:|continue-on-error/);
  });

  describe('the guard script', () => {
    it.each([
      ['push', {}],
      ['workflow_dispatch', {}],
      ['pull_request', { HEAD_REPO: 'acme/aperture' }],
    ])('passes a %s', (event, env) => {
      expect(runGuard({ EVENT: event, ...env }).status).toBe(0);
    });

    it.each([
      ['a fork', 'pull_request', 'someone/aperture'],
      ['a deleted fork (empty head repo)', 'pull_request', ''],
      ['a look-alike name', 'pull_request', 'acme/aperture-fork'],
      ['pull_request_target, even same-repo', 'pull_request_target', 'acme/aperture'],
      ['a schedule', 'schedule', ''],
      ['an empty event', '', ''],
    ])('fails %s', (_, event, head) => {
      const r = runGuard({ EVENT: event, HEAD_REPO: head });
      expect(r.status).toBe(1);
      expect(r.out).toMatch(/^::error::/);
    });
  });

  it('accepts a fixture set that follows every rule', () => {
    expect(check({ '.github/workflows/pr.yml': wf(PR, stepsJob(GUARD_STEP)) })).toEqual([]);
  });

  it('flags a job without the guard, with it second, or with it changed by one character', () => {
    const second = `      - run: echo hi\n${GUARD_STEP}`;
    const changed = GUARD_STEP.replace('exit 1', 'exit 0');
    for (const steps of ['      - run: echo hi', second, changed])
      expect(check({ '.github/workflows/x.yml': wf(PR, stepsJob(steps)) })).toContain(
        ".github/workflows/x.yml › a: the first step isn't the fork guard",
      );
  });

  it('flags a key appended to the guard step, which would still be its own', () => {
    for (const key of ['continue-on-error: true', 'if: false', 'shell: sh'])
      expect(
        check({ '.github/workflows/x.yml': wf(PR, stepsJob(`${GUARD_STEP}\n        ${key}`)) }),
      ).toContain(".github/workflows/x.yml › a: the first step isn't the fork guard");
  });

  it('flags a new unguarded workflow file', () => {
    const files = {
      ...repoFiles(),
      '.github/workflows/new.yml': wf(PR, stepsJob('      - run: make')),
    };
    expect(checkForkGuard(files)).toContain(
      ".github/workflows/new.yml › a: the first step isn't the fork guard",
    );
  });

  it('flags self-hosted, matrix and block runs-on', () => {
    for (const runsOn of ['self-hosted', '${{ matrix.os }}', '[self-hosted, linux]']) {
      const text = wf(PR, stepsJob(GUARD_STEP)).replace(
        'runs-on: ubuntu-latest',
        `runs-on: ${runsOn}`,
      );
      expect(check({ '.github/workflows/x.yml': text })).toEqual([
        `.github/workflows/x.yml:8: runs-on "${runsOn}" — only ubuntu-latest (GitHub-hosted)`,
      ]);
    }
  });

  it('flags a remote reusable workflow, a missing local one, and a job with neither steps nor uses', () => {
    const job = (body: string) => `  a:\n${body}`;
    expect(
      check({
        '.github/workflows/x.yml': wf(PR, job('    uses: org/repo/.github/workflows/w.yml@v1\n')),
      }),
    ).toEqual([
      ".github/workflows/x.yml:8: action org/repo isn't on the allowlist",
      '.github/workflows/x.yml › a: calls "org/repo/.github/workflows/w.yml@v1" — only local workflows, which carry their own guard',
    ]);
    expect(
      check({ '.github/workflows/x.yml': wf(PR, job('    uses: ./.github/workflows/gone.yml\n')) }),
    ).toEqual([".github/workflows/x.yml uses ./.github/workflows/gone.yml, which doesn't exist"]);
    expect(
      check({ '.github/workflows/x.yml': wf(PR, job('    runs-on: ubuntu-latest\n')) }),
    ).toEqual(['.github/workflows/x.yml › a: neither steps: nor uses:']);
  });

  it('flags dangerous triggers, by event and by mention', () => {
    for (const ev of ['pull_request_target', 'workflow_run', 'issue_comment', 'schedule']) {
      const problems = check({ '.github/workflows/x.yml': wf(`  ${ev}:\n`, stepsJob(GUARD_STEP)) });
      expect(problems).toContain(
        `.github/workflows/x.yml: triggers on ${ev} — allowed: push, pull_request, workflow_dispatch, workflow_call`,
      );
    }
    const mention = wf(
      PR,
      stepsJob(`${GUARD_STEP}\n      - run: gh workflow run x --ref pull_request_target`),
    );
    expect(check({ '.github/workflows/x.yml': mention })).toEqual([
      '.github/workflows/x.yml:21: mentions pull_request_target',
    ]);
  });

  it('flags event data read outside the guard, but not event_name', () => {
    const title = wf(
      PR,
      stepsJob(`${GUARD_STEP}\n      - run: echo "\${{ github.event.pull_request.title }}"`),
    );
    const ref = wf(
      PR,
      stepsJob(`${GUARD_STEP}\n      - if: github.head_ref == 'x'\n        run: echo`),
    );
    for (const text of [title, ref])
      expect(check({ '.github/workflows/x.yml': text })).toEqual([
        '.github/workflows/x.yml: reads event data (github.event, github.head_ref, the whole github context) outside the fork guard',
      ]);
    const hashed = [
      `      - run: echo "PR #\${{ github.event.pull_request.title }}"`,
      '      - run: echo "${{ toJSON(github) }}"',
      '      - run: echo "${{ github[\'event\'] }}"',
    ];
    for (const step of hashed)
      expect(
        check({ '.github/workflows/x.yml': wf(PR, stepsJob(`${GUARD_STEP}\n${step}`)) }),
      ).toEqual([
        '.github/workflows/x.yml: reads event data (github.event, github.head_ref, the whole github context) outside the fork guard',
      ]);
    const name = wf(
      PR,
      stepsJob(`${GUARD_STEP}\n      - if: \${{ github.event_name == 'push' }}\n        run: echo`),
    );
    expect(check({ '.github/workflows/x.yml': name })).toEqual([]);
  });

  it('flags secrets, id-token and environments anywhere a pull_request run reaches, through calls and actions', () => {
    const called = wf(
      '  workflow_call:\n',
      stepsJob(`${GUARD_STEP}\n      - uses: ./.github/actions/setup`),
    );
    const caller = wf(PR, '  ci:\n    uses: ./.github/workflows/called.yml\n');
    const files = { '.github/workflows/pr.yml': caller, '.github/workflows/called.yml': called };
    expect(check(files)).toEqual([]);
    const leaky = {
      ...files,
      '.github/actions/setup/action.yml': `${ACTION}      env:\n        T: \${{ secrets.X }}\n`,
      '.github/workflows/called.yml': called
        .replace('    runs-on:', '    environment: dev\n    runs-on:')
        .replace('  contents: read', '  contents: read\n  id-token: write'),
    };
    expect(check(leaky).sort()).toEqual(
      [
        '.github/actions/setup/action.yml: pull_request-reachable and mentions secrets',
        '.github/workflows/called.yml: pull_request-reachable and mentions id-token',
        '.github/workflows/called.yml: pull_request-reachable and mentions environment:',
      ].sort(),
    );
    const hashed = {
      ...files,
      '.github/workflows/called.yml': called.replace(
        '      - uses: ./.github/actions/setup',
        '      - run: echo "tok #${{ secrets.X }}"\n      - uses: ./.github/actions/setup',
      ),
    };
    expect(check(hashed)).toEqual([
      '.github/workflows/called.yml: pull_request-reachable and mentions secrets',
    ]);
    // A push-only workflow may hold all three.
    const deploy = wf(
      '  push:\n',
      stepsJob(
        `${GUARD_STEP}\n      - run: echo\n        env:\n          T: \${{ secrets.X }}`,
        '    environment: prod\n',
      ),
    );
    expect(check({ '.github/workflows/deploy.yml': deploy })).toEqual([]);
  });

  it('flags any write scope but id-token, top level or per job', () => {
    const top = wf(PR, stepsJob(GUARD_STEP)).replace('  contents: read', '  contents: write');
    const job = wf(PR, stepsJob(GUARD_STEP, '    permissions:\n      pull-requests: write\n'));
    expect(check({ '.github/workflows/x.yml': top })).toEqual([
      '.github/workflows/x.yml (top level): contents: write',
    ]);
    expect(check({ '.github/workflows/x.yml': job })).toEqual([
      '.github/workflows/x.yml › a: pull-requests: write',
    ]);
  });

  it('flags a steps job with no permissions block anywhere', () => {
    const text = `on:\n${PR}jobs:\n${stepsJob(GUARD_STEP)}`;
    expect(check({ '.github/workflows/x.yml': text })).toEqual([
      '.github/workflows/x.yml › a: no permissions block',
    ]);
  });

  it('flags an action off the allowlist, a docker action, and an allowlisted one nobody uses', () => {
    const text = wf(
      PR,
      stepsJob(
        `${GUARD_STEP}\n      - uses: tj-actions/changed-files@v46\n      - uses: docker://alpine:3`,
      ),
    );
    expect(check({ '.github/workflows/x.yml': text })).toEqual([
      ".github/workflows/x.yml:21: action tj-actions/changed-files isn't on the allowlist",
      '.github/workflows/x.yml:22: unreadable uses "docker://alpine:3"',
    ]);
    expect(checkForkGuard({ '.github/workflows/x.yml': wf(PR, stepsJob(GUARD_STEP)) })).toContain(
      "allowlisted action gitleaks/gitleaks-action isn't used — drop it from ACTIONS",
    );
  });

  it('flags container, services and defaults, and reads a loosely spaced uses', () => {
    const job = (head: string) => wf(PR, stepsJob(GUARD_STEP, head));
    expect(check({ '.github/workflows/x.yml': job('    container: node:22\n') })).toEqual([
      ".github/workflows/x.yml:8: container: isn't allowed",
    ]);
    expect(
      check({
        '.github/workflows/x.yml': job('    services:\n      db:\n        image: postgres\n'),
      }),
    ).toEqual([
      ".github/workflows/x.yml:8: services: isn't allowed",
      ".github/workflows/x.yml:10: image: isn't allowed",
    ]);
    const defaults = wf(PR, stepsJob(GUARD_STEP)).replace(
      'jobs:',
      'defaults:\n  run:\n    shell: sh\njobs:',
    );
    expect(check({ '.github/workflows/x.yml': defaults })).toEqual([
      ".github/workflows/x.yml:6: defaults: isn't allowed",
    ]);
    const spaced = wf(PR, stepsJob(`${GUARD_STEP}\n      -   uses: tj-actions/changed-files@v46`));
    expect(check({ '.github/workflows/x.yml': spaced })).toEqual([
      ".github/workflows/x.yml:21: action tj-actions/changed-files isn't on the allowlist",
    ]);
  });

  it('flags any other spelling of a key it reads, and flow-mapped steps', () => {
    const at = (step: string) =>
      check({ '.github/workflows/x.yml': wf(PR, stepsJob(`${GUARD_STEP}\n${step}`)) });
    expect(at('      - { uses: tj-actions/changed-files@v46 }')).toEqual([
      '.github/workflows/x.yml:21: unreadable uses line — write it as a plain block key',
      '.github/workflows/x.yml:21: flow mapping — write the step as a block',
    ]);
    expect(at('      - "uses": tj-actions/changed-files@v46')).toEqual([
      '.github/workflows/x.yml:21: unreadable uses line — write it as a plain block key',
    ]);
    expect(at('      - uses : tj-actions/changed-files@v46')).toEqual([
      '.github/workflows/x.yml:21: unreadable uses line — write it as a plain block key',
    ]);
    const quotedRunsOn = wf(PR, stepsJob(GUARD_STEP)).replace('runs-on:', "'runs-on':");
    expect(check({ '.github/workflows/x.yml': quotedRunsOn })).toEqual([
      '.github/workflows/x.yml:8: unreadable runs-on line — write it as a plain block key',
    ]);
  });

  it('flags a non-composite local action, a skip by actor, and BASH_ENV', () => {
    const docker = 'name: x\nruns:\n  using: docker\n  image: docker://alpine:3\n';
    expect(check({ '.github/actions/setup/action.yml': docker }).sort()).toEqual(
      [
        '.github/actions/setup/action.yml:3: using "docker" — local actions are composite only',
        ".github/actions/setup/action.yml:4: image: isn't allowed",
        '.github/actions/setup/action.yml: not a composite action',
        "allowlisted action actions/setup-node isn't used — drop it from ACTIONS",
      ].sort(),
    );
    const actor = wf(PR, stepsJob(GUARD_STEP, "    if: github.actor == 'acme'\n"));
    expect(check({ '.github/workflows/x.yml': actor })).toEqual([
      '.github/workflows/x.yml:8: keys on github.actor — a skip by who triggered it passes',
    ]);
    const bashEnv = wf(PR, stepsJob(GUARD_STEP)).replace(
      'jobs:',
      'env:\n  BASH_ENV: ./x.sh\njobs:',
    );
    expect(check({ '.github/workflows/x.yml': bashEnv })).toEqual([
      '.github/workflows/x.yml:7: sets BASH_ENV — bash sources it before the guard runs',
    ]);
  });

  it('reads context names case-insensitively, as the runner does', () => {
    const upper = wf(
      PR,
      stepsJob(`${GUARD_STEP}\n      - run: echo "\${{ github.Event.pull_request.title }}"`),
    );
    expect(check({ '.github/workflows/x.yml': upper })).toEqual([
      '.github/workflows/x.yml: reads event data (github.event, github.head_ref, the whole github context) outside the fork guard',
    ]);
    const secrets = wf(PR, stepsJob(`${GUARD_STEP}\n      - run: echo "\${{ Secrets.X }}"`));
    expect(check({ '.github/workflows/x.yml': secrets })).toEqual([
      '.github/workflows/x.yml: pull_request-reachable and mentions secrets',
    ]);
  });

  it('throws on shapes it cannot read rather than pass them', () => {
    const guarded = stepsJob(GUARD_STEP);
    expect(() => check({ '.github/workflows/x.yml': `on: push\njobs:\n${guarded}` })).toThrow(
      /on: must be a bare block/,
    );
    expect(() => check({ '.github/workflows/x.yml': `on:\n  [push]\njobs:\n${guarded}` })).toThrow(
      /unreadable trigger line/,
    );
    expect(() =>
      check({ '.github/workflows/x.yml': wf(PR, guarded).replace(/\n/g, '\r\n') }),
    ).toThrow(/CRLF/);
    expect(() => checkForkGuard({ 'README.md': '' })).toThrow(/not a workflow or an action/);
  });
});
