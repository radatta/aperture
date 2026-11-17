import { describe, expect, it } from 'vitest';
import {
  applySlotChange,
  attemptsOf,
  ATTEMPT_HISTORY_DAYS,
  coachScope,
  coachStats,
  countsAsPractice,
  easierIn,
  focusOn,
  focusRoomError,
  listRecords,
  normalizeCoachAttempt,
  normalizeFocusPattern,
  normalizeReviewPatch,
  normalizeStatsRange,
  outcomeOf,
  patternDetail,
  planDay,
  patternOfTags,
  peekOf,
  rankPatterns,
  resolveState,
  sittingTryMinutes,
  slotChangeInputs,
} from './coach';
import type { CoachInput } from './coach';
import { addDays, USER_TIME_ZONE, zonedEpoch } from './dates';
import { NEETCODE_150 } from './neetcode150';
import { emptySummary, mergeReview, patchReview } from './sittings';
import type {
  CoachAttempt,
  CoachDay,
  CoachFocus,
  HelpLevel,
  LeetcodeVerdict,
  Sitting,
  SittingReview,
} from './types';

// Synthetic fixtures only: catalog slugs, made-up days and times.
const TODAY = '2026-11-16';
const NOW = zonedEpoch(TODAY, '12:00', USER_TIME_ZONE);
const day = (n: number) => addDays(TODAY, n);
let seq = 0;
const id = () => `01J${String(++seq).padStart(23, '0')}`;
const verdict = (v: LeetcodeVerdict, at: number) => ({
  verdict: v,
  statusMsg: null,
  passed: null,
  total: null,
  at,
});
interface SitOpts {
  slug: string;
  on: string;
  // the submits in order; none = never submitted
  submits?: LeetcodeVerdict[];
  minutes?: number;
  help?: HelpLevel;
  cause?: SittingReview['cause'];
  test?: boolean;
  open?: boolean;
  title?: string;
  tags?: string[];
}
function sit(o: SitOpts): Sitting {
  const startedAt = zonedEpoch(o.on, '10:00', USER_TIME_ZONE);
  const end = startedAt + (o.minutes ?? 25) * 60_000;
  const subs = (o.submits ?? []).map((v, i) => verdict(v, startedAt + (i + 1) * 60_000));
  const acceptedAt = subs.find((s) => s.verdict === 'accepted')?.at ?? null;
  const review: SittingReview | null =
    o.help || o.cause || o.test
      ? {
          insight: null,
          help: o.help ?? 'none',
          mistakes: [],
          howItWent: null,
          tags: [],
          draftUsed: false,
          ...(o.cause ? { cause: o.cause } : {}),
          ...(o.test ? { test: true } : {}),
          updatedAt: end,
        }
      : null;
  return {
    id: id(),
    userId: 'u',
    createdAt: startedAt,
    updatedAt: end,
    deletedAt: null,
    day: o.on,
    startedAt,
    clientStartedAt: startedAt,
    endedAt: o.open ? null : end,
    status: o.open ? 'active' : 'done',
    clientSittingId: id(),
    problemSlug: o.slug,
    problemTitle:
      o.title ?? NEETCODE_150.find((c) => c.slug === o.slug)?.title ?? o.slug.replace(/-/g, ' '),
    questionId: null,
    frontendId: null,
    difficulty: null,
    topicTags: o.tags ?? null,
    lang: 'python3',
    repTaskId: id(),
    rollId: 'roll',
    prepTarget: 'General',
    lcSolveSessionId: null,
    shapedAt: startedAt,
    summary: {
      ...emptySummary(),
      submits: subs.length,
      firstSubmit: subs[0] ?? null,
      lastSubmit: subs[subs.length - 1] ?? null,
      firstAcceptedAt: acceptedAt,
      submitsBeforeAccepted: acceptedAt ? subs.findIndex((s) => s.verdict === 'accepted') : null,
      headEvents: subs.length,
    },
    review,
  };
}
const clean = (slug: string, on: string) => sit({ slug, on, submits: ['accepted'] });
const failed = (slug: string, on: string) => sit({ slug, on, submits: ['wrong_answer'] });
function manual(
  slug: string,
  on: string,
  outcome: CoachAttempt['outcome'],
  help: HelpLevel = 'none',
): CoachAttempt {
  const at = zonedEpoch(on, '20:00', USER_TIME_ZONE);
  return {
    id: id(),
    userId: 'u',
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
    slug,
    title: null,
    day: on,
    at,
    outcome,
    help,
    cause: null,
    minutes: null,
    note: null,
    source: help === 'solution' ? 'peek-seed' : 'manual',
  };
}
const focusRow = (pattern: CoachFocus['pattern'], sinceDay: string): CoachFocus => ({
  id: 'focus',
  userId: 'u',
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
  pattern,
  sinceDay,
  source: 'override',
});
const input = (o: Partial<CoachInput> = {}): CoachInput => ({
  today: TODAY,
  now: NOW,
  dayStartHour: 4,
  sittings: [],
  attempts: [],
  days: [],
  focus: null,
  ...o,
});
const kinds = (sittings: Sitting[], o: Partial<CoachInput> = {}) =>
  planDay(input({ sittings, ...o })).slots.map((s) => `${s.kind}:${s.slug}`);

describe('outcomes', () => {
  it('maps accepted, first-submit and help to clean / solved / failed', () => {
    expect(outcomeOf(true, true, 'none')).toBe('clean');
    expect(outcomeOf(true, false, 'none')).toBe('solved');
    expect(outcomeOf(true, true, 'hint')).toBe('solved');
    expect(outcomeOf(true, true, 'solution')).toBe('failed');
    expect(outcomeOf(false, false, 'none')).toBe('failed');
  });
  it('a sitting under 3 minutes with no accept, or flagged test, never counts', () => {
    expect(countsAsPractice(sit({ slug: 'two-sum', on: day(-1), minutes: 2 }), NOW)).toBe(false);
    expect(
      countsAsPractice(
        sit({ slug: 'two-sum', on: day(-1), minutes: 2, submits: ['accepted'] }),
        NOW,
      ),
    ).toBe(true);
    expect(countsAsPractice(sit({ slug: 'two-sum', on: day(-1), test: true }), NOW)).toBe(false);
    // An idle gap a reopen bridged isn't practice: 25 minutes on the clock, 23 of them away.
    const away = sit({ slug: 'two-sum', on: day(-1), minutes: 25 });
    expect(countsAsPractice({ ...away, idleMs: 23 * 60_000 }, NOW)).toBe(false);
    expect(
      attemptsOf(
        [sit({ slug: 'two-sum', on: day(-1), test: true, submits: ['accepted'] })],
        [],
        NOW,
      ),
    ).toEqual([]);
  });
  it('folds one problem’s same-day pieces into one first try: a fail then a clean redo is solved, a peek sticks', () => {
    const a = failed('two-sum', day(-1));
    const b = clean('two-sum', day(-1));
    b.startedAt = a.startedAt + 3600_000;
    b.endedAt = b.startedAt + 60_000 * 20;
    const [one] = attemptsOf([a, b], [], NOW);
    expect(one).toMatchObject({ outcome: 'solved', accepted: true, submits: 2 });
    const [cleanFirst] = attemptsOf([clean('two-sum', day(-1))], [], NOW);
    expect(cleanFirst!.outcome).toBe('clean');
    const peek = manual('two-sum', day(-1), 'failed', 'solution');
    const [stuck] = attemptsOf([a, b], [peek], NOW);
    expect(stuck).toMatchObject({ outcome: 'failed', help: 'solution' });
    expect(attemptsOf([a, b], [peek], NOW)).toHaveLength(1);
  });
  it('a manual solved, then a first-submit accept the same day, is solved — not clean', () => {
    const [one] = attemptsOf(
      [clean('two-sum', day(-1))],
      [manual('two-sum', day(-1), 'solved')],
      NOW,
    );
    // the manual piece is logged at 20:00, after the 10:00 sitting: the earliest submitting piece is the sitting
    expect(one!.outcome).toBe('clean');
    const early = {
      ...manual('two-sum', day(-1), 'solved'),
      at: zonedEpoch(day(-1), '08:00', USER_TIME_ZONE),
    };
    const [two] = attemptsOf([clean('two-sum', day(-1))], [early], NOW);
    expect(two!.outcome).toBe('solved');
  });
  it('an open sitting is not an attempt yet', () => {
    expect(attemptsOf([sit({ slug: 'two-sum', on: TODAY, open: true })], [], NOW)).toEqual([]);
  });
  it('a quick peek still counts: under 3 minutes, never accepted, the solution read', () => {
    const quick = sit({ slug: 'two-sum', on: day(-1), minutes: 2, help: 'solution' });
    expect(countsAsPractice(quick, NOW)).toBe(true);
    const [r] = listRecords({ now: NOW, sittings: [quick], attempts: [] });
    expect(r).toMatchObject({ peeked: true, schedule: { track: 'retry', dueDay: TODAY } });
  });
});

