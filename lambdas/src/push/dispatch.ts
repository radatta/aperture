import {
  dayKeyInZone,
  isRitual,
  planFireAt,
  PUSH_DAILY_GUARD,
  REMINDER_SETTINGS_DEFAULTS,
  REMINDER_WINDOW_MS,
  reminderEnabled,
  reminderKind,
  reminderTag,
  SETTING_OF_KIND,
  taskFireAt,
  timeDecidesDay,
  USER_TIME_ZONE,
  userDueEpoch,
} from '@aperture/shared';
import type {
  ReminderCandidate,
  ReminderKind,
  ReminderSettingKey,
  Settings,
} from '@aperture/shared';
import { ConditionFailedError } from '../ddb/DocClient';
import type { DocClient } from '../ddb/DocClient';
import { CAS_ATTEMPTS, Repo } from '../ddb/repo';
import type { PushArmRow, PushRows, PushUserHealth, RemindRow } from '../ddb/repo';
import { PushRegistry } from '../ddb/pushRegistry';
import type { PushRegistryUser } from '../ddb/pushRegistry';
import type { Writes } from '../ddb/writes';
import type { PushGateway, PushReadiness } from './gateway';
import { Deliverer, guardMessage, MISS_KEEP_MS, missable } from './deliver';
import { ritualSource } from './rituals';

// One poller tick (reminders.md → D2–D4, D10): every minute, for each user in the push registry, find what
// fires in the last REMINDER_WINDOW_MS, drop what already went, and send the rest as ONE notification
// per device (a ritual nudge as its own). The dedup row and the daily guard's count are written BEFORE
// the send and never refunded (D3), so no reminder is ever found twice; a transient push-service failure
// is retried on the next ticks and, past that, caught up once (deliver.ts). DynamoDB writes go through
// `writes`, sends through the PushGateway — testMode (noopWrites + noopPush) runs the selection and
// writes nothing.
//
// Armed before it fires (reminders.md → §3): the window catches up a reminder a failed tick missed, never
// one that wasn't set yet. A task or plan pings only if its current fire time was set (remindArmedAt —
// created, re-dated, re-planned) no later than that fire time, its kind's toggle was on by then,
// and the user had reminders on by then (the registry row's createdAt — the first device, and the backfill
// that comes with it). Send test is exempt: it's asked for now.

// How long a dedup row outlives its fire time: far past the window, so a row is never swept while its
// reminder can still be found.
export const PSENT_KEEP_MS = 48 * 3600_000;
// Stage-wide errors when there's nothing to sign with: the operator step hasn't run, or put a value that
// isn't a P-256 private key.
export const PUSH_NO_KEY_ERROR = 'No VAPID key on this stage — reminders are off';
export const PUSH_BAD_KEY_ERROR = 'VAPID private key is malformed — reminders are off';
export const PUSH_NO_APP_URL_ERROR =
  'This stage has no APP_URL (the VAPID sub) — reminders are off';
const STAGE_ERROR: Record<Exclude<PushReadiness, 'ok'>, { message: string; event: string }> = {
  'no-key': { message: PUSH_NO_KEY_ERROR, event: 'push_no_key' },
  'bad-key': { message: PUSH_BAD_KEY_ERROR, event: 'push_bad_key' },
  'no-app-url': { message: PUSH_NO_APP_URL_ERROR, event: 'push_no_app_url' },
};

type ReminderSettings = Partial<Pick<Settings, ReminderSettingKey>>;

// A candidate as a source found it: the shared shape, plus its dedup key (the task id, `test-<id>`,
// `ritual-morning`) and, for a Send-test row, the row to drop once handled.
export interface FoundCandidate extends ReminderCandidate {
  key: string;
  testId?: string;
}
export interface SourceContext {
  repo: Repo;
  rows: RemindRow[]; // the window, read once per user
  settings: ReminderSettings;
  now: number;
  from: number; // the window [from, to] the rows were read for
  to: number;
  catchUp: boolean; // the gap pass: reminders that fell out of the window while no tick ran
  sent(fireAt: number, key: string): boolean; // its dedup row was there when the tick began
  // The earliest fire time a kind may still ping for: the user's reminders on, and that kind's toggle on.
  notBefore(kind: Exclude<ReminderKind, 'test'>): number;
}
// D10: the rituals are one more source (rituals.ts) — no change to dedup, guard, send or health.
export type CandidateSource = (ctx: SourceContext) => Promise<FoundCandidate[]>;

