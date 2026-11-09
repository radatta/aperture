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
  claimStart,
  countStartAttempt,
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
  sittingRawExpiresAt,
  headRowOf,
  payloadError,
  summarizeHeadRows,
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
  it('only judged, note and timer events move the head', () => {
    expect(['run', 'submit', 'note', 'timer'].every((t) => isHeadEvent(t as never))).toBe(true);
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
    planSittingStart({ clientSittingId: 'new', problemSlug: slug }, sittings, tasks, 'r', now);

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
      claimStart(g, 'd', 'B', [{ id: 'A', status: 'done' }], new Set(), T)?.openSittingId,
    ).toBe('B');
    expect(
      claimStart(g, 'd', 'B', [{ id: 'A', status: 'active' }], new Set(['A']), T)?.openSittingId,
    ).toBe('B');
    expect(releaseStart(g, 'A')).toMatchObject({ openSittingId: null });
    expect(releaseStart(g, 'B')).toBeNull();
  });
  it('caps Starts a day', () => {
    const g = { ...emptyGate('d'), starts: SITTING_STARTS_PER_DAY };
    expect(() => claimStart(g, 'd', 'X', [], new Set(), T)).toThrow(SITTING_START_CAP_ERROR);
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
