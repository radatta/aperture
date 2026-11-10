import { describe, expect, it } from 'vitest';
import { DRAFT_CODE_MAX, ulid } from '@aperture/shared';
import type { SittingEventInput } from '@aperture/shared';
import { InMemoryDoc } from './ddb/DocClient';
import { Repo } from './ddb/repo';
import { liveWrites } from './ddb/writes';
import { BackendClient } from './backend';
import { handleRpc } from './handler';
import { FakeAnthropic } from './anthropic/gateway';

// The review draft on the server (docs/areas/recruiting → Review): one model call over the sitting's judged runs
// and submits and its two codes, the answer validated, nothing ever stored. The contract suite holds the stub and
// the Lambda to the same shape; this is the model seam, which only the Lambda has.

const T0 = Date.parse('2026-11-09T18:00:00Z');
const U = 'local';

async function setup() {
  const doc = new InMemoryDoc();
  const anthropic = new FakeAnthropic();
  const b = new BackendClient(new Repo(doc, liveWrites(doc), U), {
    userId: U,
    now: () => T0 + 60 * 60_000,
    anthropic,
  });
  const roll = await b.upsertRoll({ name: 'LeetCode', categoryId: null, estimateMin: 45 });
  await b.updateSettings({ leetcodeRollId: roll.id });
  const { sitting } = await b.lcSittingStart({
    clientSittingId: ulid(),
    problemSlug: 'two-sum',
    problemTitle: 'Two Sum',
    difficulty: 'Easy',
    topicTags: ['Array'],
    lang: 'python3',
    startedAt: T0,
    tzOffsetMinutes: 480,
  });
  return { doc, anthropic, b, sitting };
}
const submit = (at: number, status: number, msg: string, code: string, result = {}) =>
  ({
    id: ulid(),
    type: 'submit',
    at,
    payload: {
      request: { typed_code: code },
      result: { status_code: status, status_msg: msg, ...result },
    },
  }) as SittingEventInput;

