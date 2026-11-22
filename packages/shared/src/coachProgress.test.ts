import { afterEach, describe, expect, it } from 'vitest';
import { loadCatalog, unloadCatalog } from './catalogs';
import { buildCatalog } from './lcCatalog';
import type { AttemptOutcome, HelpLevel } from './types';
import type { ProblemRecord, ProblemTry } from './coach';
import { capTimes, coverage, problemStatus, progressWeeks, PROGRESS_STAGES } from './coachProgress';
import { addDays, isoWeekKey } from './dates';
import { NEETCODE_150, PATTERNS } from './neetcode150';

// Synthetic fixtures only: catalog slugs and made-up days.
const TODAY = '2026-11-17'; // a Tuesday
const day = (n: number) => addDays(TODAY, n);
interface T {
  on: string;
  outcome: AttemptOutcome;
  help?: HelpLevel;
  accepted?: boolean;
  minutes?: number | null;
  cap?: number;
  historical?: boolean;
}
const tryOf = (t: T): ProblemTry => ({
  day: t.on,
  outcome: t.outcome,
  help: t.help ?? 'none',
  cause: null,
  accepted: t.accepted ?? t.outcome !== 'failed',
  minutes: t.minutes ?? null,
  capMin: t.cap ?? 30,
  note: null,
  historical: t.historical ?? false,
  sittingIds: [],
  attemptIds: [],
  sources: ['manual'],
});
// A record shaped as problemRecords builds it, enough for these folds.
function rec(slug: string, tries: T[], schedule: ProblemRecord['schedule'] = null): ProblemRecord {
  const all = tries.map(tryOf);
  const live = all.filter((t) => !t.historical);
  const old = all.filter((t) => t.historical);
  const base = live.length ? live : old;
  const last = base[base.length - 1]!;
  return {
    slug,
    title: slug,
    pattern: NEETCODE_150.find((c) => c.slug === slug)?.pattern ?? 'other',
    difficulty: null,
    inCatalog: NEETCODE_150.some((c) => c.slug === slug),
    attempts: base.length,
    firstDay: base[0]!.day,
    firstOutcome: base[0]!.outcome,
    everAccepted: base.some((t) => t.outcome !== 'failed'),
    firstSubmitAccepted: null,
    submits: 0,
    runs: 0,
    lastError: null,
    peeked: base.some((t) => t.help === 'solution'),
    cause: null,
    causes: {},
    lastDay: last.day,
    lastOutcome: last.outcome,
    schedule,
    historical: old.length
      ? { tries: old.length, firstDay: old[0]!.day, lastDay: old[old.length - 1]!.day }
      : null,
    lists: NEETCODE_150.some((c) => c.slug === slug) ? ['neetcode150'] : [],
    sittingIds: [],
    tries: all,
  };
}
const sched = (dueDay: string, graduated = false): ProblemRecord['schedule'] => ({
  track: 'clean',
  step: 0,
  lastDay: day(-3),
  dueDay,
  dueBy: null,
  graduated,
});

describe('problemStatus', () => {
  it('reads untried, each live outcome, peeked and history-only', () => {
    expect(problemStatus(null, TODAY)).toMatchObject({ state: 'untried', done: false });
    expect(problemStatus(rec('two-sum', [{ on: day(-1), outcome: 'clean' }]), TODAY)).toMatchObject(
      {
        state: 'clean',
        done: true,
      },
    );
    expect(problemStatus(rec('two-sum', [{ on: day(-1), outcome: 'solved' }]), TODAY).state).toBe(
      'solved',
    );
    expect(
      problemStatus(rec('two-sum', [{ on: day(-1), outcome: 'failed', help: 'solution' }]), TODAY),
    ).toMatchObject({ state: 'peeked', done: false });
    expect(
      problemStatus(rec('two-sum', [{ on: day(-1), outcome: 'failed' }]), TODAY),
    ).toMatchObject({
      state: 'not-yet',
      done: false,
    });
    expect(
      problemStatus(
        rec('two-sum', [{ on: day(-300), outcome: 'solved', historical: true }]),
        TODAY,
      ),
    ).toMatchObject({ state: 'earlier', done: true, dueSince: null, nextDue: null });
    expect(
      problemStatus(rec('two-sum', [{ on: day(-300), outcome: 'failed', historical: true }]), TODAY)
        .state,
    ).toBe('not-yet');
    // Accepted only with the solution read: a peek, never a solve.
    const peek = { on: day(-300), outcome: 'failed', help: 'solution', historical: true } as const;
    expect(problemStatus(rec('two-sum', [{ ...peek, accepted: true }]), TODAY)).toMatchObject({
      state: 'peeked',
      done: false,
    });
    expect(problemStatus(rec('two-sum', [peek]), TODAY).state).toBe('not-yet');
  });
  it('the newest live try sets the state; a clean or solved try keeps it done', () => {
    const r = rec('two-sum', [
      { on: day(-300), outcome: 'clean', historical: true },
      { on: day(-5), outcome: 'clean' },
      { on: day(-1), outcome: 'failed' },
    ]);
    expect(problemStatus(r, TODAY)).toMatchObject({ state: 'not-yet', done: true });
    const never = rec('two-sum', [
      { on: day(-5), outcome: 'failed' },
      { on: day(-1), outcome: 'failed', help: 'solution' },
    ]);
    expect(problemStatus(never, TODAY)).toMatchObject({ state: 'peeked', done: false });
  });
  it('due since, next due and graduated from the schedule', () => {
    const r = (s: ProblemRecord['schedule']) =>
      rec('two-sum', [{ on: day(-5), outcome: 'clean' }], s);
    expect(problemStatus(r(sched(TODAY)), TODAY)).toMatchObject({ dueSince: TODAY, nextDue: null });
    expect(problemStatus(r(sched(day(-2))), TODAY).dueSince).toBe(day(-2));
    expect(problemStatus(r(sched(day(3))), TODAY)).toMatchObject({
      dueSince: null,
      nextDue: day(3),
    });
    expect(problemStatus(r(sched(day(-2), true)), TODAY)).toMatchObject({
      dueSince: null,
      nextDue: null,
      graduated: true,
    });
  });
});

