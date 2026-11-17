import { describe, expect, it } from 'vitest';
import { AI_PICK_NOTICE, AI_PICK_STALE_MS, AI_PICK_BUSY_ERROR } from '@aperture/shared';
import type { CoachToday } from '@aperture/shared';
import { InMemoryDoc } from '../ddb/DocClient';
import { Repo } from '../ddb/repo';
import { liveWrites } from '../ddb/writes';
import { BackendClient } from '../backend';
import { handleRpc } from '../handler';
import { FakeAnthropic } from '../anthropic/gateway';
import type { CoachPickCall, CoachPickRequest } from '../anthropic/gateway';
import { handleCoachPick } from '../coachWorker';
import { inlinePickInvoker } from './invoker';
import type { CoachPickEvent, CoachPickInvoker } from './invoker';
import { runCoachPick } from './pick';

// The coach's AI pick on the server (docs/areas/recruiting/coach.md → The AI pick): the claim, the worker's one call,
// the guardrails and every way it falls back — always to the rules, always with the notice. Synthetic history only.

const NOW = Date.parse('2026-11-16T19:00:00Z'); // 11:00 in LA: the user's day is 2026-11-16
const U = 'local';

type Mode = 'inline' | 'deferred' | 'throws';
async function setup(o: { mode?: Mode; history?: boolean } = {}) {
  const doc = new InMemoryDoc();
  const anthropic = new FakeAnthropic();
  let now = NOW;
  const clock = { now: () => now, at: (t: number) => (now = t) };
  const run = (e: CoachPickEvent) =>
    runCoachPick(
      { repo: new Repo(doc, liveWrites(doc), e.userId), anthropic, now: clock.now, log: () => {} },
      e,
    );
  const events: CoachPickEvent[] = [];
  const invoker: CoachPickInvoker =
    o.mode === 'deferred'
      ? { enabled: true, invoke: async (e) => void events.push(e) }
      : o.mode === 'throws'
        ? {
            enabled: true,
            invoke: async () => {
              throw new Error('throttled');
            },
          }
        : inlinePickInvoker(run);
  const b = new BackendClient(new Repo(doc, liveWrites(doc), U), {
    userId: U,
    now: clock.now,
    anthropic,
    coachPickInvoker: invoker,
  });
  if (o.history !== false)
    await b.logCoachAttempts([
      { slug: 'two-sum', day: '2026-11-12', outcome: 'failed', minutes: 40 },
      { slug: 'valid-anagram', day: '2026-11-13', outcome: 'failed', cause: 'boundary' },
      { slug: 'group-anagrams', day: '2026-11-15', outcome: 'failed' },
    ]);
  return { doc, anthropic, b, clock, events, run };
}
const answer =
  (pick: (req: CoachPickRequest) => unknown) =>
  (req: CoachPickRequest): CoachPickCall => ({
    ok: true,
    fields: pick(req),
    model: 'claude-opus-5-5',
    usage: { input: 5000, output: 900 },
    ms: 20_000,
  });
const firstTwo = answer((req) => ({
  picks: req.ctx.candidates.slice(0, 2).map((c, i) => ({ slug: c.slug, why: `why ${i + 1}` })),
  note: 'A light day.',
  focus: null,
}));
const stored = async (b: BackendClient) => (await b.exportData()).coachDays[0]?.ai;

