import { beforeEach, describe, expect, it } from 'vitest';
import { emptySummary, ulid, type ApiMethod, type Sitting } from '@aperture/shared';
import { InMemoryDoc } from '../ddb/DocClient';
import { Repo } from '../ddb/repo';
import { liveWrites } from '../ddb/writes';
import { BackendClient } from '../backend';
import { handleRpc } from '../handler';
import { TOOLS } from './tools';
import { RpcParamError } from './types';
import type { ToolContext } from './types';

// The coach's MCP tools over the real handleRpc path (docs/areas/recruiting/coach.md). Synthetic data only.
const U = 'local';
const T0 = Date.parse('2026-11-09T18:00:00Z'); // 10:00 in the user's zone: their day is 2026-11-09
const TODAY = '2026-11-09';
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

const call = (name: string, args: Record<string, unknown> = {}) => {
  const tool = TOOLS.find((x) => x.name === name);
  if (!tool) throw new Error(`no ${name}`);
  return tool.run(args, ctx) as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
};
// An ended sitting head, as the extension's capture would have folded it.
async function ended(slug: string, day: string, accepted: boolean, startedAt = T0 - 3600_000) {
  const at = startedAt + 60_000;
  const v = {
    verdict: accepted ? 'accepted' : 'wrong_answer',
    statusMsg: null,
    passed: null,
    total: null,
    at,
  } as const;
  const s: Sitting = {
    id: ulid(),
    userId: U,
    createdAt: startedAt,
    updatedAt: startedAt + 1200_000,
    deletedAt: null,
    day,
    startedAt,
    clientStartedAt: startedAt,
    endedAt: startedAt + 1200_000,
    status: 'done',
    clientSittingId: ulid(),
    problemSlug: slug,
    problemTitle: slug,
    questionId: null,
    frontendId: null,
    difficulty: null,
    topicTags: null,
    lang: 'python3',
    repTaskId: ulid(),
    rollId: 'roll',
    prepTarget: 'General',
    lcSolveSessionId: null,
    shapedAt: startedAt,
    summary: {
      ...emptySummary(),
      submits: 1,
      firstSubmit: v,
      lastSubmit: v,
      firstAcceptedAt: accepted ? at : null,
      submitsBeforeAccepted: accepted ? 0 : null,
      headEvents: 1,
    },
    review: null,
  };
  await repo.putSittingIfAbsent(s);
  return s;
}

describe('leetcode_today', () => {
  it('is listed read-only and answers with slots, rules and the wording note', async () => {
    const tool = TOOLS.find((x) => x.name === 'leetcode_today')!;
    expect(tool.description).toMatch(/Read-only/);
    const out = await call('leetcode_today');
    expect(out.day).toBe(TODAY);
    expect(out.slots).toHaveLength(4);
    expect(out.slots[0]).toMatchObject({ n: 1, kind: 'new', capMin: 30, status: 'open' });
    expect(out.focus).toMatchObject({
      pattern: 'Arrays & Hashing',
      patternId: 'arrays-hashing',
      day: 1,
    });
    expect(out.rules['re-solve']).toMatch(/no hints/);
    expect(out.note).toMatch(/never "overdue"/);
  });
  it('a sitting on a slot’s problem marks it done', async () => {
    const first = (await call('leetcode_today')).slots[0].slug as string;
    await ended(first, TODAY, true);
    expect((await call('leetcode_today')).slots[0]).toMatchObject({
      slug: first,
      status: 'done',
      outcome: 'clean',
    });
  });
  it('turns its day at dayStartHour in the user’s zone', async () => {
    t = Date.parse('2026-11-10T11:30:00Z'); // 03:30 in Los Angeles
    expect((await call('leetcode_today')).day).toBe('2026-11-09');
    t = Date.parse('2026-11-10T12:30:00Z'); // 04:30
    expect((await call('leetcode_today')).day).toBe('2026-11-10');
  });
  it('refuses a bad day', async () => {
    await expect(call('leetcode_today', { day: 'today' })).rejects.toBeInstanceOf(RpcParamError);
  });
});

describe('writes ask first', () => {
  it('every coach write opens with the ask-first sentence', () => {
    for (const name of ['mark_peeked', 'set_cause_tag', 'swap_slot', 'log_attempt'])
      expect(TOOLS.find((x) => x.name === name)!.description).toMatch(
        /^Writes to their Aperture data\. Before calling, say exactly what you will write and wait for their yes/,
      );
  });
});

