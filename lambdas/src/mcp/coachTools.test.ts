import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptySummary, ulid, type ApiMethod, type Sitting } from '@aperture/shared';
import { InMemoryDoc } from '../ddb/DocClient';
import { Repo } from '../ddb/repo';
import { liveWrites } from '../ddb/writes';
import { BackendClient } from '../backend';
import { handleRpc } from '../handler';
import { TOOLS } from './tools';
import { RpcParamError } from './types';
import type { ToolContext } from './types';
import { AI_PICK_NOTICE } from '@aperture/shared';
import { FakeAnthropic } from '../anthropic/gateway';
import type { CoachPickCall } from '../anthropic/gateway';
import { inlinePickInvoker } from '../coach/invoker';
import type { CoachPickInvoker } from '../coach/invoker';
import { runCoachPick } from '../coach/pick';
import { unloadCatalog } from '@aperture/shared';
import { FIXTURE_CLASSES, FIXTURE_SOURCE } from '../catalog/fixture';
import { runCatalogImport } from '../catalog/import';
import { inlineCatalogInvoker } from '../catalog/invoker';
import { FakeCatalogSource } from '../catalog/source';
import { CatalogStore } from '../catalog/store';

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
    expect(tool.description).toMatch(/Otherwise read-only/);
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

describe('leetcode_today and the AI pick', () => {
  const answer: CoachPickCall = {
    ok: true,
    fields: {
      picks: [{ slug: 'two-sum', why: 'Due since Thursday' }],
      note: 'One re-solve, then rest.',
      focus: null,
    },
    model: 'claude-opus-5-5',
    usage: { input: 1, output: 1 },
    ms: 1,
  };
  function aiCtx(mode: 'inline' | 'deferred', next: CoachPickCall) {
    const fake = new FakeAnthropic();
    fake.nextPick = next;
    const slept: number[] = [];
    const invoker: CoachPickInvoker =
      mode === 'inline'
        ? inlinePickInvoker((e) =>
            runCoachPick(
              {
                repo: new Repo(doc, liveWrites(doc), e.userId),
                anthropic: fake,
                now,
                log: () => {},
              },
              e,
            ),
          )
        : { enabled: true, invoke: async () => {} };
    ctx = {
      dispatch: (method: ApiMethod, args: unknown[]) =>
        handleRpc(
          doc,
          { userId: U, method, args, now },
          { anthropic: fake, coachPickInvoker: invoker },
        ),
      upload: async () => {},
      now,
      sleep: async (ms) => void slept.push(ms),
    };
    return { fake, slept };
  }
  // History: a failed try four days back, so two-sum is a due re-solve.
  const history = () =>
    backend.logCoachAttempts([
      { slug: 'two-sum', day: '2026-11-05', outcome: 'failed' },
      { slug: 'valid-anagram', day: '2026-11-06', outcome: 'clean' },
    ]);

  it('the first read starts the pick and carries the note and each slot’s why', async () => {
    await history();
    const { fake } = aiCtx('inline', answer);
    const out = await call('leetcode_today');
    expect(fake.pickCalls).toHaveLength(1);
    expect(out.ai).toMatchObject({
      status: 'ok',
      source: 'ai',
      note: 'One re-solve, then rest.',
      notice: null,
    });
    expect(out.slots).toHaveLength(4); // one answered, three filled from the rules
    expect(out.slots[0]).toEqual(
      expect.objectContaining({ slug: 'two-sum', why: 'Due since Thursday' }),
    );
    expect(out.slots.every((x: { why: unknown }) => typeof x.why === 'string')).toBe(true);
    expect(out.note).toMatch(/coach from ai.note/);
    await call('leetcode_today');
    expect(fake.pickCalls).toHaveLength(1);
  });

  it('a failed pick says so, once, over the rules’ slots', async () => {
    await history();
    aiCtx('inline', {
      ok: false,
      reason: 'api',
      detail: 'HTTP 529',
      model: 'm',
      usage: null,
      ms: 1,
    });
    const out = await call('leetcode_today');
    expect(out.ai).toMatchObject({ status: 'fallback', notice: AI_PICK_NOTICE });
    expect(out.slots.length).toBeGreaterThan(0);
    expect(out.slots.every((x: { why: unknown }) => x.why === null)).toBe(true);
  });

  it('waits ~8 s for a pick still running, then answers pending with no slots', async () => {
    await history();
    const { slept } = aiCtx('deferred', answer);
    const out = await call('leetcode_today');
    expect(slept.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(7_500);
    expect(out.ai).toMatchObject({ status: 'pending', next: expect.stringMatching(/again/) });
    expect(out.slots).toEqual([]);
  });

  it('a past day never starts one', async () => {
    await history();
    const { fake } = aiCtx('inline', answer);
    expect((await call('leetcode_today', { day: '2026-11-08' })).ai).toBeNull();
    expect(fake.pickCalls).toHaveLength(0);
  });
});

describe('writes ask first', () => {
  it('every coach write opens with the ask-first sentence', () => {
    for (const name of [
      'mark_peeked',
      'set_cause_tag',
      'swap_slot',
      'log_attempt',
      'set_focus_pattern',
      'delete_attempt',
      'set_void',
      'set_claude_notes',
      'import_catalog',
      'log_mock',
    ])
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
      nextDue: { dueDay: '2026-11-10', track: 'retry' },
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
    expect(out.nextDue).toEqual({ dueDay: '2026-11-02', track: 'retry' });
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
    expect(out.nextDue).toMatchObject({ dueDay: '2026-11-10', track: 'retry' });
  });
  it('mark_peeked on an open sitting on a problem with history reads the peek’s due day, not the old schedule', async () => {
    await ended('contains-duplicate', '2026-11-05', true, T0 - 4 * 86_400_000); // clean track, due 11-08
    await start('contains-duplicate');
    const out = await call('mark_peeked', { slug: 'contains-duplicate' });
    expect(out.nextDue).toMatchObject({ dueDay: '2026-11-10', track: 'retry' });
  });
  it('an off-plan problem is off-plan, under the cap', async () => {
    await start('rotting-oranges');
    t = T0 + 5 * 60_000;
    expect((await call('live_sitting')).slot).toMatchObject({ kind: 'off-plan', overCap: false });
  });
});

describe('the read tools', () => {
  it('are listed read-only', () => {
    for (const name of ['list_problems', 'get_problem', 'coach_stats', 'list_stories'])
      expect(TOOLS.find((x) => x.name === name)!.description).toMatch(/Read-only/);
  });
});

describe('list_problems', () => {
  const DAY = 86_400_000;
  beforeEach(async () => {
    await ended('two-sum', '2026-11-05', true, T0 - 4 * DAY); // clean: re-solve due 11-08
    await ended('valid-anagram', '2026-11-08', false, T0 - DAY); // failed: peeked track, due 11-09
    await ended('3sum', '2026-11-08', true, T0 - DAY); // clean: due 11-11
  });
  it('lists every problem tried, newest first, with its re-solve state', async () => {
    const out = await call('list_problems');
    expect(out.problems.map((p: { slug: string }) => p.slug)).toEqual([
      '3sum',
      'valid-anagram',
      'two-sum',
    ]);
    expect(out.problems[2]).toMatchObject({
      title: 'Two Sum',
      pattern: 'Arrays & Hashing',
      patternId: 'arrays-hashing',
      attempts: 1,
      firstOutcome: 'clean',
      reSolve: { track: 'clean', step: 1, of: 3, dueDay: '2026-11-08', graduated: false },
    });
    expect(out.more).toBe(false);
  });
  it('due: true is the queue, oldest due first; filters combine; limit cuts with `more`', async () => {
    const due = await call('list_problems', { due: true });
    expect(due.today).toBe(TODAY);
    expect(due.problems.map((p: { slug: string }) => p.slug)).toEqual(['two-sum', 'valid-anagram']);
    expect(
      (await call('list_problems', { due: false })).problems.map((p: { slug: string }) => p.slug),
    ).toEqual(['3sum']);
    expect(
      (await call('list_problems', { pattern: 'two-pointers' })).problems.map(
        (p: { slug: string }) => p.slug,
      ),
    ).toEqual(['3sum']);
    expect((await call('list_problems', { peeked: true })).problems).toEqual([]);
    const one = await call('list_problems', { limit: 1 });
    expect(one.problems).toHaveLength(1);
    expect(one.more).toBe(true);
  });
  it('refuses a bad pattern, flag or limit', async () => {
    for (const args of [
      { pattern: 'greedy-ish' },
      { due: 'yes' },
      { peeked: 1 },
      { limit: 0 },
      { limit: 101 },
      { limit: 2.5 },
    ])
      await expect(call('list_problems', args)).rejects.toBeInstanceOf(RpcParamError);
  });
});

describe('list_problems with nothing tried', () => {
  it('is an empty list with a note', async () => {
    const out = await call('list_problems');
    expect(out.problems).toEqual([]);
    expect(out.note).toMatch(/No practice recorded yet/);
  });
});

describe('get_problem', () => {
  it('reads one problem: its tries with ids, its sittings, its re-solve state', async () => {
    const s = await ended('two-sum', '2026-11-05', false, T0 - 4 * 86_400_000);
    const logged = await call('log_attempt', { attempts: [{ slug: 'two-sum', outcome: 'clean' }] });
    const out = await call('get_problem', { slug: 'two-sum' });
    expect(out.problem).toMatchObject({
      title: 'Two Sum',
      pattern: 'Arrays & Hashing',
      onRoadmap: true,
      url: 'https://leetcode.com/problems/two-sum/',
    });
    expect(out.record).toMatchObject({ attempts: 2, firstOutcome: 'failed', lastOutcome: 'clean' });
    expect(out.tries).toEqual([
      expect.objectContaining({ day: '2026-11-05', outcome: 'failed', sittingIds: [s.id] }),
      expect.objectContaining({ day: TODAY, attemptIds: [logged.attempts[0].id] }),
    ]);
    expect(out.sittings).toEqual([
      expect.objectContaining({ id: s.id, day: '2026-11-05', submits: 1, accepted: false }),
    ]);
  });
  it('a logged problem off the roadmap, with no sitting: its record, difficulty null', async () => {
    await call('log_attempt', {
      attempts: [{ slug: 'some-synthetic-problem', outcome: 'clean', day: '2026-11-05' }],
    });
    const out = await call('get_problem', { slug: 'some-synthetic-problem' });
    expect(out.problem).toMatchObject({ onRoadmap: false, patternId: 'other', difficulty: null });
    expect(out.record).toMatchObject({ attempts: 1, firstOutcome: 'clean' });
    expect(out.sittings).toEqual([]);
  });
  it('a problem whose only sitting is a test is record: null, with that sitting listed', async () => {
    const s = await ended('some-synthetic-problem', TODAY, false);
    await backend.patchSittingReview(s.id, { test: true });
    const out = await call('get_problem', { slug: 'some-synthetic-problem' });
    expect(out).toMatchObject({ problem: { onRoadmap: false, patternId: 'other' }, record: null });
    expect(out.sittings).toEqual([
      expect.objectContaining({ id: s.id, review: expect.objectContaining({ test: true }) }),
    ]);
    expect(out.note).toMatch(/tests or too short/);
  });
  it('a roadmap problem never tried is record: null; an unknown one is an error', async () => {
    expect(await call('get_problem', { slug: 'valid-sudoku' })).toMatchObject({
      problem: { title: 'Valid Sudoku', difficulty: 'Medium' },
      record: null,
    });
    await expect(call('get_problem', { slug: 'not-a-real-problem' })).rejects.toThrow(
      /No record of "not-a-real-problem"/,
    );
    await expect(call('get_problem', { slug: 'Two Sum' })).rejects.toBeInstanceOf(RpcParamError);
    await expect(call('get_problem', {})).rejects.toBeInstanceOf(RpcParamError);
  });
});

describe('coach_stats', () => {
  it('counts first tries and re-solves, with a pct only from 5 tries, the weakest pattern and the note', async () => {
    await ended('two-sum', '2026-11-05', true, T0 - 4 * 86_400_000);
    await ended('two-sum', TODAY, true);
    await ended('3sum', '2026-11-06', false, T0 - 3 * 86_400_000);
    const out = await call('coach_stats');
    expect(out).toMatchObject({
      from: null,
      to: TODAY,
      attempts: 3,
      problems: 2,
      firstTry: { hit: 1, of: 2, pct: null },
      resolve: { hit: 1, of: 1, pct: null },
      weakest: { pattern: 'Two Pointers', patternId: 'two-pointers' },
    });
    expect(out.patterns[0]).toMatchObject({
      pattern: 'Two Pointers',
      patternId: 'two-pointers',
      rank: 1,
      submitsPerTry: 1,
      runBeforeSubmit: { hit: 0, of: 1, pct: null },
      traced: { hit: 0, of: 0, pct: null },
      weeks: [{ week: '2026-W45', firstTry: { hit: 0, of: 1, pct: null } }],
    });
    expect(out.weeks.map((w: { week: string }) => w.week)).toEqual(['2026-W45', '2026-W46']);
    expect(out.note).toMatch(/never with other people/);
    expect(await call('coach_stats', { from: TODAY })).toMatchObject({ attempts: 1, from: TODAY });
  });
  it('a pct from 5 tries', async () => {
    const slugs = ['two-sum', 'valid-anagram', 'contains-duplicate', 'group-anagrams', '3sum'];
    for (const [i, slug] of slugs.entries()) await ended(slug, TODAY, i < 4, T0 - 3600_000 + i);
    expect((await call('coach_stats')).firstTry).toEqual({ hit: 4, of: 5, pct: 80 });
  });
  it('refuses a bad range', async () => {
    for (const args of [{ from: 'monday' }, { to: '11/09' }, { from: TODAY, to: '2026-11-01' }])
      await expect(call('coach_stats', args)).rejects.toBeInstanceOf(RpcParamError);
    await expect(call('coach_stats', { from: '2026-11-20' })).rejects.toThrow(/not be after/);
  });
});

describe('list_stories', () => {
  it('lists the story bank; empty is a note', async () => {
    expect((await call('list_stories')).note).toMatch(/No stories yet/);
    await backend.createStory({
      title: 'A synthetic migration',
      competencyTags: ['ownership'],
      situation: 'S',
      action: 'A',
      result: 'R',
    });
    const out = await call('list_stories');
    expect(out.stories).toEqual([
      expect.objectContaining({
        title: 'A synthetic migration',
        competencies: ['ownership'],
        situation: 'S',
      }),
    ]);
    expect(out.note).toBeUndefined();
  });
});

describe('set_focus_pattern', () => {
  it('holds a pattern from today, day 1 of 3; null gives it back to the engine', async () => {
    const out = await call('set_focus_pattern', { pattern: 'graphs' });
    expect(out.override).toEqual({ pattern: 'Graphs', since: TODAY });
    expect(out.focus).toMatchObject({ patternId: 'graphs', day: 1, of: 3, source: 'override' });
    expect((await call('leetcode_today')).focus).toMatchObject({
      patternId: 'graphs',
      source: 'override',
    });
    const again = await call('set_focus_pattern', { pattern: 'graphs' }); // a repeat is one state
    expect(again.override).toEqual({ pattern: 'Graphs', since: TODAY });
    const cleared = await call('set_focus_pattern', { pattern: null });
    expect(cleared.override).toBeNull();
    expect(cleared.focus).toMatchObject({ patternId: 'arrays-hashing', source: 'engine' });
  });
  it('refuses an unknown pattern, `other`, or no pattern — nothing written', async () => {
    for (const args of [{ pattern: 'graph' }, { pattern: 'other' }, {}])
      await expect(call('set_focus_pattern', args)).rejects.toBeInstanceOf(RpcParamError);
    expect(await repo.getCoachFocus({ consistent: true })).toBeNull();
  });
});

describe('delete_attempt', () => {
  it('removes a logged attempt and reads back what went; the queue recomputes', async () => {
    const logged = await call('log_attempt', {
      attempts: [{ slug: 'merge-intervals', outcome: 'failed' }],
    });
    const id = logged.attempts[0].id as string;
    expect(await call('delete_attempt', { id })).toEqual({
      id,
      deleted: true,
      slug: 'merge-intervals',
      title: 'Merge Intervals',
      day: TODAY,
      nextDue: null,
      stillTried: false,
    });
    expect((await call('list_problems')).problems).toEqual([]);
    // A repeat writes nothing and says so.
    expect(await call('delete_attempt', { id })).toMatchObject({ id, deleted: false });
  });
  it('a sitting’s id or an unknown id deletes nothing; a bad id is a param error', async () => {
    const s = await ended('two-sum', TODAY, true);
    expect(await call('delete_attempt', { id: s.id })).toMatchObject({ deleted: false });
    expect((await call('list_problems')).problems).toHaveLength(1);
    await expect(call('delete_attempt', { id: 'nope' })).rejects.toBeInstanceOf(RpcParamError);
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

describe('the full catalog over MCP', () => {
  function catalogCtx() {
    const store = new CatalogStore(doc, liveWrites(doc));
    const catalogInvoker = inlineCatalogInvoker((e) =>
      runCatalogImport(
        {
          store,
          source: new FakeCatalogSource({ ok: true, data: FIXTURE_SOURCE }),
          anthropic: new FakeAnthropic(),
          now,
          log: () => {},
        },
        e,
      ),
    );
    ctx = {
      dispatch: (method: ApiMethod, args: unknown[]) =>
        handleRpc(doc, { userId: U, method, args, now }, { catalogInvoker }),
      upload: async () => {},
      now,
    };
  }
  const reset = () => {
    unloadCatalog();
  };
  beforeEach(reset);
  afterEach(reset);

  it('reads absent, imports from an uploaded file in parts, then reads the result', async () => {
    catalogCtx();
    expect(await call('catalog_status')).toMatchObject({ state: 'absent', count: 0 });
    const cut = FIXTURE_CLASSES.length - 7; // mid-line: parts are raw slices, joined as sent
    expect(
      await call('import_catalog', { classes: FIXTURE_CLASSES.slice(0, cut), part: 1, parts: 2 }),
    ).toMatchObject({ state: 'staging', staged: { have: 1, of: 2 } });
    const done = await call('import_catalog', {
      classes: FIXTURE_CLASSES.slice(cut),
      part: 2,
      parts: 2,
    });
    expect(done).toMatchObject({ state: 'partial', count: 15, by: { model: 5 } });
    expect(done.importedAt).toMatch(/^2026-11-09T/);
  });

  it('get_problem knows an untried problem from the catalog, off the roadmap, with its related ones', async () => {
    catalogCtx();
    await call('import_catalog', { classes: FIXTURE_CLASSES });
    const out = await call('get_problem', { slug: 'synthetic-window-sum' });
    expect(out.problem).toMatchObject({
      title: 'Synthetic Window Sum',
      patternId: 'sliding-window',
      difficulty: 'Medium',
      onRoadmap: false,
      lists: ['leetcode'],
      number: 9001,
      premium: false,
      similar: [{ slug: 'synthetic-greedy-jumps', title: 'Synthetic Greedy Jumps' }],
      harder: [{ slug: 'synthetic-heap-merge', title: 'Synthetic Heap Merge' }],
    });
    expect(out.record).toBeNull();
    const ns = await call('get_problem', { slug: 'two-sum' });
    expect(ns.problem).toMatchObject({ onRoadmap: true, lists: ['neetcode150', 'leetcode'] });
  });

  it('refuses a malformed import before writing anything', async () => {
    catalogCtx();
    await expect(call('import_catalog', { classes: 'x', part: 3, parts: 2 })).rejects.toThrow(
      /part must/,
    );
    expect((await call('catalog_status')).state).toBe('absent');
  });
});

describe('log_mock and list_mocks', () => {
  it('logs a done mock and lists it, with the week line read back; no task is made', async () => {
    const out = await call('log_mock', {
      scores: { code: 3, solve: 2, communicate: 4 },
      partner: 'Study group',
      notes: 'clarified late',
    });
    expect(out).toEqual({
      mock: {
        id: expect.any(String),
        day: TODAY,
        status: 'done',
        kind: 'human',
        partner: 'Study group',
        problemSlug: null,
        sittingId: null,
        scores: { code: 3, solve: 2, communicate: 4 },
        notes: 'clarified late',
      },
      week: 'Mock this week: Code 3 · Solve 2 · Communication 4',
    });
    const list = await call('list_mocks');
    expect(list).toMatchObject({
      total: 1,
      doneCount: 1,
      mocks: [{ id: out.mock.id }],
      trend: [{ day: TODAY, code: 3, solve: 2 }],
    });
    expect(await backend.listTasks()).toEqual([]);
    expect((await call('leetcode_today')).mock).toMatchObject({ thisWeek: 'done', doneCount: 1 });
  });

  it('plans one, then marks it done by id, keeping its kind and partner', async () => {
    const planned = await call('log_mock', {
      status: 'planned',
      day: '2026-11-10',
      kind: 'claude',
    });
    expect(planned.week).toBe('Mock planned tomorrow');
    expect((await call('leetcode_today')).mock.upcoming).toEqual([
      expect.objectContaining({ id: planned.mock.id, day: '2026-11-10' }),
    ]);
    const logged = await call('log_mock', {
      id: planned.mock.id,
      status: 'done',
      day: TODAY,
      scores: { code: 2, solve: 2 },
    });
    expect(logged.mock).toMatchObject({ id: planned.mock.id, kind: 'claude', status: 'done' });
    expect((await call('list_mocks')).total).toBe(1);
  });

  it('refuses bad scores and a bad id before writing; list_mocks filters and checks its range', async () => {
    await expect(call('log_mock', { scores: { code: 5, solve: 2 } })).rejects.toThrow(/1 to 4/);
    await expect(call('log_mock', { scores: { solve: 2 } })).rejects.toThrow(/code/);
    await expect(
      call('log_mock', { id: 'nope', scores: { code: 2, solve: 2 } }),
    ).rejects.toBeInstanceOf(RpcParamError);
    expect((await call('list_mocks')).total).toBe(0);
    await call('log_mock', { day: '2026-11-01', scores: { code: 1, solve: 1 } });
    await call('log_mock', { scores: { code: 2, solve: 3 } });
    const narrowed = await call('list_mocks', { from: '2026-11-05' });
    expect(narrowed.mocks.map((m: { day: string }) => m.day)).toEqual([TODAY]);
    expect((await call('list_mocks')).trend.map((x: { code: number }) => x.code)).toEqual([1, 2]);
    expect((await call('list_mocks', { limit: 1 })).mocks).toHaveLength(1);
    await expect(
      call('list_mocks', { from: '2026-11-09', to: '2026-11-01' }),
    ).rejects.toBeInstanceOf(RpcParamError);
    await expect(call('list_mocks', { limit: 0 })).rejects.toBeInstanceOf(RpcParamError);
  });

  it('a failed read of the week after the save says so, not as a failed write', async () => {
    const real = ctx.dispatch;
    ctx = {
      ...ctx,
      dispatch: (method, args) =>
        method === 'getCoachToday' ? Promise.reject(new Error('throttled')) : real(method, args),
    };
    const out = await call('log_mock', { scores: { code: 2, solve: 2 } });
    expect(out).toMatchObject({ week: null, note: expect.stringMatching(/don’t log it again/) });
    expect((await backend.listMocks()).map((m) => m.id)).toEqual([out.mock.id]);
  });
});