describe('resolveState — every transition', () => {
  const s = (...xs: [string, 'clean' | 'solved' | 'failed'][]) =>
    resolveState(xs.map(([d, outcome]) => ({ day: d, outcome })));
  it('none → first clean or solved: clean track, step 0, due +3', () => {
    expect(s(['2026-11-01', 'clean'])).toMatchObject({
      track: 'clean',
      step: 0,
      dueDay: '2026-11-04',
    });
    expect(s(['2026-11-01', 'solved'])).toMatchObject({
      track: 'clean',
      step: 0,
      dueDay: '2026-11-04',
    });
  });
  it('none → first failed: retry track, step 0, due +1', () => {
    expect(s(['2026-11-01', 'failed'])).toMatchObject({
      track: 'retry',
      step: 0,
      dueDay: '2026-11-02',
    });
  });
  it('a clean re-solve steps on; past the last step it graduates', () => {
    expect(s(['2026-11-01', 'clean'], ['2026-11-04', 'clean'])).toMatchObject({
      step: 1,
      dueDay: '2026-11-11',
    });
    const g = s(
      ['2026-11-01', 'clean'],
      ['2026-11-04', 'clean'],
      ['2026-11-11', 'clean'],
      ['2026-11-25', 'clean'],
    );
    expect(g).toMatchObject({ graduated: true, lastDay: '2026-11-25', dueBy: null });
  });
  it('a solved re-solve repeats the same gap from its day', () => {
    expect(
      s(['2026-11-01', 'clean'], ['2026-11-04', 'clean'], ['2026-11-12', 'solved']),
    ).toMatchObject({
      step: 1,
      dueDay: '2026-11-19',
    });
  });
  it('a failed re-solve restarts the retry track', () => {
    expect(s(['2026-11-01', 'clean'], ['2026-11-04', 'failed'])).toMatchObject({
      track: 'retry',
      step: 0,
      dueDay: '2026-11-05',
    });
  });
  it('the last step carries a due window', () => {
    const last = s(['2026-11-01', 'clean'], ['2026-11-04', 'clean'], ['2026-11-11', 'clean']);
    expect(last).toMatchObject({ step: 2, dueDay: '2026-11-25', dueBy: '2026-12-02' });
  });
  it('a graduated problem that fails again restarts the retry track', () => {
    const g = s(
      ['2026-11-01', 'clean'],
      ['2026-11-04', 'clean'],
      ['2026-11-11', 'clean'],
      ['2026-11-25', 'clean'],
      ['2026-12-01', 'failed'],
    );
    expect(g).toMatchObject({ graduated: false, track: 'retry', step: 0, dueDay: '2026-12-02' });
  });
  it('a graduated problem stays dormant', () => {
    const g = s(
      ['2026-11-01', 'clean'],
      ['2026-11-04', 'clean'],
      ['2026-11-11', 'clean'],
      ['2026-11-25', 'clean'],
      ['2026-12-01', 'solved'],
    );
    expect(g).toMatchObject({ graduated: true, lastDay: '2026-12-01' });
  });
});