describe('mark_peeked', () => {
  it('with no sitting: a peeked attempt, due tomorrow; repeating it is one state', async () => {
    const a = await call('mark_peeked', { slug: 'happy-number' });
    expect(a).toMatchObject({
      slug: 'happy-number',
      peeked: true,
      nextDue: { dueDay: '2026-11-10', track: 'peeked' },
    });
    const b = await call('mark_peeked', { slug: 'happy-number' });
    expect(b.attemptId).toBe(a.attemptId);
    expect(await repo.listCoachAttempts()).toHaveLength(1);
  });
  it('on today’s sitting: its review records the solution read', async () => {
    const s = await ended('missing-number', TODAY, true);
    const out = await call('mark_peeked', { slug: 'missing-number' });
    expect(out).toMatchObject({ sittingId: s.id, nextDue: { dueDay: '2026-11-10' } });
    expect((await repo.getSitting(s.id))!.review).toMatchObject({ help: 'solution' });
    expect(await repo.listCoachAttempts()).toHaveLength(0);
  });
  it('refuses a peek by id on a sitting flagged as a test, writing nothing', async () => {
    const s = await ended('missing-number', TODAY, false);
    await backend.patchSittingReview(s.id, { test: true });
    await expect(call('mark_peeked', { sittingId: s.id })).rejects.toThrow(/flagged as a test/);
    expect((await repo.getSitting(s.id))!.review).toMatchObject({ help: 'none', test: true });
  });
  it('seeds a past peek on its day', async () => {
    const out = await call('mark_peeked', { slug: 'happy-number', day: '2026-11-01' });
    expect(out.nextDue).toEqual({ dueDay: '2026-11-02', track: 'peeked' });
  });
  it('bad args → a param error, nothing written', async () => {
    for (const args of [
      {},
      { slug: 'Happy Number' },
      { slug: 'a', sittingId: ulid() },
      { sittingId: 'x' },
    ])
      await expect(call('mark_peeked', args)).rejects.toBeInstanceOf(RpcParamError);
    expect(await repo.listCoachAttempts()).toHaveLength(0);
  });
});

describe('set_cause_tag', () => {
  it('tags the newest ended sitting; the app form’s save without a cause keeps it', async () => {
    await ended('two-sum', TODAY, false, T0 - 7200_000);
    const s = await ended('valid-anagram', TODAY, false);
    const out = await call('set_cause_tag', { cause: 'boundary', peeked: true });
    expect(out).toMatchObject({ sittingId: s.id, review: { cause: 'boundary', help: 'solution' } });
    await backend.setSittingReview(s.id, {
      insight: 'sort both',
      help: 'solution',
      mistakes: [],
      howItWent: null,
      tags: [],
      draftUsed: false,
    });
    expect((await repo.getSitting(s.id))!.review).toMatchObject({
      cause: 'boundary',
      insight: 'sort both',
    });
  });
  it('refuses an unknown cause, a false peeked, a bad id; an unknown sitting is an error', async () => {
    await expect(call('set_cause_tag', { cause: 'tired' })).rejects.toBeInstanceOf(RpcParamError);
    await expect(
      call('set_cause_tag', { cause: 'boundary', peeked: false }),
    ).rejects.toBeInstanceOf(RpcParamError);
    await expect(
      call('set_cause_tag', { cause: 'boundary', sittingId: 'x' }),
    ).rejects.toBeInstanceOf(RpcParamError);
    await expect(call('set_cause_tag', { cause: 'boundary' })).rejects.toThrow(/No ended sitting/);
    await expect(call('set_cause_tag', { cause: 'boundary', sittingId: ulid() })).rejects.toThrow(
      /Not found/,
    );
  });
});

describe('swap_slot', () => {
  it('swaps a slot to an easier problem, then restores it; the original stays planned', async () => {
    const before = await call('leetcode_today');
    const stretch = before.slots.find((s: { kind: string }) => s.kind === 'stretch');
    const swapped = await call('swap_slot', { slug: stretch.slug, action: 'swap' });
    const now = swapped.slots.find(
      (s: { swappedFrom: string | null }) => s.swappedFrom === stretch.slug,
    );
    expect(now.slug).not.toBe(stretch.slug);
    const restored = await call('swap_slot', { slug: now.slug, action: 'restore' });
    expect(restored.slots.map((s: { slug: string }) => s.slug)).toEqual(
      before.slots.map((s: { slug: string }) => s.slug),
    );
  });
  it('skip marks it; an unknown slot or target is refused with nothing written', async () => {
    const first = (await call('leetcode_today')).slots[0].slug;
    expect((await call('swap_slot', { slug: first, action: 'skip' })).slots[0].status).toBe(
      'skipped',
    );
    await expect(call('swap_slot', { slug: 'jump-game', action: 'skip' })).rejects.toThrow(
      /No slot/,
    );
    await expect(
      call('swap_slot', { slug: first, action: 'swap', toSlug: 'no-such-problem-here' }),
    ).rejects.toThrow(/Unknown problem/);
    await expect(call('swap_slot', { slug: first, action: 'flip' })).rejects.toBeInstanceOf(
      RpcParamError,
    );
    await expect(
      call('swap_slot', { slug: first, action: 'skip', toSlug: 'two-sum' }),
    ).rejects.toBeInstanceOf(RpcParamError);
    expect((await repo.listCoachDays())[0]!.changes).toHaveLength(1);
  });
});

