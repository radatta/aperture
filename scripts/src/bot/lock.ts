// The dev lock: one feature branch on the dev stack at a time, across every session and machine.
// `refs/locks/dev` → an annotated tag whose message is the holder JSON. Creating a ref that exists is a 422
// (probed 2026-10-13), so creation is the atomic acquire. Expiry lives in the message: a crashed holder frees
// the lock after TTL. Holder = branch (one session per branch). docs/ops/CI-BOT.md → Dev lock.
import type { Api } from './api.ts';
import { GitHubError } from './api.ts';
import { OWNER, REPO } from './config.ts';

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

// Acquire (or, if this branch already holds it, renew). Throws when another live holder has it.
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
    if (!isExpired(cur.holder, nowMs))
      throw new Error(`dev is locked by ${describe(cur.holder)} — wait, or ask the user`);
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

export async function status(api: Api, nowMs: number): Promise<string> {
  const cur = await readLock(api);
  if (!cur) return 'dev lock: free';
  return `dev lock: ${describe(cur.holder)}${isExpired(cur.holder, nowMs) ? ' (EXPIRED — the next acquire takes it over)' : ''}`;
}
