// The dev locks: one feature branch per dev slot at a time, across every session and machine. Slot A is
// `refs/locks/dev`, slot B `refs/locks/devb` (INFRA §2) → an annotated tag whose message is the holder JSON. Creating a
// ref that exists is a 422 (probed 2026-10-13), so creation is the atomic acquire. Expiry lives in the message: a
// crashed holder frees the lock after TTL. Holder = branch (one session per branch), and a branch holds at most one
// slot. docs/ops/CI-BOT.md → Dev lock.
import type { Api } from './api.ts';
import { GitHubError } from './api.ts';
import { OWNER, REPO } from './config.ts';
import type { Clock } from './dispatch.ts';

// = @aperture/shared DEV_SLOTS; the bot runs under plain node with builtins only, so a test pins the copy.
export const SLOTS = ['dev', 'devb'] as const;
export type Slot = (typeof SLOTS)[number];
export const lockRef = (slot: Slot = 'dev') => `locks/${slot}`;
export const LOCK_REF = lockRef('dev');
export const TTL_MS = 45 * 60 * 1000;
const R = `/repos/${OWNER}/${REPO}`;

export interface Holder {
  branch: string;
  sha: string;
  expiresAt: string;
}
export interface LockState {
  holder: Holder | null; // null: ref present but unreadable (treated as expired)
  tagSha: string;
}

// An unreadable holder or expiry counts as expired — a garbled lock must not block dev forever.
export const isExpired = (h: Holder | null, nowMs: number) =>
  !h || !(Date.parse(h.expiresAt) > nowMs);

const asHolder = (v: unknown): Holder | null => {
  const h = v as Partial<Holder> | null;
  return h &&
    typeof h.branch === 'string' &&
    typeof h.sha === 'string' &&
    typeof h.expiresAt === 'string'
    ? { branch: h.branch, sha: h.sha, expiresAt: h.expiresAt }
    : null;
};

export async function readLock(api: Api, slot: Slot = 'dev'): Promise<LockState | null> {
  let ref: { object: { sha: string; type: string } };
  try {
    ref = await api('GET', `${R}/git/ref/${lockRef(slot)}`);
  } catch (err) {
    if (err instanceof GitHubError && err.status === 404) return null;
    throw err;
  }
  if (ref.object.type !== 'tag') return { holder: null, tagSha: ref.object.sha };
  const tag = await api<{ message: string }>('GET', `${R}/git/tags/${ref.object.sha}`);
  try {
    return { holder: asHolder(JSON.parse(tag.message)), tagSha: ref.object.sha };
  } catch {
    return { holder: null, tagSha: ref.object.sha };
  }
}

async function makeTag(api: Api, holder: Holder, slot: Slot): Promise<string> {
  const tag = await api<{ sha: string }>('POST', `${R}/git/tags`, {
    tag: lockRef(slot),
    message: JSON.stringify(holder),
    object: holder.sha,
    type: 'commit',
  });
  return tag.sha;
}

const describe = (h: Holder | null) =>
  h ? `${h.branch} @ ${h.sha.slice(0, 7)} until ${h.expiresAt}` : 'an unreadable holder';

// Another live branch holds the lock. Typed, so the CLI can print who to tell before the error line. `held` lists every
// slot that refused (both, for a deploy-dev that may take either); `holder` is the first one's.
export class LockHeld extends Error {
  readonly holder: Holder | null;
  readonly held: { slot: Slot; holder: Holder | null }[];
  constructor(
    holder: Holder | null,
    slot: Slot = 'dev',
    more: { slot: Slot; holder: Holder | null }[] = [],
  ) {
    const held = [{ slot, holder }, ...more];
    super(
      held.length > 1
        ? `both dev slots are locked — ${held.map((x) => `${x.slot} by ${describe(x.holder)}`).join('; ')} — \`pnpm bot lock wait --any\` (in the background) wakes you when one frees`
        : `${slot} is locked by ${describe(holder)} — \`pnpm bot lock wait${slot === 'dev' ? '' : ` --slot ${slot}`}\` (in the background) wakes you when it frees`,
    );
    this.holder = holder;
    this.held = held;
  }
}

