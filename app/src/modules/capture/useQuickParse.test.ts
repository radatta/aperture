import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParseTaskResult } from '@aperture/shared';
import { PARSE_CLIENT_TIMEOUT_MS, withTimeout } from './useQuickParse';

// The client's ceiling on a parse (the capture bar's tests can't drive fake timers through RTL's waitFor,
// so the race is pinned here; CaptureBar.test covers what a timeout outcome does — a raw save).
describe('withTimeout', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const ok: ParseTaskResult = {
    ok: true,
    source: 'haiku',
    input: { title: 'x' },
    categoryLabel: null,
    placeName: null,
    dropped: [],
    today: '2026-10-12',
  };

  it('a parse that never replies becomes a timeout outcome at the ceiling, not before', async () => {
    let settled: ParseTaskResult | null = null;
    void withTimeout(new Promise(() => {}), PARSE_CLIENT_TIMEOUT_MS).then((r) => (settled = r));
    await vi.advanceTimersByTimeAsync(PARSE_CLIENT_TIMEOUT_MS - 1);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toEqual({ ok: false, reason: 'timeout', detail: 'no reply in 10s' });
  });

  it('a reply in time wins, and clears the timer', async () => {
    const r = withTimeout(Promise.resolve(ok), PARSE_CLIENT_TIMEOUT_MS);
    await expect(r).resolves.toEqual(ok);
    expect(vi.getTimerCount()).toBe(0);
  });
});
