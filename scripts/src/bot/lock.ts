// The dev lock: one feature branch on the dev stack at a time, across every session and machine.
// `refs/locks/dev` → an annotated tag whose message is the holder JSON. Creating a ref that exists is a 422
// (probed 2026-10-13), so creation is the atomic acquire. Expiry lives in the message: a crashed holder frees
// the lock after TTL. Holder = branch (one session per branch). docs/ops/CI-BOT.md → Dev lock.
import type { Api } from './api.ts';
import { GitHubError } from './api.ts';
import { OWNER, REPO } from './config.ts';
import type { Clock } from './dispatch.ts';

export const LOCK_REF = 'locks/dev';
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

export async function readLock(api: Api): Promise<LockState | null> {
  let ref: { object: { sha: string; type: string } };
  try {
    ref = await api('GET', `${R}/git/ref/${LOCK_REF}`);
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

async function makeTag(api: Api, holder: Holder): Promise<string> {
  const tag = await api<{ sha: string }>('POST', `${R}/git/tags`, {
    tag: LOCK_REF,
    message: JSON.stringify(holder),
    object: holder.sha,
    type: 'commit',
  });
  return tag.sha;
}

const describe = (h: Holder | null) =>
  h ? `${h.branch} @ ${h.sha.slice(0, 7)} until ${h.expiresAt}` : 'an unreadable holder';

// Another live branch holds the lock. Typed, so the CLI can print who to tell before the error line.
export class LockHeld extends Error {
  readonly holder: Holder | null;
  constructor(holder: Holder | null) {
    super(
      `dev is locked by ${describe(holder)} — \`pnpm bot lock wait\` (in the background) wakes you when it frees`,
    );
    this.holder = holder;
  }
}

// Acquire (or, if this branch already holds it, renew). Throws LockHeld when another live holder has it.
export async function acquire(
  api: Api,
  branch: string,
  sha: string,
  nowMs: number,
): Promise<Holder> {
  const holder: Holder = { branch, sha, expiresAt: new Date(nowMs + TTL_MS).toISOString() };
  const tagSha = await makeTag(api, holder);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await api('POST', `${R}/git/refs`, { ref: `refs/${LOCK_REF}`, sha: tagSha });
      return holder;
    } catch (err) {
      if (!(err instanceof GitHubError && err.status === 422)) throw err;
    }
    const cur = await readLock(api);
    if (!cur) continue; // released between our create and read — try again
    if (cur.holder?.branch === branch) {
      await api('PATCH', `${R}/git/refs/${LOCK_REF}`, { sha: tagSha, force: true });
      return holder;
    }
    if (!isExpired(cur.holder, nowMs)) throw new LockHeld(cur.holder);
    // Expired: delete only if it still points at the tag we judged expired (narrows the take-over race).
    const again = await readLock(api);
    if (again && again.tagSha === cur.tagSha) {
      // Gone already (another session's take-over deleted it first) is fine — the next create decides.
      await api('DELETE', `${R}/git/refs/${LOCK_REF}`).catch((err: unknown) => {
        if (!(err instanceof GitHubError && (err.status === 404 || err.status === 422))) throw err;
      });
    }
  }
  throw new Error(
    'lost the race for the dev lock — another session took it; check `pnpm bot lock status`',
  );
}

// renew and release are read-then-write too (PATCH force / DELETE): a take-over landing between the read and
// the write is clobbered. Same window and same backstop as acquire's take-over race (CI-BOT.md → Dev lock).
export async function renew(api: Api, branch: string, nowMs: number): Promise<Holder> {
  const cur = await readLock(api);
  if (!cur || cur.holder?.branch !== branch)
    throw new Error(
      `${branch} does not hold the dev lock (holder: ${cur ? describe(cur.holder) : 'none'})`,
    );
  const holder: Holder = { ...cur.holder, expiresAt: new Date(nowMs + TTL_MS).toISOString() };
  await api('PATCH', `${R}/git/refs/${LOCK_REF}`, { sha: await makeTag(api, holder), force: true });
  return holder;
}