// A slot refused because a main Deploy run is still to land on it (main-pending.ts), maybe with the other slot held
// too: `held` keeps every refusal, a main one with no holder and its run's URL. A LockHeld, so the CLI still prints the
// notes for the holders among them; `wait` is the command that wakes when one is free of both.
export type PendingGuard = (slot: Slot) => Promise<string | null>; // the pending run's URL, or null
export class MainPending extends LockHeld {
  readonly runs: { slot: Slot; url: string }[];
  readonly wait: string;
  constructor(refused: { slot: Slot; holder: Holder | null; run?: string }[]) {
    const [first, ...more] = refused;
    super(first?.holder ?? null, first?.slot, more);
    this.runs = refused.flatMap((x) => (x.run ? [{ slot: x.slot, url: x.run }] : []));
    this.wait =
      refused.length > 1
        ? 'lock wait --any'
        : `lock wait${first?.slot === 'devb' ? ' --slot devb' : ''}`;
    this.message = `${refused
      .map((x) =>
        x.run
          ? `${x.holder ? `${x.slot} is locked by ${describe(x.holder)}, and ` : ''}main's deploy is still to land on ${x.slot} (${x.run})`
          : `${x.slot} is locked by ${describe(x.holder)}`,
      )
      .join(
        '; ',
      )} — \`pnpm bot ${this.wait}\` (in the background) wakes you when ${refused.length > 1 ? 'one is' : 'it is'} free (docs/ops/CI-BOT.md → Dev deploys)`;
  }
}

// Acquire (or, if this branch already holds it, renew). Throws LockHeld when another live holder has it.
export async function acquire(
  api: Api,
  branch: string,
  sha: string,
  nowMs: number,
  slot: Slot = 'dev',
): Promise<Holder> {
  const ref = lockRef(slot);
  const holder: Holder = { branch, sha, expiresAt: new Date(nowMs + TTL_MS).toISOString() };
  const tagSha = await makeTag(api, holder, slot);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await api('POST', `${R}/git/refs`, { ref: `refs/${ref}`, sha: tagSha });
      return holder;
    } catch (err) {
      if (!(err instanceof GitHubError && err.status === 422)) throw err;
    }
    const cur = await readLock(api, slot);
    if (!cur) continue; // released between our create and read — try again
    if (cur.holder?.branch === branch) {
      await api('PATCH', `${R}/git/refs/${ref}`, { sha: tagSha, force: true });
      return holder;
    }
    if (!isExpired(cur.holder, nowMs)) throw new LockHeld(cur.holder, slot);
    // Expired: delete only if it still points at the tag we judged expired (narrows the take-over race).
    const again = await readLock(api, slot);
    if (again && again.tagSha === cur.tagSha) {
      // Gone already (another session's take-over deleted it first) is fine — the next create decides.
      await api('DELETE', `${R}/git/refs/${ref}`).catch((err: unknown) => {
        if (!(err instanceof GitHubError && (err.status === 404 || err.status === 422))) throw err;
      });
    }
  }
  throw new Error(
    `lost the race for the ${slot} lock — another session took it; check \`pnpm bot lock status\``,
  );
}

// The slot this branch holds a lock on (live or not), else null. A branch holds at most one.
export async function heldSlot(api: Api, branch: string): Promise<Slot | null> {
  for (const slot of SLOTS) if ((await readLock(api, slot))?.holder?.branch === branch) return slot;
  return null;
}

