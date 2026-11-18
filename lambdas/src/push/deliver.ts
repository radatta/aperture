import {
  catchUpPayload,
  catchUpTag,
  dayKeyInZone,
  isRitual,
  planFireAt,
  PUSH_DAILY_GUARD,
  PUSH_TITLE_MAX,
  PUSH_TTL_S,
  reminderPayload,
  taskFireAt,
  USER_TIME_ZONE,
  userDueEpoch,
} from '@aperture/shared';
import type { PushSub, ReminderCandidate, TaskPlan } from '@aperture/shared';
import type { PushMissRow, PushRetryRow, Repo } from '../ddb/repo';
import type { PushGateway, PushResult } from './gateway';

// Delivery for one user's tick (reminders.md → §3 _Retry and catch-up_): one POST per device, the push
// service's answer classified, and what happens next. A transient answer (a timeout, a network failure,
// 429 or a 5xx gateway or server fault — U1 in the branch's unknowns) leaves a retry row, tried again on
// the next RETRY_MAX ticks under the same Topic, so a first copy the service took but never answered for
// is replaced while still undelivered (RFC 8030 §5.4). Retries are the same notification: no guard unit,
// no new dedup row. Retries that run out leave the reminders as misses, sent once as "N reminders didn't
// reach you" after CATCH_UP_SETTLE_MS; a poller gap leaves misses too (dispatch.ts). A catch-up is tried
// once. A run-out and a failed catch-up stay on the device's error and the health line (Settings ›
// Notifications); a catch-up that lands clears the device's error like any delivery.

export const RETRY_MAX = 3; // retries after the first try, one per tick
export const RETRY_EXPIRE_MS = 5 * 60_000; // a retry older than this (the poller stalled) runs out untried
export const CATCH_UP_SETTLE_MS = 5 * 60_000; // a run-out retry waits this long before its catch-up
export const MISS_KEEP_MS = 12 * 3600_000; // a miss older than this is dropped, never caught up

export type Outcome = 'ok' | 'gone' | 'retry' | 'final';
type SendResult = PushResult | { status: 0; reason: 'error'; name: string };

// RFC 8030 + Apple + FCM (U1–U2): 404/410 the subscription is gone; 429 and 500/503 are the service's to
// retry later; 502/504 are a gateway's fault of the same kind (inference, U1); a timeout or a network
// failure may never have reached it. Anything else (400, 403, 413, a fault of ours) won't change on a retry.
const TRANSIENT = new Set([429, 500, 502, 503, 504]);
export function outcomeOf(res: SendResult): Outcome {
  if (res.status >= 200 && res.status < 300) return 'ok';
  if (res.status === 404 || res.status === 410 || res.reason === 'keys') return 'gone';
  if (res.status === 0)
    return res.reason === 'timeout' || res.reason === 'network' ? 'retry' : 'final';
  return TRANSIENT.has(res.status) ? 'retry' : 'final';
}

export const whyFailed = (res: { status: number; reason?: string; name?: string }): string =>
  res.status > 0
    ? `push service answered ${res.status}`
    : res.reason === 'timeout'
      ? 'timed out'
      : res.reason === 'keys'
        ? 'its keys are invalid'
        : res.reason === 'error'
          ? `couldn't send: ${res.name ?? 'unknown'}`
          : 'network error';

export const guardMessage = (limit: number): string =>
  `Daily reminder limit (${limit}) reached — the rest of today's were held back`;

const subRef = (s: Pick<PushSub, 'id'>) => s.id.slice(0, 6); // a log line names a device by this only
const errName = (err: unknown) => (err instanceof Error ? err.name : 'unknown');
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const clipTitle = (t: string) => Array.from(t).slice(0, PUSH_TITLE_MAX).join('');

// A candidate as a retry or a miss stores it: no Send-test row id (that row is gone once handled), and
// the title clipped as the notification clips it (a retry re-reads it anyway), so a long one can't push
// a row past DynamoDB's item limit.
export type StoredCandidate = ReminderCandidate & { key: string };
const stored = ({ kind, fireAt, taskId, title, dueTime, body, key }: StoredCandidate) => ({
  kind,
  fireAt,
  taskId,
  title: clipTitle(title),
  dueTime,
  ...(body !== undefined ? { body } : {}),
  key,
});
// A ritual or a test is never "missed": a late nudge is noise, a test is asked for now.
export const missable = (c: Pick<ReminderCandidate, 'kind'>) =>
  c.kind !== 'test' && !isRitual(c.kind);

export interface DelivererDeps {
  repo: Repo;
  push: PushGateway;
  appUrl: string;
  now: number;
  past: () => boolean;
  log: (line: string) => void;
}

export interface DeliveryTally {
  delivered: number;
  failed: number;
  retried: number; // retry POSTs made
  caughtUp: number; // catch-up notifications sent
  deadline: boolean;
}