describe('the AI pick, end to end', () => {
  it('a due day is picked once: the slots in its order, with its whys, the note, and the tokens stored', async () => {
    const { anthropic, b } = await setup();
    anthropic.nextPick = firstTwo;
    expect((await b.getCoachToday()).ai).toMatchObject({ status: 'due' });
    const t = await b.startCoachPick();
    expect(t.ai).toMatchObject({ status: 'ok', source: 'ai', note: 'A light day.', notice: null });
    expect(t.slots.map((s) => s.aiWhy)).toEqual(['why 1', 'why 2']);
    expect(anthropic.pickCalls).toHaveLength(1);
    expect(await stored(b)).toMatchObject({
      status: 'ok',
      model: 'claude-opus-5-5',
      usage: { input: 5000, output: 900 },
      oldestDue: 'two-sum',
    });
    // The context carries no ids.
    expect(JSON.stringify(anthropic.pickCalls[0]!.ctx)).not.toMatch(/01[A-Z0-9]{24}/);
  });

  it('a second read or start never calls again', async () => {
    const { anthropic, b } = await setup();
    anthropic.nextPick = firstTwo;
    const first = await b.startCoachPick();
    await b.getCoachToday();
    const again = await b.startCoachPick();
    expect(anthropic.pickCalls).toHaveLength(1);
    expect(again.ai?.pickedAt).toBe(first.ai?.pickedAt);
  });

  it('an API error falls back to the rules, with the notice', async () => {
    const { anthropic, b } = await setup();
    anthropic.nextPick = {
      ok: false,
      reason: 'api',
      detail: 'HTTP 529',
      model: 'claude-opus-5-5',
      usage: null,
      ms: 900,
    };
    const t = await b.startCoachPick();
    expect(t.ai).toMatchObject({ status: 'fallback', notice: AI_PICK_NOTICE, reason: 'api' });
    expect(t.slots.every((s) => s.aiWhy === null)).toBe(true);
    expect(t.slots.length).toBeGreaterThan(0);
  });

  it('a non-candidate id falls to the rules, naming the guardrail', async () => {
    const { anthropic, b } = await setup();
    anthropic.nextPick = answer(() => ({
      picks: [{ slug: 'contains-duplicate-ii', why: 'x' }],
      note: null,
      focus: null,
    }));
    const t = await b.startCoachPick();
    expect(t.ai).toMatchObject({ status: 'fallback', reason: 'invalid', notice: AI_PICK_NOTICE });
    expect(await stored(b)).toMatchObject({ detail: 'not-candidate' });
  });

  it('a refusal falls to the rules', async () => {
    const { anthropic, b } = await setup();
    anthropic.nextPick = {
      ok: false,
      reason: 'refusal',
      detail: 'refusal',
      model: 'claude-opus-5-5',
      usage: { input: 5000, output: 10 },
      ms: 3000,
    };
    expect((await b.startCoachPick()).ai).toMatchObject({ status: 'fallback', reason: 'refusal' });
  });

  it('applies a focus change to a top-3 pattern, and shows it', async () => {
    const { anthropic, b } = await setup();
    let to: CoachPickRequest['ctx']['top3'][number] | '' = '';
    anthropic.nextPick = answer((req) => {
      to = req.ctx.top3.find((p) => p !== req.ctx.focus.pattern)!;
      return {
        picks: [{ slug: 'two-sum', why: 'x' }],
        note: null,
        focus: { to, why: 'Weaker first tries' },
      };
    });
    const t = await b.startCoachPick();
    expect(t.focus).toMatchObject({ pattern: to, source: 'ai' });
    expect(t.ai?.focusChange).toMatchObject({ to, why: 'Weaker first tries' });
    expect((await b.exportData()).coachFocus).toMatchObject({ pattern: to, source: 'ai' });
  });
});

describe('the worker’s edges', () => {
  it('never moves a focus the user set during the call', async () => {
    const { anthropic, b, events, run } = await setup({ mode: 'deferred' });
    anthropic.nextPick = async (req: CoachPickRequest) => {
      const to = req.ctx.top3.find((p) => p !== req.ctx.focus.pattern)!;
      await b.setCoachFocus('graphs'); // the user, on the card, mid-call
      return answer(() => ({
        picks: [{ slug: 'two-sum', why: 'x' }],
        note: null,
        focus: { to, why: 'y' },
      }))(req);
    };
    await b.startCoachPick();
    expect(await run(events[0]!)).toBe('ok');
    expect((await b.exportData()).coachFocus).toMatchObject({
      pattern: 'graphs',
      source: 'override',
    });
    expect((await b.getCoachToday()).ai?.focusChange).toBeNull();
  });

  it('the switch turned off after the claim: no call, a fallback', async () => {
    const { anthropic, b, events, run } = await setup({ mode: 'deferred' });
    anthropic.nextPick = firstTwo;
    await b.startCoachPick();
    await b.updateSettings({ coachAiPick: false });
    expect(await run(events[0]!)).toBe('fallback');
    expect(anthropic.pickCalls).toHaveLength(0);
    expect(await stored(b)).toMatchObject({ status: 'fallback', detail: 'off' });
  });

  it('a throw after the start settles the day at once, never a silent timeout', async () => {
    const { anthropic, b, events, run } = await setup({ mode: 'deferred' });
    anthropic.nextPick = () => {
      throw new Error('boom');
    };
    await b.startCoachPick();
    expect(await run(events[0]!)).toBe('fallback');
    expect(await stored(b)).toMatchObject({
      status: 'fallback',
      reason: 'unavailable',
      detail: 'error',
    });
  });
});