describe('planDay', () => {
  it('empty account: new problems in the first pattern, a stretch, no carry-over; floor = the new pick', () => {
    const t = planDay(input());
    expect(t.focus).toMatchObject({ pattern: 'arrays-hashing', day: 1, of: 3, source: 'engine' });
    expect(t.slots.map((s) => s.kind)).toEqual(['new', 'new', 'stretch', 'stretch']);
    expect(t.slots[0]).toMatchObject({ slug: 'contains-duplicate', status: 'open', capMin: 30 });
    expect(
      t.slots.filter((s) => s.kind === 'stretch').every((s) => s.difficulty === 'Medium'),
    ).toBe(true);
    expect(t.floor).toMatchObject({ slug: 'contains-duplicate', on: false, done: false });
    expect(t.due).toEqual([]);
    expect(t.momentum).toEqual({
      activeDays: 0,
      of: 7,
      lastActiveDay: null,
      missedYesterday: false,
    });
  });
  it('never picks a premium problem', () => {
    const premium = new Set(NEETCODE_150.filter((c) => c.premium).map((c) => c.slug));
    const seen = NEETCODE_150.filter((c) => c.pattern === 'arrays-hashing' && !c.premium).slice(
      0,
      6,
    );
    const t = planDay(input({ sittings: seen.map((c, i) => clean(c.slug, day(-30 + i))) }));
    expect(t.slots.some((s) => premium.has(s.slug))).toBe(false);
  });
  it('yesterday’s unaccepted problem is the carry-over and leaves the re-solve queue for today', () => {
    const t = planDay(input({ sittings: [failed('valid-anagram', day(-1))] }));
    expect(t.slots[0]).toMatchObject({ kind: 'carry-over', slug: 'valid-anagram' });
    expect(t.slots.filter((s) => s.slug === 'valid-anagram')).toHaveLength(1);
    expect(t.due).toEqual([]); // it's a slot today, not a due re-solve too
    expect(t.floor).toMatchObject({ slug: 'valid-anagram', kind: 'carry-over' });
  });
  it('yesterday’s sitting left open overnight counts on its day, so the plan is the same before and after it ends', () => {
    const open = sit({ slug: 'valid-anagram', on: day(-1), submits: ['wrong_answer'], open: true });
    open.startedAt = zonedEpoch(day(-1), '22:00', USER_TIME_ZONE); // still inside its 24 h window at NOW
    const ended = { ...open, status: 'done' as const, endedAt: open.startedAt + 20 * 60_000 };
    const a = planDay(input({ sittings: [open] }));
    expect(a.slots[0]).toMatchObject({ kind: 'carry-over', slug: 'valid-anagram' });
    expect(planDay(input({ sittings: [ended] })).slots).toEqual(a.slots);
  });
  it('two unfinished yesterday: one is the carry-over, the other stays a due re-solve', () => {
    const a = failed('valid-anagram', day(-1));
    const b = failed('group-anagrams', day(-1));
    b.startedAt = a.startedAt + 3600_000;
    b.endedAt = b.startedAt + 20 * 60_000;
    const t = planDay(input({ sittings: [a, b] }));
    expect(t.slots.filter((x) => x.kind === 'carry-over').map((x) => x.slug)).toEqual([
      'group-anagrams',
    ]);
    expect(t.due.map((q) => q.slug)).toEqual(['valid-anagram']);
    expect(t.slots.some((x) => x.slug === 'valid-anagram' && x.kind === 're-solve')).toBe(true);
  });
  it('a carry-over older than 2 days is just a due re-solve', () => {
    const t = planDay(input({ sittings: [failed('valid-anagram', day(-3))] }));
    expect(t.slots.map((s) => s.kind)).not.toContain('carry-over');
    expect(t.slots.find((s) => s.slug === 'valid-anagram')?.kind).toBe('re-solve');
  });
  it('a peeked problem is never a carry-over', () => {
    const peeked = sit({
      slug: 'valid-anagram',
      on: day(-1),
      submits: ['wrong_answer'],
      help: 'solution',
    });
    expect(kinds([peeked])).not.toContain('carry-over:valid-anagram');
  });
  it('re-solves come oldest due first, other patterns before the focus pattern', () => {
    const sittings = [
      clean('two-sum', day(-10)), // arrays (the focus), due day(-7)
      clean('valid-palindrome', day(-5)), // two pointers, due day(-2)
      clean('contains-duplicate', day(-4)), // arrays, due day(-1)
    ];
    const t = planDay(input({ sittings, focus: focusRow('arrays-hashing', TODAY) }));
    expect(t.focus.pattern).toBe('arrays-hashing');
    expect(t.due.map((q) => q.slug)).toEqual(['two-sum', 'valid-palindrome', 'contains-duplicate']);
    // One re-solve slot (no carry-over, so `new` takes the spare): the interleave picks the other pattern.
    expect(t.slots.filter((s) => s.kind === 're-solve').map((s) => s.slug)).toEqual([
      'valid-palindrome',
    ]);
    expect(t.floor?.slug).toBe('two-sum'); // the oldest due, whatever its pattern
    expect(t.slots.find((s) => s.kind === 're-solve')?.reason).toMatch(/blank editor, no hints/);
  });
  it('an empty re-solve queue lets the stretch take two; never more than 4, never padded', () => {
    const sittings = [clean('contains-duplicate', day(-1))];
    const t = planDay(input({ sittings }));
    expect(t.slots.map((s) => s.kind)).toEqual(['new', 'new', 'stretch', 'stretch']);
    expect(t.slots.length).toBeLessThanOrEqual(4);
  });
  it('holds still all day: today’s sittings mark slots, never move them', () => {
    const before = planDay(input({ sittings: [failed('valid-anagram', day(-1))] }));
    const doneNew = clean(before.slots[1]!.slug, TODAY);
    const after = planDay(input({ sittings: [failed('valid-anagram', day(-1)), doneNew] }));
    expect(after.slots.map((s) => s.slug)).toEqual(before.slots.map((s) => s.slug));
    expect(after.slots[1]).toMatchObject({
      status: 'done',
      outcome: 'clean',
      sittingId: doneNew.id,
    });
  });
  it('an open sitting on a slot is in-progress', () => {
    const t = planDay(
      input({ sittings: [sit({ slug: 'contains-duplicate', on: TODAY, open: true })] }),
    );
    expect(t.slots[0]).toMatchObject({ status: 'in-progress' });
  });
  it('a sitting on another problem is off-plan; the due list is unchanged', () => {
    const base = [clean('two-sum', day(-10))];
    const off = sit({ slug: 'rotting-oranges', on: TODAY, submits: ['accepted'] });
    const t = planDay(input({ sittings: [...base, off] }));
    expect(t.offPlan).toEqual([
      { sittingId: off.id, slug: 'rotting-oranges', title: off.problemTitle },
    ]);
    expect(t.due.map((q) => q.slug)).toEqual(
      planDay(input({ sittings: base })).due.map((q) => q.slug),
    );
  });
  it('a manual attempt counts toward momentum and the queue', () => {
    const t = planDay(input({ attempts: [manual('counting-bits', day(-2), 'clean')] }));
    expect(t.momentum).toMatchObject({
      activeDays: 1,
      lastActiveDay: day(-2),
      missedYesterday: true,
    });
    expect(t.next48h.map((q) => q.slug)).toEqual(['counting-bits']); // due day(+1)
  });
  it('a test sitting changes nothing', () => {
    const t = sit({ slug: 'valid-anagram', on: day(-1), submits: ['wrong_answer'], test: true });
    expect(planDay(input({ sittings: [t] })).slots).toEqual(planDay(input()).slots);
  });
  it('slots are due at the end of the user’s day (dayStartHour, their zone)', () => {
    const t = planDay(input());
    expect(t.slots[0]!.dueAt).toBe(zonedEpoch(day(1), '04:00', USER_TIME_ZONE));
  });
  it('unreviewed lists the last two days’ ended sittings with no cause tag', () => {
    const tagged = sit({ slug: 'two-sum', on: day(-1), submits: ['accepted'], cause: 'boundary' });
    const bare = failed('valid-anagram', TODAY);
    const old = failed('group-anagrams', day(-3));
    const t = planDay(input({ sittings: [tagged, bare, old] }));
    expect(t.unreviewed.map((u) => u.slug)).toEqual(['valid-anagram']);
  });
  it('the floor choice is the user’s, from the day row', () => {
    const row: CoachDay = {
      id: TODAY,
      userId: 'u',
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
      day: TODAY,
      floor: true,
      changes: [],
    };
    expect(planDay(input({ days: [row] })).floor?.on).toBe(true);
  });
});

describe('focus', () => {
  it('holds a pattern 3 active days, then the weakest first tries — never the same pattern twice running', () => {
    const sittings = [
      clean('contains-duplicate', day(-6)),
      failed('valid-palindrome', day(-5)), // two pointers: a missed first try
      clean('valid-anagram', day(-4)),
    ];
    const f = focusOn(attemptsOf(sittings, [], NOW), null, TODAY);
    expect(f).toMatchObject({ pattern: 'two-pointers', day: 1, source: 'engine' });
    expect(f.why).toMatch(/1 of 1 not clean/);
    const mid = focusOn(attemptsOf(sittings.slice(0, 2), [], NOW), null, TODAY);
    expect(mid).toMatchObject({ pattern: 'arrays-hashing', day: 3 });
  });
  it('an override holds from its day; after 3 active days the engine takes over again', () => {
    const f = focusOn([], { pattern: 'heap', sinceDay: TODAY }, TODAY);
    expect(f).toMatchObject({ pattern: 'heap', day: 1, source: 'override' });
    const three = [
      clean('kth-largest-element-in-a-stream', day(-3)),
      clean('last-stone-weight', day(-2)),
      clean('k-closest-points-to-origin', day(-1)),
    ];
    const after = focusOn(
      attemptsOf(three, [], NOW),
      { pattern: 'heap', sinceDay: day(-3) },
      TODAY,
    );
    expect(after.pattern).not.toBe('heap');
    expect(after).toMatchObject({ day: 1, source: 'engine' });
  });
  it('refuses an override on a pattern with nothing unseen left', () => {
    const tries = NEETCODE_150.filter((c) => c.pattern === 'tries');
    const ci = input({ sittings: tries.map((c, i) => clean(c.slug, day(-10 + i))) });
    expect(focusRoomError(ci, 'tries')).toMatch(/Nothing unseen/);
    expect(focusRoomError(ci, 'graphs')).toBeNull();
  });
  it('ranks by the shrunk miss rate, ties in roadmap order, exhausted patterns out', () => {
    const r = rankPatterns(attemptsOf([failed('valid-palindrome', day(-1))], [], NOW), TODAY);
    expect(r[0]).toMatchObject({ pattern: 'two-pointers', misses: 1, of: 1 });
    expect(r[1]!.pattern).toBe('arrays-hashing');
  });
  it('maps a non-catalog problem’s LeetCode tags to a pattern', () => {
    expect(patternOfTags(['Array', 'Shortest Path', 'Graph'])).toBe('advanced-graphs');
    expect(patternOfTags(['Database'])).toBe('other');
    expect(patternOfTags(null)).toBe('other');
  });
});

