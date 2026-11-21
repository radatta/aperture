import { beforeEach, describe, expect, it } from 'vitest';
import { ulid, type ApiMethod } from '@aperture/shared';
import { InMemoryDoc } from '../ddb/DocClient';
import { Repo } from '../ddb/repo';
import { pk, sk } from '../ddb/keys';
import { liveWrites } from '../ddb/writes';
import { BackendClient } from '../backend';
import { handleRpc } from '../handler';
import { TOOLS } from './tools';
import { RpcParamError } from './types';
import type { ToolContext } from './types';

// live_sitting over the real handleRpc path (docs/areas/recruiting → Claude watches live).
const U = 'local';
const T0 = Date.parse('2026-11-09T18:00:00Z');
let t = T0;
const now = () => t;
let backend: BackendClient;
let repo: Repo;
let doc: InMemoryDoc;
let ctx: ToolContext;

beforeEach(() => {
  t = T0;
  doc = new InMemoryDoc();
  repo = new Repo(doc, liveWrites(doc), U);
  backend = new BackendClient(repo, { userId: U, now });
  ctx = {
    dispatch: (method: ApiMethod, args: unknown[]) =>
      handleRpc(doc, { userId: U, method, args, now, idlePeek: true }), // as mcp/index.ts dispatches
    upload: async () => {},
    now,
  };
});

const call = (name: string, args: Record<string, unknown> = {}) => {
  const tool = TOOLS.find((x) => x.name === name);
  if (!tool) throw new Error(`no ${name}`);
  return tool.run(args, ctx) as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
};
const run = (args: Record<string, unknown> = {}) => call('live_sitting', args);
async function open() {
  const roll = await backend.upsertRoll({ name: 'LeetCode', categoryId: null, estimateMin: 45 });
  await backend.updateSettings({ leetcodeRollId: roll.id });
  const { sitting } = await backend.lcSittingStart({
    clientSittingId: ulid(),
    problemSlug: 'two-sum',
    problemTitle: 'Two Sum',
    difficulty: 'Easy',
    topicTags: ['Array'],
    lang: 'python3',
    startedAt: T0,
    tzOffsetMinutes: 480,
  });
  return sitting;
}
// lang is updateSyncedCode's numeric id, as the extension sends it (11 = Python3).
const snap = (code: string, at: number, lang: string = '11') => ({
  id: ulid(),
  type: 'snapshot',
  at,
  payload: { code, lang },
});
// A Run LeetCode calls "Accepted" (it ran) whose answers didn't match (captured 2026-11-08).
const wrongRun = (at: number) => ({
  id: ulid(),
  type: 'run',
  at,
  payload: {
    request: { data_input: '"abc"' },
    result: {
      status_code: 10,
      status_msg: 'Accepted',
      correct_answer: false,
      total_correct: 0,
      total_testcases: 3,
      code_answer: ['3'],
      code_output: ['debug'],
      expected_code_answer: ['2'],
    },
  },
});

