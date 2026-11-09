// `pnpm sim-bench:seed [--clean]` (docs/ops/SIM-BENCH.md → Seed): the one dev task the bench's Done form job opens —
// plans.json's seed, ios-standalone's own MCP setup step, which the sim can't do (it never taps Start) — created as the
// dev test user through the devcheck's sign-in, API client and id ledger, and deleted again by `--clean`, by ledger id.
// While the bench runs, this branch holds slot A's dev lock (`pnpm bot lock acquire --slot dev`, the deploy-dev lock): no
// other lane deploys over the build under test, or devchecks into the partition holding the seed; they wait through
// `pnpm bot lock wait`. `--clean` releases it. The 45-minute TTL is renewed by whoever runs the bench (`pnpm bot lock renew`).
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createApiClient } from '../devcheck/api';
import { launch, loadPlaywright } from '../devcheck/browser';
import {
  devcheckHome,
  envPath,
  ledgerFile,
  loadEnv,
  mainCheckout,
  runLockFile,
  statePath,
  useSlot,
  worktreeRoot,
} from '../devcheck/config';
import { DevcheckError } from '../devcheck/errors';
import { openLedger, pendingIds, type Ledger } from '../devcheck/ledger';
import { ensureSignedIn, validateCachedState } from '../devcheck/login';
import { takeLock } from '../devcheck/run';
import { pickSlot, type SlotPick } from '../devcheck/slot';
import { PLANS_PATH, type BenchSeed } from './sim-bench-plans.ts';

const exec = promisify(execFile);
export const SEED_RUN = 'sim-bench-seed'; // the ledger `run` prefix that marks a seed (ids are matched by run, never title)
const VIA = 'api:createTask';

// The slice of the devcheck API client the seed uses.
export interface SeedApi {
  reads: { getTask(id: string): Promise<{ id: string; status?: string; title: string } | null> };
  writes: {
    createTask(input: { title: string; estimateMin?: number }): Promise<{ id: string }>;
    transitionTask(id: string, status: 'in_progress'): Promise<unknown>;
    deleteTask(id: string): Promise<void>;
  };
}
export interface SeedDeps {
  pick(): Promise<SlotPick>; // pickSlot: whose the dev locks are
  acquire(): Promise<string>; // `pnpm bot lock acquire --slot dev` → the lock's expiry (ISO)
  release(): Promise<void>; // `pnpm bot lock release`
  runLock(): () => void; // the devcheck's one-run-per-container lock
  ledger: Ledger;
  signIn(run: string): Promise<{ api: SeedApi; close(): Promise<void> }>;
  seed: BenchSeed;
  now(): Date;
  log(s: string): void;
}

const runId = (d: SeedDeps) =>
  `${SEED_RUN}-${d.now().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
// Seed ids still pending in the ledger, oldest first.
export const pendingSeeds = (ledger: Ledger): string[] => {
  const seeds = new Set(
    ledger
      .read()
      .filter((e) => e.op === 'created' && e.id && e.run.startsWith(SEED_RUN))
      .map((e) => e.id!),
  );
  return pendingIds(ledger.read()).filter((id) => seeds.has(id));
};

// The dev slot (A), never devb: the sim's Home Screen app is dev's. Refuses before any write when another branch tests there.
async function slotA(d: SeedDeps): Promise<{ heldBefore: boolean }> {
  const pick = await d.pick(); // NO_LOCK when another branch holds dev live — surfaces as is
  if (pick.slot !== 'dev')
    throw new DevcheckError(
      'NO_LOCK',
      `this branch holds the ${pick.slot} lock; the sim is slot A's — \`pnpm bot lock release\` first`,
    );
  return { heldBefore: pick.held };
}

export async function seed(
  d: SeedDeps,
): Promise<{ id: string; expiresAt: string; reused: boolean }> {
  // The run lock first: a devcheck running now (on either slot, until PER_SLOT_RUNS) refuses the seed before dev is locked.
  const unlock = d.runLock();
  let session: Awaited<ReturnType<SeedDeps['signIn']>> | undefined;
  let took = false;
  try {
    const { heldBefore } = await slotA(d);
    const expiresAt = await d.acquire();
    took = !heldBefore;
    d.log(
      `dev lock held until ${expiresAt} — the bench must finish (or \`pnpm bot lock renew\`) before then`,
    );
    const run = runId(d);
    session = await d.signIn(run);
    const { api } = session;
    for (const id of pendingSeeds(d.ledger)) {
      const t = await api.reads.getTask(id);
      if (t?.status === 'in_progress' && t.title === d.seed.title) {
        d.log(`seed already in place: ${id} "${t.title}" (in progress)`);
        return { id, expiresAt, reused: true };
      }
    }
    d.ledger.append({ run, op: 'run-start' });
    const t = await api.writes.createTask({
      title: d.seed.title,
      ...(d.seed.estimateMin === null ? {} : { estimateMin: d.seed.estimateMin }),
    });
    await api.writes.transitionTask(t.id, 'in_progress');
    d.log(
      `seeded ${t.id} "${d.seed.title}" (in progress) — \`pnpm sim-bench:seed --clean\` deletes it and frees dev`,
    );
    return { id: t.id, expiresAt, reused: false };
  } catch (err) {
    // Nothing to protect: free dev again, unless this branch held it before the seed (its own dev test).
    if (took)
      await d
        .release()
        .catch((e: unknown) => d.log(`  couldn't release the dev lock: ${String(e)}`));
    throw err;
  } finally {
    await session?.close().catch(() => {});
    unlock();
  }
}