describe('coverage', () => {
  it('an empty account: the whole list untried, every roadmap pattern in order', () => {
    const c = coverage([], 'neetcode150', TODAY);
    expect(c).toMatchObject({ label: 'NeetCode 150', total: 150, done: 0, tried: 0, untried: 150 });
    expect(c.premium).toBe(NEETCODE_150.filter((p) => p.premium).length);
    expect(c.patterns.map((p) => p.pattern)).toEqual([...PATTERNS]);
    expect(c.offList).toEqual([]);
  });
  it('counts done, tried, due and off the list', () => {
    const c = coverage(
      [
        rec('two-sum', [{ on: day(-3), outcome: 'clean' }], sched(day(-1))),
        rec('valid-anagram', [{ on: day(-3), outcome: 'failed' }]),
        rec('contains-duplicate', [{ on: day(-400), outcome: 'solved', historical: true }]),
        rec('some-off-list-problem', [{ on: day(-2), outcome: 'clean' }]),
      ],
      'neetcode150',
      TODAY,
    );
    expect(c).toMatchObject({ total: 150, done: 2, tried: 1, untried: 147, due: 1 });
    const ah = c.patterns.find((p) => p.pattern === 'arrays-hashing')!;
    expect(ah).toMatchObject({ done: 2, tried: 1, due: 1 });
    expect(ah.problems.map((p) => p.problem.slug)).toEqual(
      NEETCODE_150.filter((p) => p.pattern === 'arrays-hashing').map((p) => p.slug),
    );
    expect(c.offList.map((r) => r.slug)).toEqual(['some-off-list-problem']);
  });
  it('a full list: everything done', () => {
    const all = NEETCODE_150.map((p) => rec(p.slug, [{ on: day(-10), outcome: 'clean' }]));
    expect(coverage(all, 'neetcode150', TODAY)).toMatchObject({
      done: 150,
      untried: 0,
      premium: 0,
    });
  });
  it('the stages hold every roadmap pattern once, in roadmap order', () => {
    expect(PROGRESS_STAGES.flatMap((s) => s.patterns)).toEqual([...PATTERNS]);
  });
});

describe('progressWeeks', () => {
  it('twelve weeks up to this one, empty ones included, Monday starts', () => {
    const w = progressWeeks([], TODAY);
    expect(w).toHaveLength(12);
    expect(w[11]).toMatchObject({ start: day(-1), week: isoWeekKey(TODAY), clean: 0 });
    expect(w[0]!.start).toBe(addDays(day(-1), -77));
  });
  it('splits outcomes; a first try only once and never after a history-only solve', () => {
    const w = progressWeeks(
      [
        rec('two-sum', [
          { on: day(-8), outcome: 'failed' },
          { on: day(-1), outcome: 'clean' },
        ]),
        rec('valid-anagram', [
          { on: day(-500), outcome: 'solved', historical: true },
          { on: TODAY, outcome: 'clean' },
        ]),
      ],
      TODAY,
    );
    const now = w[11]!;
    const last = w[10]!;
    expect(last).toMatchObject({ failed: 1, firstTry: { hit: 0, of: 1 }, resolve: { of: 0 } });
    expect(now).toMatchObject({ clean: 2, firstTry: { of: 0 }, resolve: { hit: 2, of: 2 } });
  });
  it('a history-only solve dated after the first live try leaves it a first try', () => {
    const w = progressWeeks(
      [
        rec('contains-duplicate', [
          { on: day(-20), outcome: 'clean' },
          { on: day(-1), outcome: 'solved', historical: true },
        ]),
      ],
      TODAY,
    );
    expect(w.reduce((n, x) => n + x.firstTry.of, 0)).toBe(1);
    expect(w.reduce((n, x) => n + x.resolve.of, 0)).toBe(0);
  });
});

