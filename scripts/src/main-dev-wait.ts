// @aperture/scripts — a merge's dev deploy waits for the slot's lock (deploy.yml's `wait-dev` / `wait-devb` jobs).
//
// A merge to main used to deploy main onto slot A (and slot B on a shape change) whatever was there, replacing a lane's
// branch under its devcheck. Now the slot's deploy waits while that slot's lock (`refs/locks/<slot>`, bot/lock.ts) is
// held and live: it polls every 30 s, wakes at the holder's expiry, and goes when the lock is released or lapses
// (docs/ops/CI-BOT.md → Dev deploys → A merge waits for the lock). The bot's other half refuses the slot to every other
// branch while main's run is pending there (bot/main-pending.ts), so nothing slips in after the wait.
//
// Never a reason not to deploy: prod waits behind dev. At the run's cap (below; a lock renewed past it), or after
// MAX_ERRORS failed reads in a row, it says so — a ::warning:: and the step summary — and exits 0, so the deploy goes
// (the old behaviour, which the devcheck's build-marker check catches). Only misuse exits non-zero, and deploy.yml's
// deploy `if:`s never read this job's result anyway.
//
// The cap is one holder's turn, shared by the merges a run carries — not a fresh hour per run: CEILING_MS from the later
// of the oldest merge riding in this run (this run's own push, or an older one superseded while pending: deploy.yml's
// concurrency keeps one pending run and cancels the one it replaces before any job starts, so its commit rides here)
// and the holder's taking of the lock (`takenAt`, as first read; a lock an older bot wrote has none, so its TTL as
// first read is honoured instead). So a lane that took the slot after the merge gets its full turn, and a lock renewed
// for hours holds the merges queued behind it an hour in all, not an hour a run. Never under FLOOR_MS from this wait's
// start (MAX_ERRORS' tries at a failing read), never over CEILING_MS from it. A re-run, or a runs listing that fails,
// counts CEILING_MS from this wait's start (the old rule), the second with a ::warning:: (CI-BOT.md → Dev deploys →
// A merge waits for the lock).
//
// The holder JSON is anyone-with-contents-write's text printed to a public log: every line is stripped of control
// characters, and the annotation and summary carry only the branch through a name charset and a 7-hex sha.
//
// Run: `node scripts/src/main-dev-wait.ts <dev|devb> [--once]` with GITHUB_TOKEN (contents: read, actions: read) and
// GITHUB_REPOSITORY set; GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT (the runner's own) for the cap; GITHUB_STEP_SUMMARY when
// there is one. `--once` reads the lock once and main's Deploy runs once, and prints both (the probe in deploy-dev.yml's
// verify: this module loads on the runner and the job token reads the lock and the runs). Same no-install constraint
// as deploy-base.ts, but a wider import chain: bot/lock.ts brings bot/config.ts → identifiers.ts (reads the tracked
// identifiers.json at import) → mac-root.ts, and bot/sh.ts; bot/dispatch.ts — node: builtins only, as the bot CLI
// already runs them under plain node.
import { appendFileSync } from 'node:fs';
import { makeApi } from './bot/api.ts';
import type { Api } from './bot/api.ts';
import { OWNER, REPO } from './bot/config.ts';
import { listJobs, listRuns } from './bot/dispatch.ts';
import type { Clock, Run } from './bot/dispatch.ts';
import { SLOTS, isExpired, readLock, waitForLock } from './bot/lock.ts';
import type { Holder } from './bot/lock.ts';

export const CEILING_MS = 60 * 60_000; // one holder's turn: from the later of the oldest riding merge and its taking
export const FLOOR_MS = 15 * 60_000; // from this wait's start, whatever the merge's or the lock's age
const RUNS = 30; // main's newest Deploy runs: this one, at most one pending behind it, and the superseded ones before
export const WALK_MAX = 10; // superseded runs checked for jobs; past that, the oldest found (a later deadline)
// Before the first read: the bot refuses the slot once it sees this job running (bot/main-pending.ts); a lane that
// wrote its lock just before that sighting must be read here, so the first read comes after any jobs-API lag.
export const SETTLE_MS = 20_000;
export const MAX_ERRORS = 10; // ~5 min of failed reads at one a poll: a GitHub blip doesn't deploy over a live test
const REQUEST_MS = 20_000;

// eslint-disable-next-line no-control-regex -- stripping them is the point
const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
const safeBranch = (b: string) => b.replace(/[^A-Za-z0-9._/-]/g, '?').slice(0, 80);
const sha7 = (s: string) => /^[0-9a-f]{7}/.exec(s)?.[0] ?? '???????';
export const who = (h: Holder | null) =>
  h ? `${safeBranch(h.branch)} @ ${sha7(h.sha)}` : 'an unreadable holder';

