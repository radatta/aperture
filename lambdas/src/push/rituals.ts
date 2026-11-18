import {
  dayKeyInZone,
  reminderEnabled,
  ritualCopy,
  ritualFireAts,
  USER_TIME_ZONE,
  userDueEpoch,
} from '@aperture/shared';
import type { RitualKind, TaskPlan } from '@aperture/shared';
import type { Repo } from '../ddb/repo';
import type { CandidateSource, FoundCandidate } from './dispatch';

// The ritual nudges (reminders.md → §2, Reminders PR 3): 08:30 "Plan your day" and 21:30 "Close the
// day", in the user's zone, each with its toggle. No index row: the times come from the window itself,
// and the dedup row (psent#<fireAt>#ritual-…) makes each go once. Armed like any kind: a nudge pings only
// when its toggle and the user's reminders were on by its time. Copy is counts only (ritualCopy).
export const RITUAL_KEY: Record<RitualKind, string> = {
  ritualMorning: 'ritual-morning',
  ritualNight: 'ritual-night',
};

export const ritualSource: CandidateSource = async ({ repo, settings, notBefore, from, to, catchUp }) => {
  if (catchUp) return []; // a late nudge is noise: never caught up
  const out: FoundCandidate[] = [];
  const dayKeyOf = (at: number) => dayKeyInZone(at, USER_TIME_ZONE, 0);
  for (const r of ritualFireAts(from, to, userDueEpoch, dayKeyOf)) {
    if (!reminderEnabled(r.kind, settings) || notBefore(r.kind) > r.fireAt) continue;
    const key = RITUAL_KEY[r.kind];
    // Counted only until it has gone: the window holds a nudge for 30 ticks.
    if (await repo.hasPushSent(r.fireAt, key)) continue;
    const { title, body } = ritualCopy(r.kind, await dayCounts(repo, r.day));
    out.push({ kind: r.kind, fireAt: r.fireAt, taskId: null, title, body, dueTime: null, key });
  }
  return out;
};

// The day's plan as the app reads it: each plan's newest copy, on that day, its task not cancelled or
// deleted; done or not.
export async function dayCounts(repo: Repo, day: string): Promise<{ open: number; done: number }> {
  const newest = new Map<string, TaskPlan>();
  for (const p of await repo.listPlansFrom(day, { consistent: true })) {
    const had = newest.get(p.id);
    if (!had || p.updatedAt > had.updatedAt) newest.set(p.id, p);
  }
  const counts = { open: 0, done: 0 };
  for (const p of newest.values()) {
    if (p.day !== day) continue;
    const task = await repo.getTask(p.taskId, { consistent: true });
    if (!task || task.status === 'cancelled') continue;
    if (task.status === 'done') counts.done++;
    else counts.open++;
  }
  return counts;
}