// deploy-dev's acquire (docs/ops/CI-BOT.md → Dev lock): the slot this branch already holds, renewed; else the first
// free one, A before B; else LockHeld naming every holder. `only` asks for one slot by name (`lock acquire --slot`),
// and is refused while the branch holds the other — a branch never holds both. `ios`, the branch's changed files that
// only slot A's Simulator proves (ios-routing.ts), pins it to dev: held → LockHeld for dev alone, so the session
// waits for A rather than taking a free devb; holding devb, or asking for it, is refused.
// `pending` (main-pending.ts) refuses a slot main's Deploy run is still to land on, to any branch but its live holder
// (a lane mid-test may redeploy a fix while main waits for it). Checked before the ref is written, and again after —
// the authoritative read: main's wait reads the lock after its run exists, so either it sees our lock or we see its
// run. A refusal after the write releases it; so does a guard that fails after it (fail closed, then rethrow).
export async function acquireSlot(
  api: Api,
  branch: string,
  sha: string,
  nowMs: number,
  only?: Slot,
  ios: string[] = [],
  pending?: PendingGuard,
): Promise<{ slot: Slot; holder: Holder }> {
  const mine = await heldSlot(api, branch);
  if (ios.length) {
    const files = `${ios.slice(0, 3).join(', ')}${ios.length > 3 ? `, +${ios.length - 3} more` : ''}`;
    const why = `${branch} touches iOS paths (${files}), which only slot A's Simulator can prove (SIM_SLOT_A_ONLY)`;
    if (mine === 'devb')
      throw new Error(
        `${why}, but holds devb — \`pnpm bot lock release\`, then \`pnpm bot deploy-dev\` again (it takes dev or names \`lock wait\`)`,
      );
    if (only === 'devb') throw new Error(`${why} — take dev instead: \`lock acquire --slot dev\``);
    only = 'dev';
  }
  if (mine && only && mine !== only)
    throw new Error(
      `${branch} holds the ${mine} lock — \`pnpm bot lock release\` first to move to ${only}`,
    );
  // A live holder renews as before; a lapsed one is a new acquire (the guard applies), trying its own slot first.
  if (mine && (!pending || !isExpired((await readLock(api, mine))?.holder ?? null, nowMs)))
    return { slot: mine, holder: await acquire(api, branch, sha, nowMs, mine) };
  const order = only ? [only] : mine ? [mine, ...SLOTS.filter((s) => s !== mine)] : SLOTS;
  const letGo = (slot: Slot) => release(api, branch, slot).catch(() => false);
  const refused: { slot: Slot; holder: Holder | null; run?: string }[] = [];
  for (const slot of order) {
    const before = pending ? await pending(slot) : null;
    if (before) {
      if (slot === mine) await letGo(slot); // our lapsed lock: a branch holds at most one
      // The holder main waits for, if any, so the refusal's notes name who goes before main.
      const cur = slot === mine ? null : await readLock(api, slot);
      refused.push({
        slot,
        holder: cur && !isExpired(cur.holder, nowMs) ? cur.holder : null,
        run: before,
      });
      continue;
    }
    let holder: Holder;
    try {
      holder = await acquire(api, branch, sha, nowMs, slot);
    } catch (err) {
      if (!(err instanceof LockHeld)) throw err;
      refused.push({ slot, holder: err.holder });
      continue;
    }
    let after: string | null;
    try {
      after = pending ? await pending(slot) : null;
    } catch (err) {
      await letGo(slot);
      throw err;
    }
    if (!after) return { slot, holder };
    await letGo(slot);
    refused.push({ slot, holder: null, run: after });
  }
  if (refused.some((x) => x.run)) throw new MainPending(refused);
  const [first, ...more] = refused;
  throw new LockHeld(first?.holder ?? null, first?.slot, more);
}

// renew and release are read-then-write too (PATCH force / DELETE): a take-over landing between the read and
// the write is clobbered. Same window and same backstop as acquire's take-over race (CI-BOT.md → Dev lock).
export async function renew(
  api: Api,
  branch: string,
  nowMs: number,
  slot: Slot = 'dev',
): Promise<Holder> {
  const cur = await readLock(api, slot);
  if (!cur || cur.holder?.branch !== branch)
    throw new Error(
      `${branch} does not hold the ${slot} lock (holder: ${cur ? describe(cur.holder) : 'none'})`,
    );
  // A lapsed lock is free to all: a merge's wait may already have read it and be deploying. Re-take it through the
  // guarded acquire, never revive it here (CI-BOT.md → Dev deploys → A merge waits for the lock).
  if (isExpired(cur.holder, nowMs))
    throw new Error(
      `${branch}'s ${slot} lock lapsed at ${cur.holder.expiresAt} — \`pnpm bot lock acquire\` (or \`deploy-dev\`) takes it back unless a merge is deploying there`,
    );
  const holder: Holder = { ...cur.holder, expiresAt: new Date(nowMs + TTL_MS).toISOString() };
  await api('PATCH', `${R}/git/refs/${lockRef(slot)}`, {
    sha: await makeTag(api, holder, slot),
    force: true,
  });
  return holder;
}