describe('capTimes', () => {
  it('bins live minutes by share of the cap; history, untimed and pre-window tries stay out', () => {
    const c = capTimes(
      [
        rec('two-sum', [
          { on: day(-3), outcome: 'clean', minutes: 8 },
          { on: day(-2), outcome: 'clean', minutes: 30 },
          { on: day(-1), outcome: 'solved', minutes: 31 },
          { on: TODAY, outcome: 'failed', minutes: null },
        ]),
        rec('valid-anagram', [
          { on: day(-900), outcome: 'solved', minutes: 5, historical: true },
          { on: day(-200), outcome: 'solved', minutes: 9 },
          { on: day(-1), outcome: 'failed', minutes: 75 },
        ]),
      ],
      TODAY,
    );
    expect(c).toMatchObject({ timed: 4, inside: 2, medianMin: 31 });
    expect(c.bins.map((b) => b.label)).toEqual(['≤ ⅓', '⅓–⅔', '⅔–1×', '1–1.5×', '1.5–2×', '2×+']);
    expect(c.bins.map((b) => b.n)).toEqual([1, 0, 1, 1, 0, 1]);
    expect(c.bins.map((b) => b.over)).toEqual([false, false, false, true, true, true]);
  });
  it('each try against its own cap; a try on an edge falls in the lower bin', () => {
    const c = capTimes(
      [
        rec('two-sum', [
          { on: day(-6), outcome: 'clean', minutes: 15, cap: 45 }, // exactly ⅓
          { on: day(-5), outcome: 'clean', minutes: 16, cap: 45 },
          { on: day(-4), outcome: 'solved', minutes: 20, cap: 20 }, // exactly the cap: inside
          { on: day(-3), outcome: 'solved', minutes: 21, cap: 20 },
          { on: day(-2), outcome: 'failed', minutes: 60, cap: 30 }, // exactly 2×
          { on: day(-1), outcome: 'failed', minutes: 61, cap: 30 },
        ]),
      ],
      TODAY,
    );
    expect(c).toMatchObject({ timed: 6, inside: 3, medianMin: 21 });
    expect(c.bins.map((b) => b.n)).toEqual([1, 1, 1, 1, 1, 1]);
  });
  it('a 45-minute try reads inside a Medium cap and twice over an Easy re-solve', () => {
    const c = capTimes(
      [
        rec('two-sum', [{ on: day(-2), outcome: 'solved', minutes: 45, cap: 45 }]),
        rec('valid-anagram', [{ on: day(-1), outcome: 'solved', minutes: 45, cap: 10 }]),
      ],
      TODAY,
    );
    expect(c.inside).toBe(1);
    expect(c.bins.map((b) => b.n)).toEqual([0, 0, 1, 0, 0, 1]);
  });
  it('a try with no capMin (a pre-caps Lambda, the revert window) reads against 30', () => {
    const [r] = [rec('two-sum', [{ on: day(-1), outcome: 'solved', minutes: 31 }])];
    const bare = {
      ...r!,
      tries: r!.tries.map((t) => ({ ...t, capMin: undefined })),
    } as unknown as typeof r;
    const c = capTimes([bare!], TODAY);
    expect(c).toMatchObject({ timed: 1, inside: 0 });
    expect(c.bins.map((b) => b.n)).toEqual([0, 0, 0, 1, 0, 0]);
  });
  it('nothing timed: no median', () => {
    expect(capTimes([], TODAY)).toMatchObject({ timed: 0, inside: 0, medianMin: null });
  });
});

describe('coverage of the full catalog (a later list choice, F207)', () => {
  afterEach(() => unloadCatalog());

  it('is empty until loaded, then counts the loaded list by pattern, its `other` problems outside every card', () => {
    expect(coverage([], 'leetcode', TODAY)).toMatchObject({ label: 'All LeetCode', total: 0 });
    const row = (id: number, slug: string, tags: string[], algorithms = true) => ({
      id,
      slug,
      title: slug,
      difficulty: 'Medium' as const,
      premium: false,
      acRate: null,
      tags,
      algorithms,
    });
    loadCatalog(
      buildCatalog(
        [
          row(1, 'two-sum', ['Array']),
          row(9001, 'synthetic-heap', ['Heap (Priority Queue)']),
          row(9002, 'synthetic-query', ['Database'], false),
        ],
        new Map(),
      ),
      'rev',
    );
    const c = coverage([], 'leetcode', TODAY);
    expect(c.total).toBe(2);
    expect(c.patterns.find((p) => p.pattern === 'heap')!.total).toBe(1);
    expect(c.patterns.find((p) => p.pattern === 'arrays-hashing')!.total).toBe(1);
  });
});