// The runs just before `selfId`, newest first, for as long as each is completed and cancelled: the candidates for
// "superseded while pending" (anchorIn keeps those with no jobs). Sorted by id (ids rise with creation), not trusting
// the listing's order.
export function cancelledBefore(runs: Run[], selfId: number): Run[] {
  const out: Run[] = [];
  for (const r of runs.filter((x) => x.id < selfId).sort((a, b) => b.id - a.id)) {
    if (r.status !== 'completed' || r.conclusion !== 'cancelled') break;
    out.push(r);
  }
  return out;
}

export interface Anchor {
  at: number; // the oldest riding merge's created_at (ms)
  sha: string;
  superseded: number; // runs whose commits ride in this one
  stoppedAt?: number; // a cancelled run with jobs that ended the walk: worth a log line (a superseded run with jobs
  // would silently bring back the per-run hour)
}

// The oldest merge riding in run `selfId`: its own push, or the zero-job cancelled runs just before it. A cancelled run
// with jobs (cancelled mid-run by hand) ended the queue there, and so does any finished run: a failed or long-past
// predecessor never shortens this wait. Throws when `selfId` isn't listed or a date won't parse.
export async function anchorIn(api: Api, runs: Run[], selfId: number): Promise<Anchor> {
  const self = runs.find((r) => r.id === selfId);
  if (!self) throw new Error(`run ${selfId} isn't among main's newest ${RUNS} Deploy runs`);
  const riding = [self];
  let stoppedAt: number | undefined;
  for (const r of cancelledBefore(runs, selfId).slice(0, WALK_MAX)) {
    if ((await listJobs(api, r.id)).length) {
      stoppedAt = r.id;
      break;
    }
    riding.push(r);
  }
  const oldest = riding.at(-1) ?? self;
  const at = Date.parse(oldest.created_at);
  if (Number.isNaN(at)) throw new Error(`run ${oldest.id} has no readable created_at`);
  return { at, sha: oldest.head_sha ?? '', superseded: riding.length - 1, stoppedAt };
}

export const mainRuns = (api: Api) =>
  listRuns(api, 'deploy.yml', `per_page=${RUNS}&event=push&branch=main`);

export type CapBy = 'start' | 'merge' | 'taken' | 'ttl' | 'floor';
// The wait's deadline, and what set it. No anchor (a re-run, a failed listing): CEILING_MS from the start. Else CEILING_MS
// from the later of the oldest riding merge and the live holder's `takenAt` (a holder without one: its expiry as first
// read), within [start + FLOOR_MS, start + CEILING_MS]. Times in the future (a runner clock behind GitHub's) count as
// the start.
export function deadlineOf(
  anchorAt: number | null,
  start: number,
  holder: Holder | null = null,
): { deadline: number; by: CapBy } {
  if (anchorAt === null) return { deadline: start + CEILING_MS, by: 'start' };
  const taken = holder?.takenAt ? Date.parse(holder.takenAt) : NaN;
  const live = holder && !isExpired(holder, start);
  let deadline = Math.min(anchorAt, start) + CEILING_MS;
  let by: CapBy = 'merge';
  const grant = !live
    ? NaN
    : Number.isNaN(taken)
      ? Date.parse(holder.expiresAt)
      : Math.min(taken, start) + CEILING_MS;
  if (grant > deadline) [deadline, by] = [grant, Number.isNaN(taken) ? 'ttl' : 'taken'];
  if (deadline > start + CEILING_MS) deadline = start + CEILING_MS;
  if (deadline < start + FLOOR_MS) [deadline, by] = [start + FLOOR_MS, 'floor'];
  return { deadline, by };
}

