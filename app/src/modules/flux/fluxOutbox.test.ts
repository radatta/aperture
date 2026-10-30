import { afterEach, describe, expect, it, vi } from 'vitest';
import { ulid, type RecordFluxSetInput } from '@aperture/shared';
import {
  draftToInput,
  FLUX_OUTBOX_KEY,
  outboxAdd,
  outboxMarkError,
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

  it('never throws when storage is unavailable, and reads garbage as empty', () => {
    localStorage.setItem(FLUX_OUTBOX_KEY, '{not json');
    expect(readOutbox()).toEqual([]);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(() => outboxAdd(input(), 1)).not.toThrow();
    expect(readOutbox()).toEqual([]);
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
