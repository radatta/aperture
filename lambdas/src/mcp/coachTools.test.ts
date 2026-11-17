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
    for (const name of [
      'mark_peeked',
      'set_cause_tag',
      'swap_slot',
      'log_attempt',
      'set_focus_pattern',
      'delete_attempt',
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
