import { describe, it, expect } from 'vitest';
import { SMOKE_CALLS, buildEvent, assertHealthy } from './smoke';

describe('smoke', () => {
  it('builds a testMode direct-invoke event (no http context → skips the origin gate)', () => {
    const ev = JSON.parse(buildEvent({ method: 'getSettings', args: [] })) as { rawPath: string; body: string };
    expect(ev.rawPath).toBe('/api/getSettings');
    expect(JSON.parse(ev.body)).toEqual({ testMode: true, args: [] });
  });

  it('accepts a 200 with a plain JSON body', () => {
    expect(() => assertHealthy({ method: 'getSettings', args: [] }, { statusCode: 200, body: '{"dayStartHour":4}' })).not.toThrow();
  });

  it('fails on a non-200', () => {
    expect(() => assertHealthy({ method: 'getSettings', args: [] }, { statusCode: 401, body: '{"error":"Unauthorized"}' })).toThrow(/401/);
  });

  it('fails on an error envelope even with a 200', () => {
    expect(() => assertHealthy({ method: 'x', args: [] }, { statusCode: 200, body: '{"error":"boom"}' })).toThrow(/error/);
  });

  it('only smokes read methods with empty args (no side effects)', () => {
    expect(SMOKE_CALLS.every((c) => c.args.length === 0)).toBe(true);
  });
});
