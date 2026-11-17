import { describe, expect, it } from 'vitest';
import {
  draftMistakes,
  firstSubmitCode,
  normalizeSittingReview,
  problemCompanies,
  problemStatementText,
  PROBLEM_STATEMENT_MAX,
  REVIEW_LINE_MAX,
  suggestedHelp,
  timelineOf,
  isSittingOpen,
  newestOfType,
  judgeDetail,
  JUDGE_ERROR_MAX,
  JUDGE_TEXT_MAX,
  emptyLiveFields,
  emptySummary,
  foldLive,
  foldSummary,
  isHeadEvent,
  lcTimerState,
  normalizeSittingEvents,
  normalizeSittingStart,
  extensionVersionOf,
  claimStart,
  reclaimStart,
  countStartAttempt,
  sittingStartsPerDay,
  lcStartAttemptsPerDay,
  idleCloseAt,
  idleEnd,
  idleClosedSitting,
  finishIdleClosed,
  mayBeIdle,
  reopenedSitting,
  sittingLastActivity,
  sittingReopenError,
  sittingReturns,
  SITTING_IDLE_MS,
  SITTING_IDLE_TAIL_MS,
  SITTING_REOPEN_ERROR,
  SITTING_REOPEN_REP_ERROR,
  emptyGate,
  LC_START_ATTEMPT_CAP_ERROR,
  LC_START_ATTEMPTS_PER_DAY,
  planSittingStart,
  releaseStart,
  reserveBudget,
  SITTING_START_CAP_ERROR,
  SITTING_STARTS_PER_DAY,
  SITTING_ACTIVE_ERROR,
  SITTING_CAP_ERROR,
  SITTING_ENDED_ERROR,
  SITTING_EVENT_TIME_ERROR,
  SITTING_INGEST_WINDOW_MS,
  SITTING_MAX_EVENTS,
  SITTING_RAW_KEEP_MS,
  sittingElapsedMs,
  sittingIngestError,
  sittingIngestPhase,
  eventsBeforeEnd,
  SITTING_END_GRACE_MS,
  SITTING_END_SKEW_MS,
  sittingRawExpiresAt,
  headRowOf,
  payloadError,
  summarizeHeadRows,
  traceCommentRow,
  utf8Bytes,
} from './sittings';
import type { NormalizedSittingEvent, SittingStartInput } from './sittings';
import type { Sitting, SittingEvent, Task } from './types';
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
    sittingId: ulid(),
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

describe('extensionVersionOf', () => {
  it('keeps x.y.z, trimmed; anything else is null and never a refusal', () => {
    expect(extensionVersionOf('2.2.0')).toBe('2.2.0');
    expect(extensionVersionOf(' 10.0.31 ')).toBe('10.0.31');
    for (const bad of ['v2.2.0', '2.2', '2.2.0-beta', '', '1234567.0.0', 2.2, null, undefined, {}])
      expect(extensionVersionOf(bad), String(bad)).toBeNull();
    expect(normalizeSittingStart(start({ extensionVersion: 'x'.repeat(30) })).extensionVersion).toBeNull();
    expect(normalizeSittingStart(start()).extensionVersion).toBeNull();
  });
});

describe('sizes and shapes', () => {
  it('measures UTF-8 bytes, not characters', () => {
    expect(utf8Bytes('é')).toBe(2);
    expect(utf8Bytes('汉')).toBe(3);
  });
  it('refuses payloads DynamoDB can’t store as given', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 25; i++) deep = [deep];
    expect(payloadError(deep)).toMatch(/too deep/);
    expect(payloadError({ n: 2 ** 60 })).toMatch(/unstorable/);
    expect(payloadError({ n: 1.5, s: 'ok', a: [1, { b: null }] })).toBeNull();
  });
});

describe('normalizeSittingEvents', () => {
  it('refuses a duplicate id in one call, an unknown type and a snapshot without code', () => {
    const id = ulid();
    const snap = { id, type: 'snapshot' as const, at: 1, payload: { code: 'a' } };
    expect(() => normalizeSittingEvents({ sittingId: ulid(), events: [snap, snap] })).toThrow(
      /Duplicate/,
    );
    expect(() =>
      normalizeSittingEvents({ sittingId: ulid(), events: [{ ...snap, type: 'bogus' as never }] }),
    ).toThrow(/Unknown/);
    expect(() =>
      normalizeSittingEvents({ sittingId: ulid(), events: [{ ...snap, payload: {} }] }),
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
      normalizeSittingEvents({ sittingId: ulid(), events: [big(1), big(2), big(3)] }),
    ).toThrow(/Too much/);
  });
});

