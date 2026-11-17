import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Sitting } from '@aperture/shared';
import { IDLE_RECHECK_MS, useIdleRecheck } from './useSittings';

// A cached open head past the idle line, read longer ago than the recheck, is read again before a Done prefills.
describe('useIdleRecheck', () => {
  const M = 60_000;
  const open = { status: 'active', startedAt: 0, reopenedAt: null } as unknown as Sitting;
  const run = (s: Sitting | null, fetchedAt: number, now: number, fetching = false) => {
    const refetch = vi.fn();
    const { result } = renderHook(() => useIdleRecheck(s, fetchedAt, now, fetching, refetch));
    return { stale: result.current, refetch };
  };
  it('refetches an old cache of a sitting that may be idle, and says to wait', () => {
    const r = run(open, 46 * M - IDLE_RECHECK_MS - 1, 46 * M);
    expect(r.stale).toBe(true);
    expect(r.refetch).toHaveBeenCalledTimes(1);
  });
  it('a fresh cache, a sitting not yet past the line, or a fetch in flight: no refetch', () => {
    expect(run(open, 46 * M - 1000, 46 * M)).toMatchObject({ stale: false });
    expect(run(open, 0, 45 * M).stale).toBe(false);
    expect(run({ ...open, status: 'abandoned' } as Sitting, 0, 99 * M).stale).toBe(false);
    expect(run(null, 0, 99 * M).stale).toBe(false);
    expect(run(open, 0, 99 * M, true).refetch).not.toHaveBeenCalled();
  });
});
