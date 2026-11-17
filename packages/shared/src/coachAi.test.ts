import { describe, expect, it } from 'vitest';
import { AI_PICK_NOTICE, AI_PICK_STALE_MS, applySlotChange, planDay } from './coach';
import type { CoachInput } from './coach';
import {
  claimAiRow,
  coachAiPickOn,
  coachPickContext,
  pickResultOf,
  settleAiRow,
  standInCoachPick,
  startAiRow,
  validateCoachPick,
} from './coachAi';
import type { CoachPickContext } from './coachAi';
import { addDays, USER_TIME_ZONE, zonedEpoch } from './dates';
import { PATTERNS } from './neetcode150';
import type { CoachAttempt, CoachDay, CoachDayAi, CoachFocus } from './types';

// Synthetic fixtures only: catalog slugs, made-up days and times.
const TODAY = '2026-11-16';
const NOW = zonedEpoch(TODAY, '12:00', USER_TIME_ZONE);
const day = (n: number) => addDays(TODAY, n);
let seq = 0;
const id = () => `01J${String(++seq).padStart(23, '0')}`;
function manual(
  slug: string,
  on: string,
  outcome: CoachAttempt['outcome'],
  extra: Partial<CoachAttempt> = {},
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
    help: 'none',
    cause: null,
    minutes: null,
    note: null,
    source: 'manual',
    ...extra,
  };
}
const dayRow = (d: string, ai?: CoachDayAi, changes: CoachDay['changes'] = []): CoachDay => ({
  id: d,
  userId: 'u',
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
  day: d,
  floor: false,
  changes,
  ...(ai ? { ai } : {}),
});
const ai = (o: Partial<CoachDayAi> = {}): CoachDayAi => ({
  status: 'ok',
  claimId: 'c1',
  claimedAt: NOW - 60_000,
  startedAt: NOW - 59_000,
  settledAt: NOW - 30_000,
  model: 'claude-opus-5-5',
  picks: [],
  note: null,
  focus: null,
  oldestDue: null,
  reason: null,
  detail: null,
  usage: { input: 5000, output: 900 },
  ms: 29_000,
  ...o,
});
// History: a carry-over from yesterday (failed, unpeeked), two due re-solves (failed earlier, peeked track),
// and a clean first try that isn't due yet.
const history = [
  manual('two-sum', day(-4), 'failed', { minutes: 40, note: 'missed the hash map' }),
  manual('valid-anagram', day(-3), 'failed', { cause: 'boundary' }),
  manual('contains-duplicate', day(-2), 'clean', { minutes: 8 }),
  manual('group-anagrams', day(-1), 'failed'),
];
const input = (o: Partial<CoachInput> = {}): CoachInput => ({
  today: TODAY,
  now: NOW,
  dayStartHour: 4,
  sittings: [],
  attempts: history,
  days: [],
  focus: null,
  aiPick: true,
  aiCanStart: true,
  ...o,
});
const ctxOf = (o: Partial<CoachInput> = {}) => coachPickContext(input(o));

