import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useNow } from './useNow';

afterEach(() => vi.useRealTimers());

describe('useNow', () => {
  it('re-reads the clock every minute', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { result } = renderHook(() => useNow());
    expect(result.current).toBe(1_000_000);
    act(() => vi.advanceTimersByTime(60_000));
    expect(result.current).toBe(1_060_000);
  });

  it('shares one interval across every subscriber, and stops it with the last', () => {
    vi.useFakeTimers();
    const set = vi.spyOn(globalThis, 'setInterval');
    const clear = vi.spyOn(globalThis, 'clearInterval');
    try {
      const a = renderHook(() => useNow());
      const b = renderHook(() => useNow());
      expect(set).toHaveBeenCalledTimes(1);
      a.unmount();
      expect(clear).not.toHaveBeenCalled();
      b.unmount();
      expect(clear).toHaveBeenCalledTimes(1);
    } finally {
      // Restored here, not via restoreAllMocks: files share globals (isolate: false), and that would
      // also undo setup-installed spies other files rely on.
      set.mockRestore();
      clear.mockRestore();
    }
  });
});
