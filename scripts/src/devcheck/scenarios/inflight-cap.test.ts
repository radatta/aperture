import { describe, expect, it } from 'vitest';
import { createBurstMeter } from './inflight-cap';

// n fresh requests started on the meter, by identity like Playwright's Request objects.
const start = (m: ReturnType<typeof createBurstMeter>, n: number) =>
  Array.from({ length: n }, () => {
    const r = {};
    m.started(r);
    return r;
  });

describe('createBurstMeter', () => {
  it('passes a burst held at the cap whose queue goes out after the release', () => {
    const m = createBurstMeter(8);
    const held = start(m, 8);
    m.release();
    for (const r of held.slice(0, 3)) m.ended(r);
    start(m, 3); // the queued calls, one per freed slot
    expect(m.counts()).toEqual({ total: 11, peak: 8, afterRelease: 3 });
    expect(m.verdict()).toBeNull();
  });

  it('fails a 9th call on the wire', () => {
    const m = createBurstMeter(8);
    const held = start(m, 9);
    m.release();
    for (const r of held) m.ended(r);
    start(m, 1);
    expect(m.verdict()).toBe('9 /api calls on the wire at once — the cap is 8');
  });

  it('fails a burst that never fills the cap', () => {
    const m = createBurstMeter(8);
    for (const r of start(m, 7)) m.ended(r);
    m.release();
    start(m, 3); // Home's second wave: 10 calls, but never 8 at once
    expect(m.counts()).toEqual({ total: 10, peak: 7, afterRelease: 3 });
    expect(m.verdict()).toMatch(/^the UI wanted only 7 \/api calls at once, under the cap of 8/);
  });

  it('fails when nothing was queued behind the cap', () => {
    const m = createBurstMeter(8);
    start(m, 8);
    m.release();
    expect(m.verdict()).toBe('nothing queued behind the cap: 8 calls, none sent after the release');
  });

  it('fails a hold that was never released', () => {
    const m = createBurstMeter(8);
    start(m, 8);
    expect(m.verdict()).toBe('the held calls were never released');
  });

  it('ignores an end it never saw start, and a second end of the same request', () => {
    const m = createBurstMeter(8);
    const r = {};
    m.started(r);
    expect(m.ended({})).toBe(false);
    expect(m.ended(r)).toBe(true);
    expect(m.ended(r)).toBe(false);
    expect(m.live()).toBe(0);
  });
});