describe('live_sitting', () => {
  it('says the freshness rules and the etiquette in its description', () => {
    const d = TOOLS.find((x) => x.name === 'live_sitting')!.description;
    expect(d).toMatch(/30 s/);
    expect(d).toMatch(/never paste their code back/);
    expect(d).toMatch(/after they leave the page/);
    expect(d).toMatch(/pausedMin/);
  });

  it('with nothing ever open: inactive, no last sitting', async () => {
    expect(await run()).toMatchObject({ active: false, lastSitting: null });
  });

  it('an open sitting: the code in full with its age, the newest Submit with its failing case, counts and the pull', async () => {
    const s = await open();
    await backend.lcSittingEvents({
      sittingId: s.id,
      events: [
        snap('def a(): pass', T0 + 60_000),
        {
          id: ulid(),
          type: 'submit',
          at: T0 + 90_000,
          payload: {
            request: { typed_code: 'x' },
            result: {
              status_code: 11,
              status_msg: 'Wrong Answer',
              total_correct: 40,
              total_testcases: 63,
              last_testcase: '[3,2,4]\n6',
              expected_output: '[1,2]',
              code_output: '[0,0]',
            },
          },
        },
        {
          id: ulid(),
          type: 'run',
          at: T0 + 80_000,
          payload: {
            request: { data_input: '[2,7]\n9' },
            result: { status_code: 15, status_msg: 'Runtime Error', runtime_error: 'IndexError' },
          },
        },
        snap('def a(): return 1', T0 + 100_000),
      ] as never,
    });
    t = T0 + 120_000;
    const out = await run();
    expect(out).toMatchObject({
      active: true,
      sitting: {
        id: s.id,
        problem: {
          slug: 'two-sum',
          url: 'https://leetcode.com/problems/two-sum/',
          difficulty: 'Easy',
          tags: ['Array'],
        },
        elapsedMin: 2,
        liveReads: 1,
      },
      code: { version: 2, text: 'def a(): return 1', ageSec: 20 },
      runCount: 1,
      submitCount: 1,
      lastSubmit: {
        verdict: 'wrong_answer',
        passed: 40,
        total: 63,
        agoSec: 30,
        detail: { input: '[3,2,4]\n6', expected: '[1,2]', output: '[0,0]', error: null },
      },
      lastRun: { verdict: 'runtime_error', detail: { input: '[2,7]\n9', error: 'IndexError' } },
      outcome: { firstSubmitAccepted: false, timeToFirstSubmitMin: 2 },
    });
    expect(out.note).toMatch(/30 s/);
    expect(out).not.toHaveProperty('unchangedSinceVersion');
  });

  it('a Submit whose refold lost its race shows its own verdict beside its own failing case', async () => {
    const s = await open();
    const submit = (status: number, msg: string, at: number, input: string) => ({
      id: ulid(),
      type: 'submit',
      at,
      payload: { result: { status_code: status, status_msg: msg, last_testcase: input } },
    });
    await backend.lcSittingEvents({
      sittingId: s.id,
      events: [submit(10, 'Accepted', T0 + 60_000, 'old')] as never,
    });
    // The next submit's rows land, but its refold doesn't (a lost CAS, healed only by a retry).
    const late = submit(11, 'Wrong Answer', T0 + 90_000, '[9]');
    await repo.putSittingEventIfAbsent(
      {
        ...late,
        sittingId: s.id,
        receivedAt: T0,
        userId: U,
        createdAt: T0,
        updatedAt: T0,
        deletedAt: null,
      } as never,
      null,
    );
    expect((await run()).lastSubmit).toMatchObject({
      verdict: 'wrong_answer',
      statusMsg: 'Wrong Answer',
      detail: { input: '[9]' },
    });
    // Its payload lost (the head row landed, the jd# row didn't): the verdict stays, the case is unknown — never
    // an older submit's.
    await doc.delete(pk(U), sk.sittingJudged(s.id, late.id));
    expect((await run()).lastSubmit).toMatchObject({ verdict: 'wrong_answer', detail: null });
  });

  it('a Run that ran but answered wrong is a wrong answer, showing its answer, not its prints', async () => {
    const s = await open();
    await backend.lcSittingEvents({ sittingId: s.id, events: [wrongRun(T0 + 60_000)] as never });
    expect((await run()).lastRun).toEqual(
      expect.objectContaining({
        verdict: 'wrong_answer',
        statusMsg: 'Wrong Answer',
        passed: 0,
        total: 3,
        detail: { input: '"abc"', expected: '2', output: '3', error: null },
      }),
    );
  });

  it('a head row folded under the old rule is read past: the payload in hand decides', async () => {
    const s = await open();
    const r = wrongRun(T0 + 60_000);
    await backend.lcSittingEvents({ sittingId: s.id, events: [r] as never });
    // The head row as a pre-fix write folded it: the wrong Run stored as accepted (the summary refolds from it).
    const row = (await doc.get(pk(U), sk.sittingHeadRow(s.id, r.id)))!;
    const verdict = row.verdict as Record<string, unknown>;
    await doc.put({ ...row, verdict: { ...verdict, verdict: 'accepted', statusMsg: 'Accepted' } });
    expect((await run()).lastRun).toMatchObject({
      verdict: 'wrong_answer',
      statusMsg: 'Wrong Answer',
    });
  });

  it('names the code’s language from LeetCode’s id, else the sitting’s', async () => {
    const s = await open();
    await backend.lcSittingEvents({ sittingId: s.id, events: [snap('a', T0 + 1_000)] as never });
    expect((await run()).code.lang).toBe('Python3');
    await backend.lcSittingEvents({
      sittingId: s.id,
      events: [snap('b', T0 + 2_000, '999')] as never,
    });
    expect((await run()).code.lang).toBe('python3'); // the Start's lang
  });

  it('sinceVersion says whether the code moved, and every pull counts', async () => {
    const s = await open();
    await backend.lcSittingEvents({
      sittingId: s.id,
      events: [snap('a', T0 + 1_000)] as never,
    });
    expect(await run({ sinceVersion: 1 })).toMatchObject({
      unchangedSinceVersion: true,
      sitting: { liveReads: 1 },
    });
    expect(await run({ sinceVersion: 0 })).toMatchObject({
      unchangedSinceVersion: false,
      sitting: { liveReads: 2 },
    });
  });

  it('returns the full code at the snapshot cap', async () => {
    const s = await open();
    const big = 'x'.repeat(64 * 1024 - 64); // under the 64 KB snapshot payload cap with its JSON around it
    await backend.lcSittingEvents({ sittingId: s.id, events: [snap(big, T0 + 1_000)] as never });
    expect((await run()).code.text).toBe(big);
  });

  it('before the first snapshot: the sitting, with no code yet', async () => {
    await open();
    expect(await run()).toMatchObject({
      active: true,
      code: { version: 0, text: null, ageSec: null },
      lastRun: null,
      lastSubmit: null,
      extensionSeenAgoSec: null,
    });
  });

  it('after Done: inactive, naming it as the last sitting with its count', async () => {
    const s = await open();
    await run();
    await backend.setTaskActual(s.repTaskId, 30);
    await backend.transitionTask(s.repTaskId, 'done');
    expect(await run()).toMatchObject({
      active: false,
      lastSitting: {
        id: s.id,
        status: 'done',
        expired: false,
        liveReads: 1,
        problem: { slug: 'two-sum' },
      },
    });
  });

  it('a sitting left untouched reads closed by idle, its minutes stopped 5 past the last activity — nothing written', async () => {
    const s = await open();
    t = T0 + 30 * 3600_000;
    const rows = doc.snapshot();
    expect(await run()).toMatchObject({
      active: false,
      lastSitting: {
        id: s.id,
        status: 'abandoned',
        closedBy: 'idle',
        expired: false,
        minutes: 5,
        liveReads: 0,
      },
    });
    expect(await call('get_sitting', { id: s.id })).toMatchObject({
      sitting: { closedBy: 'idle', minutes: 5 },
    });
    expect((await call('list_sittings')).sittings[0]).toMatchObject({ closedBy: 'idle' });
    expect(doc.snapshot()).toEqual(rows); // MCP reads stay free: the app's next read writes the close
    // The app's read (no idlePeek) writes the same end.
    expect((await backend.listSittings())[0]).toMatchObject({
      closedBy: 'idle',
      endedAt: T0 + 5 * 60_000,
    });
  });

  it('a pull keeps the sitting open: 45 minutes from the pull, not the Start', async () => {
    const s = await open();
    t = T0 + 40 * 60_000;
    expect(await run()).toMatchObject({ active: true, sitting: { id: s.id } });
    t = T0 + 85 * 60_000;
    expect(await run()).toMatchObject({ active: true, sitting: { id: s.id, elapsedMin: 85 } });
  });

  it('a pause on LeetCode’s timer holds the minutes still and says so; get_sitting and list_sittings agree', async () => {
    const M = 60_000;
    // LeetCode's state as it writes it: running keeps startTimestamp, a pause keeps the elapsed in pauseMs.
    const timer = (at: number, elapsed: number, status: 'running' | 'pause') => ({
      id: ulid(),
      type: 'timer',
      at,
      payload: {
        state:
          status === 'running'
            ? {
                mode: 'reverse',
                status,
                endMs: 30 * M,
                startTimestamp: at - elapsed,
                pauseMs: null,
              }
            : { mode: 'reverse', status, endMs: 30 * M, startTimestamp: null, pauseMs: elapsed },
      },
    });
    const s = await open();
    await backend.lcSittingEvents({
      sittingId: s.id,
      events: [timer(T0 + 4 * M, 4 * M, 'running'), timer(T0 + 6 * M, 5 * M, 'pause')] as never,
    });
    t = T0 + 14 * M; // paused at 5:00, still paused
    expect(await run()).toMatchObject({
      sitting: { elapsedMin: 5, pausedMin: 9, paused: true, timerSeen: true },
    });
    await backend.lcSittingEvents({
      sittingId: s.id,
      events: [timer(T0 + 15 * M, 5 * M, 'running')] as never, // resumed at 15:00
    });
    t = T0 + 20 * M;
    expect(await run()).toMatchObject({
      sitting: { elapsedMin: 10, pausedMin: 10, paused: false },
    });
    expect(await call('get_sitting')).toMatchObject({ sitting: { minutes: 10, pausedMin: 10 } });
    expect((await call('list_sittings')).sittings[0]).toMatchObject({ minutes: 10, pausedMin: 10 });
  });

  it('a sitting left paused until the idle close: lastSitting and get_sitting read the pause to its end', async () => {
    const M = 60_000;
    const s = await open();
    const state = (at: number, status: 'running' | 'pause') => ({
      mode: 'forward',
      status,
      startTimestamp: status === 'running' ? at - 4 * M : null,
      pauseMs: status === 'pause' ? 5 * M : null,
    });
    t = T0 + 6 * M; // the server hears both reads at 6:00, its last activity
    await backend.lcSittingEvents({
      sittingId: s.id,
      events: [
        {
          id: ulid(),
          type: 'timer',
          at: T0 + 4 * M,
          payload: { state: state(T0 + 4 * M, 'running') },
        },
        {
          id: ulid(),
          type: 'timer',
          at: T0 + 6 * M,
          payload: { state: state(T0 + 6 * M, 'pause') },
        },
      ] as never,
    });
    t = T0 + 3 * 60 * M; // closed by idle at 11:00 (6:00 + 5), still paused then
    const out = await run();
    expect(out.active).toBe(false);
    // Paused at 5:00 until the close at 11:00: 5 minutes on the clock, 6 paused.
    expect(out.lastSitting).toMatchObject({ id: s.id, closedBy: 'idle', minutes: 5, pausedMin: 6 });
    expect(await call('get_sitting')).toMatchObject({ sitting: { minutes: 5, pausedMin: 6 } });
  });

  it('with no timer reads: wall-clock minutes, nothing paused, the timer unseen', async () => {
    await open();
    t = T0 + 7 * 60_000;
    expect(await run()).toMatchObject({
      sitting: { elapsedMin: 7, pausedMin: 0, paused: false, timerSeen: false },
    });
  });

  it('refuses a sinceVersion that is not a whole number ≥ 0, counting nothing', async () => {
    const s = await open();
    for (const bad of ['3', -1, 1.5, null])
      await expect(run({ sinceVersion: bad })).rejects.toBeInstanceOf(RpcParamError);
    expect((await backend.getSitting(s.id)).liveReads).toBe(0);
  });
});

