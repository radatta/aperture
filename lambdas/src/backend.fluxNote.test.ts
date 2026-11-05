import { describe, expect, it } from 'vitest';
import { USER_TIME_ZONE, zonedEpoch } from '@aperture/shared';
import type { RecordFluxSetInput } from '@aperture/shared';
import { InMemoryDoc, type Item } from './ddb/DocClient';
import { Repo } from './ddb/repo';
import { liveWrites } from './ddb/writes';
import { BackendClient } from './backend';
import { FakeAnthropic } from './anthropic/gateway';
import { ulid } from '@aperture/shared';

// The weekly note on the server (docs/areas/flux D62): one model call per change to the week's sets, the
// answer validated, every failure the deterministic line — stored too, so a bad hour never costs a call
// per request. The contract suite holds the stub and the Lambda to the same null/cache/line behaviour;
// this is the model seam, which only the Lambda has.

const MONDAY = zonedEpoch('2026-11-02', '10:00', USER_TIME_ZONE); // 2026-11-02 is a Monday

function makeBackend(now = MONDAY) {
  const doc = new InMemoryDoc();
  const anthropic = new FakeAnthropic();
  let clock = now;
  // Count the note rows written (one per change to the week, never one per request).
  const live = liveWrites(doc);
  let notePuts = 0;
  const writes = {
    ...live,
    put: (item: Item) => {
      if (String(item.SK).startsWith('fluxnote#')) notePuts++;
      return live.put(item);
    },
  };
  const b = new BackendClient(new Repo(doc, writes, 'local'), {
    userId: 'local',
    now: () => clock,
    anthropic,
  });
  return { b, anthropic, tick: (ms: number) => (clock += ms), notePuts: () => notePuts };
}

const set = (over: Partial<RecordFluxSetInput> = {}): RecordFluxSetInput => ({
  id: ulid(),
  day: '2026-11-02',
  exerciseId: 'cervical-rotation',
  kind: 'romReps',
  side: null,
  condition: null,
  count: 10,
  avgPeakDeg: 44,
  avgErrorDeg: null,
  rom: { pitch: 4, yaw: 100, roll: 5 },
  calibrated: true,
  delegate: 'GPU',
  durationSec: 150,
  completedAt: MONDAY - 1000,
  repTaskId: null,
  stoppedEarly: false,
  planned: 10,
  ...over,
});

describe('backend getFluxWeekNote', () => {
  it('asks the model once per change to the week, stores the validated note, and serves it from the row', async () => {
    const { b, anthropic, tick, notePuts } = makeBackend();
    await b.recordFluxSet(set({ completedAt: MONDAY - 3000, avgPeakDeg: 44 }));
    await b.recordFluxSet(set({ completedAt: MONDAY - 2000, avgPeakDeg: 53 }));
    anthropic.nextNote = { ok: true, fields: { note: 'Rotation twice this week, 44° to 53°.' } };
    const note = await b.getFluxWeekNote();
    expect(note).toEqual({
      weekStart: '2026-11-02',
      text: 'Rotation twice this week, 44° to 53°.',
      generatedAt: MONDAY,
    });
    expect(anthropic.noteCalls).toHaveLength(1);
    expect(anthropic.noteCalls[0]?.line).toMatch(
      /^This week: 2 sets rotation 44° → 53° · first week$/,
    );
    expect(anthropic.noteCalls[0]?.timeoutMs).toBe(6_000);
    expect(notePuts()).toBe(1);

    tick(60_000);
    expect(await b.getFluxWeekNote()).toEqual(note); // cached: no call, no write
    expect(anthropic.noteCalls).toHaveLength(1);

    anthropic.nextNote = { ok: true, fields: { note: 'Rotation three times, 44° to 60°.' } };
    await b.recordFluxSet(set({ completedAt: MONDAY - 1000, avgPeakDeg: 60 }));
    const next = await b.getFluxWeekNote();
    expect(next?.text).toBe('Rotation three times, 44° to 60°.');
    expect(next?.generatedAt).toBe(MONDAY + 60_000);
    expect(anthropic.noteCalls).toHaveLength(2);
    expect(notePuts()).toBe(2); // one write per change to the week
  });

  it('keeps the deterministic line on a model failure, a bad answer, or an invented number — and stores that too', async () => {
    const { b, anthropic } = makeBackend();
    await b.recordFluxSet(set({ completedAt: MONDAY - 3000 }));
    await b.recordFluxSet(set({ completedAt: MONDAY - 2000, avgPeakDeg: 53 }));
    const line = 'This week: 2 sets rotation 44° → 53° · first week';
    expect((await b.getFluxWeekNote())?.text).toBe(line); // unavailable (the Fake's default)
    expect(anthropic.noteCalls).toHaveLength(1);
    expect((await b.getFluxWeekNote())?.text).toBe(line);
    expect(anthropic.noteCalls).toHaveLength(1); // the fallback is cached like a note

    for (const bad of [
      { ok: true as const, fields: { note: 'x'.repeat(141) } },
      { ok: true as const, fields: { note: '   ' } },
      { ok: true as const, fields: { note: 'Rotation improved by 12 degrees.' } }, // 12 is not in the input
      { ok: true as const, fields: { nope: 1 } },
      { ok: false as const, reason: 'timeout' as const },
    ]) {
      const fresh = makeBackend();
      await fresh.b.recordFluxSet(set({ completedAt: MONDAY - 3000 }));
      await fresh.b.recordFluxSet(set({ completedAt: MONDAY - 2000, avgPeakDeg: 53 }));
      fresh.anthropic.nextNote = bad;
      expect((await fresh.b.getFluxWeekNote())?.text).toBe(line);
    }
  });

  it('is null under two sets this week, and last week’s sets only count as last week', async () => {
    const { b, anthropic } = makeBackend();
    await b.recordFluxSet(set({ day: '2026-10-30', completedAt: MONDAY - 3 * 86_400_000 }));
    await b.recordFluxSet(set({ day: '2026-10-31', completedAt: MONDAY - 2 * 86_400_000 }));
    expect(await b.getFluxWeekNote()).toBeNull();
    expect(anthropic.noteCalls).toHaveLength(0);
    await b.recordFluxSet(set({ completedAt: MONDAY - 2000 }));
    expect(await b.getFluxWeekNote()).toBeNull(); // one this week
    await b.recordFluxSet(set({ completedAt: MONDAY - 1000, avgPeakDeg: 50 }));
    expect((await b.getFluxWeekNote())?.text).toBe(
      'This week: 2 sets rotation 44° → 50° · last week 2',
    );
    expect(anthropic.noteCalls[0]?.summary.lastWeekSets).toBe(2);
    expect(anthropic.noteCalls[0]?.summary.exercises[0]?.lastWeek).toEqual({ sets: 2, latest: 44 });
  });
});
