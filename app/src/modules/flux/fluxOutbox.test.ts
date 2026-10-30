import { afterEach, describe, expect, it, vi } from 'vitest';
import { ulid, type RecordFluxSetInput } from '@aperture/shared';
import {
  draftToInput,
  FLUX_OUTBOX_KEY,
  outboxAdd,
  outboxMarkError,
  outboxInMemoryOnly,
  outboxRemove,
  readOutbox,
} from './fluxOutbox';
import type { FluxSetDraft } from './useFluxEngine';

const input = (id = ulid()): RecordFluxSetInput => ({
  id,
  day: '2026-10-20',
  exerciseId: 'chin-tuck',
  kind: 'holdAtTarget',
  side: null,
  condition: null,
  count: 10,
  avgPeakDeg: null,
  avgErrorDeg: null,
  rom: { pitch: 8, yaw: 1, roll: 1 },
  calibrated: true,
  delegate: 'GPU',
  durationSec: 120,
  completedAt: 1_000,
  repTaskId: null,
  stoppedEarly: false,
  planned: 10,
});

describe('fluxOutbox (D49)', () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('keeps a queued set across a reload until it is removed', () => {
    const a = input();
    outboxAdd(a, 5);
    outboxAdd(a, 6); // the same set twice is one entry
    expect(JSON.parse(localStorage.getItem(FLUX_OUTBOX_KEY) ?? '[]')).toEqual([
      { input: a, at: 5, error: null },
    ]);
    outboxMarkError(a.id, 'offline');
    expect(readOutbox()[0]?.error).toBe('offline');
    outboxRemove(a.id);
    expect(readOutbox()).toEqual([]);
    expect(localStorage.getItem(FLUX_OUTBOX_KEY)).toBeNull();
  });

  it('fills in an entry queued before sets said whether they were stopped early (D55)', () => {
    const old: Partial<RecordFluxSetInput> = { ...input() };
    delete old.stoppedEarly;
    delete old.planned;
    localStorage.setItem(FLUX_OUTBOX_KEY, JSON.stringify([{ input: old, at: 1, error: null }]));
    expect(readOutbox()[0]?.input).toMatchObject({ stoppedEarly: false, planned: 6 }); // chin tuck
  });

  it('reads garbage as empty', () => {
    localStorage.setItem(FLUX_OUTBOX_KEY, '{not json');
    expect(readOutbox()).toEqual([]);
  });

  it('keeps the set in memory when storage refuses it — never a silent loss', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const a = input();
    expect(() => outboxAdd(a, 1)).not.toThrow();
    expect(readOutbox().map((e) => e.input.id)).toEqual([a.id]);
    expect(outboxInMemoryOnly()).toBe(true);
    outboxMarkError(a.id, 'offline');
    expect(readOutbox()[0]?.error).toBe('offline');
    // Storage works again: the next write lands there and memory steps aside.
    vi.restoreAllMocks();
    outboxAdd(input(), 2);
    expect(outboxInMemoryOnly()).toBe(false);
    expect(JSON.parse(localStorage.getItem(FLUX_OUTBOX_KEY) ?? '[]')).toHaveLength(2);
  });

  it('back from memory, keeps what another tab queued in storage meanwhile', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const mine = input();
    outboxAdd(mine, 1); // memory only
    setItem.mockRestore();
    const theirs = input();
    localStorage.setItem(FLUX_OUTBOX_KEY, JSON.stringify([{ input: theirs, at: 2, error: null }]));
    outboxMarkError(mine.id, 'offline'); // this tab's next write sticks
    expect(outboxInMemoryOnly()).toBe(false);
    expect(readOutbox().map((e) => e.input.id)).toEqual([mine.id, theirs.id]);
  });

  it('back from memory, a set discarded meanwhile stays discarded', () => {
    const gone = input();
    outboxAdd(gone, 1); // in storage
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('quota');
    });
    outboxRemove(gone.id); // discarded — but storage still holds it
    vi.restoreAllMocks();
    outboxAdd(input(), 2); // storage is back
    expect(readOutbox().map((e) => e.input.id)).not.toContain(gone.id);
  });

  it('builds the server input from the stage draft plus its keys', () => {
    const draft: FluxSetDraft = {
      exerciseId: 'upper-trap-stretch',
      kind: 'holdAtTarget',
      side: 'b',
      condition: 'herniatedDisc',
      count: 2,
      rom: { pitch: 1, yaw: 2, roll: 30 },
      calibrated: true,
      delegate: 'CPU',
      durationSec: 70,
      completedAt: 9_000,
      stoppedEarly: true,
      planned: 4,
    };
    expect(draftToInput(draft, { id: 'X', day: '2026-10-20', repTaskId: 'T' })).toEqual({
      ...draft,
      id: 'X',
      day: '2026-10-20',
      avgPeakDeg: null,
      avgErrorDeg: null,
      repTaskId: 'T',
    });
  });
});
