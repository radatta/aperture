import { describe, expect, it } from 'vitest';
import {
  emptyLiveFields,
  emptySummary,
  foldLive,
  foldSummary,
  isHeadEvent,
  lcTimerState,
  normalizeSittingEvents,
  normalizeSittingStart,
  planSittingStart,
  reserveBudget,
  SITTING_ACTIVE_ERROR,
  SITTING_CAP_ERROR,
  SITTING_ENDED_ERROR,
  SITTING_EVENT_TIME_ERROR,
  SITTING_INGEST_WINDOW_MS,
  SITTING_MAX_EVENTS,
  SITTING_RAW_KEEP_MS,
  sittingElapsedMs,
  sittingIngestError,
  sittingRawExpiresAt,
  summarizeHeadEvents,
} from './sittings';
import type { NormalizedSittingEvent, SittingStartInput } from './sittings';
import type { Sitting, Task } from './types';
import { ulid } from './ulid';

const start = (over: Partial<SittingStartInput> = {}): SittingStartInput => ({
  clientSittingId: ulid(),
  problemSlug: 'two-sum',
  problemTitle: ' Two Sum ',
  lang: 'python3',
  startedAt: 1000,
  tzOffsetMinutes: 480,
  ...over,
});
const ev = (type: NormalizedSittingEvent['type'], at: number, payload: unknown = {}) =>
  normalizeSittingEvents({
    sittingId: 's',
    events: [
      type === 'replay'
        ? { id: ulid(), type, at, events: String(payload) }
        : { id: ulid(), type, at, payload },
    ],
  }).events[0]!;

describe('normalizeSittingStart', () => {
  it('trims, nulls the optional fields, and keeps the raw problem', () => {
    const n = normalizeSittingStart(start({ problem: { titleSlug: 'two-sum' } }));
    expect(n).toMatchObject({
      problemTitle: 'Two Sum',
      questionId: null,
      difficulty: null,
      topicTags: null,
      lcSolveSessionId: null,
      problem: { titleSlug: 'two-sum' },
    });
  });
  it('refuses a bad id, slug, tags, tz or an oversized problem', () => {
    expect(() => normalizeSittingStart(start({ clientSittingId: 'x' }))).toThrow(/valid id/);
    expect(() => normalizeSittingStart(start({ problemSlug: 'Two Sum' }))).toThrow(/malformed/);
    expect(() => normalizeSittingStart(start({ topicTags: Array(21).fill('a') }))).toThrow(/20/);
    expect(() => normalizeSittingStart(start({ tzOffsetMinutes: 2000 }))).toThrow(/range/);
    expect(() => normalizeSittingStart(start({ problem: 'x'.repeat(70_000) }))).toThrow(
      /too large/,
    );
  });
});

describe('normalizeSittingEvents', () => {
  it('refuses a duplicate id in one call, an unknown type and a snapshot without code', () => {
    const id = ulid();
    const snap = { id, type: 'snapshot' as const, at: 1, payload: { code: 'a' } };
    expect(() => normalizeSittingEvents({ sittingId: 's', events: [snap, snap] })).toThrow(
      /Duplicate/,
    );
    expect(() =>
      normalizeSittingEvents({ sittingId: 's', events: [{ ...snap, type: 'bogus' as never }] }),
    ).toThrow(/Unknown/);
    expect(() =>
      normalizeSittingEvents({ sittingId: 's', events: [{ ...snap, payload: {} }] }),
    ).toThrow(/needs its code/);
  });
  it('refuses a call over the byte budget', () => {
    const big = (i: number) => ({
      id: ulid(),
      type: 'run' as const,
      at: i,
      payload: { result: { pad: 'x'.repeat(90_000) } },
    });
    expect(() =>
      normalizeSittingEvents({ sittingId: 's', events: [big(1), big(2), big(3)] }),
    ).toThrow(/Too much/);
  });
});

describe('folds', () => {
  it('only judged, note and timer events move the head', () => {
    expect(['run', 'submit', 'note', 'timer'].every((t) => isHeadEvent(t as never))).toBe(true);
    expect(['snapshot', 'submitDetails', 'replay'].some((t) => isHeadEvent(t as never))).toBe(
      false,
    );
  });
  it('an unreadable result counts as other and holds its place as the first submit', () => {
    const s = foldSummary(emptySummary(), ev('submit', 5, { result: null }));
    const next = foldSummary(s, ev('submit', 6, { result: { status_code: 10 } }));
    expect(next.firstSubmit).toMatchObject({ verdict: 'other', at: 5 });
    expect(next).toMatchObject({ submits: 2, firstAcceptedAt: 6, submitsBeforeAccepted: 1 });
  });
  it('the summary recomputes from the head events whatever order they arrive in', () => {
    const wa = {
      id: 'b',
      type: 'submit' as const,
      at: 2,
      payload: { result: { status_code: 11 } },
    };
    const ac = {
      id: 'c',
      type: 'submit' as const,
      at: 3,
      payload: { result: { status_code: 10 } },
    };
    const run = { id: 'a', type: 'run' as const, at: 1, payload: {} };
    expect(summarizeHeadEvents([ac, run, wa])).toEqual(summarizeHeadEvents([run, wa, ac]));
    expect(summarizeHeadEvents([ac, run, wa])).toMatchObject({
      runsBeforeFirstSubmit: 1,
      firstSubmit: { verdict: 'wrong_answer' },
      submitsBeforeAccepted: 1,
    });
  });
  it('counts a restart as a rewrite, once', () => {
    const long = 'x'.repeat(400);
    let live = emptyLiveFields('s');
    for (const [code, at] of [
      [long, 1],
      ['short', 2],
      ['short!', 3],
    ] as const)
      live = foldLive(live, ev('snapshot', at, { code }), at);
    expect(live.facts).toMatchObject({ rewrites: 1, maxCodeLength: 6 });
    expect(live).toMatchObject({ version: 3, code: 'short!', receivedAt: 3 });
  });
  it('an unreadable replay chunk adds no facts', () => {
    const live = foldLive(emptyLiveFields('s'), ev('replay', 1, 'not json'), 9);
    expect(live).toMatchObject({ replayChunks: 1, receivedAt: 9, facts: { edits: 0 } });
  });
});