// How a POST's transient refusal is worded: it will be retried ('retrying'); it was the last try and the
// run-out says it ('last' — no stamp of its own); or it's final (null: a catch-up).
type Pending = 'retrying' | 'last' | null;

// One user's sends in one tick. Holds the devices as last written, so a second send to a device in the
// same tick stamps on the version the first one wrote.
export class Deliverer {
  readonly fails: string[] = []; // this tick's failures, every one: a batch two devices refuse names both
  readonly tally: DeliveryTally = {
    delivered: 0,
    failed: 0,
    retried: 0,
    caughtUp: 0,
    deadline: false,
  };
  sentAt: number | null = null; // when a push service last accepted one this tick (Settings' "last sent")
  removed = 0; // devices dropped after a 404/410
  attempted = false; // anything sent, held back or failed: the health line gets written
  private readonly subs: Map<string, PushSub>;
  // Retries still to come (`<subId>#<topic>`): their device's catch-up waits for them, and a fresh batch
  // goes to their (slow) device last.
  private readonly pending = new Set<string>();
  private readonly queued: PushMissRow[] = []; // misses this tick wrote (a run-out, a gap)
  // Devices that refused or timed out lately (a retry row with a try spent): sent to, and retried, last.
  private readonly slow = new Set<string>();

  constructor(
    private readonly d: DelivererDeps,
    subs: readonly PushSub[],
    retries: readonly PushRetryRow[],
  ) {
    this.subs = new Map(subs.map((s) => [s.id, s]));
    for (const r of retries) {
      this.pending.add(`${r.subId}#${r.topic}`);
      if (r.tries >= 1) this.slow.add(r.subId);
    }
  }

  subIds = (): string[] => [...this.subs.keys()];
  fail = (message: string): void => {
    this.attempted = true;
    if (!this.fails.includes(message)) this.fails.push(message);
  };
  private hasPending = (subId: string) => [...this.pending].some((k) => k.startsWith(`${subId}#`));
  private slowFirst = (subId: string) => Number(this.slow.has(subId)); // sorts slow devices last

  // A fresh notification to every device, the slow ones (a try spent on a retry still pending) last, so
  // one that times out again doesn't use up the tick before the rest. A transient refusal, or a device the
  // tick's deadline skipped, leaves a retry row.
  async sendBatch(cands: readonly StoredCandidate[], topic: string): Promise<void> {
    this.attempted = true;
    const payload = JSON.stringify(reminderPayload(cands, this.d.appUrl, topic));
    const order = [...this.subs.values()].sort(
      (a, b) => this.slowFirst(a.id) - this.slowFirst(b.id),
    );
    for (const sub of order) {
      if (this.d.past()) {
        this.tally.deadline = true;
        this.fail('A reminder check ran out of time before reaching every device');
        this.d.log(JSON.stringify({ event: 'push_deadline', sub: subRef(sub) }));
        await this.queueRetry(sub, cands, topic, 0, 'ran out of time');
        continue;
      }
      const { outcome, why } = await this.post(sub, payload, topic, cands, 'retrying');
      if (outcome === 'retry') await this.queueRetry(sub, cands, topic, 1, why);
    }
  }

  // Earlier ticks' retries: a slow device's last (every row of it), then the least-tried, then oldest — a
  // device the deadline skipped goes before the one that timed out. A claim (the try counted on the version read) comes before the POST, so a
  // crash spends that try instead of risking a second one.
  async runRetries(rows: readonly PushRetryRow[]): Promise<void> {
    const order = [...rows].sort(
      (a, b) =>
        this.slowFirst(a.subId) - this.slowFirst(b.subId) ||
        a.tries - b.tries ||
        a.firstAt - b.firstAt,
    );
    for (const row of order) {
      if (this.d.past()) return void (this.tally.deadline = true); // untried rows wait a tick
      const sub = this.subs.get(row.subId);
      if (!sub) {
        await this.dropRetry(row);
        continue;
      }
      if (row.retries >= RETRY_MAX || this.d.now - row.firstAt > RETRY_EXPIRE_MS) {
        await this.runOut(sub, row);
        continue;
      }
      const claimed: PushRetryRow = {
        ...row,
        retries: row.retries + 1,
        tries: row.tries + 1,
        updatedAt: Math.max(this.d.now, row.updatedAt + 1),
      };
      if (!(await this.d.repo.putPushRetryIf(claimed, row.updatedAt))) continue;
      const cands = await this.stillDue(row.cands);
      if (cands.length === 0) {
        await this.dropRetry(row);
        continue;
      }
      this.attempted = true;
      this.tally.retried++;
      const payload = JSON.stringify(reminderPayload(cands, this.d.appUrl, row.topic));
      const last = claimed.retries >= RETRY_MAX;
      const { outcome, why } = await this.post(
        sub,
        payload,
        row.topic,
        cands,
        last ? 'last' : 'retrying',
      );
      if (outcome !== 'retry') await this.dropRetry(row);
      else if (last) await this.runOut(this.subs.get(sub.id) ?? sub, { ...claimed, cands, why });
      else
        await this.d.repo.putPushRetryIf(
          { ...claimed, cands: cands.map(stored), why, updatedAt: claimed.updatedAt + 1 },
          claimed.updatedAt,
        );
    }
  }

