// @aperture/scripts — a merge's dev deploy waits for the slot's lock (deploy.yml's `wait-dev` / `wait-devb` jobs).
//
// A merge to main used to deploy main onto slot A (and slot B on a shape change) whatever was there, replacing a lane's
// branch under its devcheck. Now the slot's deploy waits while that slot's lock (`refs/locks/<slot>`, bot/lock.ts) is
// held and live: it polls every 30 s, wakes at the holder's expiry, and goes when the lock is released or lapses
// (docs/ops/CI-BOT.md → Dev deploys → A merge waits for the lock). The bot's other half refuses the slot to every other
// branch while main's run is pending there (bot/main-pending.ts), so nothing slips in after the wait.
//
// Never a reason not to deploy: prod waits behind dev. After CEILING_MS of waiting (a lock renewed past its TTL), or
// MAX_ERRORS failed reads in a row, it says so — a ::warning:: and the step summary — and exits 0, so the deploy goes
// (the old behaviour, which the devcheck's build-marker check catches). Only misuse exits non-zero, and deploy.yml's
// deploy `if:`s never read this job's result anyway.
//
// The holder JSON is anyone-with-contents-write's text printed to a public log: every line is stripped of control
// characters, and the annotation and summary carry only the branch through a name charset and a 7-hex sha.
//
// Run: `node scripts/src/main-dev-wait.ts <dev|devb> [--once]` with GITHUB_TOKEN (contents: read) and
// GITHUB_REPOSITORY set; GITHUB_STEP_SUMMARY when there is one. `--once` reads the lock once and prints it (the probe in
// deploy-dev.yml's verify: this module loads on the runner and the job token reads the lock). Same no-install
// constraint as deploy-base.ts, but a wider import chain: bot/lock.ts brings bot/config.ts → identifiers.ts (reads the
// tracked identifiers.json at import) → mac-root.ts, and bot/sh.ts — node: builtins only, as the bot CLI already
// runs them under plain node.
import { appendFileSync } from 'node:fs';
import { makeApi } from './bot/api.ts';
import { OWNER, REPO } from './bot/config.ts';
import type { Clock } from './bot/dispatch.ts';
import { SLOTS, isExpired, readLock, waitForLock } from './bot/lock.ts';
import type { Holder } from './bot/lock.ts';

export const CEILING_MS = 60 * 60_000;
export const MAX_ERRORS = 10; // ~5 min of failed reads at one a poll: a GitHub blip doesn't deploy over a live test
const REQUEST_MS = 20_000;

// eslint-disable-next-line no-control-regex -- stripping them is the point
const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
const safeBranch = (b: string) => b.replace(/[^A-Za-z0-9._/-]/g, '?').slice(0, 80);
const sha7 = (s: string) => /^[0-9a-f]{7}/.exec(s)?.[0] ?? '???????';
export const who = (h: Holder | null) =>
  h ? `${safeBranch(h.branch)} @ ${sha7(h.sha)}` : 'an unreadable holder';

export interface Deps {
  argv: string[];
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
  clock: Clock;
  log: (line: string) => void;
  summary: (markdown: string) => void;
}

export async function run({ argv, env, fetchImpl, clock, log: raw, summary }: Deps) {
  const log = (s: string) => raw(clean(s));
  const [slotArg, flag] = argv;
  const slot = SLOTS.find((x) => x === slotArg);
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repo } = env;
  if (!slot || (flag !== undefined && flag !== '--once') || argv.length > 2 || !token || !repo) {
    log('usage: main-dev-wait.ts <dev|devb> [--once], with GITHUB_TOKEN and GITHUB_REPOSITORY set');
    return 1;
  }
  const loud = (title: string, body: string) => {
    log(`::warning title=${title}::${body}`);
    summary(`### ⚠️ ${title}\n\n${body}\n`);
  };
  // The lock module reads the repo from identifiers.json; a fork or a rename would read some other repo's lock.
  if (repo !== `${OWNER}/${REPO}`) {
    if (flag === '--once') {
      log(
        `${slot} lock probe skipped: this run is ${safeBranch(repo)}, identifiers.json names another repo`,
      );
      return 0;
    }
    loud(
      `${slot} deploy did not wait`,
      `identifiers.json names ${safeBranch(`${OWNER}/${REPO}`)}, this run is ${safeBranch(repo)}: the ${slot} lock was not read, so this deploy may replace a lane's branch mid-test.`,
    );
    return 0;
  }
  const api = makeApi(token, (url, init) =>
    fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_MS) }),
  );
  if (flag === '--once') {
    try {
      const cur = await readLock(api, slot);
      log(
        `${slot} lock probe: ${!cur ? 'free' : `${who(cur.holder)}${isExpired(cur.holder, clock.now()) ? ' (expired)' : ''}`} — read with the job token`,
      );
    } catch (err) {
      log(`::warning title=${slot} lock probe failed::${clean((err as Error).message)}`);
    }
    return 0;
  }
  const start = clock.now();
  let slept = false;
  const timed: Clock = { now: clock.now, sleep: (ms) => ((slept = true), clock.sleep(ms)) };
  const mins = () => Math.round((clock.now() - start) / 60_000);
  log(`${slot}: waiting while refs/locks/${slot} is held (ceiling ${CEILING_MS / 60_000} min)`);
  try {
    const r = await waitForLock(api, 'main', timed, {
      maxMs: CEILING_MS,
      slots: [slot],
      maxErrors: MAX_ERRORS,
      log,
    });
    if (r.outcome === 'gave-up')
      loud(
        `${slot} deploy waited ${mins()} min and went anyway`,
        `The ${slot} lock was still held by ${who(r.holder)} after the ${CEILING_MS / 60_000}-minute ceiling (renewed past its TTL): this deploy replaces that branch on ${slot} mid-test. Its devcheck's build-marker check will say so; re-run its \`pnpm bot deploy-dev\` after this run's ${slot} job.`,
      );
    else if (!slept && r.outcome === 'free') log(`${slot} lock free — deploying`);
    else
      log(
        `::notice title=${slot} deploy waited for its lock::${mins()} min; ${r.outcome === 'expired' ? `${who(r.holder)}'s lock lapsed` : r.outcome === 'free' ? 'released' : 'held by main'} — deploying`,
      );
  } catch (err) {
    loud(
      `${slot} deploy could not read its lock`,
      `${MAX_ERRORS} failed reads in a row (${clean((err as Error).message)}) after ${mins()} min: deploying without knowing whether a lane is mid-test on ${slot}.`,
    );
  }
  return 0;
}

if (process.argv[1]?.endsWith('main-dev-wait.ts'))
  process.exitCode = await run({
    argv: process.argv.slice(2),
    env: process.env,
    fetchImpl: fetch,
    clock: { now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
    log: (line) => console.log(line),
    summary: (md) => {
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
    },
  });