// Holder-only: a session never frees another branch's lock (an expired one is taken over by acquire instead).
export async function release(api: Api, branch: string): Promise<boolean> {
  const cur = await readLock(api);
  if (!cur) return false;
  if (cur.holder?.branch !== branch)
    throw new Error(`${branch} does not hold the dev lock (holder: ${describe(cur.holder)})`);
  await api('DELETE', `${R}/git/refs/${LOCK_REF}`);
  return true;
}

export const formatStatus = (cur: LockState | null, nowMs: number) =>
  !cur
    ? 'dev lock: free'
    : `dev lock: ${describe(cur.holder)}${isExpired(cur.holder, nowMs) ? ' (EXPIRED — the next acquire takes it over)' : ''}`;

export const status = async (api: Api, nowMs: number) => formatStatus(await readLock(api), nowMs);

// --- lock wait: block until another branch's lock frees, expires or the cap passes (CI-BOT.md → Dev lock) ---

export type WaitOutcome = 'free' | 'expired' | 'ours' | 'gave-up';
export interface WaitOptions {
  maxMs: number;
  pollMs?: number;
  log?: (s: string) => void;
  sessionOf?: (branch: string) => string | undefined; // the holder's board session, for the log line
  onRead?: (cur: LockState | null) => void; // every successful read (the board's lock cache)
}

export const POLL_MS = 30_000;
const LOG_EVERY_MS = 5 * 60_000;
const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

export function holderLine(h: Holder, nowMs: number, session?: string): string {
  const min = Math.max(0, Math.ceil((Date.parse(h.expiresAt) - nowMs) / 60_000));
  return `dev locked by ${h.branch} @ ${h.sha.slice(0, 7)} until ${hhmm(h.expiresAt)} (${min} min)${session ? ` — session ${session}` : ''}`;
}

// Polls every 30 s, and wakes at the holder's expiry when that comes sooner. Read-only: taking the lock is still
// `deploy-dev`'s acquire. A failed read waits a full poll before the next; three in a row throw (exit 1).
export async function waitForLock(
  api: Api,
  branch: string,
  clock: Clock,
  o: WaitOptions,
): Promise<{ outcome: WaitOutcome; holder: Holder | null }> {
  const pollMs = o.pollMs ?? POLL_MS;
  const log = o.log ?? (() => undefined);
  const deadline = clock.now() + o.maxMs;
  let errors = 0;
  let last: Holder | null = null;
  let loggedExpiry = '';
  let loggedAt = -Infinity;
  for (;;) {
    let cur: LockState | null | undefined;
    try {
      cur = await readLock(api);
      errors = 0;
    } catch (err) {
      if (++errors >= 3) throw err;
      log(`lock read failed (${(err as Error).message}) — retrying`);
    }
    if (cur !== undefined) o.onRead?.(cur);
    const now = clock.now();
    if (cur !== undefined) {
      if (!cur) return { outcome: 'free', holder: null };
      if (cur.holder?.branch === branch) return { outcome: 'ours', holder: cur.holder };
      if (isExpired(cur.holder, now)) return { outcome: 'expired', holder: cur.holder };
      last = cur.holder;
      if (last && (last.expiresAt !== loggedExpiry || now - loggedAt >= LOG_EVERY_MS)) {
        log(`waiting: ${holderLine(last, now, o.sessionOf?.(last.branch))}`);
        loggedExpiry = last.expiresAt;
        loggedAt = now;
      }
    }
    if (now >= deadline) return { outcome: 'gave-up', holder: last };
    // Wake at the holder's expiry only after a good read; after a failed one, a full poll (a GitHub blip at the
    // expiry must not burn the three tries in three seconds).
    const untilExpiry =
      cur !== undefined && last ? Date.parse(last.expiresAt) - now + 1000 : pollMs;
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
export function queueNotes(branch: string, h: Holder, hub?: string, session?: string): string[] {
  const who = session ? `${h.branch} (${session})` : h.branch;
  return [
    `SendMessage ${hub ?? '<hub — scripts/board/hub.json>'}: "[lock] ${branch} — queued behind ${who}; lock wait running."`,
    ...(session
      ? [
          `SendMessage ${session}: "Queued behind you for the dev lock (${branch}) — release at phase 10 rather than letting the TTL run; no rush."`,
        ]
      : []),
  ];
}