  // Each device's misses go out as one catch-up once they've all settled and no retry is still pending
  // for it. The rows are claimed (deleted on the version read) before the guard and the send: a catch-up
  // the daily guard refuses is dropped, said on the health line — fail-closed, as a reminder past the
  // guard is. Tried once; each device's catch-up is its own notification against the guard.
  // `rows` are the misses as the tick read them; the ones this tick wrote join them, so a run-out this
  // tick holds its device's catch-up until it too has settled.
  async runCatchUps(
    rows: readonly PushMissRow[],
    takeGuard: () => Promise<boolean>,
  ): Promise<void> {
    const bySub = new Map<string, PushMissRow[]>();
    for (const r of [...rows, ...this.queued])
      bySub.set(r.subId, [...(bySub.get(r.subId) ?? []), r]);
    for (const [subId, misses] of bySub) {
      if (this.d.past()) return void (this.tally.deadline = true);
      const sub = this.subs.get(subId);
      if (!sub || this.hasPending(subId) || misses.some((m) => m.readyAt > this.d.now)) continue;
      const claimed: PushMissRow[] = [];
      for (const m of misses) if (await this.d.repo.deletePushMissIf(m)) claimed.push(m);
      const cands = await this.stillDue(claimed.map((m) => m.cand));
      if (cands.length === 0) continue;
      this.attempted = true;
      if (!(await takeGuard())) {
        this.fail(guardMessage(PUSH_DAILY_GUARD));
        this.d.log(JSON.stringify({ event: 'push_guard_tripped', catchUp: true }));
        continue;
      }
      this.tally.caughtUp++;
      const topic = catchUpTag(this.d.now);
      const payload = JSON.stringify(catchUpPayload(cands, this.d.appUrl, this.d.now));
      const n = plural(cands.length, 'missed reminder');
      await this.post(sub, payload, topic, cands, null, `Couldn't deliver the catch-up for ${n}`);
    }
  }

  // A miss per device per reminder, ready for its catch-up at `readyAt`.
  async queueMisses(
    subIds: readonly string[],
    cands: readonly StoredCandidate[],
    readyAt: number,
  ): Promise<void> {
    for (const subId of subIds)
      for (const c of cands.filter(missable)) {
        const row = { subId, cand: stored(c), readyAt, updatedAt: this.d.now };
        await this.d.repo.putPushMiss(row);
        this.queued.push(row);
      }
  }

  // One POST, its log line, and the device's stamp: delivered, dropped (gone), or its error. `lead`
  // replaces the error's opening (a catch-up's).
  private async post(
    sub: PushSub,
    payload: string,
    topic: string,
    cands: readonly ReminderCandidate[],
    pending: Pending,
    lead = "Last reminder didn't reach this device",
  ): Promise<{ outcome: Outcome; why: string }> {
    const tasks = cands.flatMap((c) => (c.taskId ? [c.taskId] : []));
    let res: SendResult;
    try {
      res = await this.d.push.send(sub, payload, {
        topic,
        ttlSeconds: PUSH_TTL_S,
        urgency: 'high',
      });
    } catch (err) {
      res = { status: 0, reason: 'error', name: errName(err) };
    }
    const outcome = outcomeOf(res);
    const why = whyFailed(res);
    const line = {
      event: outcome === 'ok' ? 'push_sent' : 'push_failed',
      status: res.status,
      reason: res.reason,
      ...('name' in res ? { name: res.name } : {}),
      sub: subRef(sub),
      tasks,
      ...(outcome === 'retry' && pending === 'retrying' ? { retry: true } : {}),
    };
    const updatedAt = Math.max(this.d.now, sub.updatedAt + 1);
    if (outcome === 'ok') {
      this.d.log(JSON.stringify(line));
      this.tally.delivered++;
      this.sentAt = this.d.now;
      await this.stamp(
        { ...sub, updatedAt, lastOkAt: this.d.now, lastError: null, lastErrorAt: null },
        sub,
      );
      return { outcome, why };
    }
    this.tally.failed++;
    if (outcome === 'gone') {
      // The push service says this subscription is dead (or its keys never could work): drop it — the
      // row as read only, so a removal (tombstone) or a revive that landed meanwhile stands. The app
      // re-subscribes on its next launch (D7).
      const deleted = await this.d.repo.deletePushSubIf(sub.id, sub.updatedAt);
      this.d.log(JSON.stringify({ ...line, ...(deleted ? { removed: true } : { changed: true }) }));
      if (deleted) {
        this.removed++;
        this.subs.delete(sub.id);
      } else {
        // A revive keeps its device (and its queued rows); a removal doesn't.
        const now = await this.d.repo.getPushSub(sub.id);
        if (now && now.deletedAt === null) this.subs.set(sub.id, now);
        else this.subs.delete(sub.id);
      }
      this.fail(
        `${sub.label} stopped accepting reminders (${why}) — turn them on again on that device`,
      );
      return { outcome, why };
    }
    this.d.log(JSON.stringify(line));
    if (outcome === 'retry' && pending === 'last') return { outcome, why }; // runOut says it
    const message = `${lead} (${why})${outcome === 'retry' && pending === 'retrying' ? ' — retrying' : ''}`;
    await this.stamp({ ...sub, updatedAt, lastError: message, lastErrorAt: this.d.now }, sub);
    this.fail(`${sub.label}: ${message}`);
    return { outcome, why };
  }