const utc = (ms: number) => `${new Date(ms).toISOString().slice(11, 16)} UTC`;
const PROBE_MS = 60_000; // the whole --once probe: verify's job has 5 min for everything

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
  const budget = flag === '--once' ? AbortSignal.timeout(PROBE_MS) : null;
  const api = makeApi(token, (url, init) => {
    const own = AbortSignal.timeout(REQUEST_MS);
    return fetchImpl(url, { ...init, signal: budget ? AbortSignal.any([own, budget]) : own });
  });
  if (flag === '--once') {
    try {
      const cur = await readLock(api, slot);
      log(
        `${slot} lock probe: ${!cur ? 'free' : `${who(cur.holder)}${isExpired(cur.holder, clock.now()) ? ' (expired)' : ''}`} — read with the job token`,
      );
    } catch (err) {
      log(`::warning title=${slot} lock probe failed::${clean((err as Error).message)}`);
    }
    // The cap's half: main's Deploy runs, and the anchor of the newest one with a cancelled run just before it (so the
    // jobs reads run too), else of the newest.
    try {
      const runs = await mainRuns(api);
      const byId = [...runs].sort((a, b) => b.id - a.id);
      const target =
        byId.find((r) => cancelledBefore(runs, r.id).length > 0 && r.conclusion !== 'cancelled') ??
        byId[0];
      if (!target) log('wait-cap probe: no main Deploy runs listed — read with the job token');
      else {
        const a = await anchorIn(api, runs, target.id);
        log(
          `wait-cap probe: ${runs.length} main Deploy runs listed; ${sha7(target.head_sha ?? '')}'s run would wait from ${sha7(a.sha)}'s merge at ${new Date(a.at).toISOString().slice(0, 16)}Z, ${a.superseded} superseded riding${a.stoppedAt ? `, walk stopped at run ${a.stoppedAt} (cancelled with jobs)` : ''} — read with the job token`,
        );
      }
    } catch (err) {
      log(`::warning title=wait-cap probe failed::${clean((err as Error).message)}`);
    }
    return 0;
  }
  log(`${slot}: waiting while refs/locks/${slot} is held`);
  await clock.sleep(SETTLE_MS);
  const start = clock.now();
  // The cap (header): from the oldest merge riding here, else — a re-run, no run id, a failed listing — from now.
  const runId = Number(env.GITHUB_RUN_ID);
  let anchor: Anchor | null = null;
  if (!Number.isSafeInteger(runId) || runId <= 0)
    log(`${slot}: no GITHUB_RUN_ID — the cap counts from this wait's start`);
  else if (!/^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT ?? ''))
    log(`${slot}: no GITHUB_RUN_ATTEMPT — the cap counts from this wait's start`);
  else if (env.GITHUB_RUN_ATTEMPT !== '1')
    log(`${slot}: a re-run — the cap counts from this wait's start`);
  else
    try {
      anchor = await anchorIn(api, await mainRuns(api), runId);
      if (anchor.stoppedAt)
        log(
          `${slot}: run ${anchor.stoppedAt} was cancelled after its jobs started — the queue riding here starts after it`,
        );
    } catch (err) {
      log(
        `::warning title=${slot} wait cap fell back::${clean((err as Error).message)} — the cap counts ${CEILING_MS / 60_000} min from this wait's start`,
      );
    }
  // The holder whose turn this is: read once before waiting (main-pending.ts keeps the slot from changing hands while
  // this wait runs). A failed read leaves it unknown — the merge's cap and the floor still hold, waitForLock retries.
  let first: Holder | null = null;
  if (anchor)
    try {
      first = (await readLock(api, slot))?.holder ?? null;
    } catch {
      first = null;
    }
  const { deadline, by } = deadlineOf(anchor?.at ?? null, start, first);
  const merge = anchor
    ? `the oldest merge riding here, ${sha7(anchor.sha)} at ${utc(anchor.at)}${anchor.superseded ? ` (${anchor.superseded} superseded run${anchor.superseded > 1 ? 's ride' : ' rides'} here)` : ''}`
    : '';
  const cap =
    by === 'start'
      ? `${CEILING_MS / 60_000} min of waiting`
      : by === 'merge'
        ? `${CEILING_MS / 60_000} min from ${merge}`
        : by === 'taken'
          ? `${CEILING_MS / 60_000} min from ${who(first)} taking the lock at ${utc(Math.min(Date.parse(first?.takenAt ?? ''), start))} (after ${merge})`
          : by === 'ttl'
            ? `${who(first)}'s lock expiry as first read (no taken time on it; ${merge})`
            : `the ${FLOOR_MS / 60_000}-minute minimum (${merge})`;
  log(`${slot}: cap ${utc(deadline)} — ${cap}`);
  let slept = false;
  const timed: Clock = { now: clock.now, sleep: (ms) => ((slept = true), clock.sleep(ms)) };
  const mins = () => Math.round((clock.now() - start) / 60_000);
  try {
    const r = await waitForLock(api, 'main', timed, {
      maxMs: deadline - clock.now(), // > 0: the floor outlasts the runs listing (11 reads at most)
      slots: [slot],
      maxErrors: MAX_ERRORS,
      log,
    });
    if (r.outcome === 'gave-up')
      loud(
        `${slot} deploy waited ${mins()} min and went anyway`,
        `The ${slot} lock was still held by ${who(r.holder)} at this run's cap, ${cap} — a turn renewed past an hour: this deploy replaces that branch on ${slot} mid-test. Its devcheck's build-marker check will say so; re-run its \`pnpm bot deploy-dev\` after this run's ${slot} job.`,
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
