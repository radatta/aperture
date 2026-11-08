import { createHash } from 'node:crypto';
import {
  PUSH_DEVICE_ID_LEN,
  PUSH_NO_DEVICE_ERROR,
  PUSH_UNCONFIGURED_ERROR,
  PUSH_UNKNOWN_DEVICE_ERROR,
  parsePushInput,
  planFireAt,
  REMINDER_WINDOW_MS,
  taskFireAt,
  userDueEpoch,
} from '@aperture/shared';
import type { PushDevice, PushStatus, PushSub, SubscribePushInput } from '@aperture/shared';
import type { Repo } from '../ddb/repo';
import type { PushRegistry } from '../ddb/pushRegistry';
import { noPublicKey } from './publicKey';
import type { PublicKeyReader } from './publicKey';
import { mapLimit } from '../util/mapLimit';

export interface PushServiceDeps {
  repo: Repo;
  userId: string;
  now: () => number;
  ulid: () => string;
  registry?: PushRegistry; // the reminder poller's user list + heartbeat (outside the user partition)
  publicKey?: PublicKeyReader; // the stage's VAPID public key (SSM); none → reminders unconfigured
}

// No registry configured: only the reminder methods touch it, so they fail loudly rather than skip.
const noPushRegistry = (): never => {
  throw new Error('Reminders unavailable: no push registry configured.');
};
const unconfiguredPushRegistry = {
  listUsers: noPushRegistry,
  hasUser: noPushRegistry,
  addUser: noPushRegistry,
  removeUser: noPushRegistry,
  dropUser: noPushRegistry,
  getUser: noPushRegistry,
  getPoller: noPushRegistry,
  putPoller: noPushRegistry,
} as unknown as PushRegistry;
// The device id: a sha256(endpoint) prefix, so re-subscribing the same endpoint is an upsert.
const pushDeviceId = (endpoint: string): string =>
  createHash('sha256').update(endpoint).digest('hex').slice(0, PUSH_DEVICE_ID_LEN);
// What Settings sees of a device — never its endpoint or keys.
const deviceOf = (s: PushSub): PushDevice => ({
  id: s.id,
  label: s.label,
  createdAt: s.createdAt,
  lastOkAt: s.lastOkAt ?? null,
  lastError: s.lastError ?? null,
  lastErrorAt: s.lastErrorAt ?? null,
});
// A fire time the zone math can't compute (a malformed legacy deadline) is none.
const fireAtOrNull = (at: () => number | null): number | null => {
  try {
    return at();
  } catch {
    return null;
  }
};

// The reminders half of the BackendClient (reminders.md) — the SAME behaviour as the stub (the shared
// contract suite runs both), over the Repo and the push registry. The BFF never sends: it stores devices and
// queues Send-test candidates; the push-dispatch poller is the only sender and the only holder of the private
// key. Every write goes through the repo / registry `writes`; a device's endpoint and keys never leave
// (deviceOf). Its own module so timed-reminders' slow poller chain gates on push/**, not backend.ts.
export class PushService {
  private readonly pushRegistry: PushRegistry;
  private readonly pushPublicKey: PublicKeyReader;
  // The Lambda's clock is UTC — a task's wall-clock deadline is resolved in the user's zone, never locally.
  private readonly dueEpoch = userDueEpoch;

  constructor(private readonly d: PushServiceDeps) {
    this.pushRegistry = d.registry ?? unconfiguredPushRegistry;
    this.pushPublicKey = d.publicKey ?? noPublicKey;
  }

  private get repo(): Repo {
    return this.d.repo;
  }
  private get userId(): string {
    return this.d.userId;
  }
  private now(): number {
    return this.d.now();
  }
  private ulid(): string {
    return this.d.ulid();
  }