  // Retries ran out (or the poller stalled past RETRY_EXPIRE_MS): the device says so, and its reminders
  // wait as misses for the catch-up.
  private async runOut(sub: PushSub, row: PushRetryRow): Promise<void> {
    await this.dropRetry(row);
    const tries = plural(row.tries, 'try', 'tries');
    const message = `Last reminder didn't reach this device (${row.why}) after ${tries}`;
    const updatedAt = Math.max(this.d.now, sub.updatedAt + 1);
    await this.stamp({ ...sub, updatedAt, lastError: message, lastErrorAt: this.d.now }, sub);
    this.fail(`${sub.label}: ${message}`);
    this.d.log(
      JSON.stringify({ event: 'push_retry_exhausted', sub: subRef(sub), tries: row.tries }),
    );
    await this.queueMisses([sub.id], row.cands, this.d.now + CATCH_UP_SETTLE_MS);
  }

  private async queueRetry(
    sub: PushSub,
    cands: readonly StoredCandidate[],
    topic: string,
    tries: number,
    why: string,
  ): Promise<void> {
    await this.d.repo.putPushRetry({
      subId: sub.id,
      topic,
      cands: cands.map(stored),
      tries,
      retries: 0,
      firstAt: this.d.now,
      why,
      updatedAt: this.d.now,
    });
    this.pending.add(`${sub.id}#${topic}`);
    if (tries >= 1) this.slow.add(sub.id);
  }
  private async dropRetry(row: Pick<PushRetryRow, 'subId' | 'topic'>): Promise<void> {
    await this.d.repo.deletePushRetry(row.subId, row.topic);
    this.pending.delete(`${row.subId}#${row.topic}`);
  }

  // Re-read before a retry or a catch-up: a task finished, deleted or re-dated since stays quiet, and so
  // does one taken off that day's plan; its title is the current one. Rituals and tests stand as stored.
  private async stillDue(cands: readonly StoredCandidate[]): Promise<StoredCandidate[]> {
    const out: StoredCandidate[] = [];
    const plans = new Map<string, TaskPlan[]>(); // newest copies from a day on, read once per day
    for (const c of cands) {
      if (!c.taskId) {
        out.push(c);
        continue;
      }
      const task = await this.d.repo.getTask(c.taskId, { consistent: true });
      if (!task || task.status === 'done' || task.status === 'cancelled') continue;
      if (c.kind === 'planned') {
        const day = dayKeyInZone(c.fireAt, USER_TIME_ZONE, 0);
        if (!plans.has(day))
          plans.set(day, await this.d.repo.listPlansFrom(day, { consistent: true }));
        if (!onPlan(plans.get(day)!, task.id, c.fireAt)) continue;
      } else if (safe(() => taskFireAt(task, userDueEpoch)) !== c.fireAt) continue;
      out.push({ ...c, title: task.title });
    }
    return out;
  }

  private async stamp(next: PushSub, read: PushSub): Promise<void> {
    if (await this.d.repo.putPushSubIf(next, read.updatedAt)) this.subs.set(next.id, next);
  }
}

// The task's newest plan copy still fires at `fireAt` (a move writes the new copy before deleting the old).
function onPlan(plans: readonly TaskPlan[], taskId: string, fireAt: number): boolean {
  const newest = new Map<string, TaskPlan>();
  for (const p of plans) {
    const had = newest.get(p.id);
    if (!had || p.updatedAt > had.updatedAt) newest.set(p.id, p);
  }
  return [...newest.values()].some(
    (p) => p.taskId === taskId && safe(() => planFireAt(p, userDueEpoch)) === fireAt,
  );
}

const safe = (at: () => number | null): number | null => {
  try {
    return at();
  } catch {
    return null;
  }
};