describe('the candidates and the context', () => {
  it('cuts the candidates from the rules’ pools, one kind each', () => {
    const ctx = ctxOf();
    const kinds = Object.fromEntries(ctx.candidates.map((c) => [c.slug, c.kind]));
    expect(kinds['group-anagrams']).toBe('carry-over');
    expect(kinds['two-sum']).toBe('re-solve');
    expect(kinds['valid-anagram']).toBe('re-solve');
    expect(kinds['contains-duplicate']).toBeUndefined(); // clean, not due
    expect(ctx.candidates.filter((c) => c.kind === 'new' && !c.ifFocus).length).toBeLessThanOrEqual(
      5,
    );
    expect(new Set(ctx.candidates.map((c) => c.slug)).size).toBe(ctx.candidates.length);
    expect(ctx.oldestDue).toBe('two-sum');
    expect(ctx.top3).toHaveLength(3);
  });

  it('offers the other top-3 patterns only behind a focus change, and none while a pick is held', () => {
    const free = ctxOf();
    const behind = free.candidates.filter((c) => c.ifFocus);
    expect(behind.length).toBeGreaterThan(0);
    for (const c of behind) {
      expect(free.top3).toContain(c.ifFocus);
      expect(c.ifFocus).not.toBe(free.focus.pattern);
    }
    const held: CoachFocus = {
      id: 'focus',
      userId: 'u',
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
      pattern: 'stack',
      sinceDay: TODAY,
      source: 'override',
    };
    const locked = ctxOf({ focus: held });
    expect(locked.focus).toMatchObject({ pattern: 'stack', locked: true });
    expect(locked.candidates.some((c) => c.ifFocus)).toBe(false);
  });

  it('carries the last two weeks with minutes, cap and notes, and no ids', () => {
    const ctx = ctxOf();
    expect(ctx.recent.map((r) => r.slug)).toEqual([
      'two-sum',
      'valid-anagram',
      'contains-duplicate',
      'group-anagrams',
    ]);
    expect(ctx.recent[0]).toMatchObject({ minutes: 40, capMin: 30, notes: 'missed the hash map' });
    expect(ctx.recent[1]).toMatchObject({ cause: 'boundary', minutes: null });
    expect(JSON.stringify(ctx)).not.toMatch(/01J/);
    expect(ctx.rates.length).toBeGreaterThan(0);
  });
});