  // Upsert by endpoint. Refuses an endpoint off PUSH_ENDPOINT_HOSTS (the one SSRF gate — the poller POSTs
  // only to stored endpoints) and a stage with no VAPID key; parsePushInput (shared with the stub) checks
  // the shape. A re-subscribe keeps createdAt / lastOkAt, and the device's last error unless the endpoint
  // or keys changed (a new subscription) — the same keys re-sent can't have fixed it. On a removed
  // device's tombstone it revives it (same id, off removedDeviceIds, error cleared). The first device puts the user in the poller's
  // registry — after re-keying their live deadlines and plans onto the remind index (rows written before
  // it existed have no keys), so a failure there fails the call and the next subscribe retries it.
  async subscribePush(input: SubscribePushInput): Promise<PushDevice> {
    const {
      endpoint,
      keys: { p256dh, auth },
      label,
    } = parsePushInput(input);
    if (!(await this.pushPublicKey())) throw new Error(PUSH_UNCONFIGURED_ERROR);
    const now = this.now();
    const id = pushDeviceId(endpoint);
    const prev = await this.repo.getPushSub(id);
    const same =
      !!prev &&
      prev.deletedAt === null &&
      prev.endpoint === endpoint &&
      prev.p256dh === p256dh &&
      prev.auth === auth;
    const sub: PushSub = {
      id,
      userId: this.userId,
      createdAt: prev?.createdAt ?? now,
      updatedAt: prev ? Math.max(now, prev.updatedAt + 1) : now,
      deletedAt: null,
      endpoint,
      p256dh,
      auth,
      label,
      lastOkAt: prev?.lastOkAt ?? null,
      lastError: same ? (prev?.lastError ?? null) : null,
      lastErrorAt: same ? (prev?.lastErrorAt ?? null) : null,
    };
    await this.repo.putPushSub(sub);
    await this.ensurePushUser(now);
    return deviceOf(sub);
  }
  // Removes the caller's device only (its own partition). Removal sticks: the row stays as a tombstone, so
  // the device's own launch-time resync sees it in removedDeviceIds and stops instead of re-adding itself —
  // with its endpoint and keys cleared (a revive re-sends them), so a tombstone holds no credential. An
  // unknown or already-removed id is a no-op. The last alive device out takes the user off the registry.
  async unsubscribePush(id: string): Promise<void> {
    if (typeof id !== 'string' || id === '') throw new Error(PUSH_UNKNOWN_DEVICE_ERROR);
    const prev = await this.repo.getPushSub(id);
    if (!prev || prev.deletedAt !== null) return;
    const now = this.now();
    await this.repo.putPushSub({
      ...prev,
      endpoint: '',
      p256dh: '',
      auth: '',
      deletedAt: now,
      updatedAt: Math.max(now, prev.updatedAt + 1),
    });
    const alive = async () => (await this.repo.listPushSubs({ consistent: true })).length > 0;
    // dropUser re-reads after its delete, so a subscribe on another device racing this one stays registered.
    if (!(await alive())) await this.pushRegistry.dropUser(this.userId, alive, now);
  }
  // Health in three signals (D6): this user's devices, the poller's heartbeat (stage-wide), and the last
  // send / error — the stage's current error when there is one, else this user's last.
  async getPushStatus(): Promise<PushStatus> {
    const [key, rows, poller, mine] = await Promise.all([
      this.pushPublicKey(),
      // Consistent: the self-heal below decides on it, and a device a moment old must count.
      this.repo.listAllPushSubs({ consistent: true }),
      this.pushRegistry.getPoller(),
      this.repo.getPushUserHealth(),
    ]);
    const stageError = poller?.lastError ?? null;
    // Cheap self-heal: a user with a live device must be on the poller's registry (one consistent read).
    if (rows.some((r) => r.deletedAt === null)) await this.ensurePushUser(this.now());
    return {
      configured: key !== null,
      vapidPublicKey: key,
      devices: rows
        .filter((r) => r.deletedAt === null)
        .map(deviceOf)
        .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1)),
      removedDeviceIds: rows
        .filter((r) => r.deletedAt !== null)
        .map((r) => r.id)
        .sort(),
      poller: {
        lastRunAt: poller?.lastRunAt ?? null,
        lastSentAt: mine?.lastSentAt ?? null, // a push service last ACCEPTED one (a refusal is an error)
        lastError: stageError ?? mine?.lastError ?? null,
        lastErrorAt: stageError ? (poller?.lastErrorAt ?? null) : (mine?.lastErrorAt ?? null),
      },
    };
  }
  // Queues a test on the remind index at now; the poller's next tick sends it like any reminder, so it
  // proves the whole chain (schedule → poller → key → push service → device).
  async sendTestPush(): Promise<void> {
    if ((await this.repo.listPushSubs({ consistent: true })).length === 0)
      throw new Error(PUSH_NO_DEVICE_ERROR);
    if (!(await this.pushPublicKey())) throw new Error(PUSH_UNCONFIGURED_ERROR);
    const now = this.now();
    await this.ensurePushUser(now); // heals a registry row a subscribe/remove race dropped
    await this.clearPushTests(); // one test queued at a time: a newer Send test replaces an unsent one
    await this.repo.putPushTest({ id: this.ulid(), createdAt: now });
  }
  // A user going live again starts with no queued test: one left unsent (the poller ticks only registered
  // users) must not fire on a later re-enable.
  private async ensurePushUser(now: number): Promise<void> {
    if (await this.pushRegistry.hasUser(this.userId)) return;
    await this.backfillReminders(now);
    await this.clearPushTests();
    await this.pushRegistry.addUser(this.userId, now);
  }
  private async clearPushTests(): Promise<void> {
    for (const t of await this.repo.listPushTests({ consistent: true }))
      await this.repo.deletePushTest(t.id);
  }
  // Re-key every alive task and plan that can still fire (from the window's start on) onto the remind
  // index, each conditional on the version read (Repo.rekey — a write since already keyed it), armed now: what
  // fell due before this backfill stays quiet. Idempotent. Consistent: a task written a moment ago counts.
  private async backfillReminders(now: number): Promise<void> {
    const from = now - REMINDER_WINDOW_MS;
    const live = (at: number | null) => at !== null && at >= from;
    const tasks = (await this.repo.listTasks({ consistent: true })).filter((t) =>
      live(fireAtOrNull(() => taskFireAt(t, this.dueEpoch))),
    );
    const plans = (await this.repo.listAllPlans({ consistent: true })).filter((p) =>
      live(fireAtOrNull(() => planFireAt(p, this.dueEpoch))),
    );
    await mapLimit(tasks, 8, (t) => this.repo.rekeyTask(t, now));
    await mapLimit(plans, 8, (p) => this.repo.rekeyPlan(p, now));
  }
}