export async function clean(
  d: SeedDeps,
): Promise<{ deleted: string[]; gone: string[]; failed: string[] }> {
  const out = { deleted: [] as string[], gone: [] as string[], failed: [] as string[] };
  const unlock = d.runLock();
  let session: Awaited<ReturnType<SeedDeps['signIn']>> | undefined;
  try {
    await slotA(d);
    const ids = pendingSeeds(d.ledger);
    if (ids.length) {
      const run = runId(d);
      session = await d.signIn(run);
      for (const id of ids) {
        try {
          if (!(await session.api.reads.getTask(id))) {
            d.ledger.append({ run, op: 'gone', id });
            out.gone.push(id);
            continue;
          }
          await session.api.writes.deleteTask(id);
          d.ledger.append({ run, op: 'deleted', id, via: VIA });
          out.deleted.push(id);
        } catch (err) {
          out.failed.push(id);
          d.log(
            `  ${id} not deleted (${err instanceof Error ? err.message : String(err)}) — the next devcheck's sweep takes it`,
          );
        }
      }
    }
  } finally {
    await session?.close().catch(() => {});
    unlock();
  }
  await d.release();
  d.log(
    `seed: ${out.deleted.length} deleted, ${out.gone.length} already gone, ${out.failed.length} left for the sweep · dev lock released`,
  );
  return out;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const bad = args.filter((a) => a !== '--clean');
  if (bad.length) throw new Error(`usage: pnpm sim-bench:seed [--clean] (got ${bad.join(' ')})`);
  const main = mainCheckout();
  const worktree = worktreeRoot();
  const git = async (a: string[]) => (await exec('git', a, { cwd: worktree })).stdout.trim();
  const branch = await git(['symbolic-ref', '--short', 'HEAD']).catch(() => '');
  if (!branch)
    throw new Error(
      'run it from a branch worktree: the dev lock is held by a branch name (docs/ops/SIM-BENCH.md → Seed)',
    );
  const bot = async (a: string[]) =>
    (
      await exec('pnpm', ['--silent', 'bot', ...a], { cwd: worktree, maxBuffer: 1 << 20 }).catch(
        (err: unknown) => {
          const e = err as { stdout?: string; stderr?: string };
          // the bot's own refusal says who holds dev and what to send (lock wait, the holder's session)
          throw new Error(
            `pnpm bot ${a.join(' ')} refused:\n${e.stdout ?? ''}${e.stderr ?? ''}`.trim(),
            { cause: err },
          );
        },
      )
    ).stdout;
  useSlot('dev');
  const plans = JSON.parse(readFileSync(PLANS_PATH, 'utf8')) as { seed: BenchSeed };
  const home = devcheckHome(main);
  const ledger = openLedger(join(home, ledgerFile('dev')));
  const env = loadEnv(envPath(main, 'dev'));
  const deps: SeedDeps = {
    pick: () =>
      pickSlot(branch, {
        lsRemote: () => git(['ls-remote', 'origin', 'refs/locks/dev', 'refs/locks/devb']),
        tagMessage: async (tag) =>
          (
            await exec(
              'gh',
              ['api', `repos/radatta/aperture/git/tags/${tag}`, '--jq', '.message'],
              { cwd: worktree },
            )
          ).stdout.trim(),
      }),
    async acquire() {
      const out = await bot(['lock', 'acquire', '--slot', 'dev']);
      const m = /dev held until (\S+)/.exec(out);
      if (!m) throw new Error(`pnpm bot lock acquire said: ${out.trim()}`);
      return m[1]!;
    },
    release: async () => void (await bot(['lock', 'release'])),
    runLock: () => takeLock(join(home, runLockFile('dev'))),
    ledger,
    async signIn(run) {
      const log = (s: string) => console.log(`[sim-bench:seed] ${s}`);
      validateCachedState(statePath(main, 'dev'), env, log);
      const { browser, context } = await launch(loadPlaywright(), statePath(main, 'dev'));
      try {
        const page = await context.newPage();
        const session = await ensureSignedIn(page, context, env, {
          statePath: statePath(main, 'dev'),
          shot: async () => {},
        });
        const api = createApiClient({
          fetch,
          token: () => session.accessToken,
          fresh: async () => {},
          ledger,
          run,
        });
        return { api, close: () => browser.close() };
      } catch (err) {
        await browser.close().catch(() => {});
        throw err;
      }
    },
    seed: plans.seed,
    now: () => new Date(),
    log: (s) => console.log(`[sim-bench:seed] ${s}`),
  };
  if (args.includes('--clean')) {
    const r = await clean(deps);
    return r.failed.length ? 1 : 0;
  }
  const r = await seed(deps);
  console.log(`\nseed ${r.id} · dev lock until ${r.expiresAt}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(2);
    },
  );