describe('the guardrails', () => {
  const ctx = ctxOf();
  const ok = { picks: [{ slug: 'two-sum', why: 'Due the longest' }], note: null, focus: null };

  it('accepts candidates, takes each one’s kind, and repairs only text', () => {
    const v = validateCoachPick(
      {
        picks: [
          { slug: 'group-anagrams', why: `  ${'x'.repeat(200)}  ` },
          { slug: 'two-sum', why: '' },
        ],
        note: '  A light day.  ',
        focus: null,
      },
      ctx,
    );
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.picks.slice(0, 2).map((p) => p.kind)).toEqual(['carry-over', 're-solve']);
    expect(v.filled).toBe(2);
    expect(v.picks[0]!.why).toHaveLength(140);
    expect(v.picks[1]!.why).toMatch(/^Re-solve today/); // empty → the rule's reason
    expect(v.note).toBe('A light day.');
  });

  it('fills a short answer to four from the rules’ pick, keeping the model’s picks first and in order', () => {
    const v = validateCoachPick(
      {
        picks: [{ slug: 'valid-anagram', why: 'Boundary slip last time' }],
        note: null,
        focus: null,
      },
      ctx,
    );
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.picks).toHaveLength(4);
    expect(v.filled).toBe(3);
    expect(v.picks[0]).toMatchObject({ slug: 'valid-anagram', why: 'Boundary slip last time' });
    const rest = v.picks.slice(1).map((p) => p.slug);
    expect(rest).toEqual(ctx.rules.filter((x) => x !== 'valid-anagram').slice(0, 3));
    for (const p of v.picks.slice(1))
      expect(p.why).toBe(ctx.candidates.find((c) => c.slug === p.slug)!.rule);
    expect(v.picks.some((p) => ctx.candidates.find((c) => c.slug === p.slug)!.ifFocus)).toBe(false);
  });

  it('fills after a focus change from the new focus, never the old focus’s new problems', () => {
    const behind = ctx.candidates.find((c) => c.ifFocus)!;
    const to = behind.ifFocus!;
    const v = validateCoachPick(
      { picks: [{ slug: behind.slug, why: 'x' }], note: null, focus: { to, why: 'y' } },
      ctx,
    );
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.picks).toHaveLength(4);
    for (const p of v.picks) {
      const c = ctx.candidates.find((x) => x.slug === p.slug)!;
      expect(c.ifFocus === null || c.ifFocus === to).toBe(true);
      expect(c.kind === 'new' && !c.ifFocus && c.pattern === ctx.focus.pattern).toBe(false);
    }
    expect(
      v.picks.filter((p) => ctx.candidates.find((x) => x.slug === p.slug)!.ifFocus === to).length,
    ).toBeGreaterThan(1);
  });

  it('keeps an owed re-solve and fills around it', () => {
    const must = ctxOf({ days: [dayRow(day(-1), ai({ oldestDue: 'two-sum', picks: [] }))] });
    const v = validateCoachPick(
      { picks: [{ slug: 'two-sum', why: 'x' }], note: null, focus: null },
      must,
    );
    expect(v).toMatchObject({ ok: true, filled: 3 });
    if (v.ok) expect(v.picks[0]!.slug).toBe('two-sum');
  });

  it('stops at the candidates there are when fewer than four may be picked', () => {
    const few: CoachPickContext = {
      ...ctx,
      candidates: ctx.candidates.filter((c) => !c.ifFocus).slice(0, 2),
      rules: ctx.rules.slice(0, 2),
    };
    const v = validateCoachPick(
      { picks: [{ slug: few.candidates[0]!.slug, why: 'x' }], note: null, focus: null },
      few,
    );
    expect(v).toMatchObject({ ok: true, filled: 1 });
    if (v.ok) expect(v.picks).toHaveLength(2);
  });

  it('a full answer fills nothing', () => {
    const four = ctx.rules.slice(0, 4).map((slug) => ({ slug, why: 'x' }));
    expect(validateCoachPick({ picks: four, note: null, focus: null }, ctx)).toMatchObject({
      ok: true,
      filled: 0,
    });
  });

  it('rejects a pick that is not a candidate', () => {
    expect(
      validateCoachPick({ ...ok, picks: [{ slug: 'contains-duplicate', why: 'x' }] }, ctx),
    ).toEqual({ ok: false, code: 'not-candidate' });
    expect(validateCoachPick({ ...ok, picks: [{ slug: 'not-a-problem', why: 'x' }] }, ctx)).toEqual(
      {
        ok: false,
        code: 'not-candidate',
      },
    );
  });

  it('rejects duplicates, none, more than four, and a broken shape', () => {
    const many = ctx.candidates.slice(0, 5).map((c) => ({ slug: c.slug, why: 'x' }));
    expect(validateCoachPick({ ...ok, picks: [ok.picks[0], ok.picks[0]] }, ctx)).toMatchObject({
      code: 'duplicate',
    });
    expect(validateCoachPick({ ...ok, picks: [] }, ctx)).toMatchObject({ code: 'count' });
    expect(validateCoachPick({ ...ok, picks: many }, ctx)).toMatchObject({ code: 'count' });
    expect(validateCoachPick('nope', ctx)).toMatchObject({ code: 'shape' });
    expect(validateCoachPick({ ...ok, note: 3 }, ctx)).toMatchObject({ code: 'shape' });
  });

  it('allows a focus change only to another top-3 pattern, and only while no pick is held', () => {
    const other = ctx.top3.find((p) => p !== ctx.focus.pattern)!;
    const v = validateCoachPick({ ...ok, focus: { to: other, why: 'Weaker first tries' } }, ctx);
    expect(v).toMatchObject({ ok: true, focus: { from: ctx.focus.pattern, to: other } });
    const outside = PATTERNS.find((p) => !ctx.top3.includes(p))!;
    expect(validateCoachPick({ ...ok, focus: { to: outside, why: 'x' } }, ctx)).toMatchObject({
      code: 'focus-not-top3',
    });
    expect(
      validateCoachPick({ ...ok, focus: { to: ctx.focus.pattern, why: 'x' } }, ctx),
    ).toMatchObject({
      code: 'focus-held',
    });
    const locked: CoachPickContext = { ...ctx, focus: { ...ctx.focus, locked: true } };
    expect(validateCoachPick({ ...ok, focus: { to: other, why: 'x' } }, locked)).toMatchObject({
      code: 'focus-held',
    });
  });

  it('takes a pick behind a focus change only with that change', () => {
    const c = ctx.candidates.find((x) => x.ifFocus)!;
    const pick = { slug: c.slug, why: 'x' };
    expect(validateCoachPick({ ...ok, picks: [pick] }, ctx)).toMatchObject({ code: 'if-focus' });
    expect(
      validateCoachPick({ ...ok, picks: [pick], focus: { to: c.ifFocus, why: 'x' } }, ctx),
    ).toMatchObject({ ok: true });
  });

  it('won’t let the oldest due re-solve be skipped two AI days running', () => {
    const yesterday = dayRow(day(-1), ai({ oldestDue: 'two-sum', picks: [] }));
    const must = ctxOf({ days: [yesterday] });
    expect(must.mustInclude).toBe('two-sum');
    const skip = { picks: [{ slug: 'valid-anagram', why: 'x' }], note: null, focus: null };
    expect(validateCoachPick(skip, must)).toEqual({ ok: false, code: 'skipped-oldest-due' });
    expect(validateCoachPick(ok, must).ok).toBe(true);
    // Yesterday's pick had it: nothing is owed today.
    const had = dayRow(
      day(-1),
      ai({ oldestDue: 'two-sum', picks: [{ slug: 'two-sum', kind: 're-solve', why: 'x' }] }),
    );
    expect(ctxOf({ days: [had] }).mustInclude).toBeNull();
    // A fallback day isn't an AI day.
    const fell = dayRow(day(-1), ai({ status: 'fallback', oldestDue: 'two-sum' }));
    expect(ctxOf({ days: [fell] }).mustInclude).toBeNull();
  });

  it('turns a rejected answer into a fallback that names the guardrail, never the text', () => {
    const res = pickResultOf({ picks: [{ slug: 'nope', why: 'secret words' }] }, ctx, {
      model: 'm',
      usage: null,
      ms: 1,
    });
    expect(res).toMatchObject({ ok: false, reason: 'invalid', detail: 'not-candidate' });
    expect(JSON.stringify(res)).not.toMatch(/secret/);
  });

  it('passes its own stand-in', () => {
    const answer = standInCoachPick(ctx);
    const v = validateCoachPick(answer, ctx);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.picks[0]!.slug).toBe('group-anagrams');
  });
});

