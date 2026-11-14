import { describe, it, expect } from 'vitest';
import { SMOKE_CALLS, buildEvent, assertHealthy } from './smoke';

describe('smoke', () => {
  it('builds a testMode direct-invoke event (no http context → skips the origin gate)', () => {
    const ev = JSON.parse(buildEvent({ method: 'getSettings', args: [] })) as {
      rawPath: string;
      body: string;
    };
    expect(ev.rawPath).toBe('/api/getSettings');
    expect(JSON.parse(ev.body)).toEqual({ testMode: true, args: [] });
  });

  it('accepts a 200 with a plain JSON body', () => {
    expect(() =>
      assertHealthy(
        { method: 'getSettings', args: [] },
        { statusCode: 200, body: '{"dayStartHour":4}' },
      ),
    ).not.toThrow();
  });

  it('fails on a non-200', () => {
    expect(() =>
      assertHealthy(
        { method: 'getSettings', args: [] },
        { statusCode: 401, body: '{"error":"Unauthorized"}' },
      ),
    ).toThrow(/401/);
  });

  it('fails on an error envelope even with a 200', () => {
    expect(() =>
      assertHealthy({ method: 'x', args: [] }, { statusCode: 200, body: '{"error":"boom"}' }),
    ).toThrow(/error/);
  });

  it('only smokes read methods, with no args or a read range (no side effects)', () => {
    const range = (a: unknown) =>
      typeof a === 'object' && a !== null && Object.keys(a).sort().join() === 'from,to';
    expect(SMOKE_CALLS.every((c) => c.args.every(range))).toBe(true);
  });

  it("every call passes the BFF's argument check, so the deploy smoke can't go red on a shape", async () => {
    // scripts doesn't depend on lambdas (rootDir src), so the check is loaded by path at runtime.
    const spec = new URL('../../lambdas/src/rpc/argSpecs.ts', import.meta.url).pathname;
    const { checkArgs } = (await import(/* @vite-ignore */ spec)) as {
      checkArgs: (method: string, args: unknown[]) => void;
    };
    for (const c of SMOKE_CALLS) expect(() => checkArgs(c.method, c.args), c.method).not.toThrow();
    expect(() => checkArgs('getCalibration', [])).toThrow(/range is required/);
  });
});