describe('draftSittingReview', () => {
  it('with nothing judged: nothing-to-draft, and no model call', async () => {
    const { anthropic, b, sitting } = await setup();
    await b.lcSittingEvents({
      sittingId: sitting.id,
      events: [{ id: ulid(), type: 'snapshot', at: T0 + 1, payload: { code: 'x' } }],
    });
    expect(await b.draftSittingReview(sitting.id)).toEqual({
      ok: false,
      reason: 'nothing-to-draft',
    });
    expect(anthropic.draftCalls).toHaveLength(0);
  });

  it('sends the problem, the judged events with their cases, and both codes capped — no ids or dates', async () => {
    const { anthropic, b, sitting } = await setup();
    const big = 'y'.repeat(DRAFT_CODE_MAX + 500);
    await b.lcSittingEvents({
      sittingId: sitting.id,
      events: [
        submit(T0 + 5 * 60_000, 11, 'Wrong Answer', 'first', {
          last_testcase: '[3,3]\n6',
          expected_output: '[0,1]',
          code_output: '[]',
        }),
        { id: ulid(), type: 'snapshot', at: T0 + 7 * 60_000, payload: { code: big } },
        submit(T0 + 9 * 60_000, 10, 'Accepted', 'second'),
      ],
    });
    anthropic.nextDraft = { ok: true, fields: { mistakes: ['  Submit 1:  [3,3] → []  ', ''] } };
    expect(await b.draftSittingReview(sitting.id)).toEqual({
      ok: true,
      mistakes: ['Submit 1: [3,3] → []'],
    });
    const { data } = anthropic.draftCalls[0]!;
    expect(data).toMatchObject({
      problem: { title: 'Two Sum', difficulty: 'Easy', tags: ['Array'] },
      judged: [
        {
          type: 'submit',
          n: 1,
          minute: 5,
          verdict: 'Wrong Answer',
          input: '[3,3]\n6',
          expected: '[0,1]',
          output: '[]',
        },
        { type: 'submit', n: 2, minute: 9, verdict: 'Accepted' },
      ],
      firstSubmitCode: 'first',
    });
    expect(data.finalCode).toHaveLength(DRAFT_CODE_MAX);
    expect(JSON.stringify(data)).not.toContain(sitting.id);
  });

  it('a Run LeetCode calls Accepted with correct_answer false reaches the model as Wrong Answer, its answer as the output', async () => {
    const { anthropic, b, sitting } = await setup();
    await b.lcSittingEvents({
      sittingId: sitting.id,
      events: [
        {
          id: ulid(),
          type: 'run',
          at: T0 + 2 * 60_000,
          payload: {
            request: { data_input: '"abba"' },
            result: {
              status_code: 10,
              status_msg: 'Accepted',
              correct_answer: false,
              total_correct: 0,
              total_testcases: 2,
              code_answer: ['3'],
              code_output: ['debug print'],
              expected_code_answer: ['2'],
            },
          },
        } as SittingEventInput,
      ],
    });
    anthropic.nextDraft = { ok: true, fields: { mistakes: [] } };
    await b.draftSittingReview(sitting.id);
    expect(anthropic.draftCalls[0]!.data.judged).toEqual([
      expect.objectContaining({
        type: 'run',
        verdict: 'Wrong Answer',
        passed: 0,
        total: 2,
        input: '"abba"',
        expected: '2',
        output: '3',
      }),
    ]);
  });

  it('too many or too long lines are cut to fit, not refused', async () => {
    const { anthropic, b, doc, sitting } = await setup();
    await b.lcSittingEvents({
      sittingId: sitting.id,
      events: [submit(T0 + 1, 11, 'Wrong Answer', 'x')],
    });
    const before = JSON.stringify(doc.snapshot());
    const six = Array.from({ length: 6 }, (_, i) => `l${i}`);
    anthropic.nextDraft = { ok: true, fields: { mistakes: ['z'.repeat(161), ...six] } };
    expect(await b.draftSittingReview(sitting.id)).toEqual({
      ok: true,
      mistakes: [`${'z'.repeat(159)}…`, ...six.slice(0, 4)],
    });
    expect(JSON.stringify(doc.snapshot())).toBe(before); // a draft writes nothing
  });

  it('a bad shape is refused and nothing is written', async () => {
    const { anthropic, b, doc, sitting } = await setup();
    await b.lcSittingEvents({
      sittingId: sitting.id,
      events: [submit(T0 + 1, 11, 'Wrong Answer', 'x')],
    });
    const before = JSON.stringify(doc.snapshot());
    for (const mistakes of ['x', [1], ['ok', null]]) {
      anthropic.nextDraft = { ok: true, fields: { mistakes } };
      expect(await b.draftSittingReview(sitting.id)).toEqual({ ok: false, reason: 'bad-shape' });
    }
    anthropic.nextDraft = { ok: true, fields: {} };
    expect(await b.draftSittingReview(sitting.id)).toEqual({ ok: false, reason: 'bad-shape' });
    expect(JSON.stringify(doc.snapshot())).toBe(before);
  });

  it('a model failure passes its reason through', async () => {
    const { anthropic, b, sitting } = await setup();
    await b.lcSittingEvents({
      sittingId: sitting.id,
      events: [submit(T0 + 1, 11, 'Wrong Answer', 'x')],
    });
    anthropic.nextDraft = { ok: false, reason: 'timeout' };
    expect(await b.draftSittingReview(sitting.id)).toEqual({ ok: false, reason: 'timeout' });
  });

  it('a smoke run spends nothing: testMode never reaches the model', async () => {
    const { anthropic, b, doc, sitting } = await setup();
    await b.lcSittingEvents({
      sittingId: sitting.id,
      events: [submit(T0 + 1, 11, 'Wrong Answer', 'x')],
    });
    anthropic.nextDraft = { ok: true, fields: { mistakes: ['would cost'] } };
    const out = await handleRpc(
      doc,
      {
        userId: U,
        method: 'draftSittingReview',
        args: [sitting.id],
        testMode: true,
        now: () => T0,
      },
      { anthropic },
    );
    expect(out).toEqual({ ok: false, reason: 'unavailable' });
    expect(anthropic.draftCalls).toHaveLength(0);
  });
});