describe('the claim', () => {
  it('two readers at once: one claim, one invoke, one call even when the event is redelivered', async () => {
    const { anthropic, b, events, run } = await setup({ mode: 'deferred' });
    anthropic.nextPick = firstTwo;
    const [x, y] = await Promise.all([b.startCoachPick(), b.startCoachPick()]);
    expect(events).toHaveLength(1);
    expect(x.ai?.status).toBe('pending');
    expect(y.ai?.status).toBe('pending');
    expect(await run(events[0]!)).toBe('ok');
    expect(await run(events[0]!)).toBe('not-ours');
    expect(anthropic.pickCalls).toHaveLength(1);
    expect((await b.getCoachToday()).ai?.status).toBe('ok');
  });

  it('while pending: slot changes wait, the floor doesn’t', async () => {
    const { b } = await setup({ mode: 'deferred' });
    const t = await b.startCoachPick();
    await expect(b.setCoachSlot({ slug: t.slots[0]!.slug, action: 'skip' })).rejects.toThrow(
      AI_PICK_BUSY_ERROR,
    );
    await expect(b.setCoachFloor(true)).resolves.toBeTruthy();
  });

  it('a claim that never lands reads as a timeout, with the notice, and is never retried', async () => {
    const { anthropic, b, clock, events, run } = await setup({ mode: 'deferred' });
    anthropic.nextPick = firstTwo;
    await b.startCoachPick();
    clock.at(NOW + AI_PICK_STALE_MS + 1);
    const t = await b.getCoachToday();
    expect(t.ai).toMatchObject({ status: 'fallback', reason: 'timeout', notice: AI_PICK_NOTICE });
    await b.startCoachPick();
    expect(events).toHaveLength(1);
    // The dropped event, delivered late anyway: no call, and the day keeps the timeout readers saw.
    expect(await run(events[0]!)).toBe('fallback');
    expect(anthropic.pickCalls).toHaveLength(0);
    expect(await stored(b)).toMatchObject({ status: 'fallback', reason: 'timeout' });
  });

  it('an event that waited in a queue is given up without a call', async () => {
    const { anthropic, b, clock, events, run } = await setup({ mode: 'deferred' });
    anthropic.nextPick = firstTwo;
    await b.startCoachPick();
    clock.at(NOW + 25_000);
    expect(await run(events[0]!)).toBe('fallback');
    expect(anthropic.pickCalls).toHaveLength(0);
    expect((await b.getCoachToday()).ai).toMatchObject({
      status: 'fallback',
      notice: AI_PICK_NOTICE,
    });
  });

  it('a result after the stale mark is kept as the timeout readers saw', async () => {
    const { anthropic, b, clock, events, run } = await setup({ mode: 'deferred' });
    anthropic.nextPick = (req) => {
      clock.at(NOW + AI_PICK_STALE_MS + 5_000); // the call ran long
      return firstTwo(req);
    };
    await b.startCoachPick();
    expect(await run(events[0]!)).toBe('fallback');
    expect(await stored(b)).toMatchObject({
      status: 'fallback',
      reason: 'timeout',
      detail: 'late',
    });
  });

  it('an invoke that fails falls back at once', async () => {
    const { anthropic, b } = await setup({ mode: 'throws' });
    const t = await b.startCoachPick();
    expect(t.ai).toMatchObject({
      status: 'fallback',
      reason: 'unavailable',
      notice: AI_PICK_NOTICE,
    });
    expect(anthropic.pickCalls).toHaveLength(0);
  });
});

describe('when there is no pick', () => {
  it('the setting off: nothing due, nothing called, a stored pick ignored', async () => {
    const { anthropic, b } = await setup();
    anthropic.nextPick = firstTwo;
    await b.startCoachPick();
    await b.updateSettings({ coachAiPick: false });
    const t = await b.getCoachToday();
    expect(t.ai).toBeNull();
    expect(t.slots.every((s) => s.aiWhy === null)).toBe(true);
    await b.startCoachPick();
    expect(anthropic.pickCalls).toHaveLength(1);
  });

  it('the setting off from the start: no call at all', async () => {
    const { anthropic, b } = await setup();
    await b.updateSettings({ coachAiPick: false });
    expect((await b.startCoachPick()).ai).toBeNull();
    expect(anthropic.pickCalls).toHaveLength(0);
    expect(await stored(b)).toBeUndefined();
  });

  it('a new user: no pick, no notice', async () => {
    const { anthropic, b } = await setup({ history: false });
    const t = await b.startCoachPick();
    expect(t.ai).toBeNull();
    expect(anthropic.pickCalls).toHaveLength(0);
  });

  it('a past day’s read never starts one', async () => {
    const { b } = await setup();
    expect((await b.getCoachToday('2026-11-15')).ai).toBeNull();
  });

  it('a smoke (testMode) read sees no pick', async () => {
    const { doc } = await setup();
    const t = (await handleRpc(
      doc,
      { userId: U, method: 'getCoachToday', args: [], testMode: true },
      { coachPickInvoker: inlinePickInvoker(async () => {}) },
    )) as CoachToday;
    expect(t.ai).toBeNull();
  });

  it('refuses a malformed event before touching the table', async () => {
    const doc = new InMemoryDoc();
    const fake = new FakeAnthropic();
    await expect(handleCoachPick(doc, fake, { userId: U, day: 'x', claimId: 'c' })).rejects.toThrow(
      'Invalid coach worker event: day',
    );
    await expect(handleCoachPick(doc, fake, { day: '2026-11-16', claimId: 'c' })).rejects.toThrow(
      'userId',
    );
    expect(fake.pickCalls).toHaveLength(0);
  });
});