describe('the overlay and the view', () => {
  const picks = [
    { slug: 'valid-anagram', kind: 're-solve' as const, why: 'Boundary slip last time' },
    { slug: 'group-anagrams', kind: 'carry-over' as const, why: 'Finish it warm' },
  ];
  const okRow = dayRow(TODAY, ai({ picks, note: 'Two re-solves, then rest.' }));

  it('lays the stored pick over the rule slots, in its order, with its whys', () => {
    const t = planDay(input({ days: [okRow] }));
    expect(t.slots.map((s) => [s.slug, s.kind, s.aiWhy])).toEqual([
      ['valid-anagram', 're-solve', 'Boundary slip last time'],
      ['group-anagrams', 'carry-over', 'Finish it warm'],
    ]);
    expect(t.slots[0]!.reason).toMatch(/^Re-solve today/); // the rule's facts stay
    expect(t.ai).toMatchObject({
      status: 'ok',
      source: 'ai',
      note: 'Two re-solves, then rest.',
      notice: null,
    });
  });

  it('keeps the rules’ floor whatever the pick', () => {
    const rules = planDay(input({ aiPick: false }));
    expect(planDay(input({ days: [okRow] })).floor).toEqual(rules.floor);
  });

  it('keys a swap or skip on an AI slot by its pick', () => {
    const ci = input({ days: [okRow] });
    const changes = applySlotChange(
      planDay(ci),
      [],
      { slug: 'valid-anagram', action: 'skip' },
      () => true,
      new Set(),
      NOW,
    );
    const t = planDay(input({ days: [{ ...okRow, changes }] }));
    expect(t.slots.map((s) => [s.slug, s.status])).toEqual([
      ['valid-anagram', 'skipped'],
      ['group-anagrams', 'open'],
    ]);
  });

  it('ignores a stored pick with the setting off', () => {
    const t = planDay(input({ days: [okRow], aiPick: false }));
    expect(t.ai).toBeNull();
    expect(t.slots.every((s) => s.aiWhy === null)).toBe(true);
  });

  it('is due only on a pickable day with history, and never for a new user', () => {
    expect(planDay(input()).ai).toMatchObject({ status: 'due', source: 'rules', notice: null });
    expect(planDay(input({ aiCanStart: false })).ai).toBeNull();
    expect(planDay(input({ attempts: [] })).ai).toBeNull();
  });

  it('isn’t due once the day is under way on the rules: a slot change, or practice logged today', () => {
    const swapped = dayRow(TODAY, undefined, [
      { kind: 're-solve', action: 'skip', from: 'two-sum', to: null, at: NOW },
    ]);
    expect(planDay(input({ days: [swapped] })).ai).toBeNull();
    const practised = [...history, manual('contains-duplicate', TODAY, 'clean')];
    expect(planDay(input({ attempts: practised })).ai).toBeNull();
  });

  it('shows pending, then a stale claim as a timeout with the notice', () => {
    const pending = dayRow(
      TODAY,
      ai({ status: 'pending', claimedAt: NOW - 5_000, settledAt: null }),
    );
    expect(planDay(input({ days: [pending] })).ai).toMatchObject({
      status: 'pending',
      source: 'rules',
    });
    const stale = dayRow(
      TODAY,
      ai({ status: 'pending', claimedAt: NOW - AI_PICK_STALE_MS - 1, settledAt: null }),
    );
    expect(planDay(input({ days: [stale] })).ai).toMatchObject({
      status: 'fallback',
      reason: 'timeout',
      notice: AI_PICK_NOTICE,
    });
  });

  it('says a fallback out loud, with the rule slots', () => {
    const fell = dayRow(TODAY, ai({ status: 'fallback', reason: 'api', detail: 'HTTP 529' }));
    const t = planDay(input({ days: [fell] }));
    expect(t.ai).toMatchObject({
      status: 'fallback',
      source: 'rules',
      notice: AI_PICK_NOTICE,
      reason: 'api',
    });
    expect(t.slots).toEqual(planDay(input({ aiPick: false })).slots);
  });

  it('shows a focus change only while the focus it set holds', () => {
    const change = { from: 'arrays-hashing' as const, to: 'stack' as const, why: 'x' };
    const row = dayRow(TODAY, ai({ picks, focus: change }));
    const aiFocus: CoachFocus = {
      id: 'focus',
      userId: 'u',
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
      pattern: 'stack',
      sinceDay: TODAY,
      source: 'ai',
    };
    const t = planDay(input({ days: [row], focus: aiFocus }));
    expect(t.ai?.focusChange).toEqual(change);
    expect(t.focus).toMatchObject({ pattern: 'stack', source: 'ai' });
    expect(t.focus.why).toMatch(/Opus/);
    expect(planDay(input({ days: [row] })).ai?.focusChange).toBeNull();
  });
});