// The index is eventually consistent, so each hit is re-read strongly: a task completed, re-dated or
// deleted a moment ago must not ping, and a row whose fire time has since moved is stale.
const safeFireAt = (at: () => number | null): number | null => {
  try {
    return at();
  } catch {
    return null;
  }
};

export const taskSource: CandidateSource = async ({ repo, rows, settings, notBefore }) => {
  const out: FoundCandidate[] = [];
  for (const row of rows) {
    if (row.kind !== 'task') continue;
    const read = await repo.getTaskForRemind(row.task.id);
    if (!read || safeFireAt(() => taskFireAt(read.task, userDueEpoch)) !== row.fireAt) continue;
    const { task, armedAt } = read;
    const kind = reminderKind(task);
    if (!kind || !reminderEnabled(kind, settings)) continue;
    if (armedAt > row.fireAt || notBefore(kind) > row.fireAt) continue; // set after it fell due
    out.push({
      kind,
      fireAt: row.fireAt,
      taskId: task.id,
      title: task.title,
      dueTime: kind === 'timed' ? task.dueTime : null,
      key: task.id,
    });
  }
  return out;
};

// A plan pings only while its task is open and untimed (a timed task is never planned — the check is
// defensive), and only from its newest copy: a move writes the new key before deleting the old, so the old
// one outlives it by a write, or for good when that delete failed. The app's reads keep the newest per id;
// one consistent range read from the window's earliest plan day does the same here. A newest copy dated
// before that day (or a removal's tombstone) reads as absent, so the row stays quiet.
export const planSource: CandidateSource = async ({ repo, rows, settings, notBefore }) => {
  if (!reminderEnabled('planned', settings)) return [];
  const reads = [];
  for (const row of rows)
    if (row.kind === 'plan') reads.push({ row, read: await repo.getPlanForRemind(row.sk) });
  const days = reads.flatMap(({ read }) => (read ? [read.plan.day] : [])).sort();
  if (!days.length) return [];
  const newest = new Map(
    (await repo.listPlansFrom(days[0]!, { consistent: true })).map((p) => [p.id, p]),
  );
  const out: FoundCandidate[] = [];
  for (const { row, read } of reads) {
    if (!read || safeFireAt(() => planFireAt(read.plan, userDueEpoch)) !== row.fireAt) continue;
    const { plan, armedAt } = read;
    const head = newest.get(plan.id);
    if (
      !head ||
      head.day !== plan.day ||
      head.order !== plan.order ||
      head.updatedAt !== plan.updatedAt
    )
      continue; // a stale copy
    if (armedAt > row.fireAt || notBefore('planned') > row.fireAt) continue; // planned after 9:00
    const task = await repo.getTask(plan.taskId, { consistent: true });
    // A timed task is never planned (lenses.md D13) — bar a series deadline occurrence (recurring.md D8),
    // which is planned on its work day like an untimed task, so it gets this ping too.
    if (!task || task.status === 'done' || task.status === 'cancelled' || timeDecidesDay(task))
      continue;
    out.push({
      kind: 'planned',
      fireAt: row.fireAt,
      taskId: task.id,
      title: task.title,
      dueTime: null,
      key: task.id,
    });
  }
  return out;
};

// Titled for a batch's body; alone, reminderCopy titles it "Aperture test" anyway.
export const testSource: CandidateSource = async ({ rows }) =>
  rows.flatMap((row) =>
    row.kind === 'test'
      ? [
          {
            kind: 'test' as const,
            fireAt: row.fireAt,
            taskId: null,
            title: 'Aperture test',
            dueTime: null,
            key: `test-${row.id}`,
            testId: row.id,
          },
        ]
      : [],
  );

