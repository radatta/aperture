// The dev test user's daily sitting budget (DEV-CHECK.md → The test user's daily LeetCode Start gate): the BFF
// refuses a Start past its day's cap, and nothing reads the gate's count back. So the harness estimates it from
// the shared ledger before the run, and a step that fails on the refusal reads needs-you with the reason — the
// budget is spent, nothing broke — never a pass, never a bare STEP_FAILED.
// scripts doesn't depend on shared: budget.test.ts pins these to packages/shared/src (sittings.ts, dates.ts) by text.
import { SITTING_VIA } from './api';
import type { LedgerEntry } from './ledger';

export const SITTING_START_CAP_ERROR = 'Too many sittings started today.';
export const LC_START_ATTEMPT_CAP_ERROR = 'Too many Start attempts today.';
export const SITTING_ACTIVE_ERROR = 'Another sitting is still open — end it in Aperture first.';
export const DEV_STARTS_PER_DAY = 1000; // SITTING_STARTS_PER_DAY_DEV
export const DEV_START_ATTEMPTS_PER_DAY = 4000; // LC_START_ATTEMPTS_PER_DAY_DEV
const ZONE = 'America/Los_Angeles'; // USER_TIME_ZONE: the gate's day is the user's app day in it
export const DAY_START_HOUR = 4; // the settings default; the run reads the test user's own (pipeline.ts)

export type Refusal = 'starts' | 'attempts';

export function capRefusal(text: string): Refusal | null {
  if (text.includes(SITTING_START_CAP_ERROR)) return 'starts';
  if (text.includes(LC_START_ATTEMPT_CAP_ERROR)) return 'attempts';
  return null;
}

// The app day a moment falls in, as the BFF keys the gate (dayKeyInZone): its date in the user's zone, the day's
// start hour earlier. Within an hour of a DST change it can be an hour off — fine for an estimate.
export function appDay(t: number, dayStart = DAY_START_HOUR): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(
    new Date(t - dayStart * 3600_000),
  );
}

// Sitting Starts the ledger recorded on this slot's test user in the current app day: each is recorded before its
// call, so a refused one counts too (as the attempt gate does). Another slot's runs are in another ledger file.
export function startsToday(
  entries: LedgerEntry[],
  now: number,
  dayStart = DAY_START_HOUR,
): number {
  const day = appDay(now, dayStart);
  const ids = new Set<string>();
  for (const e of entries) {
    if (e.op !== 'created' || e.via !== SITTING_VIA || !e.id) continue;
    const t = Date.parse(e.t);
    if (!Number.isNaN(t) && appDay(t, dayStart) === day) ids.add(e.id);
  }
  return ids.size;
}

const resets = (dayStart: number) => `${String(dayStart).padStart(2, '0')}:00 PT`;

export const budgetLine = (counted: number, dayStart = DAY_START_HOUR) =>
  `Sitting starts today (ledger estimate): ~${counted} of ${DEV_STARTS_PER_DAY}, resets ${resets(dayStart)}`;

// A starts refusal is believed only when the ledger's count makes it plausible: well under the cap, it reads as a
// counter bug (or another writer on the test user), and the step stays a failure. The attempts gate also counts
// resumes and refused Starts, which the ledger never sees, so no count can size that one: it's believed unless the
// ledger has no Start at all today.
export function budgetReason(
  kind: Refusal,
  counted: number,
  dayStart = DAY_START_HOUR,
): { needsYou: string } | { fail: string } {
  if (kind === 'attempts' && counted === 0)
    return {
      fail: `the BFF refused a Start for its daily cap of ${DEV_START_ATTEMPTS_PER_DAY} Start attempts with no sitting counted today — check the gate counter`,
    };
  if (kind === 'attempts')
    return {
      needsYou: `the test user's ${DEV_START_ATTEMPTS_PER_DAY} Start attempts for today are spent (~${counted} sittings counted; resumes and refused Starts aren't in the ledger); rerun after ${resets(dayStart)}`,
    };
  if (counted * 2 < DEV_STARTS_PER_DAY)
    return {
      fail: `the BFF refused a Start for its daily cap of ${DEV_STARTS_PER_DAY} sitting starts at ~${counted} counted — check the gate counter`,
    };
  return {
    needsYou: `the test user's ${DEV_STARTS_PER_DAY} sitting starts for today are spent (~${counted} counted); rerun after ${resets(dayStart)}`,
  };
}

// Once the budget has run out mid-scenario, the steps that would end the sitting it opened never run, so the next
// scenario's Start is refused for that open sitting, not for the cap: the same spent budget, said differently.
export const leftOpenReason = (spent: string) =>
  `a sitting opened before the budget ran out is still open, so this Start is refused for it (${spent})`;
