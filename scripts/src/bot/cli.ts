// `pnpm bot <command>` — the bot identity (GitHub App aperture-cc-bot) for pushes, dev deploys and dev logs. PRs
// are opened by the user, so `main`'s squash commits are theirs (docs/ops/CI-BOT.md).
// Plain `node` (type stripping), builtins only: no tsx/esbuild native binary in the path. Setup, threat model and
// the post-merge verification: docs/ops/CI-BOT.md.
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeApi } from './api.ts';
import type { Api } from './api.ts';
import { loadConfig } from './config.ts';
import { deployDev } from './deploy-dev.ts';
import type { Clock } from './dispatch.ts';
import { featureBranch, requirePushed } from './git.ts';
import {
  acquire,
  formatStatus,
  isExpired,
  parseWaitMax,
  queueNotes,
  readLock,
  release,
  renew,
  waitForLock,
} from './lock.ts';
import type { Holder } from './lock.ts';
import { boardDir, holderSession, writeLockCache } from './lock-cache.ts';
import { fetchLogs } from './logs.ts';
import { push } from './push.ts';
import { run } from './sh.ts';
import { PERMS, mintToken } from './token.ts';
import type { Permissions } from './token.ts';

const USAGE = `pnpm bot <command>
  push [--after-rebase]          push the current feature branch as the bot (--after-rebase: lease on the last push)
  deploy-dev                     dev lock + deploy this pushed commit to dev; the lock stays held for the devcheck
  lock status|acquire|renew|release
  lock wait [--max MIN]          block until another branch's dev lock frees or expires (default 45, at most 55);
                                 exit 75 if still held — run it in the background
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
const hubName = (): string | undefined => {
  try {
    return JSON.parse(readFileSync(join(root(), 'scripts/board/hub.json'), 'utf8')).name;
  } catch {
    return undefined;
  }
};

async function lockWait(
  api: Api,
  max: string | undefined,
  dir: string | null,
  cache: (h: Holder | null) => void,
): Promise<number> {
  const maxMs = parseWaitMax(max);
  const branch = featureBranch(run);
  let told = false;
  const r = await waitForLock(api, branch, clock, {
    maxMs,
    log: console.log,
    sessionOf: (b) => holderSession(dir, b),
    onRead: (cur) => {
      cache(cur?.holder ?? null);
      const h = cur?.holder;
      if (told || !h || h.branch === branch || isExpired(h, clock.now())) return;
      told = true;
      console.log('tell them, once each:');
      for (const l of queueNotes(branch, h, hubName(), holderSession(dir, h.branch)))
        console.log(`  ${l}`);
    },
  });
  if (r.outcome === 'free') console.log('dev lock: free — `pnpm bot deploy-dev` takes it');
  else if (r.outcome === 'ours') console.log(`dev lock: ${branch} already holds it`);
  else if (r.outcome === 'expired')
    console.log(
      `dev lock: ${r.holder?.branch ?? 'an unreadable holder'}'s lock expired — \`pnpm bot deploy-dev\` takes it over`,
    );
  else {
    console.log(
      `dev lock: still held by ${r.holder?.branch ?? '?'} after ${maxMs / 60_000} min — tell the user who holds it and until when`,
    );
    return 75;
  }
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const [cmd, sub] = positional;
  switch (cmd) {
    case 'push':
      push(run, await token(PERMS.push), { afterRebase: flags['after-rebase'] === 'true' });
      return 0;
    case 'deploy-dev': {
      const dir = boardDir(run);
      const r = await deployDev(
        run,
        makeApi(await token(PERMS.deployDev)),
        clock,
        console.log,
        (h) => writeLockCache(dir, h, clock.now()),
      );
      return r.conclusion === 'success' ? 0 : 1;
    }
    case 'lock': {
      const api = makeApi(await token(PERMS.lock));
      const dir = boardDir(run);
      const cache = (h: Holder | null) => writeLockCache(dir, h, clock.now());
      if (sub === 'status') {
        const cur = await readLock(api);
        cache(cur?.holder ?? null);
        console.log(formatStatus(cur, clock.now()));
      } else if (sub === 'acquire') {
        const h = await acquire(
          api,
          featureBranch(run),
          requirePushed(run, featureBranch(run)),
          clock.now(),
        );
        cache(h);
        console.log(`held until ${h.expiresAt}`);
      } else if (sub === 'renew') {
        const h = await renew(api, featureBranch(run), clock.now());
        cache(h);
        console.log(`renewed until ${h.expiresAt}`);
      } else if (sub === 'release') {
        const was = await release(api, featureBranch(run));
        cache(null);
        console.log(was ? 'released' : 'dev lock was already free');
      } else if (sub === 'wait') return lockWait(api, flags.max, dir, cache);
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
