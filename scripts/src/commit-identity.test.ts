import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fakeRun } from './bot/fakes.ts';
import {
  commandHits,
  expectedIdentity,
  identityProblem,
  keepsHeadAuthor,
  overrideProblems,
  rangeIdentityHits,
} from './commit-identity.ts';
import { IDS } from './identifiers.ts';

// The login is public (identifiers.json); every wrong value is synthetic.
const LOGIN = IDS.maintainer.github;
const NOREPLY = `${LOGIN}@users.noreply.github.com`;
const WITH_ID = `12345678+${LOGIN}@users.noreply.github.com`;
const GIT = ['git', 'commit'].join(' ');

describe('identityProblem', () => {
  it('passes the login with either noreply form, in any case', () => {
    expect(expectedIdentity().name).toBe(LOGIN);
    for (const email of [NOREPLY, WITH_ID, WITH_ID.toUpperCase()])
      expect(identityProblem(LOGIN, email)).toEqual([]);
  });

  it('names each wrong field', () => {
    expect(identityProblem('Someone Else', NOREPLY)).toEqual(['name']);
    expect(identityProblem(LOGIN.toUpperCase(), NOREPLY)).toEqual(['name']);
    expect(identityProblem('Someone Else', 'someone@example.com')).toEqual(['name', 'email']);
  });

  it.each([
    ['a personal mailbox under the login', `${LOGIN}@gmail.com`],
    ['another login’s noreply', '12345678+someone@users.noreply.github.com'],
    ['a non-numeric id', `x1+${LOGIN}@users.noreply.github.com`],
    ['a longer domain', `${NOREPLY}.example.com`],
    ['a prefix on the login', `not${LOGIN}@users.noreply.github.com`],
    ['an empty email', ''],
  ])('refuses %s', (_, email) => {
    expect(identityProblem(LOGIN, email)).toEqual(['email']);
  });
});

describe('rangeIdentityHits', () => {
  const line = (sha: string, ...f: string[]) => [sha.repeat(40), ...f].join('\0');

  it('reads author and committer of every commit in the range, never printing a value', () => {
    const { run, calls } = fakeRun([
      [
        'git log',
        [
          line('a', LOGIN, NOREPLY, LOGIN, WITH_ID),
          line('b', 'Someone', 'someone@example.com', LOGIN, NOREPLY),
          line('c', LOGIN, NOREPLY, 'GitHub', 'noreply@github.com'),
        ].join('\n'),
      ],
    ]);
    const hits = rangeIdentityHits(run, ['origin/main..HEAD', `^${'f'.repeat(40)}`]);
    expect(hits).toEqual([
      'bbbbbbbbbbbb author name',
      'bbbbbbbbbbbb author email',
      'cccccccccccc committer name',
      'cccccccccccc committer email',
    ]);
    expect(hits.join()).not.toMatch(/someone|GitHub/);
    expect(calls[0]?.args).toEqual([
      'log',
      '--format=%H%x00%an%x00%ae%x00%cn%x00%ce',
      'origin/main..HEAD',
      `^${'f'.repeat(40)}`,
    ]);
  });

  it('an empty range has no hits; a failed log says to fetch', () => {
    expect(rangeIdentityHits(fakeRun([['git log', '']]).run, ['origin/main..HEAD'])).toEqual([]);
    const broken = fakeRun([
      [
        'git log',
        () => {
          throw new Error('bad revision');
        },
      ],
    ]);
    expect(() => rangeIdentityHits(broken.run, ['origin/main..HEAD'])).toThrow(/git fetch origin/);
  });
});

describe('overrideProblems', () => {
  it.each([
    [`GIT_AUTHOR_EMAIL=someone@example.com ${GIT} -m "x"`, 'GIT_AUTHOR_'],
    [`export GIT_COMMITTER_NAME=Someone && ${GIT} -m "x"`, 'GIT_AUTHOR_'],
    [`env GIT_COMMITTER_EMAIL=someone@example.com ${GIT} -m "x"`, 'GIT_AUTHOR_'],
    [`${GIT} --author="Someone <someone@example.com>" -m "x"`, '--author'],
    [`${GIT} -m "x" --author Someone`, '--author'],
    [`git -c user.email=someone@example.com commit -m "x"`, '`-c`'],
    [`git -c user.name=Someone commit -m "x"`, '`-c`'],
    [`git -c author.email=someone@example.com commit -m "x"`, '`-c`'],
    [`git --config-env=user.email=MAIL commit -m "x"`, '--config-env'],
    [`git config user.email someone@example.com && ${GIT} -m "x"`, '`git config`'],
    [`git config set user.name Someone; ${GIT} -m "x"`, '`git config`'],
    [
      `git -C . config --local committer.email someone@example.com && ${GIT} -m "x"`,
      '`git config`',
    ],
  ])('%s', (cmd, want) => {
    const found = overrideProblems(cmd);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain(want);
    expect(found[0]).not.toContain('someone');
  });

  it.each([
    `${GIT} -m "fixed the cache ttl"`,
    `git log --author=someone && ${GIT} -m "x"`,
    `${GIT} --amend --no-edit --reset-author`,
    `git rebase origin/main --exec '${GIT} --amend --no-edit --reset-author'`,
    `git -C ../other commit -m "x"`,
  ])('allows %s', (cmd) => {
    expect(overrideProblems(cmd)).toEqual([]);
  });
});