describe('reasons and kinds (F173)', () => {
  const ISO = /\d{4}-\d{2}-\d{2}/;
  it('reasons say days the way a person would, never a raw ISO date', () => {
    const t = planDay(
      input({
        sittings: [failed('valid-anagram', day(-1)), clean('valid-palindrome', day(-9))],
        focus: focusRow('arrays-hashing', day(-1)),
      }),
    );
    for (const x of t.slots) expect(x.reason).not.toMatch(ISO);
    expect(t.floor!.reason).not.toMatch(ISO);
    expect(t.focus.why).not.toMatch(ISO);
    expect(t.slots.find((x) => x.kind === 'carry-over')!.reason).toMatch(/from yesterday/);
  });
  it('a re-solve’s reason opens with today’s rule', () => {
    const t = planDay(input({ sittings: [clean('valid-palindrome', day(-5))] }));
    const r = t.slots.find((x) => x.kind === 're-solve')!;
    expect(r.reason).toMatch(/^Re-solve today: blank editor, no hints\. Due since /);
  });
  it('a swapped-in problem takes its own kind: unseen → new, a due one → re-solve', () => {
    const sittings = [clean('valid-palindrome', day(-5)), clean('two-sum', day(-6))];
    const t = planDay(input({ sittings, focus: focusRow('arrays-hashing', TODAY) }));
    const resolve = t.slots.find((x) => x.kind === 're-solve')!;
    const known = (slug: string) => NEETCODE_150.some((c) => c.slug === slug);
    const seen = new Set(['valid-palindrome', 'two-sum']);
    const row = (changes: CoachDay['changes']): CoachDay => ({
      id: TODAY,
      userId: 'u',
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
      day: TODAY,
      floor: false,
      changes,
    });
    const toNew = applySlotChange(
      t,
      [],
      { slug: resolve.slug, action: 'swap', toSlug: 'happy-number' },
      known,
      seen,
      NOW,
    );
    const a = planDay(
      input({ sittings, focus: focusRow('arrays-hashing', TODAY), days: [row(toNew)] }),
    );
    expect(a.slots.find((x) => x.swappedFrom === resolve.slug)).toMatchObject({
      slug: 'happy-number',
      kind: 'new',
    });
    const newSlot = t.slots.find((x) => x.kind === 'new')!;
    const other = resolve.slug === 'two-sum' ? 'valid-palindrome' : 'two-sum';
    const toDue = applySlotChange(
      t,
      [],
      { slug: newSlot.slug, action: 'swap', toSlug: other },
      known,
      seen,
      NOW,
    );
    const b = planDay(
      input({ sittings, focus: focusRow('arrays-hashing', TODAY), days: [row(toDue)] }),
    );
    const swapped = b.slots.find((x) => x.swappedFrom === newSlot.slug)!;
    expect(swapped).toMatchObject({ slug: other, kind: 're-solve' });
    expect(swapped.reason).toMatch(/blank editor, no hints/);
    // Restoring it by its slug still finds the slot, whatever kind it shows now.
    expect(applySlotChange(b, toDue, { slug: other, action: 'restore' }, known, seen, NOW)).toEqual(
      [],
    );
  });
  it('"easier" is strictly easier, the nearest level first; the same level only when nothing easier is left', () => {
    const none = new Set<string>();
    const fromHard = easierIn('arrays-hashing', 'Hard', none, none);
    expect(fromHard.length).toBeGreaterThan(0);
    expect(fromHard[0]!.difficulty).toBe('Medium');
    expect(fromHard.every((c) => c.difficulty !== 'Hard')).toBe(true);
    expect(
      easierIn('arrays-hashing', 'Medium', none, none).every((c) => c.difficulty === 'Easy'),
    ).toBe(true);
    // Easy has nothing easier: the same level.
    expect(
      easierIn('arrays-hashing', 'Easy', none, none).every((c) => c.difficulty === 'Easy'),
    ).toBe(true);
    const easies = new Set(
      NEETCODE_150.filter((c) => c.pattern === 'arrays-hashing' && c.difficulty === 'Easy').map(
        (c) => c.slug,
      ),
    );
    expect(
      easierIn('arrays-hashing', 'Medium', easies, none).every((c) => c.difficulty === 'Medium'),
    ).toBe(true);
  });
});

describe('slot changes', () => {
  const t = planDay(input());
  const seen = new Set<string>();
  const known = (slug: string) => NEETCODE_150.some((c) => c.slug === slug);
  it('swap with no target takes the next easier unseen problem in the pattern; restore removes it', () => {
    const stretch = t.slots.find((s) => s.kind === 'stretch')!;
    const changes = applySlotChange(
      t,
      [],
      { slug: stretch.slug, action: 'swap' },
      known,
      seen,
      NOW,
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: 'stretch', action: 'swap', from: stretch.slug });
    const row: CoachDay = {
      id: TODAY,
      userId: 'u',
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
      day: TODAY,
      floor: false,
      changes,
    };
    const after = planDay(input({ days: [row] }));
    const swapped = after.slots.find((s) => s.swappedFrom === stretch.slug)!;
    expect(swapped.slug).toBe(changes[0]!.to);
    expect(swapped.kind).toBe('stretch'); // an unseen problem in a stretch slot stays a stretch
    // A second swap takes its kind from the engine's slot, not from what was swapped in.
    const seenTwo = new Set(['two-sum']);
    const viaTried = applySlotChange(
      after,
      changes,
      { slug: swapped.slug, action: 'swap', toSlug: 'two-sum' },
      known,
      seenTwo,
      NOW,
    );
    const tried = planDay(
      input({ sittings: [clean('two-sum', day(-1))], days: [{ ...row, changes: viaTried }] }),
    );
    expect(tried.slots.find((s) => s.swappedFrom === stretch.slug)).toMatchObject({
      slug: 'two-sum',
      kind: 're-solve',
    });
    const back = applySlotChange(
      tried,
      viaTried,
      { slug: 'two-sum', action: 'swap', toSlug: 'happy-number' },
      known,
      seenTwo,
      NOW,
    );
    const third = planDay(
      input({ sittings: [clean('two-sum', day(-1))], days: [{ ...row, changes: back }] }),
    );
    expect(third.slots.find((s) => s.swappedFrom === stretch.slug)).toMatchObject({
      slug: 'happy-number',
      kind: 'stretch',
    });
    expect(
      applySlotChange(after, changes, { slug: swapped.slug, action: 'restore' }, known, seen, NOW),
    ).toEqual([]);
  });
  it('“Another” after a swap never offers back the pick it replaced', () => {
    const first = t.slots[0]!; // contains-duplicate (Easy)
    expect(first.alternatives.map((a) => a.slug)).not.toContain(first.slug);
    const row = (changes: CoachDay['changes']): CoachDay => ({
      id: TODAY,
      userId: 'u',
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
      day: TODAY,
      floor: false,
      changes,
    });
    const once = applySlotChange(
      t,
      [],
      { slug: first.slug, action: 'swap', toSlug: 'product-of-array-except-self' },
      known,
      seen,
      NOW,
    );
    const after = planDay(input({ days: [row(once)] }));
    const swappedIn = after.slots[0]!;
    expect(swappedIn).toMatchObject({
      slug: 'product-of-array-except-self',
      swappedFrom: first.slug,
    });
    expect(swappedIn.alternatives.map((a) => a.slug)).not.toContain(first.slug);
    // The easiest unseen Arrays problem not on the plan — never the replaced pick, first in catalog order.
    const twice = applySlotChange(
      after,
      once,
      { slug: swappedIn.slug, action: 'swap' },
      known,
      seen,
      NOW,
    );
    expect(twice).toEqual([expect.objectContaining({ from: first.slug, to: 'two-sum' })]);
  });
  it('a swap target that is another slot’s engine pick is refused; a slug matches the slot showing it first', () => {
    const [a, b] = [t.slots[0]!, t.slots[2]!];
    const swapA = applySlotChange(
      t,
      [],
      { slug: a.slug, action: 'swap', toSlug: 'two-sum' },
      known,
      seen,
      NOW,
    );
    const row: CoachDay = {
      id: TODAY,
      userId: 'u',
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
      day: TODAY,
      floor: false,
      changes: swapA,
    };
    const after = planDay(input({ days: [row] }));
    expect(() =>
      applySlotChange(
        after,
        swapA,
        { slug: b.slug, action: 'swap', toSlug: a.slug },
        known,
        seen,
        NOW,
      ),
    ).toThrow(/already/);
    const skipTwoSum = applySlotChange(
      after,
      swapA,
      { slug: 'two-sum', action: 'skip' },
      known,
      seen,
      NOW,
    );
    expect(skipTwoSum).toEqual([
      expect.objectContaining({ kind: a.kind, action: 'skip', from: a.slug }),
    ]);
  });
  it('the same swap twice is one change; skip replaces it', () => {
    const s = t.slots[0]!.slug;
    const once = applySlotChange(
      t,
      [],
      { slug: s, action: 'swap', toSlug: 'two-sum' },
      known,
      seen,
      NOW,
    );
    const twice = applySlotChange(
      t,
      once,
      { slug: s, action: 'swap', toSlug: 'two-sum' },
      known,
      seen,
      NOW,
    );
    expect(twice).toHaveLength(1);
    const skip = applySlotChange(t, twice, { slug: s, action: 'skip' }, known, seen, NOW);
    expect(skip).toEqual([expect.objectContaining({ action: 'skip', from: s, to: null })]);
  });
  it('refuses an unknown slot, an unknown problem, or a problem already on the plan', () => {
    expect(() =>
      applySlotChange(t, [], { slug: 'jump-game', action: 'skip' }, known, seen, NOW),
    ).toThrow(/No slot/);
    expect(() =>
      applySlotChange(
        t,
        [],
        { slug: t.slots[0]!.slug, action: 'swap', toSlug: 'not-a-real-problem' },
        known,
        seen,
        NOW,
      ),
    ).toThrow(/Unknown problem/);
    expect(() =>
      applySlotChange(
        t,
        [],
        { slug: t.slots[0]!.slug, action: 'swap', toSlug: t.slots[1]!.slug },
        known,
        seen,
        NOW,
      ),
    ).toThrow(/already/);
  });
});

