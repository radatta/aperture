import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useNow } from './useNow';

afterEach(() => vi.useRealTimers());

describe('useNow', () => {
  it('re-reads the clock on its interval', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { result } = renderHook(() => useNow(60_000));
    expect(result.current).toBe(1_000_000);
    act(() => vi.advanceTimersByTime(60_000));
    expect(result.current).toBe(1_060_000);
  });
});
