import {
  dayKeyInZone,
  planFireAt,
  PUSH_DAILY_GUARD,
  PUSH_TTL_S,
  REMINDER_SETTINGS_DEFAULTS,
  REMINDER_WINDOW_MS,
  reminderEnabled,
  reminderKind,
  reminderPayload,
  reminderTag,
  taskFireAt,
  USER_TIME_ZONE,
  userDueEpoch,
} from '@aperture/shared';
import type {
  PushSub,
  ReminderCandidate,
  ReminderKind,
  ReminderSettingKey,
  Settings,
} from '@aperture/shared';
import { ConditionFailedError } from '../ddb/DocClient';
import type { DocClient } from '../ddb/DocClient';
import { CAS_ATTEMPTS, Repo } from '../ddb/repo';
import type { PushArmRow, PushUserHealth, RemindRow } from '../ddb/repo';
import { PushRegistry } from '../ddb/pushRegistry';
import type { PushRegistryUser } from '../ddb/pushRegistry';
import type { Writes } from '../ddb/writes';
import type { PushGateway, PushReadiness, PushResult } from './gateway';

// One poller tick (reminders.md → D2–D4, D10): every minute, for each user in the push registry, find what
// fires in the last REMINDER_WINDOW_MS, drop what already went, and send the rest as ONE notification
// per device. Fail-closed by design (D3): the dedup row and the daily guard's count are written BEFORE
// the send and never refunded, so a transient push-service failure loses that one ping (logged, and on
// the health line) rather than risking a double ping; no retries. DynamoDB writes go through `writes`,
// sends through the PushGateway — testMode (noopWrites + noopPush) runs the selection and writes nothing.
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