export const DEFAULT_SOURCES: readonly CandidateSource[] = [
  taskSource,
  planSource,
  testSource,
  ritualSource,
];

// One ping per (fire time, key): a task due today (day-only) and planned today fire at the same 09:00 —
// the deadline wins over the plan (D4).
export function dueWins(found: readonly FoundCandidate[]): FoundCandidate[] {
  const byKey = new Map<string, FoundCandidate>();
  for (const c of found) {
    const id = `${c.fireAt}#${c.key}`;
    const had = byKey.get(id);
    if (!had || (had.kind === 'planned' && c.kind !== 'planned')) byKey.set(id, c);
  }
  return [...byKey.values()].sort((a, b) => a.fireAt - b.fireAt);
}

export interface PushTickDeps {
  doc: DocClient;
  writes: Writes;
  push: PushGateway;
  now: () => number;
  appUrl: string;
  deadline?: number; // epoch ms: start no user and no send past it
  log?: (line: string) => void;
}

export interface PushTickReport {
  users: number;
  notifications: number; // batches sent (reminders, each ritual, each catch-up)
  delivered: number; // device POSTs a push service accepted
  failed: number; // device POSTs that didn't land
  retried: number; // of them, retries of an earlier tick's transient failure
  caughtUp: number; // "N reminders didn't reach you" notifications
  guardTripped: number;
  deadline: boolean; // the tick stopped early
  error: string | null; // stage-wide
}

// A stage fault ("no key", "bad key") is logged once per container, not every minute.
const coldStart = { logged: new Set<string>() };
export const resetColdStart = (): void => coldStart.logged.clear();

const errName = (err: unknown) => (err instanceof Error ? err.name : 'unknown');

