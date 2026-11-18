import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  DEV_START_ATTEMPTS_PER_DAY,
  DEV_STARTS_PER_DAY,
  LC_START_ATTEMPT_CAP_ERROR,
  SITTING_START_CAP_ERROR,
  appDay,
  budgetLine,
  budgetReason,
  capRefusal,
  startsToday,
} from './budget';
import type { LedgerEntry } from './ledger';

describe('budget', () => {
  it('matches the BFF: the refusal texts and the dev caps are shared/sittings.ts’s', () => {
    const src = readFileSync(
      new URL('../../../packages/shared/src/sittings.ts', import.meta.url),
      'utf8',
    );
    expect(src).toContain(`SITTING_START_CAP_ERROR = '${SITTING_START_CAP_ERROR}'`);
    expect(src).toContain(`LC_START_ATTEMPT_CAP_ERROR = '${LC_START_ATTEMPT_CAP_ERROR}'`);
    expect(src).toContain(`SITTING_STARTS_PER_DAY_DEV = ${DEV_STARTS_PER_DAY};`);
    expect(src).toContain(`LC_START_ATTEMPTS_PER_DAY_DEV = ${DEV_START_ATTEMPTS_PER_DAY};`);
  });

  it('reads either refusal out of an error or a body', () => {
    expect(capRefusal(`lcSittingStart → HTTP 400: {"error":"${SITTING_START_CAP_ERROR}"}`)).toBe(
      'starts',
    );
    expect(capRefusal(LC_START_ATTEMPT_CAP_ERROR)).toBe('attempts');
    expect(capRefusal('Too many requests')).toBeNull();
  });

  it('turns the app day over at 04:00 Pacific, PST and PDT alike', () => {
    expect(appDay(Date.parse('2026-11-17T11:59:00Z'))).toBe('2026-11-16'); // 03:59 PST
    expect(appDay(Date.parse('2026-11-17T12:00:00Z'))).toBe('2026-11-17'); // 04:00 PST
    expect(appDay(Date.parse('2026-07-01T10:59:00Z'))).toBe('2026-06-30'); // 03:59 PDT
    expect(appDay(Date.parse('2026-07-01T11:00:00Z'))).toBe('2026-07-01'); // 04:00 PDT
  });

  it('counts today’s distinct sitting Starts only — not reps, other kinds, yesterday or a torn timestamp', () => {
    const now = Date.parse('2026-11-17T20:00:00Z');
    const e = (
      t: string,
      id: string,
      via = 'api:lcSittingStart',
      op: LedgerEntry['op'] = 'created',
    ): LedgerEntry => ({
      t,
      run: 'r',
      op,
      id,
      via,
    });
    const entries = [
      e('2026-11-17T12:00:00Z', 'a'),
      e('2026-11-17T13:00:00Z', 'a'), // the same id recorded twice
      e('2026-11-17T14:00:00Z', 'b'),
      e('2026-11-17T14:00:00Z', 'r1', 'api:lcSittingStart:rep'),
      e('2026-11-17T14:00:00Z', 't1', 'api:createTask'),
      e('2026-11-17T14:00:00Z', 'b', 'api:lcSittingStart', 'deleted'),
      e('2026-11-17T11:59:00Z', 'y'), // 03:59 PST: yesterday's
      e('', 'z'),
    ];
    expect(startsToday(entries, now)).toBe(2);
  });

  it('believes a refusal only at a plausible count: half the cap or more', () => {
    expect(budgetReason('starts', 500)).toEqual({
      needsYou:
        "the test user's 1000 sitting starts for today are spent (~500 counted); rerun after 04:00 PT",
    });
    expect(budgetReason('starts', 499)).toEqual({
      fail: 'the BFF refused a Start for its daily cap of 1000 sitting starts at ~499 counted — check the gate counter',
    });
    expect(budgetReason('attempts', 1999)).toHaveProperty('fail');
    expect(budgetReason('attempts', 2000)).toHaveProperty('needsYou');
  });

  it('says the estimate in one line', () => {
    expect(budgetLine(42)).toBe(
      'Sitting starts today (ledger estimate): ~42 of 1000, resets 04:00 PT',
    );
  });
});