describe('lcTimerState', () => {
  it('reads a paused timer as its pauseMs, a running one as pauseMs plus the time since start', () => {
    expect(
      lcTimerState({ state: { mode: 'reverse', pauseMs: 5000, status: 'pause' } }, 0),
    ).toMatchObject({
      elapsedMs: 5000,
      status: 'pause',
    });
    expect(
      lcTimerState(
        { state: { mode: 'reverse', pauseMs: 5000, startTimestamp: 100, status: 'start' } },
        1100,
      ),
    ).toMatchObject({ elapsedMs: 6000 });
    expect(lcTimerState('nope', 0)).toBeNull();
  });
});

describe('ingest guards', () => {
  const sitting = { status: 'active', startedAt: 0, clientStartedAt: 0 } as Sitting;
  it('refuses an ended sitting, one past its window, and an event off its clock', () => {
    expect(sittingIngestError({ ...sitting, status: 'done' }, [], 1)).toBe(SITTING_ENDED_ERROR);
    expect(sittingIngestError(sitting, [], SITTING_INGEST_WINDOW_MS + 1)).toBe(SITTING_ENDED_ERROR);
    expect(sittingIngestError(sitting, [{ at: 1e21 }], 1)).toBe(SITTING_EVENT_TIME_ERROR);
    expect(sittingIngestError(sitting, [{ at: -2 * SITTING_INGEST_WINDOW_MS }], 1)).toBe(
      SITTING_EVENT_TIME_ERROR,
    );
    expect(sittingIngestError(sitting, [{ at: 5 }], 1)).toBeNull();
  });
  it('reserves a call in the budget, refusing one that would pass a cap', () => {
    expect(reserveBudget({ events: 1, bytes: 10 }, { count: 2, bytes: 5 })).toEqual({
      events: 3,
      bytes: 15,
    });
    expect(() =>
      reserveBudget({ events: SITTING_MAX_EVENTS, bytes: 0 }, { count: 1, bytes: 1 }),
    ).toThrow(SITTING_CAP_ERROR);
  });
  it('the raw bulk expires the keep past the ingest window, in epoch seconds', () => {
    expect(sittingRawExpiresAt({ startedAt: 0 })).toBe(
      (SITTING_INGEST_WINDOW_MS + SITTING_RAW_KEEP_MS) / 1000,
    );
  });
  it('elapsed runs to now while open and stops at the end', () => {
    expect(sittingElapsedMs({ startedAt: 100, endedAt: null }, 600)).toBe(500);
    expect(sittingElapsedMs({ startedAt: 100, endedAt: 300 }, 600)).toBe(200);
  });
});

describe('planSittingStart', () => {
  const H = 3600_000;
  const rep = (id: string, status: Task['status']) =>
    ({ id, status, rollId: 'r', deletedAt: null }) as Task;
  const open = (over: Partial<Sitting>): Sitting =>
    ({
      id: 's1',
      clientSittingId: 'c1',
      status: 'active',
      problemSlug: 'a',
      repTaskId: 't1',
      startedAt: 0,
      day: 'd',
      ...over,
    }) as Sitting;
  const plan = (sittings: Sitting[], tasks: Task[], slug = 'b', now = H) =>
    planSittingStart({ clientSittingId: 'new', problemSlug: slug }, 'd', sittings, tasks, 'r', now);

  it('refuses another problem while one is open on a live rep', () => {
    expect(() => plan([open({})], [rep('t1', 'in_progress')])).toThrow(SITTING_ACTIVE_ERROR);
  });
  it('ends an open sitting whose rep finished, then plans as if it were gone', () => {
    const p = plan([open({})], [rep('t1', 'done')]);
    expect(p.ends).toEqual([{ sitting: expect.objectContaining({ id: 's1' }), to: 'done' }]);
    expect(p.kind).toBe('spawn');
  });
  it('abandons one past its window and reuses its still-open rep', () => {
    const p = plan([open({})], [rep('t1', 'in_progress')], 'a', SITTING_INGEST_WINDOW_MS + 1);
    expect(p.ends.map((e) => e.to)).toEqual(['abandoned']);
    expect(p).toMatchObject({ kind: 'attach', rep: { id: 't1' } });
  });
  it('abandons a half-made Start on another problem, but resumes it on its own', () => {
    expect(plan([open({})], [], 'b').ends.map((e) => e.to)).toEqual(['abandoned']);
    expect(plan([open({})], [], 'a')).toMatchObject({ kind: 'resume', ends: [] });
  });
});
