import type { DocClient } from './DocClient';
import { ConditionFailedError } from './DocClient';
import type { Writes } from './writes';
import { PUSH_PK, pushSk } from './keys';
import { toEntity } from './mapping';

// The reminder poller's partition (keys.ts → `push`), outside every user's, so it isn't on Repo:
//   push / user#<uid>   — this user has at least one device; the poller ticks over these (N ≤ 2)
//   push / health       — the poller's heartbeat and its last stage-wide error (no key, a tick's fault)
// The user rows are derived — written by the BFF on a first subscribe, removed with the last unsubscribe
// or by the poller on finding none — never client-set. Writes go through `writes`.

export interface PushRegistryUser {
  userId: string;
  createdAt: number;
}

export interface PushPollerRow {
  lastRunAt: number | null;
  lastError: string | null; // stage-wide: no VAPID key, a tick that threw — a user's own errors are theirs
  lastErrorAt: number | null;
  updatedAt: number;
}

export class PushRegistry {
  constructor(
    private readonly doc: DocClient,
    private readonly writes: Writes,
  ) {}

  async listUsers(): Promise<PushRegistryUser[]> {
    return (await this.doc.query(PUSH_PK, pushSk.userPrefix())).map((i) =>
      toEntity<PushRegistryUser>(i),
    );
  }
  async getUser(userId: string): Promise<PushRegistryUser | null> {
    const it = await this.doc.get(PUSH_PK, pushSk.user(userId), { consistent: true });
    return it ? toEntity<PushRegistryUser>(it) : null;
  }
  async hasUser(userId: string): Promise<boolean> {
    return (await this.getUser(userId)) !== null;
  }
  // Written only if absent. false = it was already there (another device's subscribe won the race).
  // `createdAt` is when the user's reminders went live: nothing due before it pings (reminders.md → §3).
  async addUser(userId: string, createdAt: number): Promise<boolean> {
    try {
      await this.writes.putIf({ PK: PUSH_PK, SK: pushSk.user(userId), userId, createdAt }, null);
      return true;
    } catch (err) {
      if (err instanceof ConditionFailedError) return false;
      throw err;
    }
  }
  async removeUser(userId: string): Promise<void> {
    await this.writes.delete(PUSH_PK, pushSk.user(userId));
  }
  // The last alive device went: take the user off — then re-read their devices strongly and put the row
  // back (keeping its createdAt) if one is alive. A subscribe writes its device before it checks the
  // registry, so one that saw the row still there and skipped adding it is always seen by this re-read:
  // the user can't drop out for good. true = they stayed (or came back).
  async dropUser(userId: string, hasAlive: () => Promise<boolean>, now: number): Promise<boolean> {
    const had = await this.getUser(userId);
    await this.removeUser(userId);
    if (!(await hasAlive())) return false;
    await this.addUser(userId, had?.createdAt ?? now);
    return true;
  }

  async getPoller(): Promise<PushPollerRow | null> {
    const it = await this.doc.get(PUSH_PK, pushSk.health(), { consistent: true });
    return it ? toEntity<PushPollerRow>(it) : null;
  }
  // The poller is its only writer (one tick at a time: timeout < rate, prod reserves one), so a plain put.
  async putPoller(row: PushPollerRow): Promise<void> {
    await this.writes.put({ PK: PUSH_PK, SK: pushSk.health(), ...row });
  }
}