describe('records', () => {
  it('a peek on one problem leaves a second problem’s schedule alone', () => {
    const base = [clean('two-sum', day(-3))];
    const a = listRecords({ now: NOW, sittings: base, attempts: [] });
    const b = listRecords({
      now: NOW,
      sittings: base,
      attempts: [manual('valid-anagram', TODAY, 'failed', 'solution')],
    });
    expect(b.find((r) => r.slug === 'two-sum')!.schedule).toEqual(a[0]!.schedule);
    expect(b.find((r) => r.slug === 'valid-anagram')).toMatchObject({
      peeked: true,
      schedule: { track: 'retry', dueDay: day(1) },
    });
  });
  it('a non-catalog problem keeps its own title and a tag pattern', () => {
    const [r] = listRecords({
      now: NOW,
      sittings: [
        sit({
          slug: 'some-graph-problem',
          on: day(-1),
          submits: ['accepted'],
          title: 'Some Graph Problem',
          tags: ['Graph'],
        }),
      ],
      attempts: [],
    });
    expect(r).toMatchObject({ inCatalog: false, title: 'Some Graph Problem', pattern: 'graphs' });
  });
  it('peekOf finds an earlier peek on the same problem and day', () => {
    const p = manual('two-sum', TODAY, 'failed', 'solution');
    expect(peekOf([p], { slug: 'two-sum', day: TODAY })).toBe(p);
    expect(peekOf([p], { slug: 'two-sum', day: day(-1) })).toBeNull();
  });
});

describe('stats', () => {
  // TODAY is a Monday (ISO week 47); everything from day(-7) to day(-1) is week 46.
  const peek = manual('valid-palindrome', day(-2), 'failed', 'solution');
  const sittings = [
    clean('two-sum', day(-7)),
    sit({ slug: 'valid-anagram', on: day(-6), submits: ['wrong_answer'], cause: 'boundary' }),
    clean('valid-anagram', TODAY),
    sit({ slug: '3sum', on: day(-1), submits: ['accepted'], test: true }), // a test sitting never counts
  ];
  const all = () => attemptsOf(sittings, [peek], NOW, undefined, TODAY);

  it('counts first tries and re-solves, clean only as a hit, per week and per pattern, weakest first', () => {
    expect(coachStats(all(), TODAY)).toEqual({
      from: null,
      to: TODAY,
      activeDays: 4,
      problems: 3,
      attempts: 4,
      firstTry: { hit: 1, of: 3 },
      resolve: { hit: 1, of: 1 },
      peeked: 1,
      causes: { boundary: 1 },
      untagged: 1, // the peek: went wrong, no cause
      weeks: [
        { week: '2026-W46', attempts: 3, firstTry: { hit: 1, of: 3 }, resolve: { hit: 0, of: 0 } },
        { week: '2026-W47', attempts: 1, firstTry: { hit: 0, of: 0 }, resolve: { hit: 1, of: 1 } },
      ],
      patterns: [
        {
          pattern: 'two-pointers', // 1 of 1 first tries missed: the weakest
          problems: 1,
          attempts: 1,
          firstTry: { hit: 0, of: 1 },
          resolve: { hit: 0, of: 0 },
          peeked: 1,
          causes: {},
          rank: 1,
          submitsPerTry: null, // a logged peek carries no submit, run or trace
          runBeforeSubmit: { hit: 0, of: 0 },
          traced: { hit: 0, of: 0 },
          weeks: [{ week: '2026-W46', firstTry: { hit: 0, of: 1 } }],
        },
        {
          pattern: 'arrays-hashing',
          problems: 2,
          attempts: 3,
          firstTry: { hit: 1, of: 2 },
          resolve: { hit: 1, of: 1 },
          peeked: 0,
          causes: { boundary: 1 },
          rank: 2, // ties the untried patterns, first in the roadmap order
          submitsPerTry: 1,
          runBeforeSubmit: { hit: 0, of: 3 },
          traced: { hit: 0, of: 0 },
          weeks: [{ week: '2026-W46', firstTry: { hit: 1, of: 2 } }], // today's is a re-solve
        },
      ],
      weakest: 'two-pointers',
      ranking: expect.arrayContaining(['two-pointers', 'arrays-hashing']),
    });
    expect(coachStats(all(), TODAY).ranking.slice(0, 2)).toEqual([
      'two-pointers',
      'arrays-hashing',
    ]);
  });
  it('weakest is the ranking’s top even with no row in range: all clean so far → an untried pattern', () => {
    const s = coachStats(attemptsOf([clean('two-sum', day(-2))], [], NOW), TODAY);
    expect(s.patterns.map((p) => p.pattern)).toEqual(['arrays-hashing']);
    expect(s.patterns[0]!.rank).toBeGreaterThan(1); // 1 of 1 clean: the strongest
    expect(s.weakest).toBe('two-pointers');
  });
  it('a range never turns a re-solve into a first try', () => {
    const s = coachStats(all(), TODAY, { from: TODAY });
    expect(s).toMatchObject({
      from: TODAY,
      attempts: 1,
      problems: 1,
      firstTry: { hit: 0, of: 0 },
      resolve: { hit: 1, of: 1 },
    });
    expect(coachStats(all(), TODAY, { from: day(-6), to: day(-2) })).toMatchObject({
      to: day(-2),
      attempts: 2,
      firstTry: { hit: 0, of: 2 },
      activeDays: 2,
    });
  });
  it('no attempts: zeros and empty lists, never a missing field', () => {
    expect(() => coachStats([], TODAY, { from: day(1) })).toThrow(/not be after/); // to defaults to today
    expect(coachStats([], TODAY)).toMatchObject({
      attempts: 0,
      firstTry: { hit: 0, of: 0 },
      weeks: [],
      patterns: [],
      causes: {},
    });
  });
  it('the range input', () => {
    expect(normalizeStatsRange(undefined)).toEqual({});
    expect(normalizeStatsRange({ from: day(-3) })).toEqual({ from: day(-3) });
    expect(() => normalizeStatsRange({ from: 'soon' })).toThrow(/from must be an ISO date/);
    expect(() => normalizeStatsRange({ from: TODAY, to: day(-1) })).toThrow(/not be after/);
    expect(() => normalizeStatsRange({ since: TODAY })).toThrow(/Unknown range field: since/);
    expect(() => normalizeStatsRange('2026-11-01')).toThrow(/must be an object/);
  });
  it('a record lists every try with its sitting and logged-attempt ids', () => {
    const recs = listRecords({ now: NOW, today: TODAY, sittings, attempts: [peek] });
    const va = recs.find((r) => r.slug === 'valid-anagram')!;
    expect(va.tries.map((t) => [t.day, t.outcome, t.cause])).toEqual([
      [day(-6), 'failed', 'boundary'],
      [TODAY, 'clean', null],
    ]);
    expect(va.tries[0]!.sittingIds).toEqual([sittings[1]!.id]);
    expect(recs.find((r) => r.slug === 'valid-palindrome')!.tries).toEqual([
      {
        day: day(-2),
        outcome: 'failed',
        help: 'solution',
        cause: null,
        minutes: null,
        note: null,
        historical: false,
        sittingIds: [],
        attemptIds: [peek.id],
        sources: ['peek-seed'],
      },
    ]);
  });
});

