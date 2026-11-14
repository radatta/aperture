// `pnpm bot push [--after-rebase]` — push the current feature branch as the bot.
// To the explicit HTTPS URL, so the pusher is the bot even where `origin` is SSH. The token reaches git through
// an env-configured credential helper: never argv, never .git/config. GIT_CONFIG_* outranks every config file,
// and an empty helper value clears the inherited list (the container's read-only `gh` helper).
import { scanRange } from '../identifiers-scan.ts';
import { findIdentifiers } from '../identifiers.ts';
import { REPO_URL } from './config.ts';
import { featureBranch } from './git.ts';
import type { Run } from './sh.ts';

const HELPER =
  '!f() { test "$1" = get && echo username=x-access-token && echo "password=$APERTURE_BOT_TOKEN"; }; f';

export function credentialEnv(
  token: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...base,
    APERTURE_BOT_TOKEN: token,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_1: '',
    GIT_CONFIG_KEY_2: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_2: HELPER,
  };
}

export function pushArgs(branch: string, afterRebase: boolean, leaseSha: string): string[] {
  const args = ['push', '--porcelain'];
  // Lease on what we last pushed (origin/<branch> as of our last push or fetch): a push from anywhere else
  // since then makes this fail instead of being overwritten.
  if (afterRebase) args.push(`--force-with-lease=refs/heads/${branch}:${leaseSha}`);
  args.push(REPO_URL, `HEAD:refs/heads/${branch}`);
  return args;
}

// The last stop before the branch is public (docs/ops/IDENTIFIERS.md): every commit not yet on origin/main — its
// message and its own diff, since a branch's history is visible on its PR — carries no personal identifier. The
// commit hook can miss what a `git add` in the same command staged; this can't.
export function identifierHits(run: Run, branch = ''): string[] {
  // Commits already on origin/<branch> are public whatever this push does: only the new ones are checked, so a
  // branch from before the rules can still push a fix on top (its rebase onto main then checks every commit).
  const published = (() => {
    try {
      return branch
        ? run('git', ['rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}`])
        : '';
    } catch {
      return '';
    }
  })();
  const range = ['origin/main..HEAD', ...(published ? [`^${published}`] : [])];
  let shas: string[];
  try {
    shas = run('git', ['rev-list', '--reverse', ...range])
      .split('\n')
      .filter(Boolean);
  } catch (err) {
    throw new Error("can't list the commits to check for identifiers — `git fetch origin` first", {
      cause: err,
    });
  }
  // A merge commit's combined diff isn't scanned line by line, and the project rebases: say so instead.
  if (run('git', ['rev-list', '--merges', ...range]).trim())
    throw new Error(
      'this branch has merge commits — rebase onto origin/main instead (the identifier scan reads plain commits)',
    );
  const named = branch ? findIdentifiers(branch).map((h) => `the branch name ${h.kind}`) : [];
  return [
    ...named,
    ...scanRange(
      shas.map((sha) => ({
        sha,
        message: run('git', ['show', '-s', '--format=%B', sha]),
        diff: run('git', [
          '-c',
          'core.quotePath=false',
          'show',
          '--format=',
          '-U0',
          '--no-color',
          '--no-ext-diff',
          '--no-textconv',
          '--src-prefix=a/',
          '--dst-prefix=b/',
          sha,
        ]),
      })),
    ),
  ];
}

export function push(
  run: Run,
  token: string,
  opts: { afterRebase: boolean },
  log: (s: string) => void = console.log,
): string {
  const branch = featureBranch(run);
  let lease = '';
  if (opts.afterRebase) {
    try {
      lease = run('git', ['rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}`]);
    } catch {
      lease = '';
    }
    if (!lease)
      throw new Error(
        `--after-rebase needs origin/${branch} to lease against — it was never pushed; use a plain \`pnpm bot push\``,
      );
  }
  const hits = identifierHits(run, branch);
  if (hits.length)
    throw new Error(
      `refusing to push: these commits carry a personal identifier (docs/ops/IDENTIFIERS.md → Push). Fix it in the commit that added it — a later commit removing it still leaves it in the pushed history: edit the line, \`git commit --fixup=<sha>\`, \`git rebase --autosquash origin/main\`, then \`pnpm bot push --after-rebase\`:\n${hits.join('\n')}`,
    );
  run('git', pushArgs(branch, opts.afterRebase, lease), { env: credentialEnv(token) });
  // Record what we pushed (the next lease) and track it — read-only fetch, no token.
  run('git', ['fetch', '-q', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  run('git', ['branch', `--set-upstream-to=origin/${branch}`, branch]);
  log(`pushed ${branch} → ${run('git', ['rev-parse', '--short', 'HEAD'])} as aperture-cc-bot`);
  return branch;
}