export async function runPushTick(
  deps: PushTickDeps,
  sources: readonly CandidateSource[] = DEFAULT_SOURCES,
): Promise<PushTickReport> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const started = deps.now();
  const past = () => deps.deadline !== undefined && deps.now() >= deps.deadline;
  const registry = new PushRegistry(deps.doc, deps.writes);
  const report: PushTickReport = {
    users: 0,
    notifications: 0,
    delivered: 0,
    failed: 0,
    retried: 0,
    caughtUp: 0,
    guardTripped: 0,
    deadline: false,
    error: null,
  };
  const faults: unknown[] = [];
  const prev = await registry.getPoller();
  // No tick checked every user for longer than the window — an outage, a stalled schedule, a stage that
  // couldn't sign, ticks that kept failing: what fell due in between, up to MISS_KEEP_MS back, is caught
  // up once instead of lost.
  const checked = prev?.lastCheckedAt ?? prev?.lastRunAt ?? null;
  const gapFrom =
    checked !== null && started - checked > REMINDER_WINDOW_MS
      ? Math.max(checked, started - MISS_KEEP_MS)
      : null;
  let checkedAll = false;

  // A user's tick: select → dedup → guard → send → retries → catch-up → stamp. Throws only on an infra
  // fault (DynamoDB).
  async function tickUser({ userId, createdAt }: PushRegistryUser): Promise<void> {
    const repo = new Repo(deps.doc, deps.writes, userId);
    // Consistent: a device added a moment ago must keep its user in the registry.
    const alive = async () => (await repo.listPushSubs({ consistent: true })).length > 0;
    const subs = await repo.listPushSubs({ consistent: true });
    if (subs.length === 0) {
      // dropUser re-reads after the delete, so a subscribe racing it keeps the user registered.
      if (!(await registry.dropUser(userId, alive, deps.now())))
        log(JSON.stringify({ event: 'push_user_dropped' }));
      return;
    }
    report.users++;
    const settings = { ...REMINDER_SETTINGS_DEFAULTS, ...((await repo.getSettingsRow()) ?? {}) };
    const arm: PushArmRow | null = await repo.getPushArm();
    const notBefore = (kind: Exclude<ReminderKind, 'test'>) =>
      Math.max(createdAt ?? 0, arm?.[SETTING_OF_KIND[kind]] ?? 0);
    const now = deps.now();
    // One read of the user's poller rows: the send queue, the dedup rows, the Send-test rows.
    const own = await repo.listPushRows();
    const went = new Set(own.sent.map((r) => `${r.fireAt}#${r.key}`));
    const sent = (fireAt: number, key: string) => went.has(`${fireAt}#${key}`);
    const find = async (from: number, to: number, catchUp: boolean) => {
      const rows = await repo.remindRowsInWindow(from, to);
      const ctx = { repo, rows, settings, now, from, to, catchUp, notBefore, sent };
      return dueWins((await Promise.all(sources.map((s) => s(ctx)))).flat());
    };
    const found = await find(now - REMINDER_WINDOW_MS, now, false);

    // Dedup before anything leaves: a row that already exists means it went (or is going) once.
    const fresh: FoundCandidate[] = [];
    for (const c of found)
      if (await repo.putPushSentIf({ fireAt: c.fireAt, key: c.key, sentAt: now })) fresh.push(c);
    const send = new Deliverer(
      { repo, push: deps.push, appUrl: deps.appUrl, now, past, log },
      subs,
      own.retries,
    );
    // The gap's reminders: deduped, then queued as misses at once — before any send, so a fault later in
    // this tick can't leave them deduped but never caught up.
    if (gapFrom !== null && gapFrom < now - REMINDER_WINDOW_MS) {
      const missed: FoundCandidate[] = [];
      for (const c of (await find(gapFrom, now - REMINDER_WINDOW_MS - 1, true)).filter(missable))
        if (await repo.putPushSentIf({ fireAt: c.fireAt, key: c.key, sentAt: now })) missed.push(c);
      if (missed.length > 0) await send.queueMisses(send.subIds(), missed, now);
    }
    const guard = () => takeGuard(repo, now);
    // The reminders as one notification; each ritual as its own (its tap opens Home, not a task).
    const batches = [
      fresh.filter((c) => !isRitual(c.kind)),
      ...fresh.filter((c) => isRitual(c.kind)).map((c) => [c]),
    ].filter((b) => b.length > 0);
    for (const batch of batches) {
      if (!(await guard())) {
        report.guardTripped++;
        send.fail(guardMessage(PUSH_DAILY_GUARD));
        log(JSON.stringify({ event: 'push_guard_tripped', tasks: taskIds(batch) }));
        continue;
      }
      report.notifications++;
      await send.sendBatch(batch, reminderTag(batch));
    }
    await send.runRetries(own.retries);
    await send.runCatchUps(own.misses, guard);

    report.notifications += send.tally.caughtUp;
    report.delivered += send.tally.delivered;
    report.failed += send.tally.failed;
    report.retried += send.tally.retried;
    report.caughtUp += send.tally.caughtUp;
    if (send.tally.deadline) report.deadline = true;
    // The last alive device went: off the registry, unless a subscribe raced it (dropUser re-reads).
    if (send.removed > 0 && !(await alive())) await registry.dropUser(userId, alive, now);
    if (send.attempted) {
      // Read only when it's written: a quiet tick costs no read of it.
      const health = await repo.getPushUserHealth();
      await repo.putPushUserHealth({
        lastSentAt: send.sentAt ?? health?.lastSentAt ?? null,
        lastError: send.fails.length > 0 ? send.fails.join(' · ') : (health?.lastError ?? null),
        lastErrorAt: send.fails.length > 0 ? now : (health?.lastErrorAt ?? null),
        updatedAt: now,
      } satisfies PushUserHealth);
    }

    // Send-test rows are one-shot: handled (sent, deduped or held back) means gone.
    const handled = new Set<string>();
    for (const c of found)
      if (c.testId) {
        await repo.deletePushTest(c.testId);
        handled.add(c.testId);
      }
    await sweep(repo, now, new Set(send.subIds()), own, handled);
  }

  let stageError: string | null = null;
  try {
    const ready = await deps.push.readiness();
    if (ready !== 'ok') {
      stageError = STAGE_ERROR[ready].message;
      if (!coldStart.logged.has(ready)) log(JSON.stringify({ event: STAGE_ERROR[ready].event }));
      coldStart.logged.add(ready);
    } else {
      checkedAll = true;
      for (const user of await registry.listUsers()) {
        if (past()) {
          report.deadline = true;
          checkedAll = false;
          log(JSON.stringify({ event: 'push_deadline' }));
          break;
        }
        try {
          await tickUser(user);
        } catch (err) {
          // One user's fault never starves the next; the tick still fails at the end (the Errors alarm).
          faults.push(err);
          log(JSON.stringify({ event: 'push_failed', reason: 'tick', name: errName(err) }));
        }
      }
    }
  } catch (err) {
    faults.push(err);
    log(JSON.stringify({ event: 'push_failed', reason: 'tick', name: errName(err) }));
  }
  if (faults.length > 0) stageError = `The reminder check failed (${errName(faults[0])})`;
  report.error = stageError;

  // The heartbeat, every tick (Settings: "checked 1 min ago", red past PUSH_STALE_MS). `lastError` is the
  // stage's state now; `lastErrorAt` keeps when it last went wrong.
  await registry.putPoller({
    lastRunAt: started,
    lastCheckedAt: checkedAll && faults.length === 0 ? started : (checked ?? null),
    lastError: stageError,
    lastErrorAt: stageError ? started : (prev?.lastErrorAt ?? null),
    updatedAt: started,
  });
  if (faults.length > 0) throw faults[0];
  return report;
}