describe('inputs', () => {
  it('a manual attempt: defaults, bounds and the help/outcome rules', () => {
    expect(normalizeCoachAttempt({ slug: 'counting-bits', outcome: 'clean' }, TODAY)).toMatchObject(
      {
        day: TODAY,
        help: 'none',
        cause: null,
        minutes: null,
      },
    );
    const bad: [unknown, RegExp][] = [
      [{ slug: 'Counting Bits', outcome: 'clean' }, /slug/],
      [{ slug: 'counting-bits', outcome: 'great' }, /outcome/],
      [{ slug: 'counting-bits', outcome: 'clean', help: 'hint' }, /no help/],
      [{ slug: 'counting-bits', outcome: 'clean', help: 'solution' }, /no help/],
      [{ slug: 'counting-bits', outcome: 'solved', accepted: true }, /only for a peek/],
      [
        { slug: 'counting-bits', help: 'solution', outcome: 'solved', accepted: false },
        /contradicts/,
      ],
      [{ slug: 'counting-bits' }, /outcome/],
      [{ slug: 'counting-bits', outcome: 'clean', difficulty: 'Brutal' }, /difficulty/],
      [{ slug: 'counting-bits', outcome: 'clean', day: day(1) }, /after today/],
      [{ slug: 'counting-bits', outcome: 'clean', day: day(-61) }, /60 days/],
      [{ slug: 'counting-bits', outcome: 'clean', cause: 'tired' }, /cause/],
      [{ slug: 'counting-bits', outcome: 'clean', minutes: 0 }, /minutes/],
      [{ slug: 'counting-bits', outcome: 'clean', extra: 1 }, /Unknown/],
    ];
    for (const [v, re] of bad) expect(() => normalizeCoachAttempt(v, TODAY)).toThrow(re);
  });
  it('a peek in one call: help solution lands failed, and a solved peek keeps its accept', () => {
    expect(normalizeCoachAttempt({ slug: 'counting-bits', help: 'solution' }, TODAY)).toMatchObject(
      {
        outcome: 'failed',
        help: 'solution',
      },
    );
    const solved = normalizeCoachAttempt(
      { slug: 'counting-bits', help: 'solution', outcome: 'solved' },
      TODAY,
    );
    expect(solved).toMatchObject({ outcome: 'failed', accepted: true });
    expect(
      normalizeCoachAttempt({ slug: 'counting-bits', help: 'solution', accepted: true }, TODAY),
    ).toMatchObject({ outcome: 'failed', accepted: true });
    expect(
      normalizeCoachAttempt({ slug: 'counting-bits', help: 'solution', outcome: 'failed' }, TODAY),
    ).not.toHaveProperty('accepted');
  });
  it('an off-catalog title and difficulty are kept', () => {
    expect(
      normalizeCoachAttempt(
        {
          slug: 'made-up-problem',
          outcome: 'solved',
          title: 'Made Up Problem',
          difficulty: 'Hard',
        },
        TODAY,
      ),
    ).toMatchObject({ title: 'Made Up Problem', difficulty: 'Hard' });
  });
  it('the focus pattern and the review patch', () => {
    expect(normalizeFocusPattern('graphs')).toBe('graphs');
    expect(normalizeFocusPattern(null)).toBeNull();
    expect(() => normalizeFocusPattern('other')).toThrow(/pattern/);
    expect(() => normalizeReviewPatch({})).toThrow(/cause, help or test/);
    expect(() => normalizeReviewPatch({ cause: 'nope' })).toThrow(/cause/);
    expect(() => normalizeReviewPatch({ insight: 'x' })).toThrow(/Unknown/);
  });
});

describe('review merge (setSittingReview keeps what the coach set)', () => {
  const base = {
    insight: 'two pointers',
    help: 'none' as const,
    mistakes: [],
    howItWent: null,
    tags: [],
    draftUsed: false,
  };
  it('a form save without a cause keeps the stored one; an explicit null clears it', () => {
    const cur = mergeReview(null, { ...base, cause: 'boundary' }, 1)!;
    expect(mergeReview(cur, base, 2)).toMatchObject({ cause: 'boundary', updatedAt: 2 });
    expect(mergeReview(cur, { ...base, cause: null }, 3)).not.toHaveProperty('cause');
  });
  it('a patch onto no review makes one; clearing everything is null', () => {
    const r = patchReview(null, { cause: 'no-trace' }, 5);
    expect(r).toMatchObject({ cause: 'no-trace', help: 'none', mistakes: [], updatedAt: 5 });
    expect(patchReview(r, { cause: null }, 6)).toBeNull();
    expect(patchReview(null, { help: 'solution' }, 7)).toMatchObject({ help: 'solution' });
  });
  it('a form save that doesn’t send help keeps a peek set over MCP (F172); an explicit help replaces it', () => {
    const peeked = patchReview(null, { help: 'solution' }, 5);
    const noHelp = { ...base, help: undefined };
    expect(mergeReview(peeked, noHelp, 6)).toMatchObject({
      help: 'solution',
      insight: 'two pointers',
    });
    expect(mergeReview(peeked, { ...base, help: 'hint' }, 7)).toMatchObject({ help: 'hint' });
    expect(mergeReview(peeked, null, 8)).toBeNull(); // the form's explicit clear-all
  });
  it('a review with only the cause survives an empty form save', () => {
    const r = patchReview(null, { cause: 'off-by-one' }, 5);
    expect(mergeReview(r, null, 6)).toMatchObject({ cause: 'off-by-one' });
  });
});