// Holder-only: a session never frees another branch's lock (an expired one is taken over by acquire instead).
export async function release(api: Api, branch: string, slot: Slot = 'dev'): Promise<boolean> {
  const cur = await readLock(api, slot);
  if (!cur) return false;
  if (cur.holder?.branch !== branch)
    throw new Error(`${branch} does not hold the ${slot} lock (holder: ${describe(cur.holder)})`);
  await api('DELETE', `${R}/git/refs/${lockRef(slot)}`);
  return true;
}

export const formatStatus = (cur: LockState | null, nowMs: number, slot: Slot = 'dev') =>
  !cur
    ? `${slot} lock: free`
    : `${slot} lock: ${describe(cur.holder)}${isExpired(cur.holder, nowMs) ? ' (EXPIRED — the next acquire takes it over)' : ''}`;

export const status = async (api: Api, nowMs: number, slot: Slot = 'dev') =>
  formatStatus(await readLock(api, slot), nowMs, slot);

// --- lock wait: block until another branch's lock frees, expires or the cap passes (CI-BOT.md → Dev lock). `slots`
// watches several: `lock wait --any` returns on the first of either slot to free. ---

export type WaitOutcome = 'free' | 'expired' | 'ours' | 'gave-up';
export interface WaitOptions {
  maxMs: number;
  pollMs?: number;
  log?: (s: string) => void;
  sessionOf?: (branch: string) => string | undefined; // the holder's board session, for the log line
  onRead?: (cur: LockState | null, slot: Slot) => void; // every successful read (the board's lock cache)
  slots?: readonly Slot[]; // which locks to watch; slot A by default
  maxErrors?: number; // failed reads in a row before it throws; 3 by default
  // A free or lapsed slot still busy (main's Deploy run is still to land on it: main-pending.ts) isn't free yet. A
  // failure counts as a failed read.
  busy?: (slot: Slot) => Promise<boolean>;
}

export const POLL_MS = 30_000;
const LOG_EVERY_MS = 5 * 60_000;
const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

export function holderLine(h: Holder, nowMs: number, session?: string, slot: Slot = 'dev'): string {
  const min = Math.max(0, Math.ceil((Date.parse(h.expiresAt) - nowMs) / 60_000));
  return `${slot} locked by ${h.branch} @ ${h.sha.slice(0, 7)} until ${hhmm(h.expiresAt)} (${min} min)${session ? ` — session ${session}` : ''}`;
}

// Polls every 30 s, and wakes at the holder's expiry when that comes sooner. Read-only: taking the lock is still
// `deploy-dev`'s acquire. A failed read waits a full poll before the next; three in a row throw (exit 1).
export async function waitForLock(
  api: Api,
  branch: string,
  clock: Clock,
  o: WaitOptions,
): Promise<{ outcome: WaitOutcome; holder: Holder | null; slot: Slot; main?: boolean }> {
  const pollMs = o.pollMs ?? POLL_MS;
  const log = o.log ?? (() => undefined);
  const slots = o.slots ?? ['dev'];
  const deadline = clock.now() + o.maxMs;
  let errors = 0;
  let last: { slot: Slot; holder: Holder } | null = null;
  let loggedExpiry = '';
  let loggedAt = -Infinity;
  let loggedBusy = '';
  let heldBack: Slot[] = []; // free or lapsed, but main's run is still to land there (`busy`)
  for (;;) {
    let reads: { slot: Slot; cur: LockState | null }[] | undefined;
    const now = clock.now();
    let open: { outcome: 'free' | 'expired'; holder: Holder | null; slot: Slot }[] = [];
    try {
      reads = [];
      for (const slot of slots) reads.push({ slot, cur: await readLock(api, slot) });
      for (const { slot, cur } of reads) {
        if (cur?.holder?.branch === branch) continue;
        if (!cur) open.push({ outcome: 'free', holder: null, slot });
        else if (isExpired(cur.holder, now))
          open.push({ outcome: 'expired', holder: cur.holder, slot });
      }
      if (o.busy) {
        const still: Slot[] = [];
        for (const x of open) if (await o.busy(x.slot)) still.push(x.slot);
        open = open.filter((x) => !still.includes(x.slot));
        heldBack = still;
        const said = still.join(',');
        if (said && said !== loggedBusy)
          log(`waiting: main's deploy is still to land on ${still.join(' and ')}`);
        loggedBusy = said;
      }
      errors = 0;
    } catch (err) {
      reads = undefined;
      if (++errors >= (o.maxErrors ?? 3)) throw err;
      log(`lock read failed (${(err as Error).message}) — retrying`);
    }
    for (const { slot, cur } of reads ?? []) o.onRead?.(cur, slot);
    if (reads) {
      for (const { slot, cur } of reads)
        if (cur?.holder?.branch === branch) return { outcome: 'ours', holder: cur.holder, slot };
      const [first] = open;
      if (first) return first;
      // Every slot is live and someone else's, or busy with main: watch the live lock that frees soonest (a lapsed
      // one main is still to land on has no expiry left to wake at — it waits a poll).
      last = null;
      for (const { slot, cur } of reads)
        if (
          cur?.holder &&
          !isExpired(cur.holder, now) &&
          (!last || cur.holder.expiresAt < last.holder.expiresAt)
        )
          last = { slot, holder: cur.holder };
      if (last && (last.holder.expiresAt !== loggedExpiry || now - loggedAt >= LOG_EVERY_MS)) {
        log(
          `waiting: ${holderLine(last.holder, now, o.sessionOf?.(last.holder.branch), last.slot)}`,
        );
        loggedExpiry = last.holder.expiresAt;
        loggedAt = now;
      }
    }
    if (now >= deadline)
      return {
        outcome: 'gave-up',
        holder: last?.holder ?? null,
        slot: last?.slot ?? heldBack[0] ?? slots[0] ?? 'dev',
        ...(!last && heldBack.length ? { main: true } : {}),
      };
    // Wake at the holder's expiry only after a good read; after a failed one, a full poll (a GitHub blip at the
    // expiry must not burn the three tries in three seconds).
    const untilExpiry = reads && last ? Date.parse(last.holder.expiresAt) - now + 1000 : pollMs;
    await clock.sleep(Math.max(0, Math.min(pollMs, untilExpiry, deadline - now)));
  }
}

