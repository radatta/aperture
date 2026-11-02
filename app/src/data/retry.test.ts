import { describe, expect, it } from 'vitest';
import { queryClient } from './queryClient';
import { ApiError, isThrottle, isTransientRead, retryDelayMs, retryQuery } from './retry';

describe('retry policy', () => {
  it('retries a 5xx and a network failure on reads, up to two more tries', () => {
    for (const e of [
      new ApiError('x', 500),
      new ApiError('x', 503),
      new TypeError('Failed to fetch'),
    ]) {
      expect(retryQuery(0, e)).toBe(true);
      expect(retryQuery(1, e)).toBe(true);
      expect(retryQuery(2, e)).toBe(false);
    }
  });

  it('does not retry a 400 refusal, a 401, a 404 or a plain Error at the query layer', () => {
    for (const e of [
      new ApiError('x', 400),
      new ApiError('x', 401),
      new ApiError('x', 404),
      new Error('stub'),
    ])
      expect(retryQuery(0, e)).toBe(false);
  });

  it('leaves a 429 to the http client, which already retried it', () => {
    const e = new ApiError('x', 429);
    expect(isThrottle(e)).toBe(true);
    expect(isTransientRead(e)).toBe(false);
    expect(retryQuery(0, e)).toBe(false);
  });

  it('backs off 600 ms then 1800 ms, jittered ±20%', () => {
    expect(retryDelayMs(0, () => 0.5)).toBe(600);
    expect(retryDelayMs(1, () => 0.5)).toBe(1800);
    expect(retryDelayMs(0, () => 0)).toBe(480);
    expect(retryDelayMs(1, () => 1)).toBeCloseTo(2160);
  });

  it('the app QueryClient wires the policy and leaves mutations un-retried', () => {
    const d = queryClient.getDefaultOptions();
    expect(d.queries?.retry).toBe(retryQuery);
    expect(d.queries?.networkMode).toBe('always'); // offline fails visibly, never pauses on "Loading…"
    expect(d.mutations?.retry).toBeUndefined();
    // Writes keep TanStack's 'online': offline, a write is held and sent on reconnect, not failed.
    expect(d.mutations?.networkMode).toBeUndefined();
  });
});