describe('pattern detail (the Patterns tab)', () => {
  const tp = NEETCODE_150.filter((c) => c.pattern === 'two-pointers').map((c) => c.slug);
  const st = NEETCODE_150.filter((c) => c.pattern === 'stack').map((c) => c.slug);
  const withRuns = (s: Sitting, runsBeforeFirstSubmit: number) => ({
    ...s,
    summary: { ...s.summary, runs: runsBeforeFirstSubmit, runsBeforeFirstSubmit },
  });
  // The trace comment's fold (sittings.ts commentTrace): the only traced/untraced source.
  const withTrace = (s: Sitting, trace: 'traced' | 'none') => ({
    ...s,
    summary: { ...s.summary, commentTrace: trace },
  });
  const statsOf = (sittings: Sitting[], manualRows: CoachAttempt[] = [], range = {}) =>
    coachStats(attemptsOf(sittings, manualRows, NOW, undefined, TODAY), TODAY, range);
  const pat = (s: ReturnType<typeof statsOf>, p: string) =>
    s.patterns.find((x) => x.pattern === p)!;

  it('submits a try, run-before-submit and trace rate over the attempts with the data', () => {
    const s = statsOf([
      withTrace(
        withRuns(sit({ slug: tp[0]!, on: day(-5), submits: ['wrong_answer', 'accepted'] }), 2),
        'traced',
      ),
      withTrace(withRuns(sit({ slug: tp[1]!, on: day(-4), submits: ['accepted'] }), 0), 'none'),
      sit({ slug: tp[2]!, on: day(-3), minutes: 20 }), // never submitted: no submit, run or trace data
    ]);
    expect(pat(s, 'two-pointers')).toMatchObject({
      problems: 3,
      attempts: 3,
      submitsPerTry: 1.5,
      runBeforeSubmit: { hit: 1, of: 2 },
      traced: { hit: 1, of: 2 },
    });
  });

  it('an untraced submit is a miss; no comment data counts nowhere, and the card is never read', () => {
    const plain = clean(tp[3]!, day(-1));
    const cardTraced = {
      ...plain,
      summary: { ...plain.summary, coach: { config: null, trace: 'traced' as const, nudges: 0 } },
    };
    const s = statsOf([
      withTrace(clean(tp[0]!, day(-3)), 'none'),
      withTrace(clean(tp[1]!, day(-2)), 'none'),
      clean(tp[2]!, day(-1)),
      cardTraced,
    ]);
    expect(pat(s, 'two-pointers').traced).toEqual({ hit: 0, of: 2 });
  });

  it('a re-solve’s submits are its own try; a logged piece earlier the same day keeps the sitting’s run and trace', () => {
    const s = statsOf(
      [
        clean(st[0]!, day(-9)),
        withTrace(withRuns(sit({ slug: st[0]!, on: day(-2), submits: ['accepted'] }), 1), 'traced'),
      ],
      [{ ...manual(st[0]!, day(-2), 'solved'), at: zonedEpoch(day(-2), '08:00', USER_TIME_ZONE) }],
    );
    expect(pat(s, 'stack')).toMatchObject({
      attempts: 2,
      submitsPerTry: 1,
      runBeforeSubmit: { hit: 1, of: 2 },
      traced: { hit: 1, of: 1 },
    });
  });

  it('per-week first tries, oldest first; a re-solve is not a first try', () => {
    const s = statsOf([
      clean(st[0]!, '2026-11-02'),
      failed(st[1]!, '2026-11-03'),
      clean(st[1]!, '2026-11-10'), // re-solve: not in the week's first tries
      clean(st[2]!, '2026-11-11'),
    ]);
    expect(pat(s, 'stack').weeks).toEqual([
      { week: '2026-W45', firstTry: { hit: 1, of: 2 } },
      { week: '2026-W46', firstTry: { hit: 1, of: 1 } },
    ]);
  });

  it('manual attempts and peek seeds count as tries but carry no submit, run or trace data', () => {
    const s = statsOf(
      [],
      [manual(tp[0]!, day(-2), 'clean'), manual(tp[1]!, day(-1), 'failed', 'solution')],
    );
    expect(pat(s, 'two-pointers')).toMatchObject({
      attempts: 2,
      submitsPerTry: null,
      runBeforeSubmit: { hit: 0, of: 0 },
      traced: { hit: 0, of: 0 },
    });
  });

  it('test sittings never count, and the range bounds every field', () => {
    const s = statsOf(
      [
        withRuns(clean(tp[0]!, day(-10)), 1),
        withRuns(sit({ slug: tp[1]!, on: day(-2), submits: ['accepted'], test: true }), 1),
        withRuns(failed(tp[2]!, day(-1)), 0),
      ],
      [],
      { from: day(-3) },
    );
    expect(pat(s, 'two-pointers')).toMatchObject({
      attempts: 1,
      submitsPerTry: 1,
      runBeforeSubmit: { hit: 0, of: 1 },
      weeks: [{ week: expect.any(String), firstTry: { hit: 0, of: 1 } }],
    });
  });
});

describe('history-only solves', () => {
  const old = (slug: string, on: string, outcome: CoachAttempt['outcome'] = 'solved') => ({
    ...manual(slug, on, outcome),
    historical: true as const,
  });
  const AH = NEETCODE_150.filter((c) => c.pattern === 'arrays-hashing' && !c.premium);

  it('light a record with no schedule, and never reach the live attempts', () => {
    const recs = listRecords({
      now: NOW,
      today: TODAY,
      sittings: [],
      attempts: [old('two-sum', day(-400))],
    });
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      slug: 'two-sum',
      schedule: null,
      historical: { tries: 1, firstDay: day(-400), lastDay: day(-400) },
      lists: ['neetcode150'],
      lastOutcome: 'solved',
    });
    expect(recs[0]!.tries).toEqual([
      expect.objectContaining({ historical: true, outcome: 'solved' }),
    ]);
    expect(attemptsOf([], [old('two-sum', day(-400))], NOW)).toEqual([]);
  });

  it('leave the plan’s queue alone but are never offered as new', () => {
    const focus = focusRow('arrays-hashing', day(-1));
    const bare = planDay(input({ focus }));
    expect(bare.slots.find((s) => s.kind === 'new')!.slug).toBe(AH[0]!.slug);
    const t = planDay(
      input({ focus, attempts: AH.slice(0, 3).map((c) => old(c.slug, day(-200))) }),
    );
    expect(t.slots.find((s) => s.kind === 'new')!.slug).toBe(AH[3]!.slug);
    expect(t.due).toEqual([]);
    expect(t.next48h).toEqual([]);
    expect(t.momentum).toEqual(bare.momentum);
  });

  it('a later live try is a re-solve with a schedule of its own; stats never count the history', () => {
    const attempts = [old('two-sum', day(-300))];
    const sittings = [clean('two-sum', day(-5))];
    const recs = listRecords({ now: NOW, today: TODAY, sittings, attempts });
    expect(recs[0]!.schedule).toMatchObject({ track: 'clean', step: 0 });
    expect(recs[0]!.historical).toMatchObject({ tries: 1 });
    expect(recs[0]!.tries.map((t) => t.historical)).toEqual([true, false]);
    const live = attemptsOf(sittings, attempts, NOW);
    const ci = input({ sittings, attempts });
    const stats = coachStats(live, TODAY, {}, coachScope(ci));
    expect(stats).toMatchObject({
      attempts: 1,
      firstTry: { hit: 0, of: 0 },
      resolve: { hit: 1, of: 1 },
    });
    expect(
      coachStats(attemptsOf([], attempts, NOW), TODAY, {}, coachScope(input({ attempts }))),
    ).toMatchObject({
      attempts: 0,
      problems: 0,
    });
  });

  it('a history-only piece on a day with a live try leaves that day’s outcome and schedule alone', () => {
    const sittings = [clean('two-sum', day(-4))];
    const attempts = [old('two-sum', day(-4), 'failed')];
    const [live] = attemptsOf(sittings, attempts, NOW);
    expect(live).toMatchObject({ outcome: 'clean', historical: false, attemptIds: [] });
    const [r] = listRecords({ now: NOW, today: TODAY, sittings, attempts });
    expect(r).toMatchObject({ lastOutcome: 'clean', attempts: 1, historical: { tries: 1 } });
    expect(r!.schedule).toEqual(
      listRecords({ now: NOW, today: TODAY, sittings, attempts: [] })[0]!.schedule,
    );
  });

  it('only a history-only solve dated before a live try makes it a re-solve', () => {
    // Live first (day -20), the history logged later with the default day: the live try stays a first try.
    const sittings = [clean('two-sum', day(-20))];
    const later = [old('two-sum', day(-1))];
    const live = attemptsOf(sittings, later, NOW);
    const scope = coachScope(input({ sittings, attempts: later }));
    expect(coachStats(live, TODAY, {}, scope)).toMatchObject({ firstTry: { hit: 1, of: 1 } });
    expect(
      rankPatterns(live, TODAY, scope).find((r) => r.pattern === 'arrays-hashing'),
    ).toMatchObject({
      of: 1,
    });
    // History dated before it: the live try is a re-solve.
    const earlier = [old('two-sum', day(-200))];
    const scope2 = coachScope(input({ sittings, attempts: earlier }));
    expect(coachStats(live, TODAY, {}, scope2)).toMatchObject({
      firstTry: { of: 0 },
      resolve: { hit: 1, of: 1 },
    });
    expect(
      rankPatterns(live, TODAY, scope2).find((r) => r.pattern === 'arrays-hashing'),
    ).toMatchObject({
      of: 0,
    });
    expect(patternDetail(live, null, TODAY, scope).get('arrays-hashing')!.weeks).toHaveLength(1);
    expect(patternDetail(live, null, TODAY, scope2).get('arrays-hashing')!.weeks).toEqual([]);
  });

  it('mark a problem seen for the focus ranking without counting as a first try', () => {
    const all = AH.map((c) => old(c.slug, day(-100)));
    const scope = coachScope(input({ attempts: all }));
    expect(rankPatterns([], TODAY, scope).some((r) => r.pattern === 'arrays-hashing')).toBe(false);
    expect(rankPatterns([], TODAY).find((r) => r.pattern === 'arrays-hashing')).toMatchObject({
      of: 0,
    });
    expect(focusRoomError(input({ attempts: all }), 'arrays-hashing')).toMatch(/Nothing unseen/);
  });

  it('count as seen and known for a swap', () => {
    const { seen, known } = slotChangeInputs(input({ attempts: [old('jump-game', day(-90))] }));
    expect(seen.has('jump-game')).toBe(true);
    expect(known('some-off-list-problem')).toBe(false);
    const off = slotChangeInputs(input({ attempts: [old('some-off-list-problem', day(-90))] }));
    expect(off.known('some-off-list-problem')).toBe(true);
  });

  it('the input: a flag, up to 10 years back; live stays at 60 days', () => {
    expect(
      normalizeCoachAttempt(
        { slug: 'two-sum', outcome: 'solved', day: day(-400), historical: true },
        TODAY,
      ),
    ).toMatchObject({ historical: true, day: day(-400) });
    expect(normalizeCoachAttempt({ slug: 'two-sum', outcome: 'solved' }, TODAY)).not.toHaveProperty(
      'historical',
    );
    expect(
      normalizeCoachAttempt({ slug: 'two-sum', outcome: 'solved', historical: false }, TODAY),
    ).not.toHaveProperty('historical');
    expect(() =>
      normalizeCoachAttempt({ slug: 'two-sum', outcome: 'solved', day: day(-61) }, TODAY),
    ).toThrow(/last 60 days .*historical true/);
    expect(() =>
      normalizeCoachAttempt(
        {
          slug: 'two-sum',
          outcome: 'solved',
          day: day(-ATTEMPT_HISTORY_DAYS - 1),
          historical: true,
        },
        TODAY,
      ),
    ).toThrow(/last 10 years/);
    expect(() =>
      normalizeCoachAttempt({ slug: 'two-sum', outcome: 'solved', historical: 'yes' }, TODAY),
    ).toThrow(/historical must be true or false/);
    // Dated before today: default yesterday; today refused, so it reads as seen before today's plan.
    expect(
      normalizeCoachAttempt({ slug: 'two-sum', outcome: 'solved', historical: true }, TODAY).day,
    ).toBe(day(-1));
    expect(() =>
      normalizeCoachAttempt(
        { slug: 'two-sum', outcome: 'solved', historical: true, day: TODAY },
        TODAY,
      ),
    ).toThrow(/dated before today/);
  });

  it('a peek and a history-only peek on one day are two rows', () => {
    const live = manual('two-sum', day(-3), 'failed', 'solution');
    expect(peekOf([live], { slug: 'two-sum', day: day(-3), historical: true })).toBeNull();
    expect(peekOf([live], { slug: 'two-sum', day: day(-3) })).toBe(live);
  });
});

