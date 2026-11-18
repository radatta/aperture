// The dev test user's daily sitting budget (DEV-CHECK.md → The test user's daily LeetCode Start gate): the BFF
// refuses a Start past its day's cap, and nothing reads the gate's count back. So the harness estimates it from
// the shared ledger before the run, and a step that fails on the refusal reads needs-you with the reason — the
// budget is spent, nothing broke — never a pass, never a bare STEP_FAILED.
// scripts doesn't depend on shared: budget.test.ts pins these to packages/shared/src/sittings.ts by text.
import { SITTING_VIA } from './api';
import type { LedgerEntry } from './ledger';

export const SITTING_START_CAP_ERROR = 'Too many sittings started today.';
export const LC_START_ATTEMPT_CAP_ERROR = 'Too many Start attempts today.';
export const DEV_STARTS_PER_DAY = 1000; // SITTING_STARTS_PER_DAY_DEV
export const DEV_START_ATTEMPTS_PER_DAY = 4000; // LC_START_ATTEMPTS_PER_DAY_DEV
const ZONE = 'America/Los_Angeles'; // the user's zone; the app day starts at 04:00 in it
const DAY_START_HOUR = 4;

export type Refusal = 'starts' | 'attempts';

export function capRefusal(text: string): Refusal | null {
  if (text.includes(SITTING_START_CAP_ERROR)) return 'starts';
  if (text.includes(LC_START_ATTEMPT_CAP_ERROR)) return 'attempts';
  return null;
}

// The app day a moment falls in: its date in the user's zone, four hours earlier. Within an hour of a DST
// change it can be an hour off — fine for an estimate.
export function appDay(t: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(
    new Date(t - DAY_START_HOUR * 3600_000),
  );
}

// Sitting Starts the ledger recorded on this slot's test user in the current app day: each is recorded before its
// call, so a refused one counts too (as the attempt gate does). Another slot's runs are in another ledger file.
export function startsToday(entries: LedgerEntry[], now: number): number {
  const day = appDay(now);
  const ids = new Set<string>();
  for (const e of entries) {
    if (e.op !== 'created' || e.via !== SITTING_VIA || !e.id) continue;
    const t = Date.parse(e.t);
    if (!Number.isNaN(t) && appDay(t) === day) ids.add(e.id);
  }
  return ids.size;
}

export const budgetLine = (counted: number) =>
  `Sitting starts today (ledger estimate): ~${counted} of ${DEV_STARTS_PER_DAY}, resets 04:00 PT`;

// A refusal is believed only when the ledger's count makes it plausible: well under the cap, it reads as a counter
// bug (or another writer on the test user), and the step stays a failure.
export function budgetReason(
  kind: Refusal,
  counted: number,
): { needsYou: string } | { fail: string } {
  const cap = kind === 'starts' ? DEV_STARTS_PER_DAY : DEV_START_ATTEMPTS_PER_DAY;
  const what = kind === 'starts' ? 'sitting starts' : 'Start attempts';
  if (counted * 2 < cap)
    return {
      fail: `the BFF refused a Start for its daily cap of ${cap} ${what} at ~${counted} counted — check the gate counter`,
    };
  return {
    needsYou: `the test user's ${cap} ${what} for today are spent (~${counted} counted); rerun after 04:00 PT`,
  };
}
