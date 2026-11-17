import { describe, expect, it } from 'vitest';
import {
  attemptsOf,
  autoCatchUp,
  coachStats,
  claudeNotesText,
  COACH_PARAMS,
  legacyGroups,
  listRecords,
  normalizeClaudeNotes,
  normalizeCoachVoids,
  planDay,
} from './coach';
import type { CoachInput } from './coach';
import { legacyRow } from './coachLegacyFixtures';
import { addDays, USER_TIME_ZONE, zonedEpoch } from './dates';
import { emptySummary } from './sittings';
import type { CoachAttempt, CoachVoid, Sitting } from './types';

// Synthetic fixtures only: catalog slugs, made-up days and times.
const TODAY = '2026-11-16';
const NOW = zonedEpoch(TODAY, '12:00', USER_TIME_ZONE);
const day = (n: number) => addDays(TODAY, n);
const at = (d: string, hhmm = '10:00') => zonedEpoch(d, hhmm, USER_TIME_ZONE);
let seq = 0;
const id = () => `01K${String(++seq).padStart(23, '0')}`;

function logged(
  slug: string,
  on: string,
  outcome: CoachAttempt['outcome'],
  o: Partial<CoachAttempt> = {},
): CoachAttempt {
  const t = at(on, '20:00');
  return {
    id: id(),
    userId: 'u',
    createdAt: t,
    updatedAt: t,
    deletedAt: null,
    slug,
    title: null,
    day: on,
    at: t,
    outcome,
    help: 'none',
    cause: null,
    minutes: null,
    note: null,
    source: 'manual',
    ...o,
  };
}
function sitting(slug: string, on: string, accepted: boolean, o: Partial<Sitting> = {}): Sitting {
  const start = at(on);
  const v = {
    verdict: accepted ? ('accepted' as const) : ('wrong_answer' as const),
    statusMsg: null,
    passed: null,
    total: null,
    at: start + 60_000,
  };
  return {
    id: id(),
    userId: 'u',
    createdAt: start,
    updatedAt: start,
    deletedAt: null,
    day: on,
    startedAt: start,
    clientStartedAt: start,
    endedAt: start + 25 * 60_000,
    status: 'done',
    clientSittingId: id(),
    problemSlug: slug,
    problemTitle: slug,
    questionId: null,
    frontendId: null,
    difficulty: null,
    topicTags: null,
    lang: 'python3',
    repTaskId: id(),
    rollId: 'roll',
    prepTarget: 'General',
    lcSolveSessionId: null,
    shapedAt: start,
    summary: {
      ...emptySummary(),
      submits: 1,
      firstSubmit: v,
      lastSubmit: v,
      firstAcceptedAt: accepted ? v.at : null,
      submitsBeforeAccepted: accepted ? 0 : null,
      headEvents: 1,
    },
    review: null,
    ...o,
  };
}
const voidRow = (d: string, slug: string, v: boolean): CoachVoid => ({
  id: `${d}#${slug}`,
  userId: 'u',
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
  day: d,
  slug,
  void: v,
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
const attempts = (ci: CoachInput) =>
  attemptsOf(ci.sittings, ci.attempts, ci.now, COACH_PARAMS, ci.today, ci);

describe('legacy history', () => {
  const d = day(-20);
  const rows = [
    legacyRow('contains-duplicate', d, 'wrong_answer', at(d, '09:00'), 1),
    legacyRow('contains-duplicate', d, 'accepted', at(d, '09:05'), 2),
    legacyRow('valid-anagram', d, 'accepted', at(d, '09:30'), 3),
    legacyRow('two-sum', d, 'accepted', at(d, '08:00'), 4),
  ];

  it('folds each (day, slug) group into one attempt, judged by its first submit', () => {
    const list = attempts(input({ legacy: rows }));
    expect(list.map((a) => [a.slug, a.outcome, a.submits, a.sources])).toEqual([
      ['contains-duplicate', 'solved', 2, ['legacy']],
      ['valid-anagram', 'clean', 1, ['legacy']],
    ]);
  });

  it('two-sum is test data by default; a stored void: false lifts it, a void: true drops any group', () => {
    expect(attempts(input({ legacy: rows })).some((a) => a.slug === 'two-sum')).toBe(false);
    const lifted = attempts(input({ legacy: rows, voids: [voidRow(d, 'two-sum', false)] }));
    expect(lifted.find((a) => a.slug === 'two-sum')).toMatchObject({ outcome: 'clean' });
    const dropped = attempts(input({ legacy: rows, voids: [voidRow(d, 'valid-anagram', true)] }));
    expect(dropped.map((a) => a.slug)).toEqual(['contains-duplicate']);
  });

  it('the default never touches a logged two-sum, even on a legacy day', () => {
    const list = attempts(input({ legacy: rows, attempts: [logged('two-sum', d, 'solved')] }));
    expect(list.find((a) => a.slug === 'two-sum')).toMatchObject({
      outcome: 'solved',
      sources: ['manual'],
    });
  });

  it('a legacy group and a logged attempt on the same day count once: the capture judges the first try', () => {
    const list = attempts(
      input({ legacy: rows, attempts: [logged('contains-duplicate', d, 'clean')] }),
    );
    const cd = list.filter((a) => a.slug === 'contains-duplicate');
    expect(cd).toHaveLength(1);
    expect(cd[0]).toMatchObject({ outcome: 'solved', submits: 2 });
    expect(cd[0]!.sources.sort()).toEqual(['legacy', 'manual']);
  });

  it('a logged peek the same day still wins: the day is failed', () => {
    const peek = logged('valid-anagram', d, 'failed', { help: 'solution', source: 'peek-seed' });
    const list = attempts(input({ legacy: rows, attempts: [peek] }));
    expect(list.find((a) => a.slug === 'valid-anagram')).toMatchObject({
      outcome: 'failed',
      help: 'solution',
      accepted: true,
    });
  });

  it('legacy tries show in the records with their source, and tombstoned rows are skipped', () => {
    const dead = { ...rows[2]!, deletedAt: NOW };
    const recs = listRecords(input({ legacy: [rows[0]!, rows[1]!, dead] }));
    expect(recs.map((r) => r.slug)).toEqual(['contains-duplicate']);
    expect(recs[0]!.tries[0]!.sources).toEqual(['legacy']);
    // Stats and the day's plan read the same attempts.
    const ci = input({ legacy: rows });
    expect(coachStats(attempts(ci), TODAY)).toMatchObject({ attempts: 2, problems: 2 });
    const t = planDay(ci);
    expect(t.momentum.lastActiveDay).toBe(d);
  });

  it('legacyGroups lists every group with why it does not count', () => {
    const groups = legacyGroups(rows, [voidRow(d, 'valid-anagram', true)]);
    expect(groups.map((g) => [g.slug, g.counted, g.voidedBy, g.submits])).toEqual([
      ['contains-duplicate', true, null, 2],
      ['two-sum', false, 'default', 1],
      ['valid-anagram', false, 'you', 1],
    ]);
  });

  it('void inputs are validated as a batch', () => {
    expect(normalizeCoachVoids([{ day: d, slug: 'two-sum', void: false }])).toHaveLength(1);
    const bad: [unknown, RegExp][] = [
      [[], /non-empty/],
      [[{ day: 'today', slug: 'two-sum', void: true }], /YYYY-MM-DD/],
      [[{ day: d, slug: 'Two Sum', void: true }], /slug/],
      [[{ day: d, slug: 'two-sum', void: 'yes' }], /true or false/],
      [[{ day: d, slug: 'two-sum', void: true, x: 1 }], /Unknown/],
      [
        [
          { day: d, slug: 'two-sum', void: true },
          { day: d, slug: 'two-sum', void: false },
        ],
        /twice/,
      ],
    ];
    for (const [v, re] of bad) expect(() => normalizeCoachVoids(v)).toThrow(re);
  });
});

describe('a void sitting (review.test) and the re-solve schedule', () => {
  // A solve logged on day -10 starts the clean track (due day -7). Two quick test sittings on day -3, both
  // accepted first try, would fold into a clean re-solve: step 1, due day -3 + 7. Voided, the log alone decides.
  const log = logged('two-sum', day(-10), 'clean');
  const tests = [sitting('two-sum', day(-3), true), sitting('two-sum', day(-3), true)];
  const schedule = (s: Sitting[]) =>
    listRecords(input({ sittings: s, attempts: [log] })).find((r) => r.slug === 'two-sum')!
      .schedule;

  it('counted, the test sittings push the next due a week out', () =>
    expect(schedule(tests)).toMatchObject({ track: 'clean', step: 1, dueDay: day(4) }));

  it('voided, the log alone decides: due since day -7', () => {
    const voided = tests.map((s) => ({
      ...s,
      review: {
        insight: null,
        help: 'none' as const,
        mistakes: [],
        howItWent: null,
        tags: [],
        draftUsed: false,
        test: true,
        updatedAt: NOW,
      },
    }));
    expect(schedule(voided)).toMatchObject({ track: 'clean', step: 0, dueDay: day(-7) });
  });
});

describe('logged attempts: a peek after an accept, and an off-catalog problem', () => {
  it('a peek that was also accepted stays on the retry track but counts as ever accepted', () => {
    const peek = logged('counting-bits', day(-2), 'failed', {
      help: 'solution',
      accepted: true,
      source: 'peek-seed',
    });
    const rec = listRecords(input({ attempts: [peek] }))[0]!;
    expect(rec).toMatchObject({ everAccepted: true, peeked: true, lastOutcome: 'failed' });
    expect(rec.schedule).toMatchObject({ track: 'retry', dueDay: day(-1) });
  });

  it('an off-catalog title and difficulty survive a later untitled log', () => {
    const first = logged('made-up-problem', day(-5), 'solved', {
      title: 'Made Up Problem',
      difficulty: 'Hard',
    });
    const later = logged('made-up-problem', day(-1), 'clean');
    const rec = listRecords(input({ attempts: [first, later] }))[0]!;
    expect(rec).toMatchObject({ title: 'Made Up Problem', difficulty: 'Hard', inCatalog: false });
  });
});

describe('plan mode', () => {
  // Ten catalog problems failed on day -3: each is due on day -2 (the retry track's first gap).
  const TEN = [
    'contains-duplicate',
    'valid-anagram',
    'group-anagrams',
    'top-k-frequent-elements',
    'valid-palindrome',
    'valid-parentheses',
    'binary-search',
    'reverse-linked-list',
    'climbing-stairs',
    'invert-binary-tree',
  ];
  const failedTen = TEN.map((s) => logged(s, day(-3), 'failed'));
  const kinds = (ci: CoachInput) => planDay(ci).slots.map((s) => s.kind);

  it('auto: catch-up from 10 due', () => {
    const t = planDay(input({ attempts: failedTen }));
    expect(t.planMode).toEqual({
      setting: 'auto',
      mode: 'catch-up',
      due: 10,
      line: 'Catch-up: 10 due · auto',
    });
    expect(kinds(input({ attempts: failedTen }))).toEqual([
      'new',
      're-solve',
      're-solve',
      're-solve',
    ]);
  });

  it('auto: hysteresis holds catch-up between 5 and 9 due, and leaves it below 5', () => {
    // Clean re-solves on day -1 move problems off the due list (the clean track's next gap is days away).
    const fix = (n: number) => TEN.slice(0, n).map((s) => logged(s, day(-1), 'clean'));
    expect(planDay(input({ attempts: [...failedTen, ...fix(3)] })).planMode).toMatchObject({
      mode: 'catch-up',
      due: 7,
    });
    expect(planDay(input({ attempts: [...failedTen, ...fix(6)] })).planMode).toMatchObject({
      mode: 'balanced',
      due: 4,
    });
  });

  it('auto: 7 due with no earlier 10 stays balanced', () => {
    const seven = TEN.slice(0, 7).map((s) => logged(s, day(-3), 'failed'));
    expect(planDay(input({ attempts: seven })).planMode).toMatchObject({
      mode: 'balanced',
      due: 7,
    });
  });

  it('autoCatchUp replays only days before today', () => {
    const list = attempts(input({ attempts: failedTen }));
    expect(autoCatchUp(list, day(-2))).toBe(true);
    expect(autoCatchUp(list, day(-3))).toBe(false);
    expect(autoCatchUp([], TODAY)).toBe(false);
  });

  it('catch-up keeps the carry-over and one new, fills with re-solves, no stretch', () => {
    // A failed sitting yesterday is the carry-over.
    const ci = input({
      attempts: failedTen,
      sittings: [sitting('two-sum', day(-1), false)],
      planMode: 'catch-up',
    });
    expect(kinds(ci)).toEqual(['carry-over', 'new', 're-solve', 're-solve']);
  });

  it('forced balanced with 10 due keeps the usual mix: at most two re-solves, a stretch', () => {
    const k = kinds(input({ attempts: failedTen, planMode: 'balanced' }));
    expect(k.filter((x) => x === 're-solve').length).toBeLessThanOrEqual(2);
    expect(k).toContain('stretch');
    expect(planDay(input({ attempts: failedTen, planMode: 'balanced' })).planMode.line).toBe(
      'Balanced: 10 due',
    );
  });

  it('the floor is the oldest due re-solve in either mode', () => {
    for (const planMode of ['balanced', 'catch-up'] as const)
      expect(planDay(input({ attempts: failedTen, planMode })).floor?.kind).toBe('re-solve');
  });
});

describe("Claude's notes", () => {
  it('unnoted lists ended, counted sittings with no notes, newest first; void and open ones stay out', () => {
    const a = sitting('valid-anagram', day(-1), true);
    const b = sitting('two-sum', day(-2), false);
    const noted = sitting('climbing-stairs', day(-1), true, {
      claudeNotes: { text: 'Traced well.', updatedAt: NOW },
    });
    const open = sitting('binary-search', TODAY, false, {
      endedAt: null,
      status: 'active',
      startedAt: NOW - 60_000,
    });
    const old = sitting('valid-palindrome', day(-15), true);
    const t = planDay(input({ sittings: [b, a, noted, open, old] }));
    expect(t.unnoted.map((u) => u.slug)).toEqual(['valid-anagram', 'two-sum']);
  });

  it('notes keep their lines, fold blank runs, cap at 800 and clear on blank', () => {
    expect(claudeNotesText('  Line one  \r\n\r\n\r\n  line   two ')).toBe('Line one\n\nline two');
    expect(claudeNotesText('   ')).toBeNull();
    expect(claudeNotesText(null)).toBeNull();
    expect(() => claudeNotesText('x'.repeat(801))).toThrow(/800/);
    expect(() =>
      normalizeClaudeNotes([
        { sittingId: 's', text: 'a' },
        { sittingId: 's', text: 'b' },
      ]),
    ).toThrow(/twice/);
    expect(() => normalizeClaudeNotes([])).toThrow(/non-empty/);
    expect(() => normalizeClaudeNotes([{ sittingId: 's' }])).toThrow(/text is required/);
    expect(normalizeClaudeNotes([{ sittingId: 's', text: null }])).toEqual([
      { sittingId: 's', text: null },
    ]);
    expect(() =>
      normalizeClaudeNotes(
        Array.from({ length: 21 }, (_, i) => ({ sittingId: `s${i}`, text: 'a' })),
      ),
    ).toThrow(/20/);
  });
});