const taskIds = (cands: readonly ReminderCandidate[]) =>
  cands.flatMap((c) => (c.taskId ? [c.taskId] : []));

// The hidden guard (D3): one count per notification per user per LA day, a conditional write on the
// version read, refused at PUSH_DAILY_GUARD. A write that keeps losing refuses too — fail closed.
async function takeGuard(repo: Repo, now: number): Promise<boolean> {
  const day = dayKeyInZone(now, USER_TIME_ZONE, 0);
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const row = await repo.getPushCount(day);
    const count = row?.count ?? 0;
    if (count >= PUSH_DAILY_GUARD) return false;
    const updatedAt = row ? Math.max(now, row.updatedAt + 1) : now;
    try {
      await repo.putPushCountIf({ day, count: count + 1, updatedAt }, row?.updatedAt ?? null);
      return true;
    } catch (err) {
      if (!(err instanceof ConditionFailedError)) throw err;
    }
  }
  return false;
}

// The poller's own rows don't pile up (the table has no TTL — adding one touches the data stack): dedup
// rows past PSENT_KEEP_MS, Send-test rows that fell out of the window unsent, retry and miss rows of a
// device that's gone, misses past MISS_KEEP_MS — all from the tick's one read of them — and, every
// SWEEP_COUNTS_EVERY minutes, guard counters older than two days.
export const SWEEP_COUNTS_EVERY = 10;
async function sweep(
  repo: Repo,
  now: number,
  alive: ReadonlySet<string>,
  own: PushRows, // as the tick read it: a row this tick wrote is a live device's, and young
  handled: ReadonlySet<string>, // Send-test rows this tick already deleted
): Promise<void> {
  for (const r of own.sent) if (r.fireAt < now - PSENT_KEEP_MS) await repo.deletePushSent(r);
  for (const t of own.tests)
    if (!handled.has(t.id) && t.createdAt < now - REMINDER_WINDOW_MS)
      await repo.deletePushTest(t.id);
  for (const r of own.retries)
    if (!alive.has(r.subId)) await repo.deletePushRetry(r.subId, r.topic);
  for (const m of own.misses)
    if (!alive.has(m.subId) || m.cand.fireAt < now - MISS_KEEP_MS) await repo.deletePushMissIf(m);
  if (Math.floor(now / 60_000) % SWEEP_COUNTS_EVERY !== 0) return;
  const keepDay = dayKeyInZone(now - PSENT_KEEP_MS, USER_TIME_ZONE, 0);
  for (const c of await repo.listPushCounts())
    if (c.day < keepDay) await repo.deletePushCount(c.day);
}