describe('the day row’s steps', () => {
  const blank = dayRow(TODAY);

  it('claims a day once, ever', () => {
    const claimed = claimAiRow(blank, 'c1', NOW)!;
    expect(claimed.ai).toMatchObject({ status: 'pending', claimId: 'c1', startedAt: null });
    expect(claimAiRow(claimed, 'c2', NOW)).toBeNull();
    const fell = settleAiRow(
      claimed,
      'c1',
      {
        ok: false,
        reason: 'api',
        detail: null,
        oldestDue: null,
        model: null,
        usage: null,
        ms: null,
      },
      NOW,
    )!;
    expect(claimAiRow(fell, 'c3', NOW)).toBeNull(); // a fallback stays a fallback
  });

  it('won’t claim a day a slot change reached first', () => {
    const changed = dayRow(TODAY, undefined, [
      { kind: 'new', action: 'skip', from: 'two-sum', to: null, at: NOW },
    ]);
    expect(claimAiRow(changed, 'c1', NOW)).toBeNull();
  });

  it('starts only its own live claim, once', () => {
    const claimed = claimAiRow(blank, 'c1', NOW)!;
    const started = startAiRow(claimed, 'c1', NOW + 1_000)!;
    expect(started.ai?.startedAt).toBe(NOW + 1_000);
    expect(startAiRow(started, 'c1', NOW + 2_000)).toBeNull(); // a redelivered event
    expect(startAiRow(claimed, 'other', NOW)).toBeNull();
    expect(startAiRow(claimed, 'c1', NOW + AI_PICK_STALE_MS + 1)).toBeNull();
  });

  it('settles only a pending claim it owns', () => {
    const claimed = claimAiRow(blank, 'c1', NOW)!;
    const res = {
      ok: true as const,
      picks: [],
      note: null,
      focus: null,
      oldestDue: 'two-sum',
      model: 'm',
      usage: { input: 1, output: 2 },
      ms: 3,
    };
    expect(settleAiRow(claimed, 'c2', res, NOW)).toBeNull();
    const done = settleAiRow(claimed, 'c1', res, NOW + 10)!;
    expect(done.ai).toMatchObject({
      status: 'ok',
      settledAt: NOW + 10,
      oldestDue: 'two-sum',
      usage: { input: 1, output: 2 },
    });
    expect(settleAiRow(done, 'c1', res, NOW + 20)).toBeNull();
  });

  it('reads an old settings row as on', () => {
    expect(coachAiPickOn({} as { coachAiPick: boolean })).toBe(true);
    expect(coachAiPickOn({ coachAiPick: false })).toBe(false);
  });
});