describe('LeetCode Premium', () => {
  const AH = NEETCODE_150.filter((c) => c.pattern === 'arrays-hashing');
  it('on: a swap’s default target may be a Premium problem; off, there is none', () => {
    const prem = AH.find((c) => c.premium)!;
    // The slot: another problem at the Premium one's level; everything else in the pattern already seen.
    const slot = AH.find((c) => !c.premium && c.difficulty === prem.difficulty)!;
    const seen = new Set(AH.filter((c) => !c.premium && c.slug !== slot.slug).map((c) => c.slug));
    const today = {
      slots: [
        {
          kind: 'new',
          slug: slot.slug,
          pattern: 'arrays-hashing',
          difficulty: slot.difficulty,
          swappedFrom: null,
        },
      ],
    } as unknown as ReturnType<typeof planDay>;
    const known = (slug: string) => NEETCODE_150.some((c) => c.slug === slug);
    const swap = { slug: slot.slug, action: 'swap' as const };
    expect(applySlotChange(today, [], swap, known, seen, NOW, true)).toEqual([
      expect.objectContaining({ action: 'swap', from: slot.slug, to: prem.slug }),
    ]);
    expect(() => applySlotChange(today, [], swap, known, seen, NOW)).toThrow(
      /No unseen problem left/,
    );
  });

  const premiumIdx = AH.findIndex((c) => c.premium);
  const before = AH.slice(0, premiumIdx).map((c, i) => clean(c.slug, day(-40 + i)));
  const focus = focusRow('arrays-hashing', day(-1));
  const newPick = (premium?: boolean) =>
    planDay(input({ sittings: before, focus, premium })).slots.find((s) => s.kind === 'new')?.slug;

  it('off (or absent): a Premium problem is never picked', () => {
    expect(newPick()).toBe(AH[premiumIdx + 1]!.slug);
    expect(newPick(false)).toBe(AH[premiumIdx + 1]!.slug);
  });
  it('on: a Premium problem is picked in its turn', () => {
    expect(newPick(true)).toBe(AH[premiumIdx]!.slug);
  });
  it('on: easier picks and the room check count Premium problems', () => {
    const seen = new Set(AH.filter((c) => !c.premium).map((c) => c.slug));
    expect(easierIn('arrays-hashing', 'Hard', seen, new Set())).toEqual([]);
    expect(easierIn('arrays-hashing', 'Hard', seen, new Set(), true).map((c) => c.slug)).toEqual(
      AH.filter((c) => c.premium).map((c) => c.slug),
    );
    const done = AH.filter((c) => !c.premium).map((c, i) => clean(c.slug, day(-60 + i)));
    expect(focusRoomError(input({ sittings: done }), 'arrays-hashing')).toMatch(/Nothing unseen/);
    expect(focusRoomError(input({ sittings: done, premium: true }), 'arrays-hashing')).toBeNull();
  });
});

describe('minutes on a try', () => {
  it('a sitting: to the first accept, else its length once ended, else none', () => {
    expect(sittingTryMinutes(clean('two-sum', day(-1)))).toBe(1); // accepted at the first minute
    expect(
      sittingTryMinutes(
        sit({ slug: 'two-sum', on: day(-1), submits: ['wrong_answer'], minutes: 42 }),
      ),
    ).toBe(42);
    expect(sittingTryMinutes(sit({ slug: 'two-sum', on: day(-1), open: true }))).toBeNull();
  });
  it('a day’s pieces sum; a logged try keeps its minutes and note', () => {
    const logged = {
      ...manual('two-sum', day(-2), 'solved'),
      minutes: 20,
      note: 'used a hash map',
    };
    const sittings = [
      sit({ slug: 'two-sum', on: day(-2), submits: ['wrong_answer'], minutes: 15 }),
    ];
    const [a] = attemptsOf(sittings, [logged], NOW);
    expect(a).toMatchObject({ minutes: 35, note: 'used a hash map', historical: false });
    const [r] = listRecords({ now: NOW, today: TODAY, sittings, attempts: [logged] });
    expect(r!.tries[0]).toMatchObject({ minutes: 35, note: 'used a hash map' });
  });
});
