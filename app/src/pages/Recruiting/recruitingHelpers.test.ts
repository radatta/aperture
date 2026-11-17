import { describe, expect, it } from 'vitest';
import { emptySummary } from '@aperture/shared';
import type { CoachSlot, CoachToday, Sitting, SittingSummary } from '@aperture/shared';
import {
  canOfferReopen,
  coachGlance,
  endedNote,
  IDLE_CLOSED_NOTICE,
  dueBeyondSlots,
  dueLabel,
  groupSittings,
  slotState,
  suggestedCause,
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

describe('idle close', () => {
  const s = (over: Partial<Sitting>) => ({ status: 'abandoned', startedAt: 0, ...over }) as Sitting;
  it('says closed automatically, never dropped, and offers Reopen only inside the window', () => {
    expect(IDLE_CLOSED_NOTICE).toBe('Closed automatically: 45 min with no activity');
    expect(endedNote(s({ closedBy: 'idle' }))).toBe('closed automatically');
    expect(endedNote(s({}))).toBe('dropped');
    expect(endedNote(s({ status: 'done', closedBy: 'idle' }))).toBeNull();
    expect(endedNote(s({ status: 'active' }))).toBeNull();
    expect(canOfferReopen(s({ closedBy: 'idle' }), 24 * 3600_000)).toBe(true);
    expect(canOfferReopen(s({ closedBy: 'idle' }), 24 * 3600_000 + 1)).toBe(false);
    expect(canOfferReopen(s({ status: 'done', closedBy: 'idle' }), 1)).toBe(false);
    expect(canOfferReopen(s({}), 1)).toBe(false);
  });
});

describe('verdict presentation', () => {
  it('reads accepted as teal and everything else as gold', () => {
    expect(verdictTone('accepted')).toBe('teal');
    expect(verdictTone('runtime_error')).toBe('gold');
    expect(verdictLabel('time_limit')).toBe('Time Limit');
  });
});

describe('the coach’s view helpers', () => {
  it('suggests No trace when the code held no trace comment, or the first submit failed with no run', () => {
    expect(suggestedCause(mk({}, { commentTrace: 'none' }))).toBe('no-trace');
    // The card is never read: its "skipped" says nothing.
    expect(
      suggestedCause(mk({}, { coach: { config: null, trace: 'skipped', nudges: 0 } })),
    ).toBeNull();
    expect(
      suggestedCause(mk({}, { firstSubmit: v('wrong_answer'), runsBeforeFirstSubmit: 0 })),
    ).toBe('no-trace');
    expect(
      suggestedCause(mk({}, { firstSubmit: v('wrong_answer'), runsBeforeFirstSubmit: 2 })),
    ).toBeNull();
    expect(
      suggestedCause(mk({}, { firstSubmit: v('accepted'), runsBeforeFirstSubmit: 0 })),
    ).toBeNull();
    expect(suggestedCause(mk({}, { commentTrace: 'traced' }))).toBeNull();
    expect(suggestedCause(mk())).toBeNull();
  });

  it('a slot’s state is teal only when done clean, never red', () => {
    expect(slotState({ status: 'done', outcome: 'clean' })).toEqual({
      label: 'done · clean',
      tone: 'teal',
    });
    expect(slotState({ status: 'done', outcome: 'failed' }).tone).toBe('gold');
    expect(slotState({ status: 'in-progress', outcome: null }).label).toBe('in progress');
    expect(slotState({ status: 'skipped', outcome: null }).tone).toBe('muted');
    expect(slotState({ status: 'open', outcome: null }).label).toBe('open');
  });

  it('labels a queue day as due, tomorrow, or its heading', () => {
    expect(dueLabel('2026-11-14', '2026-11-16')).toBe('due');
    expect(dueLabel('2026-11-16', '2026-11-16')).toBe('due');
    expect(dueLabel('2026-11-17', '2026-11-16')).toBe('tomorrow');
    expect(dueLabel('2026-11-18', '2026-11-16')).toBe('Wednesday, Nov 18');
  });

  const slot = (status: CoachSlot['status']) => ({ status }) as CoachSlot;
  const day = (over: Partial<CoachToday>): CoachToday =>
    ({ slots: [], due: [], floor: null, ...over }) as unknown as CoachToday;
  it('the Home line counts what’s left, the due re-solves, and a floor day', () => {
    const four = ['open', 'open', 'open', 'open'] as const;
    const slotOn = (slug: string) => ({ status: 'open', slug }) as CoachSlot;
    expect(
      coachGlance(
        day({
          slots: ['a', 'b', 'c', 'two-sum'].map(slotOn),
          due: [{ slug: 'two-sum' }, { slug: 'x' }, { slug: 'y' }] as never,
        }),
      ),
    ).toBe('LeetCode · 4 today · +2 re-solves due'); // two-sum is a slot already
    expect(coachGlance(day({ slots: four.map(slot), due: [{ slug: 'x' }] as never }))).toBe(
      'LeetCode · 4 today · +1 re-solve due',
    );
    expect(
      coachGlance(
        day({
          slots: [slot('done'), slot('open'), slot('skipped')],
          due: [{ slug: 'x' }] as never,
        }),
      ),
    ).toBe('LeetCode · 1 left today · +1 re-solve due');
    expect(coachGlance(day({ slots: [slot('done'), slot('skipped')] }))).toBe(
      'LeetCode · 1 of 1 done',
    );
    expect(coachGlance(day({}))).toBe('LeetCode · nothing planned today');
    expect(
      coachGlance(
        day({
          slots: four.map(slot),
          floor: { on: true, done: false, title: 'Two Sum' } as CoachToday['floor'],
        }),
      ),
    ).toBe('LeetCode · floor day · Two Sum');
  });
  it('the Home line says the AI pick is running, never a plan about to change', () => {
    const picking = (status: 'due' | 'pending') =>
      coachGlance(
        day({ slots: [{ status: 'open', slug: 'a' } as CoachSlot], ai: { status } as never }),
      );
    expect(picking('due')).toBe('LeetCode · picking today’s problems…');
    expect(picking('pending')).toBe('LeetCode · picking today’s problems…');
    const due = day({
      slots: [{ status: 'open', slug: 'a' } as CoachSlot],
      ai: { status: 'due' } as never,
    });
    expect(coachGlance(due, true)).toBe('LeetCode · 1 today');
    expect(
      coachGlance(
        day({
          slots: [{ status: 'open', slug: 'a' } as CoachSlot],
          ai: { status: 'fallback' } as never,
        }),
      ),
    ).toBe('LeetCode · 1 today');
  });

  it('due beyond the slots: a live slot counts there; a skipped one, or one swapped away, is still due', () => {
    const due = [{ slug: 'a' }, { slug: 'b' }, { slug: 'c' }] as CoachToday['due'];
    const slots = [
      { slug: 'a', status: 'open' },
      { slug: 'b', status: 'skipped' },
      { slug: 'z', status: 'open', swappedFrom: 'c' },
    ] as CoachSlot[];
    expect(dueBeyondSlots({ due, slots }).map((q) => q.slug)).toEqual(['b', 'c']);
  });
});