// The installation token is minted once per command and lives an hour, so a wait stops short of that.
export const MAX_WAIT_MIN = 55;
export function parseWaitMax(v: string | undefined): number {
  const min = v === undefined ? 45 : Number(v);
  if (!(min > 0 && min <= MAX_WAIT_MIN))
    throw new Error(`--max is minutes, at most ${MAX_WAIT_MIN} (the bot token lives an hour)`);
  return min * 60_000;
}

// The two messages a queued session sends at once, once each (docs/ops/HUB.md → Lock etiquette): the hub always,
// the holder only when the board names its live session. Printed with the foreground refusal (LockHeld).
// `held` is every slot that refused: one hub note naming them all, and one note per holder the board can name.
export function queueNotes(
  branch: string,
  held: { slot: Slot; holder: Holder }[],
  hub?: string,
  sessionOf: (branch: string) => string | undefined = () => undefined,
  next?: string, // the wait to name, when the refusal knows better than `held` (MainPending: a slot main holds up)
  main: Slot[] = [], // slots main's Deploy run is still to land on (MainPending): queued behind it too
): string[] {
  const mainOnly = main.filter((m) => !held.some((h) => h.slot === m));
  const many = held.length + mainOnly.length > 1;
  const who = [
    ...held.map(({ slot, holder }) => {
      const s = sessionOf(holder.branch);
      return `${holder.branch}${s ? ` (${s})` : ''}${many || slot !== 'dev' ? ` on ${slot}` : ''}${main.includes(slot) ? ", then main's deploy" : ''}`;
    }),
    ...mainOnly.map((slot) => `main's deploy on ${slot}`),
  ].join(' and ');
  const wait =
    next ??
    (held.length > 1
      ? 'lock wait --any'
      : `lock wait${held[0]?.slot === 'devb' ? ' --slot devb' : ''}`);
  return [
    `SendMessage ${hub ?? '<hub — scripts/board/hub.json>'}: "[lock] ${branch} — queued behind ${who}; ${wait} next."`,
    ...held.flatMap(({ slot, holder }) => {
      const s = sessionOf(holder.branch);
      return s
        ? [
            `SendMessage ${s}: "Queued behind you for the ${slot} lock (${branch}) — release at phase 10 rather than letting the TTL run; no rush."`,
          ]
        : [];
    }),
  ];
}
