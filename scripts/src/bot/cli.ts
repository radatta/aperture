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
import { iosFiles } from './ios-routing.ts';
import {
  LockHeld,
  SLOTS,
  acquireSlot,
  formatStatus,
  heldSlot,
  holderLine,
  parseWaitMax,
  queueNotes,
  readLock,
  release,
  renew,
  waitForLock,
} from './lock.ts';
import type { Holder, Slot } from './lock.ts';
import { boardDir, holderSession, writeLockCache } from './lock-cache.ts';
import { fetchLogs } from './logs.ts';
import { pruneBranches } from './prune.ts';
import { push } from './push.ts';
import { runCommand } from './run.ts';
import { run } from './sh.ts';
import { PERMS, mintToken } from './token.ts';
import type { Permissions } from './token.ts';

const USAGE = `pnpm bot <command>
  push [--after-rebase]          push the current feature branch as the bot (--after-rebase: lease on the last push)
  deploy-dev                     take a dev slot's lock (the one this branch holds, else dev, else devb) + deploy
                                 this pushed commit there; the lock stays held for the devcheck
  lock status                    both slots' locks (dev = slot A, devb = slot B)
  lock acquire [--slot dev|devb] take a lock (by default as deploy-dev would; --slot names one)
  lock renew|release             the lock this branch holds, whichever slot
  lock wait [--max MIN] [--any | --slot devb]
                                 block until another branch's lock frees or expires — slot A by default, either with
                                 --any (default 45 min, at most 55); exit 75 if still held — run it in the background
  logs [--since 30m | --start ISO --end ISO] [--groups bff,mcp,finance-sync,push-dispatch,bff-devb,…] [--filter P] [--query Q]
  run cancel <run-id>            cancel a superseded PR check run (the PR workflow, on a feature branch, only)
  run rerun <run-id> [--failed]  rerun a finished PR check run, or only its failed jobs
  prune-branches [--dry-run]     delete local branches whose PR merged at exactly their tip (end of wave)`;

// `--slot` names a slot; anything else is misuse. Undefined when the flag is absent.
export function parseSlot(v: string | undefined): Slot | undefined {
  if (v === undefined) return undefined;
  const slot = SLOTS.find((s) => s === v);
  if (!slot) throw new Error(`--slot must be ${SLOTS.join(' or ')}`);
  return slot;
}

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
  flags: Record<string, string>,
  dir: string | null,
  cache: (h: Holder | null, slot: Slot) => void,
): Promise<number> {
  const maxMs = parseWaitMax(flags.max);
  const one = parseSlot(flags.slot);
  if (one && flags.any) throw new Error('--any and --slot are exclusive');
  const slots = flags.any ? SLOTS : [one ?? 'dev'];
  const branch = featureBranch(run);
  const r = await waitForLock(api, branch, clock, {
    maxMs,
    log: console.log,
    sessionOf: (b) => holderSession(dir, b),
    onRead: (cur, slot) => cache(cur?.holder ?? null, slot),
    slots,
  });
  if (r.outcome === 'free') console.log(`${r.slot} lock: free — \`pnpm bot deploy-dev\` takes it`);
  else if (r.outcome === 'ours') console.log(`${r.slot} lock: ${branch} already holds it`);
  else if (r.outcome === 'expired')
    console.log(
      `${r.slot} lock: ${r.holder?.branch ?? 'an unreadable holder'}'s lock expired — \`pnpm bot deploy-dev\` takes it over`,
    );
  else {
    const held = r.holder
      ? holderLine(r.holder, clock.now(), holderSession(dir, r.holder.branch), r.slot)
      : `${r.slot} locked`;
    console.log(
      `${held} — still held after ${maxMs / 60_000} min; tell the user who holds it and until when`,
    );
    return 75;
  }
  return 0;
}

export interface TellContext {
  dir: string | null; // the board
  branch: () => string;
  hub: () => string | undefined;
  log: (s: string) => void;
  now: () => number;
}