// A candidate as a source found it: the shared shape, plus its dedup key (the task id, `test-<id>` — PR 3's
// rituals add `ritual-morning`) and, for a Send-test row, the row to drop once handled.
export interface FoundCandidate extends ReminderCandidate {
  key: string;
  testId?: string;
}
export interface SourceContext {
  repo: Repo;
  rows: RemindRow[]; // the window, read once per user
  settings: ReminderSettings;
  now: number;
  // The earliest fire time a kind may still ping for: the user's reminders on, and that kind's toggle on.
  notBefore(kind: Exclude<ReminderKind, 'test'>): number;
}
// D10: PR 3 adds a ritual source here — no change to dedup, guard, send or health.
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
// defensive).
export const planSource: CandidateSource = async ({ repo, rows, settings, notBefore }) => {
  if (!reminderEnabled('planned', settings)) return [];
  const out: FoundCandidate[] = [];
  for (const row of rows) {
    if (row.kind !== 'plan') continue;
    const read = await repo.getPlanForRemind(row.sk);
    if (!read || safeFireAt(() => planFireAt(read.plan, userDueEpoch)) !== row.fireAt) continue;
    const { plan, armedAt } = read;
    if (armedAt > row.fireAt || notBefore('planned') > row.fireAt) continue; // planned after 9:00
    const task = await repo.getTask(plan.taskId, { consistent: true });
    if (!task || task.status === 'done' || task.status === 'cancelled' || task.dueTime) continue;
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

export const DEFAULT_SOURCES: readonly CandidateSource[] = [taskSource, planSource, testSource];

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
  notifications: number; // batches sent (one per user per tick at most)
  delivered: number; // device POSTs a push service accepted
  failed: number; // device POSTs that didn't land
  guardTripped: number;
  deadline: boolean; // the tick stopped early
  error: string | null; // stage-wide
}

// A stage fault ("no key", "bad key") is logged once per container, not every minute.
const coldStart = { logged: new Set<string>() };
export const resetColdStart = (): void => coldStart.logged.clear();

const subRef = (s: Pick<PushSub, 'id'>) => s.id.slice(0, 6); // a log line names a device by this only
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
    guardTripped: 0,
    deadline: false,
    error: null,
  };
  const faults: unknown[] = [];

  // A user's tick: select → dedup → guard → send → stamp. Throws only on an infra fault (DynamoDB).
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
    const rows = await repo.remindRowsInWindow(now - REMINDER_WINDOW_MS, now);
    const found = dueWins(
      (await Promise.all(sources.map((s) => s({ repo, rows, settings, now, notBefore })))).flat(),
    );

    // Dedup before anything leaves: a row that already exists means it went (or is going) once.
    const fresh: FoundCandidate[] = [];
    for (const c of found)
      if (await repo.putPushSentIf({ fireAt: c.fireAt, key: c.key, sentAt: now })) fresh.push(c);

    if (fresh.length > 0) {
      const health = await repo.getPushUserHealth();
      // This tick's failures, every one: a batch that two devices refuse names both.
      const fails: string[] = [];
      const fail = (message: string) => void fails.push(message);
      const tasks = fresh.flatMap((c) => (c.taskId ? [c.taskId] : []));
      // The last time a push service ACCEPTED a notification for this user — an attempt it refused is an
      // error, not a send (Settings' "last sent").
      let sentAt = health?.lastSentAt ?? null;
      let removed = 0;
      if (!(await takeGuard(repo, now))) {
        report.guardTripped++;
        fail(
          `Daily reminder limit (${PUSH_DAILY_GUARD}) reached — the rest of today's were held back`,
        );
        log(JSON.stringify({ event: 'push_guard_tripped', tasks }));
      } else {
        report.notifications++;
        const payload = JSON.stringify(reminderPayload(fresh, deps.appUrl));
        const topic = reminderTag(fresh);
        for (const sub of subs) {
          if (past()) {
            report.deadline = true;
            fail('A reminder check ran out of time before reaching every device');
            log(JSON.stringify({ event: 'push_deadline', sub: subRef(sub) }));
            break;
          }
          let res: PushResult | { status: 0; reason: 'error'; name: string };
          try {
            res = await deps.push.send(sub, payload, {
              topic,
              ttlSeconds: PUSH_TTL_S,
              urgency: 'high',
            });
          } catch (err) {
            res = { status: 0, reason: 'error', name: errName(err) };
          }
          const ok = res.status >= 200 && res.status < 300;
          const gone = res.status === 404 || res.status === 410 || res.reason === 'keys';
          const line = {
            event: ok ? 'push_sent' : 'push_failed',
            status: res.status,
            reason: res.reason,
            ...('name' in res ? { name: res.name } : {}),
            sub: subRef(sub),
            tasks,
          };
          const stamp = { updatedAt: Math.max(now, sub.updatedAt + 1) };
          if (ok) {
            log(JSON.stringify(line));
            report.delivered++;
            sentAt = now;
            await repo.putPushSubIf(
              { ...sub, ...stamp, lastOkAt: now, lastError: null, lastErrorAt: null },
              sub.updatedAt,
            );
            continue;
          }
          report.failed++;
          const why = whyFailed(res);
          if (gone) {
            // The push service says this subscription is dead (or its keys never could work): drop it — the
            // row as read only, so a removal (tombstone) or a revive that landed meanwhile stands. The app
            // re-subscribes on its next launch (D7).
            const deleted = await repo.deletePushSubIf(sub.id, sub.updatedAt);
            log(JSON.stringify({ ...line, ...(deleted ? { removed: true } : { changed: true }) }));
            if (deleted) removed++;
            fail(
              `${sub.label} stopped accepting reminders (${why}) — turn them on again on that device`,
            );
          } else {
            log(JSON.stringify(line));
            const message = `Last reminder didn't reach this device (${why})`;
            await repo.putPushSubIf(
              { ...sub, ...stamp, lastError: message, lastErrorAt: now },
              sub.updatedAt,
            );
            fail(`${sub.label}: ${message}`);
          }
        }
        // The last alive device went: off the registry, unless a subscribe raced it (dropUser re-reads).
        if (removed > 0 && !(await alive())) await registry.dropUser(userId, alive, now);
      }
      await repo.putPushUserHealth({
        lastSentAt: sentAt,
        lastError: fails.length > 0 ? fails.join(' · ') : (health?.lastError ?? null),
        lastErrorAt: fails.length > 0 ? now : (health?.lastErrorAt ?? null),
        updatedAt: now,
      } satisfies PushUserHealth);
    }

    // Send-test rows are one-shot: handled (sent, deduped or held back) means gone.
    for (const c of found) if (c.testId) await repo.deletePushTest(c.testId);
    await sweep(repo, now);
  }

  let stageError: string | null = null;
  try {
    const ready = await deps.push.readiness();
    if (ready !== 'ok') {
      stageError = STAGE_ERROR[ready].message;
      if (!coldStart.logged.has(ready)) log(JSON.stringify({ event: STAGE_ERROR[ready].event }));
      coldStart.logged.add(ready);
    } else {
      for (const user of await registry.listUsers()) {
        if (past()) {
          report.deadline = true;
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
  const prev = await registry.getPoller();
  await registry.putPoller({
    lastRunAt: started,
    lastError: stageError,
    lastErrorAt: stageError ? started : (prev?.lastErrorAt ?? null),
    updatedAt: started,
  });
  if (faults.length > 0) throw faults[0];
  return report;
}

const SETTING_OF_KIND: Record<Exclude<ReminderKind, 'test'>, ReminderSettingKey> = {
  timed: 'remindTimed',
  dueDay: 'remindDueDay',
  planned: 'remindPlanned',
};

const whyFailed = (res: { status: number; reason?: string; name?: string }): string =>
  res.status > 0
    ? `push service answered ${res.status}`
    : res.reason === 'timeout'
      ? 'timed out'
      : res.reason === 'keys'
        ? 'its keys are invalid'
        : res.reason === 'error'
          ? `couldn't send: ${res.name ?? 'unknown'}`
          : 'network error';

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
// rows past PSENT_KEEP_MS, guard counters older than two days, and Send-test rows that fell out of the
// window unsent.
async function sweep(repo: Repo, now: number): Promise<void> {
  for (const r of await repo.listPushSent())
    if (r.fireAt < now - PSENT_KEEP_MS) await repo.deletePushSent(r);
  const keepDay = dayKeyInZone(now - PSENT_KEEP_MS, USER_TIME_ZONE, 0);
  for (const c of await repo.listPushCounts())
    if (c.day < keepDay) await repo.deletePushCount(c.day);
  for (const t of await repo.listPushTests())
    if (t.createdAt < now - REMINDER_WINDOW_MS) await repo.deletePushTest(t.id);
}