describe('the plan mode in the pick', () => {
  // Ten failed problems → ten due re-solves → Auto reads catch-up.
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
  ].map((s) => manual(s, day(-3), 'failed'));
  const ctx = ctxOf({ attempts: TEN });

  it('catch-up offers no stretch and says so in the context', () => {
    expect(ctx.planMode).toEqual({ mode: 'catch-up', due: 10 });
    expect(ctx.candidates.some((c) => c.kind === 'stretch')).toBe(false);
    expect(ctxOf().planMode.mode).toBe('balanced');
  });

  it('a catch-up pick keeps the mix: one new at most, no fewer re-solves than the rules', () => {
    const news = ctx.candidates.filter((c) => c.kind === 'new' && !c.ifFocus);
    const resolves = ctx.candidates.filter((c) => c.kind === 're-solve');
    const pick = (slugs: string[]) =>
      validateCoachPick({ picks: slugs.map((slug) => ({ slug, why: 'x' })), focus: null }, ctx);
    expect(pick([news[0]!.slug, ...resolves.slice(0, 3).map((c) => c.slug)]).ok).toBe(true);
    expect(pick([news[0]!.slug, news[1]!.slug, resolves[0]!.slug])).toEqual({
      ok: false,
      code: 'mix',
    });
    expect(pick([news[0]!.slug, resolves[0]!.slug])).toEqual({ ok: false, code: 'mix' });
  });

  it('the stand-in stays within the mix', () => {
    expect(validateCoachPick(standInCoachPick(ctx), ctx).ok).toBe(true);
  });

  it("carries Claude's notes on recent sittings, null when none", () => {
    expect(ctxOf().recent.every((r) => r.claudeNotes === null)).toBe(true);
  });
});
