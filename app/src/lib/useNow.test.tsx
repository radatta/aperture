import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useNow } from './useNow';

// No fake timers here: files share globals (isolate: false), and a fake clock leaking out of this file
// stalled other files' waitFor. The interval is spied instead, and its tick called by hand. Spies are
// restored in `finally`, never via restoreAllMocks (that also undoes setup-installed spies).
describe('useNow', () => {
  it('re-reads the clock on each tick, from one interval shared by every subscriber', () => {
    const set = vi.spyOn(globalThis, 'setInterval');
    const clear = vi.spyOn(globalThis, 'clearInterval');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      const a = renderHook(() => useNow());
      const b = renderHook(() => useNow());
      expect(a.result.current).toBe(1_000_000);
      expect(set).toHaveBeenCalledTimes(1);
      expect(set.mock.calls[0]![1]).toBe(60_000);

      clock.mockReturnValue(1_060_000);
      act(() => (set.mock.calls[0]![0] as () => void)());
      expect(a.result.current).toBe(1_060_000);
      expect(b.result.current).toBe(1_060_000);

      a.unmount();
      expect(clear).not.toHaveBeenCalled();
      b.unmount();
      expect(clear).toHaveBeenCalledTimes(1);
    } finally {
      set.mockRestore();
      clear.mockRestore();
      clock.mockRestore();
    }
  });
});
