import { describe, expect, it } from 'vitest';
import { fakeRun } from './fakes.ts';
import { IDS } from '../identifiers.ts';
import { credentialEnv, push, pushArgs } from './push.ts';

const quiet = () => undefined;
const onBranch = (branch: string, extra: [string, string | (() => string)][] = []) =>
  fakeRun([
    ['git symbolic-ref', branch],
    ['git rev-parse --verify -q refs/remotes/origin/', 'a'.repeat(40)],
    ['git rev-parse --short HEAD', 'abc1234'],
    ...extra,
    ['git rev-list', ''],
    ['git push', ''],
    ['git fetch', ''],
    ['git branch --set-upstream-to', ''],
  ]);

describe('bot push', () => {
  it('refuses a commit whose message or diff carries a personal identifier, before pushing', () => {
    const first = IDS.maintainer.name.split(' ')[0]!;
    for (const [message, diff, where] of [
      [`thanks ${first}`, '', '1111111111111111 message:1 name'],
      [
        'clean',
        [
          'diff --git a/n.md b/n.md',
          '--- /dev/null',
          '+++ b/n.md',
          '@@ -0,0 +1 @@',
          `+${first}`,
        ].join('\n'),
        '1111111111111111 n.md:1 name',
      ],
    ]) {
      const { run, calls } = fakeRun([
        ['git symbolic-ref', 'feat'],
        ['git rev-list', `${'1'.repeat(40)}\n`],
        ['git show -s', message!],
        ['git -c core.quotePath=false show', diff!],
      ]);
      expect(() => push(run, 't', { afterRebase: false }, quiet)).toThrow(
        where!.replace(/^(\w{12})\w+/, '$1'),
      );
      expect(calls.some((c) => c.args[0] === 'push')).toBe(false);
    }
  });

  it.each(['main', 'master', 'dev'])('refuses the deploy branch %s', (b) => {
    const { run, calls } = onBranch(b);
    expect(() => push(run, 't', { afterRebase: false }, quiet)).toThrow(/deploy branch/);
    expect(calls.some((c) => c.args[0] === 'push')).toBe(false);
  });

  it('refuses detached HEAD', () => {
    const { run } = fakeRun([
      [
        'git symbolic-ref',
        () => {
          throw new Error('not a symbolic ref');
        },
      ],
    ]);
    expect(() => push(run, 't', { afterRebase: false }, quiet)).toThrow(/detached HEAD/);
  });

  it.each(['dev-e2e', 'main-menu-fix', 'feature/dev'])(
    'pushes the feature branch %s to its own name only',
    (b) => {
      const { run, calls } = onBranch(b);
      push(run, 't', { afterRebase: false }, quiet);
      const p = calls.find((c) => c.args[0] === 'push');
      expect(p?.args).toEqual([
        'push',
        '--porcelain',
        'https://github.com/radatta/aperture.git',
        `HEAD:refs/heads/${b}`,
      ]);
    },
  );

  it('carries the token in env through a credential helper — never argv', () => {
    const { run, calls } = onBranch('ci-bot');
    push(run, 'ghs_SECRET', { afterRebase: false }, quiet);
    const p = calls.find((c) => c.args[0] === 'push');
    expect(p?.args.join(' ')).not.toContain('ghs_SECRET');
    expect(p?.env?.APERTURE_BOT_TOKEN).toBe('ghs_SECRET');
    expect(calls.filter((c) => c.args[0] !== 'push').every((c) => !c.env?.APERTURE_BOT_TOKEN)).toBe(
      true,
    );
  });

  it('clears inherited credential helpers before adding its own', () => {
    const env = credentialEnv('t', {});
    expect([env.GIT_CONFIG_KEY_0, env.GIT_CONFIG_VALUE_0]).toEqual(['credential.helper', '']);
    expect([env.GIT_CONFIG_KEY_1, env.GIT_CONFIG_VALUE_1]).toEqual([
      'credential.https://github.com.helper',
      '',
    ]);
    expect(env.GIT_CONFIG_VALUE_2).toContain('$APERTURE_BOT_TOKEN');
    expect(env.GIT_CONFIG_VALUE_2).not.toContain('t;');
    expect(env.GIT_CONFIG_COUNT).toBe('3');
  });

  it('--after-rebase leases on the last pushed sha, for this branch only', () => {
    expect(pushArgs('ci-bot', true, 'b'.repeat(40))).toEqual([
      'push',
      '--porcelain',
      `--force-with-lease=refs/heads/ci-bot:${'b'.repeat(40)}`,
      'https://github.com/radatta/aperture.git',
      'HEAD:refs/heads/ci-bot',
    ]);
    expect(pushArgs('ci-bot', false, '').join(' ')).not.toMatch(/force/);
  });

  it('--after-rebase refuses a branch that was never pushed', () => {
    const { run } = fakeRun([
      ['git symbolic-ref', 'ci-bot'],
      ['git rev-parse --verify', ''],
    ]);
    expect(() => push(run, 't', { afterRebase: true }, quiet)).toThrow(/never pushed/);
  });
});
