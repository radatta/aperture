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
  async hasUser(userId: string): Promise<boolean> {
    return (await this.doc.get(PUSH_PK, pushSk.user(userId), { consistent: true })) !== null;
  }
  // Written only if absent. false = it was already there (another device's subscribe won the race).
  async addUser(userId: string, now: number): Promise<boolean> {
    try {
      await this.writes.putIf(
        { PK: PUSH_PK, SK: pushSk.user(userId), userId, createdAt: now },
        null,
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionFailedError) return false;
      throw err;
    }
  }
  async removeUser(userId: string): Promise<void> {
    await this.writes.delete(PUSH_PK, pushSk.user(userId));
  }

  async getPoller(): Promise<PushPollerRow | null> {
    const it = await this.doc.get(PUSH_PK, pushSk.health());
    return it ? toEntity<PushPollerRow>(it) : null;
  }
  // The poller is its only writer (one tick at a time: timeout < rate, prod reserves one), so a plain put.
  async putPoller(row: PushPollerRow): Promise<void> {
    await this.writes.put({ PK: PUSH_PK, SK: pushSk.health(), ...row });
  }
}
