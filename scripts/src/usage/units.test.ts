import { describe, expect, it } from 'vitest';
import { prRow } from './fixtures.ts';
import { priceCall, priceParts } from './prices.ts';
import type { Attributed } from './prs.ts';
import { agentPrices, ctxBands, growth, splitTotals, typePrices } from './units.ts';

// Synthetic attributed calls; every number invented.
const T0 = Date.parse('2026-01-05T10:00:00Z');
let n = 0;
function at(o: {
  ctx: number;
  qu?: number;
  reread?: number;
  kind?: Attributed['kind'];
  ts?: number;
}): Attributed {
  const qu = o.qu ?? 0.1;
  const reread = o.reread ?? qu / 2;
  return {
    ts: o.ts ?? T0 + n++ * 1000,
    qu,
    lane: 'lane-a',
    role: 'lane',
    phase: 'build',
    phaseSrc: 'heuristic',
    kind: o.kind ?? 'main',
    file: 'f',
    session: 's',
    track: 't',
    model: 'claude-opus-5-5',
    ctx: o.ctx,
    parts: { reread, ingest: qu - reread - 0.01, output: 0.01 },
  };
}

describe('price parts', () => {
  it('splits a call into re-read, ingest and output that sum to its QU, fast and Haiku long tier included', () => {
    const t = { i: 2e5, cw5: 3e4, cw1: 1e4, cr: 9e5, o: 4e3 };
    for (const [model, fast] of [
      ['claude-opus-5-5', false],
      ['claude-opus-5-5', true],
      ['claude-haiku-5-5', false],
      ['claude-nova-1', false],
    ] as const) {
      const p = priceParts(model, t, { fast });
      expect(p.parts.reread + p.parts.ingest + p.parts.output).toBeCloseTo(p.qu, 12);
      expect(p.qu).toBeCloseTo(priceCall(model, t, { fast }).qu, 12);
    }
    // Opus 5.5: 900k cache reads at $0.20 per MTok
    expect(priceParts('claude-opus-5-5', t).parts.reread).toBeCloseTo(0.18);
  });
});

describe('work units', () => {
  it('sums the split for main sessions apart from agents', () => {
    const s = splitTotals([
      at({ ctx: 1, qu: 1, reread: 0.6 }),
      at({ ctx: 1, qu: 2, reread: 1, kind: 'subagent' }),
    ]);
    expect(s.main).toMatchObject({ qu: 1, reread: 0.6, output: 0.01 });
    expect(s.agents.qu).toBe(2);
    expect(s.agents.reread).toBe(1);
  });

  it('bands turns by context, edges inclusive below, and drops empty bands', () => {
    const calls = [
      at({ ctx: 99_999, qu: 0.1 }),
      at({ ctx: 100_000, qu: 0.2 }),
      at({ ctx: 150_000, qu: 0.4 }),
      at({ ctx: 650_000, qu: 1 }),
    ];
    const b = ctxBands(calls);
    expect(b.map((x) => [x.lo, x.turns])).toEqual([
      [0, 1],
      [100_000, 2],
      [500_000, 1],
    ]);
    expect(b[1]!.quPerTurn).toBeCloseTo(0.3);
    expect(b[1]!.share).toBe(0.5);
    expect(b[2]!.hi).toBe(Infinity);
    expect(ctxBands([])).toEqual([]);
  });

  it("reads each track's context at turns 1, 10, 50 … over the tracks that got that far", () => {
    const track = (len: number, start: number) =>
      Array.from({ length: len }, (_, i) => at({ ctx: start + i * 1000, ts: T0 + i })).reverse(); // handed over newest first
    const g = growth([track(60, 60_000), track(12, 70_000)]);
    expect(g).toEqual([
      { turn: 1, ctx: 65_000, n: 2 },
      { turn: 10, ctx: 74_000, n: 2 },
      { turn: 50, ctx: 109_000, n: 1 },
    ]);
  });

  it('prices each agent type by model per run, and per PR over the PRs that ran it', () => {
    const rows = [
      prRow({
        runs: [
          { agentType: 'review-fixes', model: 'claude-opus-5-5', qu: 1 },
          { agentType: 'review-fixes', model: 'claude-opus-5-5', qu: 2 },
          { agentType: 'review-tests', model: 'claude-sonnet-5-5-20260101', qu: 0.4 },
        ],
      }),
      prRow({ runs: [{ agentType: 'review-fixes', model: 'claude-opus-5-5', qu: 3 }] }),
    ];
    expect(agentPrices(rows)[0]).toEqual({
      agentType: 'review-fixes',
      model: 'opus-5-5',
      runs: 3,
      median: 2,
      p25: 1.5,
      p75: 2.5,
    });
    expect(agentPrices(rows)[1]).toMatchObject({ agentType: 'review-tests', model: 'sonnet-5-5' });
    expect(typePrices(rows).get('review-fixes')).toEqual({ perPR: 3, perRun: 2, runs: 3, prs: 2 });
  });
});