describe('folds', () => {
  it('only judged, note, timer and coach events move the head', () => {
    expect(['run', 'submit', 'note', 'timer', 'coach'].every((t) => isHeadEvent(t as never))).toBe(
      true,
    );
    expect(['snapshot', 'submitDetails', 'replay'].some((t) => isHeadEvent(t as never))).toBe(
      false,
    );
  });
  it('an unreadable result counts as other and holds its place as the first submit', () => {
    const rows = [
      headRowOf('s', { id: 'a', type: 'submit', at: 5, payload: { result: null } }),
      headRowOf('s', { id: 'b', type: 'submit', at: 6, payload: { result: { status_code: 10 } } }),
    ];
    const next = rows.reduce(foldSummary, emptySummary());
    expect(next.firstSubmit).toMatchObject({ verdict: 'other', at: 5 });
    expect(next).toMatchObject({
      submits: 2,
      firstAcceptedAt: 6,
      submitsBeforeAccepted: 1,
      headEvents: 2,
    });
  });
  it('the summary recomputes from the head rows whatever order they arrive in', () => {
    const wa = headRowOf('s', {
      id: 'b',
      type: 'submit',
      at: 2,
      payload: { result: { status_code: 11 } },
    });
    const ac = headRowOf('s', {
      id: 'c',
      type: 'submit',
      at: 3,
      payload: { result: { status_code: 10 } },
    });
    const run = headRowOf('s', { id: 'a', type: 'run', at: 1, payload: {} });
    expect(summarizeHeadRows([ac, run, wa])).toEqual(summarizeHeadRows([run, wa, ac]));
    expect(summarizeHeadRows([ac, run, wa])).toMatchObject({
      runsBeforeFirstSubmit: 1,
      firstSubmit: { verdict: 'wrong_answer' },
      submitsBeforeAccepted: 1,
    });
  });
  describe('coach events', () => {
    const coach = (id: string, at: number, payload: unknown) =>
      headRowOf('s', { id, type: 'coach', at, payload });
    const submit = (id: string, at: number) =>
      headRowOf('s', { id, type: 'submit', at, payload: { result: { status_code: 11 } } });
    const trace = (empty: unknown, boundary: unknown, normal: unknown) => ({
      kind: 'trace',
      inputs: { empty, boundary, normal },
      ms: 40_000,
    });
    it('a head row keeps the kind, the traced count and the switches, never the text', () => {
      expect(coach('a', 1, trace('[]', '[1]', '[1,2,3]')).coach).toEqual({
        kind: 'trace',
        inputs: 3,
        config: null,
      });
      expect(coach('a', 1, trace('[]', '  ', null)).coach).toMatchObject({ inputs: 1 });
      expect(
        coach('a', 1, { kind: 'config', trace: true, hold: false, nudge: true }).coach,
      ).toEqual({
        kind: 'config',
        inputs: null,
        config: { trace: true, hold: false, nudge: true },
      });
      expect(coach('a', 1, { kind: 'config', trace: 'yes' }).coach!.config).toBeNull();
      expect(coach('a', 1, { kind: 'later-thing' }).coach!.kind).toBeNull();
      expect(coach('a', 1, null).coach!.kind).toBeNull();
      expect(submit('a', 1).coach).toBeNull();
    });
    it('three inputs before the first submit is traced; one or two partial; none or a skip, skipped', () => {
      const at = (p: unknown) => summarizeHeadRows([coach('a', 1, p), submit('b', 2)]).coach;
      expect(at(trace('[]', '[0]', '[1,2]'))).toEqual({ config: null, trace: 'traced', nudges: 0 });
      expect(at(trace('[]', null, '[1,2]'))!.trace).toBe('partial');
      expect(at(trace('', null, ' '))!.trace).toBe('skipped');
      expect(at({ kind: 'trace-skip', ms: 900 })!.trace).toBe('skipped');
    });
    it('the latest before the first submit wins; one after it changes nothing', () => {
      const skipThenTrace = summarizeHeadRows([
        coach('a', 1, { kind: 'trace-skip', ms: 1 }),
        coach('b', 2, trace('[]', '[0]', '[1]')),
        submit('c', 3),
        coach('d', 4, { kind: 'trace-skip', ms: 1 }),
      ]);
      expect(skipThenTrace.coach!.trace).toBe('traced');
    });
    it('a submit seen untraced is none, unless a trace or skip came first, whenever it lands', () => {
      expect(
        summarizeHeadRows([submit('a', 1), coach('b', 2, { kind: 'untraced-submit' })]).coach!
          .trace,
      ).toBe('none');
      expect(
        summarizeHeadRows([
          coach('a', 1, { kind: 'trace-skip', ms: 1 }),
          submit('b', 2),
          coach('c', 3, { kind: 'untraced-submit' }),
        ]).coach!.trace,
      ).toBe('skipped');
    });
    it('nudges count, the config is the latest readable one, and an unknown kind folds nothing', () => {
      const s = summarizeHeadRows([
        coach('a', 1, { kind: 'config', trace: true, hold: true, nudge: true }),
        coach('b', 2, { kind: 'nudge-shown', gapMs: 30_000 }),
        coach('c', 3, { kind: 'nudge-shown', gapMs: 20_000 }),
        coach('d', 4, { kind: 'config', hold: 1 }),
      ]);
      expect(s.coach).toEqual({
        config: { trace: true, hold: true, nudge: true },
        trace: null,
        nudges: 2,
      });
      expect(s.headEvents).toBe(4);
      const unknown = summarizeHeadRows([coach('a', 1, { kind: 'later-thing' })]);
      expect(unknown.coach).toBeUndefined();
      expect(unknown.headEvents).toBe(1);
    });
    it('a sitting with no coach events has no coach on its summary', () => {
      expect(summarizeHeadRows([submit('a', 1)]).coach).toBeUndefined();
    });
    it('a coach event is taken up to 4 KB, refused past it', () => {
      const ev = (n: number) => ({
        id: ulid(),
        type: 'coach' as const,
        at: 1,
        payload: { kind: 'trace', note: 'x'.repeat(n) },
      });
      expect(normalizeSittingEvents({ sittingId: ulid(), events: [ev(4000)] }).events).toHaveLength(
        1,
      );
      expect(() => normalizeSittingEvents({ sittingId: ulid(), events: [ev(4200)] })).toThrow(
        /coach event is too large/,
      );
    });
  });
  describe('a Run’s verdict', () => {
    // A Run's /check/ as captured 2026-11-08: status 10 "Accepted" means it ran; correct_answer says if it matched.
    const ran = (extra: Record<string, unknown>) => ({
      result: { status_code: 10, status_msg: 'Accepted', ...extra },
    });
    const row = (type: 'run' | 'submit', payload: unknown) =>
      headRowOf('s', { id: 'a', type, at: 1, payload });
    it('correct_answer false is a wrong answer, said so; true stays accepted', () => {
      expect(
        row('run', ran({ correct_answer: false, total_correct: 0, total_testcases: 3 })).verdict,
      ).toEqual({ verdict: 'wrong_answer', statusMsg: 'Wrong Answer', passed: 0, total: 3, at: 1 });
      expect(
        row('run', ran({ correct_answer: true, total_correct: 3, total_testcases: 3 })).verdict,
      ).toMatchObject({ verdict: 'accepted', statusMsg: 'Accepted' });
    });
    it('with no flag, fewer passed than run is wrong and all passed is accepted', () => {
      expect(row('run', ran({ total_correct: 1, total_testcases: 3 })).verdict).toMatchObject({
        verdict: 'wrong_answer',
        statusMsg: 'Wrong Answer',
      });
      expect(row('run', ran({ total_correct: 3, total_testcases: 3 })).verdict?.verdict).toBe(
        'accepted',
      );
      expect(row('run', ran({})).verdict?.verdict).toBe('accepted');
    });
    it('an errored Run and a Submit are left as LeetCode judged them', () => {
      expect(
        row('run', {
          result: { status_code: 15, status_msg: 'Runtime Error', correct_answer: false },
        }).verdict,
      ).toMatchObject({ verdict: 'runtime_error', statusMsg: 'Runtime Error' });
      expect(
        row('submit', ran({ correct_answer: false, total_correct: 0, total_testcases: 3 })).verdict,
      ).toMatchObject({ verdict: 'accepted', statusMsg: 'Accepted' });
    });
    it('folds into lastRun without touching the outcome', () => {
      const s = summarizeHeadRows([
        row('run', ran({ correct_answer: false, total_correct: 0, total_testcases: 3 })),
      ]);
      expect(s.lastRun).toMatchObject({ verdict: 'wrong_answer', passed: 0, total: 3 });
      expect(s).toMatchObject({ firstAcceptedAt: null, submits: 0 });
    });
  });
  it('trims a status message before it reaches the head', () => {
    const r = headRowOf('s', {
      id: 'a',
      type: 'submit',
      at: 1,
      payload: { result: { status_msg: 'x'.repeat(5000) } },
    });
    expect(r.verdict?.statusMsg).toHaveLength(200);
  });
  it('a repeated snapshot counts nothing but still lands its code when newest', () => {
    const live = foldLive(emptyLiveFields('s'), ev('snapshot', 1, { code: 'old' }), 1);
    const healed = foldLive(live, ev('snapshot', 5, { code: 'new' }), 9, false);
    expect(healed).toMatchObject({ version: 1, snapshots: 1, code: 'new', codeAt: 5 });
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
  const sitting = { status: 'active', startedAt: 0, clientStartedAt: 0, endedAt: null } as Sitting;
  const done = { ...sitting, status: 'done', endedAt: 0 } as Sitting;
  it('refuses a sitting past its grace or its window, and an event off its clock', () => {
    expect(sittingIngestError(done, [], SITTING_END_GRACE_MS + 1)).toBe(SITTING_ENDED_ERROR);
    expect(sittingIngestError(done, [{ at: 5 }], SITTING_END_GRACE_MS)).toBeNull();
    expect(sittingIngestError(sitting, [], SITTING_INGEST_WINDOW_MS + 1)).toBe(SITTING_ENDED_ERROR);
    expect(sittingIngestError(sitting, [{ at: 1e21 }], 1)).toBe(SITTING_EVENT_TIME_ERROR);
    expect(sittingIngestError(sitting, [{ at: -2 * SITTING_INGEST_WINDOW_MS }], 1)).toBe(
      SITTING_EVENT_TIME_ERROR,
    );
    // Inside the grace the bounds still cover every event, the ones that will be skipped too.
    expect(sittingIngestError(done, [{ at: 5 }, { at: 1e21 }], 1)).toBe(SITTING_EVENT_TIME_ERROR);
    expect(sittingIngestError(sitting, [{ at: 5 }], 1)).toBeNull();
  });
  it('after its end a sitting takes events for ten minutes, inside its window only', () => {
    expect(SITTING_END_GRACE_MS).toBe(10 * 60_000);
    const ended = { ...done, endedAt: 3600_000 };
    expect(sittingIngestPhase(sitting, 1)).toBe('open');
    expect(sittingIngestPhase(ended, 3600_000)).toBe('grace');
    expect(sittingIngestPhase(ended, 3600_000 + SITTING_END_GRACE_MS)).toBe('grace');
    expect(sittingIngestPhase(ended, 3600_000 + SITTING_END_GRACE_MS + 1)).toBe('closed');
    expect(sittingIngestPhase({ ...ended, status: 'abandoned' }, 3600_000 + 1)).toBe('grace');
    // Ended by a Start past its window (endedAt = that Start's now): no grace — the window is the ceiling.
    const stale = {
      ...done,
      status: 'abandoned',
      endedAt: SITTING_INGEST_WINDOW_MS + 1,
    } as Sitting;
    expect(sittingIngestPhase(stale, SITTING_INGEST_WINDOW_MS + 2)).toBe('closed');
    // The grace reaching past the window is cut at the window.
    const late = { ...done, endedAt: SITTING_INGEST_WINDOW_MS - 1 };
    expect(sittingIngestPhase(late, SITTING_INGEST_WINDOW_MS)).toBe('grace');
    expect(sittingIngestPhase(late, SITTING_INGEST_WINDOW_MS + 1)).toBe('closed');
    expect(sittingIngestPhase({ ...done, endedAt: null }, 1)).toBe('closed');
  });
  it('keeps the events stamped before the end, on the extension’s clock', () => {
    expect(SITTING_END_SKEW_MS).toBe(60_000);
    const ev = (at: number, id: string) => ({ at, id });
    // The server's Start at 10 h; ended at 11 h; the extension's clock 3 h behind, then 3 h ahead.
    const H = 3600_000;
    const behind = { ...done, startedAt: 10 * H, clientStartedAt: 7 * H, endedAt: 11 * H };
    const cutBehind = 8 * H + SITTING_END_SKEW_MS;
    expect(
      eventsBeforeEnd(behind, [
        ev(cutBehind, 'a'),
        ev(cutBehind + 1, 'b'),
        ev(7 * H + 1, 'c'),
        ev(10.5 * H, 'd'), // before the end on the server's clock, 2.5 h after it on the extension's
      ]).map((e) => e.id),
    ).toEqual(['a', 'c']);
    const ahead = { ...behind, clientStartedAt: 13 * H };
    const cutAhead = 14 * H + SITTING_END_SKEW_MS;
    expect(
      eventsBeforeEnd(ahead, [ev(13.5 * H, 'x'), ev(cutAhead + 1, 'y'), ev(cutAhead, 'z')]).map(
        (e) => e.id,
      ),
    ).toEqual(['x', 'z']);
    const all = [ev(1e15, 'p'), ev(0, 'q')];
    expect(eventsBeforeEnd({ ...behind, status: 'active', endedAt: null }, all)).toEqual(all);
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
    planSittingStart(
      { clientSittingId: 'new', problemSlug: slug },
      sittings,
      tasks,
      'r',
      now,
      () => true,
    );

  it('refuses another problem while one is open on a live rep', () => {
    expect(() => plan([open({})], [rep('t1', 'in_progress')])).toThrow(SITTING_ACTIVE_ERROR);
  });
  it('ends an open sitting whose rep finished, then plans as if it were gone', () => {
    const p = plan([open({})], [{ ...rep('t1', 'done'), completedAt: 1234 }]);
    // Ended when its rep finished, not now — its minutes don't stretch to the next Start.
    expect(p.ends).toEqual([
      { sitting: expect.objectContaining({ id: 's1' }), to: 'done', at: 1234 },
    ]);
    expect(p.kind).toBe('spawn');
  });
  it('abandons one past its window and reuses its still-open rep', () => {
    const p = plan([open({})], [rep('t1', 'in_progress')], 'a', SITTING_INGEST_WINDOW_MS + 1);
    expect(p.ends.map((e) => e.to)).toEqual(['abandoned']);
    expect(p).toMatchObject({ kind: 'attach', rep: { id: 't1' } });
  });
  it('abandons a half-made Start on another problem once it can’t be in flight, but resumes it on its own', () => {
    expect(() => plan([open({ startedAt: H - 1000 })], [], 'b')).toThrow(SITTING_ACTIVE_ERROR); // still writing
    expect(plan([open({})], [], 'b').ends.map((e) => e.to)).toEqual(['abandoned']);
    expect(plan([open({})], [], 'a')).toMatchObject({ kind: 'resume', ends: [] });
  });
});

describe('the Start gate', () => {
  const T = 10 * 60_000;
  it('counts attempts per day, resetting on a new day', () => {
    let g = emptyGate('d1');
    for (let i = 0; i < LC_START_ATTEMPTS_PER_DAY; i++) g = countStartAttempt(g, 'd1');
    expect(() => countStartAttempt(g, 'd1')).toThrow(LC_START_ATTEMPT_CAP_ERROR);
    expect(countStartAttempt(g, 'd2').attempts).toBe(1);
    expect(countStartAttempt(emptyGate('d2'), 'd1').day).toBe('d2'); // never rolls back
    expect(LC_START_ATTEMPTS_PER_DAY).toBe(400);
    const at = { ...emptyGate('d1'), attempts: 3999 };
    expect(countStartAttempt(at, 'd1', 4000).attempts).toBe(4000);
    expect(() => countStartAttempt({ ...at, attempts: 4000 }, 'd1', 4000)).toThrow(
      LC_START_ATTEMPT_CAP_ERROR,
    );
  });
  it('lets one sitting through; a parallel Start sees the fresh claim and is refused', () => {
    const g = claimStart(emptyGate('d'), 'd', 'A', [], new Set(), T)!;
    expect(g).toMatchObject({ openSittingId: 'A', starts: 1 });
    expect(claimStart(g, 'd', 'A', [], new Set(), T)).toBeNull(); // the same Start again
    expect(() => claimStart(g, 'd', 'B', [], new Set(), T + 1000)).toThrow(SITTING_ACTIVE_ERROR);
  });
  it('lets through past a claim that died, an ended sitting, or a released one', () => {
    const g = claimStart(emptyGate('d'), 'd', 'A', [], new Set(), T)!;
    expect(claimStart(g, 'd', 'B', [], new Set(), T + 3 * 60_000)?.openSittingId).toBe('B');
    expect(
      claimStart(g, 'd', 'B', [{ id: 'A', status: 'done', endedAt: T + 1 }], new Set(), T)
        ?.openSittingId,
    ).toBe('B');
    expect(
      claimStart(g, 'd', 'B', [{ id: 'A', status: 'active', endedAt: null }], new Set(['A']), T)
        ?.openSittingId,
    ).toBe('B');
    expect(releaseStart(g, 'A')).toMatchObject({ openSittingId: null });
    expect(releaseStart(g, 'B')).toBeNull();
  });
  it('caps Starts a day', () => {
    const g = { ...emptyGate('d'), starts: SITTING_STARTS_PER_DAY };
    expect(() => claimStart(g, 'd', 'X', [], new Set(), T)).toThrow(SITTING_START_CAP_ERROR);
    expect(SITTING_STARTS_PER_DAY).toBe(100);
  });
  it('caps Starts at the cap it is given', () => {
    const at = (starts: number) => ({ ...emptyGate('d'), starts });
    expect(claimStart(at(999), 'd', 'X', [], new Set(), T, 1000)?.starts).toBe(1000);
    expect(() => claimStart(at(1000), 'd', 'X', [], new Set(), T, 1000)).toThrow(
      SITTING_START_CAP_ERROR,
    );
  });
  it('gives the dev slots 10× the Starts and attempts, every other stage prod’s', () => {
    for (const stage of ['dev', 'devb']) {
      expect(sittingStartsPerDay(stage)).toBe(1000);
      expect(lcStartAttemptsPerDay(stage)).toBe(4000);
    }
    for (const stage of [undefined, '', 'prod', 'Dev', 'dev ', 'garbage']) {
      expect(sittingStartsPerDay(stage)).toBe(SITTING_STARTS_PER_DAY);
      expect(lcStartAttemptsPerDay(stage)).toBe(LC_START_ATTEMPTS_PER_DAY);
    }
  });
});

describe('the live pull’s helpers', () => {
  it('a sitting is open only while active and inside its window', () => {
    const s = { status: 'active' as const, startedAt: 0 };
    expect(isSittingOpen(s, SITTING_INGEST_WINDOW_MS)).toBe(true);
    expect(isSittingOpen(s, SITTING_INGEST_WINDOW_MS + 1)).toBe(false);
    expect(isSittingOpen({ ...s, status: 'done' }, 1)).toBe(false);
  });

  it('the newest of a type goes by time, then the later id on a tie', () => {
    const e = (id: string, type: string, at: number) => ({ id, type, at });
    const events = [
      e('01B', 'submit', 5),
      e('01A', 'submit', 5),
      e('01C', 'run', 9),
      e('01D', 'submit', 2),
    ];
    expect(newestOfType(events, 'submit')?.id).toBe('01B');
    expect(newestOfType(events, 'note')).toBeNull();
  });

  it('judgeDetail reads a submit’s failing case and a run’s input, joins arrays, caps, and never throws', () => {
    expect(
      judgeDetail({
        result: { last_testcase: '[3,2,4]\n6', expected_output: '[1,2]', code_output: '[0,0]' },
      }),
    ).toEqual({ input: '[3,2,4]\n6', expected: '[1,2]', output: '[0,0]', error: null });
    expect(
      judgeDetail({
        request: { data_input: '[2,7]\n9' },
        result: {
          code_answer: ['[0,1]', '[1,2]'],
          expected_code_answer: ['[0,1]', '[0,2]'],
          full_runtime_error: 'E'.repeat(5000),
        },
      }),
    ).toEqual({
      input: '[2,7]\n9',
      expected: '[0,1]\n[0,2]',
      output: '[0,1]\n[1,2]',
      error: `${'E'.repeat(JUDGE_ERROR_MAX - 1)}…`,
    });
    expect(judgeDetail({ result: { last_testcase: 'x'.repeat(5000) } }).input).toHaveLength(
      JUDGE_TEXT_MAX,
    );
    // An errored Run's answer is [] (captured 2026-11-08): no output, never its prints; a submit has no
    // code_answer, so its code_output is the output.
    expect(
      judgeDetail({
        result: { status_code: 15, code_answer: [], code_output: ['debug'], runtime_error: 'E' },
      }).output,
    ).toBeNull();
    expect(judgeDetail({ result: { code_answer: null, code_output: '[0,0]' } }).output).toBe(
      '[0,0]',
    );
    // A Run's code_output is its prints (captured 2026-11-08): the answer is what's shown.
    expect(
      judgeDetail({ result: { code_answer: ['4', '-1'], code_output: ['a', 'a'] } }).output,
    ).toBe('4\n-1');
    const none = { input: null, expected: null, output: null, error: null };
    for (const junk of [null, 'x', 7, [], { result: 3 }, { result: { code_answer: [1, 2] } }])
      expect(judgeDetail(junk)).toEqual(none);
  });
});

describe('the review', () => {
  const blank = {
    insight: null,
    help: 'none',
    mistakes: [],
    howItWent: null,
    tags: [],
    draftUsed: false,
  };

  it('folds whitespace, drops empties, lowercases and dedupes tags in order, keeps how-it-went’s lines', () => {
    expect(
      normalizeSittingReview({
        insight: '  two   pointers\n',
        help: 'hint',
        mistakes: [' off  by one ', '', '  '],
        howItWent: '  slow start\r\nthen fine  ',
        tags: ['Two-Pointers', ' sliding window ', 'two-pointers', ''],
        draftUsed: true,
      }),
    ).toEqual({
      insight: 'two pointers',
      help: 'hint',
      mistakes: ['off by one'],
      howItWent: 'slow start\nthen fine',
      tags: ['two-pointers', 'sliding window'],
      draftUsed: true,
    });
  });

  it('saying nothing is no review, and draftUsed needs a mistake', () => {
    expect(normalizeSittingReview(blank)).toBeNull();
    expect(normalizeSittingReview({ ...blank, mistakes: ['  '], draftUsed: true })).toBeNull();
    expect(normalizeSittingReview({ ...blank, help: 'solution' })).toMatchObject({
      help: 'solution',
    });
    expect(normalizeSittingReview({ ...blank, insight: 'x', draftUsed: true })?.draftUsed).toBe(
      false,
    );
  });

  it('refuses, naming the field, anything over a cap or of the wrong kind', () => {
    const bad: [Record<string, unknown>, RegExp][] = [
      [{ help: 'cheat' }, /Help/],
      [{ insight: 'x'.repeat(201) }, /One-liner/],
      [{ insight: 3 }, /One-liner/],
      [{ mistakes: Array(9).fill('m') }, /Mistakes are limited to 8/],
      [{ mistakes: ['m'.repeat(REVIEW_LINE_MAX + 1)] }, /A mistake/],
      [{ mistakes: 'm' }, /Mistakes must be a list/],
      [{ howItWent: 'h'.repeat(1001) }, /How it went/],
      [{ tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }, /Tags are limited/],
      [{ tags: ['t'.repeat(41)] }, /A tag/],
    ];
    for (const [over, msg] of bad)
      expect(() => normalizeSittingReview({ ...blank, ...over })).toThrow(msg);
    expect(() => normalizeSittingReview(null)).toThrow(/object/);
  });

  it('suggests a hint once a submit failed before the accepted one', () => {
    const s = (n: number | null) => ({ summary: { ...emptySummary(), submitsBeforeAccepted: n } });
    expect(suggestedHelp(s(null))).toBe('none');
    expect(suggestedHelp(s(0))).toBe('none');
    expect(suggestedHelp(s(2))).toBe('hint');
  });

  it('draftMistakes folds and dedupes, cuts a long line to 160 with "…", keeps the first five', () => {
    expect(draftMistakes([' a  b ', '', 'a b', 'c'])).toEqual(['a b', 'c']);
    expect(draftMistakes([])).toEqual([]);
    expect(draftMistakes(['x'.repeat(160)])).toEqual(['x'.repeat(160)]);
    const [cut] = draftMistakes(['y'.repeat(158) + ' zzzz'])!;
    expect(cut).toBe(`${'y'.repeat(158)}…`); // the space before the cut is dropped
    expect(draftMistakes(['w'.repeat(200)])).toEqual([`${'w'.repeat(159)}…`]);
    // an emoji straddling the cut goes whole, never half a surrogate pair
    expect(draftMistakes([`${'e'.repeat(158)}😀tail`])).toEqual([`${'e'.repeat(158)}…`]);
    // two lines that differ only past the cut are one line
    expect(draftMistakes(['q'.repeat(170), `${'q'.repeat(165)}r`])).toEqual([
      `${'q'.repeat(159)}…`,
    ]);
    const seven = Array.from({ length: 7 }, (_, i) => `l${i}`);
    expect(draftMistakes(seven)).toEqual(seven.slice(0, 5));
  });

  it('draftMistakes refuses only a non-list or a list with a non-text item', () => {
    for (const junk of ['x', null, undefined, {}, [1], ['a', null]])
      expect(draftMistakes(junk)).toBeNull();
  });
});

describe('reading a sitting back', () => {
  const e = (id: string, type: SittingEvent['type'], at: number, payload: unknown = {}) =>
    ({ id, type, at, payload }) as SittingEvent;
  const wa = {
    request: { typed_code: 'v1' },
    result: { status_code: 11, status_msg: 'Wrong Answer', last_testcase: '[1]' },
  };
  const ac = { request: { typed_code: 'v2' }, result: { status_code: 10, status_msg: 'Accepted' } };

  it('timelineOf numbers runs and submits in time order, with the snapshots between as code-changed markers', () => {
    const events = [
      e('01E', 'submit', 500, ac),
      e('01A', 'snapshot', 100),
      e('01B', 'run', 200, { result: { status_code: 15 } }),
      e('01C', 'snapshot', 300),
      e('01D', 'snapshot', 350),
      e('01F', 'submit', 400, wa),
      e('01G', 'snapshot', 600),
      e('01H', 'timer', 650),
    ];
    const t = timelineOf({ clientStartedAt: 50 }, events);
    expect(
      t.map((x) => (x.kind === 'judged' ? `${x.type}${x.n}:${x.verdict.verdict}` : `×${x.count}`)),
    ).toEqual(['×1', 'run1:runtime_error', '×2', 'submit1:wrong_answer', 'submit2:accepted', '×1']);
    expect(t[3]).toMatchObject({ offsetMs: 350, detail: { input: '[1]' } });
    expect(timelineOf({ clientStartedAt: 0 }, [e('01A', 'submit', 1, {})])[0]).toMatchObject({
      verdict: { verdict: 'other' },
    });
    expect(timelineOf({ clientStartedAt: 0 }, [])).toEqual([]);
  });
  it('timelineOf reads a wrong Run from its payload, so an older sitting reads right too', () => {
    const run = {
      result: {
        status_code: 10,
        status_msg: 'Accepted',
        correct_answer: false,
        total_correct: 0,
        total_testcases: 3,
      },
    };
    expect(timelineOf({ clientStartedAt: 0 }, [e('01A', 'run', 1, run)])[0]).toMatchObject({
      verdict: { verdict: 'wrong_answer', statusMsg: 'Wrong Answer', passed: 0, total: 3 },
    });
  });

  it('firstSubmitCode is the first submit’s typed code', () => {
    expect(firstSubmitCode([e('01B', 'submit', 9, ac), e('01A', 'submit', 5, wa)])).toBe('v1');
    expect(firstSubmitCode([e('01A', 'run', 5, wa)])).toBeNull();
    expect(firstSubmitCode([e('01A', 'submit', 5, { request: { typed_code: 3 } })])).toBeNull();
  });

  it('problemStatementText turns questionDetail’s HTML into text, capped; unknown → null', () => {
    const raw = {
      content:
        '<p>Given <code>nums</code> &amp; <code>target</code>, 10<sup>4</sup> &lt; n &#39;x&#39; &#x41;&nbsp;b</p>\n\n<ul>\n\t<li>one</li>\n\t<li>two</li>\n</ul>',
    };
    expect(problemStatementText({ raw })).toBe(
      "Given nums & target, 10^4 < n 'x' A b\n\n- one\n\n- two",
    );
    expect(problemStatementText({ raw: { content: `<p>${'w '.repeat(5000)}</p>` } })).toHaveLength(
      PROBLEM_STATEMENT_MAX,
    );
    for (const junk of [
      null,
      { raw: null },
      { raw: { content: 3 } },
      { raw: { content: '<p></p>' } },
    ])
      expect(problemStatementText(junk)).toBeNull();
  });

  it('problemCompanies names the top three of the most recent non-empty window', () => {
    const stats = {
      three_months: [],
      six_months: [
        { name: 'B', timesEncountered: 3 },
        { name: 'A', timesEncountered: 16 },
        { name: 'C', timesEncountered: 2 },
        { name: 'D', timesEncountered: 1 },
        { slug: 'nameless' },
      ],
    };
    expect(problemCompanies({ raw: { companyTagStatsV2: JSON.stringify(stats) } })).toEqual([
      'A',
      'B',
      'C',
    ]);
    for (const junk of [
      null,
      { raw: {} },
      { raw: { companyTagStatsV2: '{bad' } },
      { raw: { companyTagStatsV2: '[]' } },
    ])
      expect(problemCompanies(junk)).toEqual([]);
  });
});

describe('idle close', () => {
  const M = 60_000;
  const H = 60 * M;
  const head = (over: Partial<Sitting> = {}): Sitting =>
    ({
      id: 's1',
      clientSittingId: 'c1',
      status: 'active',
      problemSlug: 'a',
      repTaskId: 't1',
      startedAt: 0,
      clientStartedAt: 0,
      endedAt: null,
      updatedAt: 0,
      day: 'd',
      ...over,
    }) as Sitting;
  const none = { budgetAt: null, readsAt: null };
  it('waits 45 minutes from the last activity and ends 5 minutes after it', () => {
    expect(SITTING_IDLE_MS).toBe(45 * M);
    expect(SITTING_IDLE_TAIL_MS).toBe(5 * M);
    expect(idleCloseAt(head(), none, 45 * M)).toBeNull(); // exactly at the line: still open
    expect(idleCloseAt(head(), none, 45 * M + 1)).toBe(5 * M);
    // The newest of Start, reopen, an events call and a pull counts.
    const a = { budgetAt: 10 * M, readsAt: 20 * M };
    expect(sittingLastActivity(head({ reopenedAt: 15 * M }), a)).toBe(20 * M);
    expect(idleCloseAt(head(), a, 65 * M)).toBeNull();
    expect(idleCloseAt(head(), a, 65 * M + 1)).toBe(25 * M);
    expect(idleCloseAt(head({ reopenedAt: 30 * M }), a, 70 * M)).toBeNull();
  });
  it('an idle sitting whose rep finished meanwhile ends as its rep did, no later than the idle end', () => {
    const a = { budgetAt: 10 * M, readsAt: null };
    expect(idleEnd(head(), undefined, a, 60 * M)).toEqual({
      to: 'abandoned',
      at: 15 * M,
      idle: true,
    });
    const done = { status: 'done', completedAt: 12 * M, cancelledAt: null } as Task;
    expect(idleEnd(head(), done, a, 60 * M)).toEqual({ to: 'done', at: 12 * M, idle: false });
    expect(idleEnd(head(), { ...done, completedAt: 50 * M }, a, 60 * M)).toMatchObject({
      at: 15 * M,
    });
    const dropped = { status: 'cancelled', completedAt: null, cancelledAt: 11 * M } as Task;
    expect(idleEnd(head(), dropped, a, 60 * M)).toEqual({
      to: 'abandoned',
      at: 11 * M,
      idle: false,
    });
    expect(idleEnd(head(), done, a, 50 * M)).toBeNull(); // not idle: Start or the hook decides, as before
  });
  it('the precheck is free and never closes an ended sitting', () => {
    expect(mayBeIdle(head(), 45 * M)).toBe(false);
    expect(mayBeIdle(head({ reopenedAt: 10 * M }), 50 * M)).toBe(false);
    expect(mayBeIdle(head(), 50 * M)).toBe(true);
    expect(mayBeIdle(head({ status: 'done', endedAt: 1 }), 50 * M)).toBe(false);
    expect(idleCloseAt(head({ status: 'abandoned', endedAt: 1 }), none, 9 * H)).toBeNull();
  });
  it('an idle close abandons it at its end, and Done after reads done with the end kept', () => {
    const closed = idleClosedSitting(head(), 5 * M, 50 * M);
    expect(closed).toMatchObject({ status: 'abandoned', endedAt: 5 * M, closedBy: 'idle' });
    expect(closed.updatedAt).toBe(50 * M);
    expect(finishIdleClosed(closed, 60 * M)).toMatchObject({
      status: 'done',
      endedAt: 5 * M,
      closedBy: 'idle',
    });
    expect(finishIdleClosed(head({ status: 'abandoned', endedAt: 1 }), 60 * M)).toBeNull();
  });
  it('a reopen leaves the gap out of its minutes, across several reopens', () => {
    const closed = idleClosedSitting(head(), 20 * M, 70 * M);
    const back = reopenedSitting(closed, 3 * H);
    expect(back).toMatchObject({
      status: 'active',
      endedAt: null,
      closedBy: null,
      reopenedAt: 3 * H,
    });
    expect(back.idleMs).toBe(3 * H - 20 * M);
    expect(sittingElapsedMs(back, 3 * H + 10 * M)).toBe(30 * M); // 20 before + 10 after
    const twice = reopenedSitting(idleClosedSitting(back, 3 * H + 15 * M, 4 * H), 5 * H);
    expect(sittingElapsedMs({ ...twice, endedAt: 5 * H + 5 * M }, 9 * H)).toBe(40 * M);
  });
  it('refuses a reopen unless closed by idle, in its window, its rep live and nothing else open', () => {
    const closed = idleClosedSitting(head(), 5 * M, 50 * M);
    const live = { status: 'in_progress' } as Task;
    const other = head({ id: 's2', clientSittingId: 'c2', repTaskId: 't2', startedAt: H });
    expect(sittingReopenError(closed, live, [closed], H)).toBeNull();
    expect(sittingReopenError(head(), live, [], H)).toBeNull(); // already open: a no-op
    expect(sittingReopenError(head({ status: 'abandoned', endedAt: 1 }), live, [], H)).toBe(
      SITTING_REOPEN_ERROR,
    );
    expect(sittingReopenError(closed, live, [], SITTING_INGEST_WINDOW_MS + 1)).toBe(
      SITTING_ENDED_ERROR,
    );
    expect(sittingReopenError(closed, { status: 'done' } as Task, [], H)).toBe(
      SITTING_REOPEN_REP_ERROR,
    );
    expect(sittingReopenError(closed, undefined, [], H)).toBe(SITTING_REOPEN_REP_ERROR);
    expect(sittingReopenError(closed, live, [closed, other], 2 * H)).toBe(SITTING_ACTIVE_ERROR);
    // A later sitting that took its rep, itself ended.
    const later = { ...other, repTaskId: 't1', status: 'abandoned' as const, endedAt: 2 * H };
    expect(sittingReopenError(closed, live, [closed, later], 3 * H)).toBe(SITTING_REOPEN_REP_ERROR);
    expect(sittingReopenError(finishIdleClosed(closed, H)!, live, [], H)).toBe(
      SITTING_REOPEN_ERROR,
    );
  });
  it('an event stamped after the end comes back; one before it is a straggler', () => {
    // The extension's clock 3 h behind the server's; ended at 5 min server time.
    const closed = idleClosedSitting(
      head({ startedAt: 3 * H, clientStartedAt: 0 }),
      3 * H + 5 * M,
      4 * H,
    );
    const cut = 5 * M + 60_000; // the end on the extension's clock, plus the skew
    expect(sittingReturns(closed, [{ at: cut }])).toBe(false);
    expect(sittingReturns(closed, [{ at: cut }, { at: cut + 1 }])).toBe(true);
    expect(sittingReturns(head(), [{ at: 9 * H }])).toBe(false); // open: nothing to come back to
    expect(sittingReturns({ ...closed, closedBy: null }, [{ at: 9 * H }])).toBe(false);
  });
  it('an idle-closed sitting takes stragglers for its whole window, not just the grace', () => {
    const closed = idleClosedSitting(head(), 5 * M, 50 * M);
    expect(sittingIngestPhase(closed, 5 * H)).toBe('grace');
    expect(sittingIngestPhase(closed, SITTING_INGEST_WINDOW_MS + 1)).toBe('closed');
  });
  it('a Start on its problem the same app day reopens it; another day, it attaches the rep', () => {
    const closed = idleClosedSitting(head(), 5 * M, 50 * M);
    const tasks = [{ id: 't1', status: 'in_progress', rollId: 'r', deletedAt: null } as Task];
    const plan = (slug: string, sameDay: boolean, id = 'new') =>
      planSittingStart(
        { clientSittingId: id, problemSlug: slug },
        [closed],
        tasks,
        'r',
        H,
        () => sameDay,
      );
    expect(plan('a', true)).toMatchObject({ kind: 'reopen', sitting: { id: 's1' }, ends: [] });
    expect(plan('a', true, 'c1')).toMatchObject({ kind: 'reopen' }); // a repeat Start of it
    expect(plan('a', false)).toMatchObject({ kind: 'attach', rep: { id: 't1' } });
    expect(plan('a', false, 'c1')).toMatchObject({
      kind: 'resume',
      sitting: { status: 'abandoned' },
    });
    expect(plan('b', true)).toMatchObject({ kind: 'attach', rep: { id: 't1' } });
    // Its rep finished: nothing to come back to.
    const done = [{ ...tasks[0]!, status: 'done' } as Task];
    expect(
      planSittingStart(
        { clientSittingId: 'n', problemSlug: 'a' },
        [closed],
        done,
        'r',
        H,
        () => true,
      ).kind,
    ).toBe('spawn');
  });
  it('a reopen claims the gate without counting a Start; a Start can’t take it from a fresh reclaim', () => {
    const T = 2 * H;
    const closed = { id: 'A', status: 'abandoned' as const, startedAt: 0, endedAt: 5 * M };
    const g0 = { ...emptyGate('d'), starts: 3 };
    const g = reclaimStart(g0, 'A', [closed], T)!;
    expect(g).toMatchObject({ openSittingId: 'A', openClaimedAt: T, starts: 3 });
    // Still held by A (its idle close not yet released): stamped afresh, so that release can't free the reopen.
    expect(reclaimStart(g, 'A', [closed], T + 5)).toMatchObject({
      openSittingId: 'A',
      openClaimedAt: T + 5,
    });
    expect(releaseStart({ ...g, openClaimedAt: T + 5 }, 'A', T)).toBeNull();
    expect(releaseStart(g, 'A', T)).toMatchObject({ openSittingId: null });
    // A Start that read A as ended: refused while the reclaim may still be writing A's head.
    expect(() => claimStart(g, 'd', 'B', [closed], new Set(), T + 1000)).toThrow(
      SITTING_ACTIVE_ERROR,
    );
    expect(claimStart(g, 'd', 'B', [closed], new Set(), T + 3 * M)?.openSittingId).toBe('B');
    // Refused while another is open, or claimed moments ago by a Start not yet seen.
    const open = { id: 'B', status: 'active' as const, startedAt: T - M, endedAt: null };
    const held = { ...g0, openSittingId: 'B', openClaimedAt: T - M };
    expect(() => reclaimStart(held, 'A', [closed, open], T)).toThrow(SITTING_ACTIVE_ERROR);
    expect(() => reclaimStart(held, 'A', [closed], T)).toThrow(SITTING_ACTIVE_ERROR);
    expect(reclaimStart(held, 'A', [closed], T + 2 * M)?.openSittingId).toBe('A');
  });
});

describe('the trace comment fold (commentTrace)', () => {
  const judged = (type: 'run' | 'submit', id: string, at: number) =>
    headRowOf('s', { id, type, at, payload: { result: { status_code: 11 } } });
  it('absent until judged; the first judged event with no comment reads none', () => {
    expect(summarizeHeadRows([]).commentTrace).toBeUndefined();
    const s = summarizeHeadRows([judged('submit', 'a', 5)]);
    expect(s).toMatchObject({ commentTrace: 'none', firstJudgedAt: 5 });
    expect(summarizeHeadRows([judged('run', 'r', 3), judged('submit', 'a', 5)]).firstJudgedAt).toBe(
      3,
    );
  });
  it('a trace comment before the first judged event reads traced; after it, nothing changes', () => {
    expect(
      summarizeHeadRows([traceCommentRow('s', { id: 'c', at: 1 }), judged('run', 'r', 2)])
        .commentTrace,
    ).toBe('traced');
    expect(summarizeHeadRows([traceCommentRow('s', { id: 'c', at: 1 })]).commentTrace).toBe(
      'traced',
    );
    expect(
      summarizeHeadRows([judged('run', 'r', 1), traceCommentRow('s', { id: 'c', at: 2 })])
        .commentTrace,
    ).toBe('none');
  });
  it('only its own row moves it: another head row before the first judged event changes nothing', () => {
    const other = headRowOf('s', {
      id: 'k',
      type: 'coach',
      at: 1,
      payload: { kind: 'not-a-kind' },
    });
    const s = summarizeHeadRows([other, judged('submit', 'a', 2)]);
    expect(s.commentTrace).toBe('none');
  });
  it('a tie on time folds by id, so a retry lands the same way', () => {
    const rows = [judged('submit', 'b', 2), traceCommentRow('s', { id: 'a', at: 2 })];
    expect(summarizeHeadRows(rows)).toEqual(summarizeHeadRows([...rows].reverse()));
  });
});
