import { describe, expect, it } from 'vitest';
import { burnLines, rates } from './burn.ts';
import type { FitModel } from './model.ts';

const H = 3_600_000;
const NOW = Date.parse('2026-11-18T20:00:00Z');
const f = (t: number) => new Date(t).toISOString().slice(11, 16); // UTC, TZ-free
const fd = (t: number) => `d ${f(t)}`;
const model = (
  burn: Partial<FitModel['burn']>,
  k80: { lo: number; hi: number } | null = { lo: 0.04, hi: 0.05 },
  lambda = 0,
) =>
  ({
    all: {
      fit: { k: 0.045, lambda, lambdaFixed: false, n: 9, sse: 0 },
      unc: k80 ? { method: 'bootstrap', k80, sdLnK: 0, zeroShare: 0 } : null,
      kOnly: null,
    },
    burn: {
      pct: 50,
      pctPerHour: 4,
      quPerHour: 100,
      hoursTo100: null,
      since: NOW - H,
      resetAt: null,
      at: NOW,
      nextReset: NOW + 5 * H,
      ...burn,
    },
  }) as unknown as FitModel;

describe('rates', () => {
  it("k's 80% interval × QU/h (+ λ), widened to hold the tick rate", () => {
    expect(rates(model({})).range).toEqual({ point: 4, lo: 4, hi: 5 }); // 4.0–5.0 from k; the tick 4 is the low end
    expect(rates(model({ pctPerHour: 6 })).range).toEqual({ point: 6, lo: 4, hi: 6 });
    expect(rates(model({}, { lo: 0.01, hi: 0.02 }, 0.5)).range).toEqual({
      point: 4,
      lo: 1.5,
      hi: 4,
    });
    expect(rates(model({}, null)).range).toBeNull();
    // a point from the fit (no ticks: since null) carries no λ, so neither does its range
    expect(rates(model({ since: null }, { lo: 0.01, hi: 0.02 }, 0.5)).range).toEqual({
      point: 4,
      lo: 1,
      hi: 4,
    });
    expect(rates(model({ quPerHour: null })).range).toBeNull();
  });
});

describe('burnLines', () => {
  it('projects to the reset and a named time, low–high', () => {
    expect(burnLines(model({}), NOW + 2 * H, NOW, f, fd)).toEqual([
      'BURN 50% (20:00) · 4.0%/h (ticks since 19:00) · resets d 01:00 (in 5.0 h)',
      '  at reset   70% (70–75%)',
      '  at 22:00   58% (58–60%)',
      "  range: k's 80% interval × the last hour's QU (+ λ), widened to hold the tick rate; assumes the last hour's pace holds",
    ]);
  });
  it('a named time past the reset projects nothing through it', () => {
    const out = burnLines(model({}), NOW + 6 * H, NOW, f, fd);
    expect(out[2]).toBe('  at 02:00   after the reset (d 01:00): the meter starts again near 0');
  });
  it("100% comes from the status line's clock (hoursTo100): a reading an hour old has moved on by a point", () => {
    // 90% read at 19:00 at 4 %/h: 2.5 h of points from now, less the one point (15 min) it has moved since → 22:15,
    // what `usage line` says too; the plain reading-plus-2.5 h would have said 21:30
    const old = burnLines(model({ pct: 90, pctPerHour: 4, at: NOW - H }), null, NOW, f, fd);
    expect(old[1]).toMatch(/^ {2}at reset {3}100% from ~22:15 /);
    // and the % before then reads off the same clock: at 21:15, an hour short of 100% at 4 %/h
    expect(
      burnLines(model({ pct: 90, pctPerHour: 4, at: NOW - H }), NOW + 75 * 60e3, NOW, f, fd)[2],
    ).toMatch(/^ {2}at 21:15 {3}96% /);
  });
  it('reaching 100%: when, fastest to slowest; the fast end alone says possible', () => {
    const fast = burnLines(model({ pct: 90, pctPerHour: 4 }), null, NOW, f, fd);
    // 10 points at 4–5 %/h: 22:00 at 5, 22:30 at 4
    expect(fast[1]).toBe('  at reset   100% from ~22:30 (22:00–22:30)');
    const edge = burnLines(model({ pct: 76, pctPerHour: 4 }), null, NOW, f, fd); // 96% at 4/h, 100% at 5/h from 24:48
    expect(edge[1]).toBe('  at reset   96% (96–100%, 100% possible from 00:48)');
    const slow = burnLines(
      model({ pct: 90, pctPerHour: 4 }, { lo: 0.01, hi: 0.05 }),
      null,
      NOW,
      f,
      fd,
    ); // lo 1 %/h: 95%
    expect(slow[1]).toBe('  at reset   100% from ~22:30 (22:00–not by then, 95%)');
  });
  it('no interval: the point only, and says why', () => {
    const out = burnLines(model({}, null), null, NOW, f, fd);
    expect(out[1]).toBe('  at reset   70%');
    expect(out[2]).toMatch(/^ {2}no range: too few intervals/);
  });
  it('stale, unknown and rate-less readings say so', () => {
    expect(burnLines(model({ resetAt: NOW - H }), null, NOW, f, fd)).toEqual([
      'BURN reset d 19:00 · no reading since',
    ]);
    expect(burnLines(model({ pct: null }), null, NOW, f, fd)).toEqual([
      'BURN unknown (no meter reading: pnpm usage doctor)',
    ]);
    expect(burnLines(model({ pctPerHour: null }), null, NOW, f, fd)).toEqual([
      'BURN 50% (20:00) · rate unknown · resets d 01:00 (in 5.0 h)',
    ]);
    expect(burnLines(model({ nextReset: null, since: null }), null, NOW, f, fd)[0]).toBe(
      'BURN 50% (20:00) · 4.0%/h (k × the last hour) · reset unknown',
    );
  });
});
