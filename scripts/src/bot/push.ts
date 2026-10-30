// `pnpm bot push [--after-rebase]` — push the current feature branch as the bot.
// To the explicit HTTPS URL, so the pusher is the bot even where `origin` is SSH. The token reaches git through
// an env-configured credential helper: never argv, never .git/config. GIT_CONFIG_* outranks every config file,
// and an empty helper value clears the inherited list (the container's read-only `gh` helper).
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
  run('git', pushArgs(branch, opts.afterRebase, lease), { env: credentialEnv(token) });
  // Record what we pushed (the next lease) and track it — read-only fetch, no token.
  run('git', ['fetch', '-q', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  run('git', ['branch', `--set-upstream-to=origin/${branch}`, branch]);
  log(`pushed ${branch} → ${run('git', ['rev-parse', '--short', 'HEAD'])} as aperture-cc-bot`);
  return branch;
}
