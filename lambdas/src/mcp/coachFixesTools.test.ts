import { beforeEach, describe, expect, it } from 'vitest';
import { emptySummary, ulid, type ApiMethod, type Sitting } from '@aperture/shared';
import { legacyRow } from '@aperture/shared/contract';
import { InMemoryDoc } from '../ddb/DocClient';
import { entityItem } from '../ddb/mapping';
import { Repo } from '../ddb/repo';
import { liveWrites } from '../ddb/writes';
import { handleRpc } from '../handler';
import { TOOLS } from './tools';
import { RpcParamError } from './types';
import type { ToolContext } from './types';

// The coach-fixes MCP surface over the real handleRpc path: set_void, set_claude_notes, the peek and off-catalog
// fields, the retry track, the plan mode and the legacy days. Synthetic data only.
const U = 'local';
const T0 = Date.parse('2026-11-09T18:00:00Z'); // 10:00 in the user's zone: their day is 2026-11-09
const TODAY = '2026-11-09';
const LEGACY_DAY = '2026-10-20';
let t = T0;
const now = () => t;
let repo: Repo;
let doc: InMemoryDoc;
let ctx: ToolContext;

beforeEach(async () => {
  t = T0;
  doc = new InMemoryDoc();
  repo = new Repo(doc, liveWrites(doc), U);
  const base = Date.parse('2026-10-20T17:00:00Z');
  for (const r of [
    legacyRow('valid-anagram', LEGACY_DAY, 'accepted', base, 1),
    legacyRow('two-sum', LEGACY_DAY, 'accepted', base + 60_000, 2),
  ])
    await doc.put(entityItem(U, `lc#${r.day}#${r.id}`, r));
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
async function ended(slug: string, day: string, accepted: boolean, open = false) {
  const startedAt = open ? T0 - 60_000 : T0 - 3600_000;
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
    updatedAt: startedAt,
    deletedAt: null,
    day,
    startedAt,
    clientStartedAt: startedAt,
    endedAt: open ? null : startedAt + 1200_000,
    status: open ? 'active' : 'done',
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

describe('set_void', () => {
  it('voids a sitting and a legacy day in one call, and un-voids them', async () => {
    const s = await ended('climbing-stairs', '2026-11-08', true);
    const out = await call('set_void', {
      targets: [
        { sittingId: s.id, void: true },
        { day: LEGACY_DAY, slug: 'valid-anagram', void: true },
      ],
    });
    expect(out.sittings).toEqual([
      { sittingId: s.id, slug: 'climbing-stairs', day: '2026-11-08', void: true, nextDue: null },
    ]);
    expect(out.legacy).toMatchObject([{ slug: 'valid-anagram', void: true, voidedBy: 'you' }]);
    // Only the legacy two-sum day (not voided) is left.
    expect((await call('list_problems')).problems.map((p: { slug: string }) => p.slug)).toEqual([
      'two-sum',
    ]);
    await call('set_void', {
      targets: [
        { sittingId: s.id, void: false },
        { day: LEGACY_DAY, slug: 'valid-anagram', void: false },
      ],
    });
    expect(
      (await call('list_problems')).problems.map((p: { slug: string }) => p.slug).sort(),
    ).toEqual(['climbing-stairs', 'two-sum', 'valid-anagram']);
  });

  it('get_problem lists a legacy day and its state; voided, the record goes; un-voided, it is back', async () => {
    const before = await call('get_problem', { slug: 'two-sum' });
    expect(before.record).toMatchObject({ attempts: 1, firstOutcome: 'clean' });
    expect(before.tries[0]).toMatchObject({ sources: ['legacy'], claudeNotes: [] });
    expect(before.legacy).toMatchObject([{ day: LEGACY_DAY, counted: true, voidedBy: null }]);
    await call('set_void', { targets: [{ day: LEGACY_DAY, slug: 'two-sum', void: true }] });
    const voided = await call('get_problem', { slug: 'two-sum' });
    expect(voided.record).toBeNull();
    expect(voided.legacy).toMatchObject([{ day: LEGACY_DAY, counted: false, voidedBy: 'you' }]);
    await call('set_void', { targets: [{ day: LEGACY_DAY, slug: 'two-sum', void: false }] });
    expect((await call('get_problem', { slug: 'two-sum' })).record).toMatchObject({ attempts: 1 });
  });

  it('refuses a bad target, an unknown sitting or a day with no legacy rows — and writes nothing', async () => {
    const s = await ended('climbing-stairs', '2026-11-08', true);
    await expect(call('set_void', { targets: [] })).rejects.toBeInstanceOf(RpcParamError);
    await expect(
      call('set_void', { targets: [{ sittingId: s.id, day: LEGACY_DAY, slug: 'x', void: true }] }),
    ).rejects.toBeInstanceOf(RpcParamError);
    await expect(call('set_void', { targets: [{ sittingId: s.id }] })).rejects.toBeInstanceOf(
      RpcParamError,
    );
    await expect(
      call('set_void', { targets: [{ sittingId: ulid(), void: true }] }),
    ).rejects.toThrow(/No sitting/);
    await expect(
      call('set_void', {
        targets: [
          { sittingId: s.id, void: true },
          { day: '2026-10-21', slug: 'valid-anagram', void: true },
        ],
      }),
    ).rejects.toThrow(/No legacy history/);
    expect((await repo.getSitting(s.id))?.review ?? null).toBeNull();
  });
});

describe('set_claude_notes', () => {
  it('saves notes on an accepted and an unaccepted sitting in one call; get_sitting and get_problem read them', async () => {
    const a = await ended('climbing-stairs', '2026-11-08', true);
    const b = await ended('climbing-stairs', '2026-11-07', false);
    expect(
      (await call('leetcode_today')).unnoted.map((u: { sittingId: string }) => u.sittingId),
    ).toEqual([a.id, b.id]);
    const out = await call('set_claude_notes', {
      notes: [
        { sittingId: a.id, text: 'Traced the base case.\nAccepted first try.' },
        { sittingId: b.id, text: 'Gave up at the cap; off by one on n = 2.' },
      ],
    });
    expect(out.saved.map((x: { claudeNotes: string }) => x.claudeNotes)).toEqual([
      'Traced the base case.\nAccepted first try.',
      'Gave up at the cap; off by one on n = 2.',
    ]);
    expect((await call('get_sitting', { id: a.id })).claudeNotes).toMatchObject({
      text: 'Traced the base case.\nAccepted first try.',
    });
    const p = await call('get_problem', { slug: 'climbing-stairs' });
    expect(p.tries.map((x: { claudeNotes: string[] }) => x.claudeNotes)).toEqual([
      ['Gave up at the cap; off by one on n = 2.'],
      ['Traced the base case.\nAccepted first try.'],
    ]);
    expect((await call('leetcode_today')).unnoted).toEqual([]);
  });

  it('takes an abandoned sitting, refuses an open one, and writes nothing on a refusal', async () => {
    const done = await ended('climbing-stairs', '2026-11-08', false);
    const a = { ...done, id: ulid(), clientSittingId: ulid(), status: 'abandoned' as const };
    await repo.putSittingIfAbsent(a);
    const open = await ended('valid-anagram', TODAY, false, true);
    await expect(
      call('set_claude_notes', {
        notes: [
          { sittingId: a.id, text: 'x' },
          { sittingId: open.id, text: 'y' },
        ],
      }),
    ).rejects.toThrow(/still open/);
    expect((await repo.getSitting(a.id))?.claudeNotes ?? null).toBeNull();
    const ok = await call('set_claude_notes', {
      notes: [{ sittingId: a.id, text: 'Dropped at the cap; the loop bound was off by one.' }],
    });
    expect(ok.saved).toMatchObject([
      { sittingId: a.id, claudeNotes: expect.stringMatching(/^Dropped/) },
    ]);
    expect((await repo.getSitting(a.id))?.status).toBe('abandoned');
    await expect(call('set_claude_notes', { notes: [] })).rejects.toBeInstanceOf(RpcParamError);
    await expect(
      call('set_claude_notes', { notes: [{ sittingId: a.id, text: 'z'.repeat(801) }] }),
    ).rejects.toThrow(/800/);
  });
});

describe('set_claude_notes on an idle sitting', () => {
  it('an idle-closed sitting takes notes: the write closes it as the app would, then saves', async () => {
    // Started 2 h ago with no events and no pulls: idle past the 45-minute line, its head still active.
    const s = await ended('climbing-stairs', TODAY, false, true);
    const idle = { ...s, id: ulid(), clientSittingId: ulid(), startedAt: T0 - 2 * 3600_000 };
    await repo.putSittingIfAbsent(idle);
    const out = await call('set_claude_notes', {
      notes: [{ sittingId: idle.id, text: 'Stopped after the first failing case; no trace.' }],
    });
    expect(out.saved).toMatchObject([{ sittingId: idle.id }]);
    expect(await repo.getSitting(idle.id)).toMatchObject({
      closedBy: 'idle',
      claudeNotes: { text: 'Stopped after the first failing case; no trace.' },
    });
  });
});

describe('the peek and off-catalog fields', () => {
  it('log_attempt: help solution with no outcome is one call onto the retry track', async () => {
    const out = await call('log_attempt', {
      attempts: [{ slug: 'counting-bits', help: 'solution', accepted: true }],
    });
    expect(out.attempts[0]).toMatchObject({ outcome: 'failed', help: 'solution' });
    expect(out.attempts[0].nextDue).toMatchObject({ track: 'retry' });
    const p = await call('get_problem', { slug: 'counting-bits' });
    expect(p.record).toMatchObject({ everAccepted: true, peeked: true });
  });

  it('mark_peeked with a day and no sitting keeps the accept, and titles an off-catalog problem', async () => {
    const out = await call('mark_peeked', {
      slug: 'made-up-problem',
      day: '2026-11-05',
      accepted: true,
      title: 'Made Up Problem',
      difficulty: 'Medium',
    });
    expect(out.nextDue).toMatchObject({ track: 'retry', dueDay: '2026-11-06' });
    const p = await call('get_problem', { slug: 'made-up-problem' });
    expect(p.problem).toMatchObject({ title: 'Made Up Problem', difficulty: 'Medium' });
    expect(p.record).toMatchObject({ everAccepted: true });
    await expect(call('mark_peeked', { sittingId: ulid(), title: 'x' })).rejects.toBeInstanceOf(
      RpcParamError,
    );
  });

  it('mark_peeked keeps an accept already logged that day, without accepted', async () => {
    await call('log_attempt', {
      attempts: [{ slug: 'counting-bits', day: '2026-11-05', outcome: 'solved' }],
    });
    await call('mark_peeked', { slug: 'counting-bits', day: '2026-11-05' });
    expect((await call('get_problem', { slug: 'counting-bits' })).record).toMatchObject({
      everAccepted: true,
      lastOutcome: 'failed',
    });
  });
});

describe('the retry track and the plan mode', () => {
  it('list_problems filters by track; "peeked" reads as retry; leetcode_today carries the plan mode', async () => {
    await call('log_attempt', {
      attempts: [
        { slug: 'counting-bits', day: '2026-11-05', outcome: 'failed' },
        { slug: 'climbing-stairs', day: '2026-11-05', outcome: 'clean' },
      ],
    });
    const slugs = async (track: string) =>
      (await call('list_problems', { track })).problems.map((p: { slug: string }) => p.slug);
    expect(await slugs('retry')).toEqual(['counting-bits']);
    expect(await slugs('peeked')).toEqual(['counting-bits']);
    expect((await slugs('clean')).sort()).toEqual(['climbing-stairs', 'two-sum', 'valid-anagram']);
    await expect(call('list_problems', { track: 'fast' })).rejects.toBeInstanceOf(RpcParamError);
    const today = await call('leetcode_today');
    expect(today.planMode).toMatchObject({
      setting: 'auto',
      mode: 'balanced',
      line: expect.stringMatching(/^Balanced: \d+ due · auto$/),
    });
    expect(
      today.due.every((q: { track: string }) => q.track === 'retry' || q.track === 'clean'),
    ).toBe(true);
  });
});