describe('log_attempt', () => {
  it('counts toward momentum and the queue', async () => {
    const out = await call('log_attempt', {
      attempts: [{ slug: 'counting-bits', outcome: 'clean', day: '2026-11-08', minutes: 20 }],
    });
    expect(out.attempts[0]).toMatchObject({
      slug: 'counting-bits',
      outcome: 'clean',
      nextDue: { dueDay: '2026-11-11' },
    });
    const today = await call('leetcode_today');
    expect(today.momentum).toMatchObject({ activeDays: 1, lastActiveDay: '2026-11-08' });
    expect(today.next48h.map((q: { slug: string }) => q.slug)).toEqual(['counting-bits']);
  });
  it('bad args are refused with nothing written — the whole list', async () => {
    await expect(call('log_attempt', { attempts: [] })).rejects.toBeInstanceOf(RpcParamError);
    await expect(call('log_attempt', { attempts: [{ outcome: 'clean' }] })).rejects.toBeInstanceOf(
      RpcParamError,
    );
    await expect(
      call('log_attempt', {
        attempts: [
          { slug: 'counting-bits', outcome: 'clean' },
          { slug: 'two-sum', outcome: 'great' },
        ],
      }),
    ).rejects.toThrow(/outcome/);
    expect(await repo.listCoachAttempts()).toHaveLength(0);
  });
});

describe('live_sitting slot', () => {
  async function start(slug: string) {
    const roll = await backend.upsertRoll({ name: 'LeetCode', categoryId: null, estimateMin: 45 });
    await backend.updateSettings({ leetcodeRollId: roll.id });
    await backend.lcSittingStart({
      clientSittingId: ulid(),
      problemSlug: slug,
      problemTitle: slug,
      difficulty: 'Easy',
      topicTags: ['Array'],
      lang: 'python3',
      startedAt: T0,
      tzOffsetMinutes: 480,
    });
  }
  it('names the open sitting’s slot, its cap and the rules', async () => {
    await start('contains-duplicate');
    t = T0 + 31 * 60_000;
    const out = await call('live_sitting');
    expect(out.slot).toMatchObject({ kind: 'new', capMin: 30, overCap: true });
    expect(out.trace).toBeNull(); // no coach event from the extension yet
    expect(out.slot.rules).toMatch(/hint ladder/);
  });
  it('a failed coach read never fails the live pull: slot is null', async () => {
    await start('contains-duplicate');
    const inner = ctx.dispatch;
    ctx.dispatch = (method, args) =>
      method === 'getCoachToday' ? Promise.reject(new Error('boom')) : inner(method, args);
    const out = await call('live_sitting');
    expect(out).toMatchObject({ active: true, slot: null });
  });
  it('mark_peeked on the open sitting says when the re-solve will be due', async () => {
    await start('contains-duplicate');
    const out = await call('mark_peeked', { slug: 'contains-duplicate' });
    expect(out.nextDue).toMatchObject({ dueDay: '2026-11-10', track: 'peeked' });
  });
  it('mark_peeked on an open sitting on a problem with history reads the peek’s due day, not the old schedule', async () => {
    await ended('contains-duplicate', '2026-11-05', true, T0 - 4 * 86_400_000); // clean track, due 11-08
    await start('contains-duplicate');
    const out = await call('mark_peeked', { slug: 'contains-duplicate' });
    expect(out.nextDue).toMatchObject({ dueDay: '2026-11-10', track: 'peeked' });
  });
  it('an off-plan problem is off-plan, under the cap', async () => {
    await start('rotting-oranges');
    t = T0 + 5 * 60_000;
    expect((await call('live_sitting')).slot).toMatchObject({ kind: 'off-plan', overCap: false });
  });
});

describe('ownership', () => {
  it('coach rows sit under the caller’s partition: another user sees none of them', async () => {
    await call('log_attempt', { attempts: [{ slug: 'counting-bits', outcome: 'clean' }] });
    await call('swap_slot', { slug: (await call('leetcode_today')).slots[0].slug, action: 'skip' });
    await backend.setCoachFocus('graphs');
    const other = new BackendClient(new Repo(doc, liveWrites(doc), 'someone-else'), {
      userId: 'someone-else',
      now,
    });
    expect(await other.listProblemRecords()).toEqual([]);
    const t = await other.getCoachToday();
    expect(t.focus.source).toBe('engine');
    expect(t.slots.every((s) => s.status === 'open')).toBe(true);
    await other.deleteCoachAttempt((await repo.listCoachAttempts())[0]!.id);
    expect(await repo.listCoachAttempts()).toHaveLength(1);
  });
});
