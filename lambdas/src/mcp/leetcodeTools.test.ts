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
      handleRpc(doc, { userId: U, method, args, now }),
    upload: async () => {},
    now,
  };
});

const run = (args: Record<string, unknown> = {}) => {
  const tool = TOOLS.find((x) => x.name === 'live_sitting');
  if (!tool) throw new Error('no live_sitting');
  return tool.run(args, ctx) as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
};
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
const snap = (code: string, at: number) => ({
  id: ulid(),
  type: 'snapshot',
  at,
  payload: { code, lang: 'python3' },
});

describe('live_sitting', () => {
  it('says the freshness rules and the etiquette in its description', () => {
    const d = TOOLS.find((x) => x.name === 'live_sitting')!.description;
    expect(d).toMatch(/30 s/);
    expect(d).toMatch(/never paste his code back/);
    expect(d).toMatch(/after he leaves the page/);
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

  it('a sitting left open past its window: inactive, its last sitting marked expired with minutes stopped at the window', async () => {
    const s = await open();
    t = T0 + 30 * 3600_000;
    expect(await run()).toMatchObject({
      active: false,
      lastSitting: { id: s.id, status: 'active', expired: true, minutes: 24 * 60 },
    });
  });

  it('refuses a sinceVersion that is not a whole number ≥ 0, counting nothing', async () => {
    const s = await open();
    for (const bad of ['3', -1, 1.5, null])
      await expect(run({ sinceVersion: bad })).rejects.toBeInstanceOf(RpcParamError);
    expect((await backend.getSitting(s.id)).liveReads).toBe(0);
  });
});
