// `pnpm bot <command>` — the bot identity (GitHub App aperture-cc-bot) for pushes, dev deploys and dev logs. PRs
// are opened by the user, so `main`'s squash commits are theirs (docs/ops/CI-BOT.md).
// Plain `node` (type stripping), builtins only: no tsx/esbuild native binary in the path. Setup, threat model and
// the post-merge verification: docs/ops/CI-BOT.md.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeApi } from './api.ts';
import { loadConfig } from './config.ts';
import { deployDev } from './deploy-dev.ts';
import type { Clock } from './dispatch.ts';
import { featureBranch, requirePushed } from './git.ts';
import { acquire, release, renew, status } from './lock.ts';
import { fetchLogs } from './logs.ts';
import { push } from './push.ts';
import { run } from './sh.ts';
import { PERMS, mintToken } from './token.ts';
import type { Permissions } from './token.ts';

const USAGE = `pnpm bot <command>
  push [--after-rebase]          push the current feature branch as the bot (--after-rebase: lease on the last push)
  deploy-dev                     dev lock + deploy this pushed commit to dev; the lock stays held for the devcheck
  lock status|acquire|renew|release
  logs [--since 30m | --start ISO --end ISO] [--groups bff,mcp,finance-sync] [--filter P] [--query Q]`;

// `--name value` and bare `--flag` → { name: value | 'true' }; the rest stay positional.
export function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const [name, inline] = a.slice(2).split(/=(.*)/s);
    const next = argv[i + 1];
    if (inline !== undefined) flags[name ?? ''] = inline;
    else if (next !== undefined && !next.startsWith('--')) flags[name ?? ''] = argv[++i] ?? '';
    else flags[name ?? ''] = 'true';
  }
  return { positional, flags };
}

const clock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};
const token = async (perms: Permissions) => mintToken(loadConfig(), perms);
const root = () => run('git', ['rev-parse', '--show-toplevel']);

export async function main(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const [cmd, sub] = positional;
  switch (cmd) {
    case 'push':
      push(run, await token(PERMS.push), { afterRebase: flags['after-rebase'] === 'true' });
      return 0;
    case 'deploy-dev': {
      const r = await deployDev(run, makeApi(await token(PERMS.deployDev)), clock);
      return r.conclusion === 'success' ? 0 : 1;
    }
    case 'lock': {
      const api = makeApi(await token(PERMS.lock));
      if (sub === 'status') console.log(await status(api, clock.now()));
      else if (sub === 'acquire')
        console.log(
          `held until ${(await acquire(api, featureBranch(run), requirePushed(run, featureBranch(run)), clock.now())).expiresAt}`,
        );
      else if (sub === 'renew')
        console.log(
          `renewed until ${(await renew(api, featureBranch(run), clock.now())).expiresAt}`,
        );
      else if (sub === 'release')
        console.log(
          (await release(api, featureBranch(run))) ? 'released' : 'dev lock was already free',
        );
      else {
        console.error(USAGE);
        return 2;
      }
      return 0;
    }
    case 'logs': {
      const t = await token(PERMS.logs);
      await fetchLogs(run, makeApi(t), t, clock, flags, root());
      return 0;
    }
    case 'help':
    case undefined:
      console.log(USAGE);
      return cmd ? 0 : 2;
    default:
      console.error(`unknown command "${cmd}"\n${USAGE}`);
      return 2;
  }
}

// Run only as the entry point (tests import parseArgs/main).
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(`bot: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
