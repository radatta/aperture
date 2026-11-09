import { describe, expect, it } from 'vitest';
import { emptySummary } from '@aperture/shared';
import type { Sitting, SittingSummary } from '@aperture/shared';
import {
  groupSittings,
  sittingOutcome,
  summarizeSittings,
  verdictLabel,
  verdictTone,
} from './recruitingHelpers';

const v = (verdict: 'accepted' | 'wrong_answer', at = 1) => ({
  verdict,
  statusMsg: null,
  passed: null,
  total: null,
  at,
});
const mk = (over: Partial<Sitting> = {}, summary: Partial<SittingSummary> = {}): Sitting =>
  ({
    id: Math.random().toString(36),
    day: '2026-11-08',
    startedAt: 0,
    endedAt: 1,
    status: 'done',
    problemSlug: 'two-sum',
    summary: { ...emptySummary(), ...summary },
    ...over,
  }) as Sitting;

const outcome = (s: Sitting, now = 1) => sittingOutcome(s, now);

describe('sittingOutcome', () => {
  it('names the first submit, never in red', () => {
    expect(outcome(mk({ status: 'active' }))).toEqual({
      label: 'no submit yet',
      tone: 'muted',
    });
    expect(outcome(mk())).toEqual({ label: 'no submit', tone: 'muted' }); // ended: no "yet"
    // Still active but past its 24 h window: no more runs or submits can land, so no "yet" either.
    expect(outcome(mk({ status: 'active' }), 25 * 3600_000)).toEqual({
      label: 'no submit',
      tone: 'muted',
    });
    expect(outcome(mk({}, { submits: 1, firstSubmit: v('accepted') }))).toEqual({
      label: 'first submit accepted',
      tone: 'teal',
    });
    expect(
      outcome(mk({}, { submits: 3, firstSubmit: v('wrong_answer'), submitsBeforeAccepted: 2 })),
    ).toEqual({ label: 'accepted on submit 3', tone: 'gold' });
    expect(outcome(mk({}, { submits: 1, firstSubmit: v('wrong_answer') }))).toEqual({
      label: 'not accepted · 1 submit',
      tone: 'gold',
    });
  });
});

describe('summaries and grouping', () => {
  it('counts sittings, distinct problems and first-try accepts', () => {
    const rows = [
      mk({}, { firstSubmit: v('accepted') }),
      mk(),
      mk({ problemSlug: 'three-sum' }, { firstSubmit: v('wrong_answer') }),
    ];
    expect(summarizeSittings(rows)).toEqual({ sittings: 3, problems: 2, firstTry: 1 });
  });
  it('pulls the open sitting out and orders days newest first', () => {
    const open = mk({ status: 'active', day: '2026-11-08', startedAt: 9 });
    const old = mk({ day: '2026-11-01', startedAt: 1 });
    const recent = mk({ day: '2026-11-07', startedAt: 5 });
    const g = groupSittings([old, open, recent]);
    expect(g.open).toEqual([open]);
    expect(g.days.map(([d]) => d)).toEqual(['2026-11-07', '2026-11-01']);
  });
});

describe('verdict presentation', () => {
  it('reads accepted as teal and everything else as gold', () => {
    expect(verdictTone('accepted')).toBe('teal');
    expect(verdictTone('runtime_error')).toBe('gold');
    expect(verdictLabel('time_limit')).toBe('Time Limit');
  });
});