// A refused acquire (deploy-dev, lock acquire) runs in the foreground, so that's where the session learns whom to
// tell: the notes print before the error line (docs/ops/HUB.md → Lock etiquette). The error is rethrown as is.
export async function tellingWhoToTell<T>(ctx: TellContext, f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (err) {
    const held = err instanceof LockHeld ? err.held.filter((x) => x.holder) : [];
    if (held.length) {
      for (const { slot, holder } of held) writeLockCache(ctx.dir, holder, ctx.now(), slot);
      let branch = '<your branch>';
      try {
        branch = ctx.branch();
      } catch {
        // only the notes' wording needs it
      }
      const wait =
        held.length > 1
          ? 'lock wait --any'
          : `lock wait${held[0]?.slot === 'devb' ? ' --slot devb' : ''}`;
      ctx.log(
        `${held.length > 1 ? 'both dev slots are' : `${held[0]?.slot} is`} locked — send these now, once each, then \`pnpm bot ${wait}\` in the background:`,
      );
      const notes = queueNotes(branch, held as { slot: Slot; holder: Holder }[], ctx.hub(), (b) =>
        holderSession(ctx.dir, b),
      );
      for (const l of notes) ctx.log(`  ${l}`);
    }
    throw err;
  }
}

const tellCtx = (dir: string | null): TellContext => ({
  dir,
  branch: () => featureBranch(run),
  hub: hubName,
  log: console.log,
  now: clock.now,
});

export async function main(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const [cmd, sub] = positional;
  switch (cmd) {
    case 'push':
      push(run, await token(PERMS.push), { afterRebase: flags['after-rebase'] === 'true' });
      return 0;
    case 'deploy-dev': {
      const dir = boardDir(run);
      const api = makeApi(await token(PERMS.deployDev));
      const r = await tellingWhoToTell(tellCtx(dir), () =>
        deployDev(run, api, clock, console.log, (h, slot) =>
          writeLockCache(dir, h, clock.now(), slot),
        ),
      );
      return r.conclusion === 'success' ? 0 : 1;
    }
    case 'lock': {
      // status and wait only read: a read-only token, which a 55-minute background wait holds
      const api = makeApi(
        await token(sub === 'status' || sub === 'wait' ? PERMS.lockRead : PERMS.lock),
      );
      const dir = boardDir(run);
      const cache = (h: Holder | null, slot: Slot) => writeLockCache(dir, h, clock.now(), slot);
      if (sub === 'status') {
        for (const slot of SLOTS) {
          const cur = await readLock(api, slot);
          cache(cur?.holder ?? null, slot);
          console.log(formatStatus(cur, clock.now(), slot));
        }
      } else if (sub === 'acquire') {
        const only = parseSlot(flags.slot);
        const { slot, holder } = await tellingWhoToTell(tellCtx(dir), () =>
          acquireSlot(
            api,
            featureBranch(run),
            requirePushed(run, featureBranch(run)),
            clock.now(),
            only,
            iosFiles(run),
          ),
        );
        cache(holder, slot);
        console.log(`${slot} held until ${holder.expiresAt}`);
      } else if (sub === 'renew' || sub === 'release') {
        const branch = featureBranch(run);
        const slot = await heldSlot(api, branch);
        if (sub === 'release') {
          if (!slot) {
            console.log(`${branch} holds no dev lock — already free`);
            return 0;
          }
          await release(api, branch, slot);
          cache(null, slot);
          console.log(`${slot} lock released`);
        } else {
          if (!slot)
            throw new Error(`${branch} holds no dev lock — \`pnpm bot deploy-dev\` takes one`);
          const h = await renew(api, branch, clock.now(), slot);
          cache(h, slot);
          console.log(`${slot} renewed until ${h.expiresAt}`);
        }
      } else if (sub === 'wait') return lockWait(api, flags, dir, cache);
      else {
        console.error(USAGE);
        return 2;
      }
      return 0;
    }
    case 'run': {
      // Checked before the actions: write token is minted: only rerun's bare --failed, and no extra arguments.
      const odd = Object.entries(flags).filter(([k, v]) => k !== 'failed' || v !== 'true');
      if (
        odd.length ||
        (sub !== 'cancel' && sub !== 'rerun') ||
        (sub === 'cancel' && flags.failed !== undefined) ||
        positional.length !== 3 ||
        !/^[1-9][0-9]{0,19}$/.test(positional[2] ?? '')
      ) {
        console.error(`run takes cancel|rerun <run-id> [--failed]\n${USAGE}`);
        return 2;
      }
      return runCommand(
        makeApi(await token(PERMS.run)),
        sub,
        positional[2],
        flags.failed === 'true',
        console.log,
      );
    }
    case 'prune-branches': {
      // A destructive command: anything but a bare --dry-run is a usage error, never a real delete.
      const odd = Object.entries(flags).filter(([k, v]) => k !== 'dry-run' || v !== 'true');
      if (odd.length || positional.length > 1) {
        console.error(`prune-branches takes only --dry-run\n${USAGE}`);
        return 2;
      }
      pruneBranches(run, flags['dry-run'] === 'true', console.log);
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