describe('commandHits (the hook)', () => {
  const ident = (role: string, name: string, email: string) =>
    `${role} ${name} <${email}> 1794878100 -0800`;
  const good = [ident('author', LOGIN, WITH_ID), ident('committer', LOGIN, WITH_ID)];
  const badHead = ident('head-author', 'Someone', 'someone@example.com');

  it('passes the expected identity; names the role and field of a wrong one', () => {
    expect(commandHits(good.join('\n'), `${GIT} -m "x"`)).toEqual([]);
    expect(
      commandHits(
        [
          ident('author', LOGIN, 'someone@example.com'),
          ident('committer', 'Someone', NOREPLY),
        ].join('\n'),
        `${GIT} -m "x"`,
      ),
    ).toEqual(['the author email', 'the committer name']);
  });

  it('checks HEAD’s author only on an --amend that keeps it', () => {
    const idents = [...good, badHead].join('\n');
    expect(keepsHeadAuthor(`${GIT} --amend --no-edit`)).toBe(true);
    expect(commandHits(idents, `${GIT} --amend --no-edit`)).toEqual([
      "HEAD's author name (kept by --amend)",
      "HEAD's author email (kept by --amend)",
    ]);
    expect(commandHits(idents, `${GIT} --amend --no-edit --reset-author`)).toEqual([]);
    expect(commandHits(idents, `${GIT} -m "x"`)).toEqual([]);
  });

  it('adds the overrides git var cannot see', () => {
    expect(
      commandHits(good.join('\n'), `${GIT} --author="Someone <s@example.com>" -m "x"`),
    ).toEqual(['`--author` on the commit']);
  });

  it('cannot tell without both idents', () => {
    expect(commandHits(good[0]!, `${GIT} -m "x"`)).toBeNull();
    expect(commandHits('', `${GIT} -m "x"`)).toBeNull();
  });

  it('as a CLI: exit 1 with the hits, 0 clean, 2 when it cannot tell', () => {
    const cli = (input: string, cmd: string) =>
      spawnSync(
        process.execPath,
        [fileURLToPath(new URL('./commit-identity.ts', import.meta.url))],
        {
          input,
          encoding: 'utf8',
          env: { ...process.env, HOOK_CMD: cmd },
        },
      );
    expect(cli(good.join('\n'), `${GIT} -m "x"`).status).toBe(0);
    const bad = cli(
      [good[0]!, ident('committer', LOGIN, 'someone@example.com')].join('\n'),
      `${GIT} -m "x"`,
    );
    expect([bad.status, bad.stdout.trim()]).toEqual([1, 'the committer email']);
    expect(cli('', `${GIT} -m "x"`).status).toBe(2);
  });
});

describe('a real repo: rebase and the fix recipe', () => {
  // Hermetic: no global or system config, no inherited GIT_* (an exported identity would decide the result).
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
  );
  const env = {
    ...base,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_EDITOR: 'true',
  };
  const BAD = { GIT_AUTHOR_NAME: 'Someone', GIT_AUTHOR_EMAIL: 'someone@example.com' };
  const BAD_COMMITTER = {
    GIT_COMMITTER_NAME: 'Someone',
    GIT_COMMITTER_EMAIL: 'someone@example.com',
  };

  it('a rebase keeps the author and restamps the committer; the recipe replays an up-to-date branch and fixes both', () => {
    const dir = mkdtempSync(join(tmpdir(), 'identity-'));
    const g = (args: string[], extra: Record<string, string> = {}) =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...env, ...extra } }).trim();
    const run = (_cmd: string, args: string[]) => g(args);
    const commit = (file: string, extra: Record<string, string> = {}) => {
      writeFileSync(join(dir, file), `${file}\n`);
      g(['add', file]);
      g(['commit', '-q', '-m', `added ${file}`], extra);
    };
    const roles = () =>
      rangeIdentityHits(run, ['origin/main..HEAD']).map((h) => h.split(' ').slice(1).join(' '));
    const shas = () => g(['rev-list', 'origin/main..HEAD']);

    g(['init', '-q', '-b', 'main']);
    g(['config', 'user.name', LOGIN]);
    g(['config', 'user.email', WITH_ID]);
    commit('base');
    g(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    g(['switch', '-q', '-c', 'feat']);
    commit('one', { ...BAD, ...BAD_COMMITTER });
    commit('two', BAD);
    expect(roles()).toEqual([
      'author name',
      'author email', // two: author only
      'author name',
      'author email',
      'committer name',
      'committer email', // one: both
    ]);

    // main moves on; a plain rebase restamps every committer from the config, every author stays.
    g(['switch', '-q', 'main']);
    commit('later');
    g(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    g(['switch', '-q', 'feat']);
    const before = shas();
    g(['rebase', '-q', 'origin/main']);
    expect(shas()).not.toBe(before);
    expect(roles()).toEqual(['author name', 'author email', 'author name', 'author email']);

    // The recipe (IDENTIFIERS.md → _The checks_ → Commit identity) on a branch already on origin/main: --exec still replays it.
    const upToDate = shas();
    g(['rebase', '-q', 'origin/main', '--exec', 'git commit --amend --no-edit --reset-author']);
    expect(shas()).not.toBe(upToDate);
    expect(roles()).toEqual([]);
    expect(g(['log', '--format=%s', 'origin/main..HEAD'])).toBe('added two\nadded one');
  });
});