// Reading a sitting back (docs/areas/recruiting → Reading a sitting back): both read-only.
describe('get_sitting and list_sittings', () => {
  async function reviewed() {
    const s = await open();
    await backend.lcSittingEvents({
      sittingId: s.id,
      events: [
        snap('v1', T0 + 60_000),
        {
          id: ulid(),
          type: 'submit',
          at: T0 + 120_000,
          payload: {
            request: { typed_code: 'v1' },
            result: {
              status_code: 11,
              status_msg: 'Wrong Answer',
              total_correct: 1,
              total_testcases: 3,
              last_testcase: 'x'.repeat(500),
              expected_output: '[1,2]',
              code_output: '[0,0]',
            },
          },
        },
        snap('v2', T0 + 180_000),
      ] as never,
    });
    await backend.setSittingReview(s.id, {
      insight: 'two pointers',
      help: 'hint',
      mistakes: ['m'],
      howItWent: null,
      tags: ['two-pointers'],
      draftUsed: false,
    });
    return s;
  }

  it('get_sitting with no id reads the latest: statement, timeline with capped cases, full code, review — writing nothing', async () => {
    const s = await reviewed();
    await repo.putLeetcodeProblem({
      id: 'two-sum',
      userId: U,
      slug: 'two-sum',
      title: 'Two Sum',
      questionId: '1',
      frontendId: '1',
      difficulty: 'Easy',
      topicTags: ['Array'],
      raw: { content: '<p>Find <code>two</code> numbers.</p>' },
      createdAt: T0,
      updatedAt: T0,
      deletedAt: null,
    });
    t = T0 + 600_000;
    const before = JSON.stringify(doc.snapshot());
    const out = await call('get_sitting');
    expect(out).toMatchObject({
      sitting: {
        id: s.id,
        status: 'active',
        expired: false,
        minutes: 10,
        submitCount: 1,
        liveReads: 0,
      },
      problem: { statement: 'Find two numbers.', companies: [] },
      timeline: [
        { kind: 'codeChanged', count: 1 },
        {
          kind: 'judged',
          type: 'submit',
          n: 1,
          minute: 2,
          verdict: 'wrong_answer',
          passed: 1,
          total: 3,
          detail: { expected: '[1,2]', output: '[0,0]' },
        },
        { kind: 'codeChanged', count: 1 },
      ],
      code: { final: 'v2', version: 2, lang: 'Python3' },
      review: { insight: 'two pointers', help: 'hint', tags: ['two-pointers'] },
    });
    expect(out.review.updatedAt).toMatch(/^\d{4}-\d\d-\d\dT/); // ISO, like every other time
    expect(out.timeline[1].detail.input).toHaveLength(300);
    expect(JSON.stringify(doc.snapshot())).toBe(before);
    expect(await call('get_sitting', { id: s.id })).toMatchObject({ sitting: { id: s.id } });
  });

  it('get_sitting reads a wrong Run as one, its answer as the output', async () => {
    const s = await open();
    await backend.lcSittingEvents({ sittingId: s.id, events: [wrongRun(T0 + 60_000)] as never });
    expect((await call('get_sitting')).timeline).toEqual([
      expect.objectContaining({
        type: 'run',
        verdict: 'wrong_answer',
        statusMsg: 'Wrong Answer',
        passed: 0,
        total: 3,
        detail: { input: '"abc"', expected: '2', output: '3', error: null },
      }),
    ]);
  });

  it('get_sitting: nothing yet says so; a bad id is a param error; a foreign one is Not found', async () => {
    expect(await call('get_sitting')).toEqual({ sitting: null, note: 'No sittings yet.' });
    await expect(call('get_sitting', { id: 'x' })).rejects.toBeInstanceOf(RpcParamError);
    await expect(call('get_sitting', { id: ulid() })).rejects.toThrow(/Not found/);
  });

  it('list_sittings: newest first with reviewed and tags, a range, a limit, and bad arguments refused', async () => {
    const s = await reviewed();
    await backend.setTaskActual(s.repTaskId, 30);
    await backend.transitionTask(s.repTaskId, 'done');
    t = T0 + 3600_000;
    const { sitting: other } = await backend.lcSittingStart({
      clientSittingId: ulid(),
      problemSlug: 'three-sum',
      problemTitle: '3Sum',
      lang: 'python3',
      startedAt: t,
      tzOffsetMinutes: 480,
    });
    const all = await call('list_sittings');
    expect(all.sittings.map((x: { id: string }) => x.id)).toEqual([other.id, s.id]);
    expect(all.sittings[1]).toMatchObject({
      status: 'done',
      reviewed: true,
      tags: ['two-pointers'],
      outcome: { firstSubmitAccepted: false },
    });
    expect(all.sittings[0]).toMatchObject({ reviewed: false, tags: [], status: 'active' });
    expect(await call('list_sittings', { limit: 1 })).toMatchObject({
      sittings: [{ id: other.id }],
      more: true,
    });
    expect(await call('list_sittings', { from: '2026-10-01', to: '2026-10-31' })).toEqual({
      sittings: [],
      more: false,
    });
    for (const bad of [
      { limit: '5' },
      { limit: 0 },
      { limit: 101 },
      { from: 'yesterday', to: '2026-11-09' },
      { from: '2026-11-09' },
      { from: '2026-11-10', to: '2026-11-09' },
    ])
      await expect(call('list_sittings', bad)).rejects.toBeInstanceOf(RpcParamError);
  });
});
