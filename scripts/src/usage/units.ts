// The work units under a PR's QU (the 11-19 work-units analysis, docs/ops/USAGE-METER.md → Work units): where a call's
// QU goes (re-read, ingest, output), what a main-session turn costs by the context it carries, how a lane session's
// context grows with its turns, and what each kind of agent run costs. Pure: the model passes the tables in.
import { normalizeModel, type Parts } from './prices.ts';
import type { Attributed, PRRow } from './prs.ts';
import { median, quantile } from './stats.ts';

export interface Split extends Parts {
  qu: number;
}
const zero = (): Split => ({ qu: 0, reread: 0, ingest: 0, output: 0 });
const add = (s: Split, c: Attributed) => {
  s.qu += c.qu;
  s.reread += c.parts.reread;
  s.ingest += c.parts.ingest;
  s.output += c.parts.output;
};

// Re-read, ingest and output QU, main sessions apart from subagents and workflow agents.
export function splitTotals(calls: Attributed[]): { main: Split; agents: Split } {
  const out = { main: zero(), agents: zero() };
  for (const c of calls) add(c.kind === 'main' ? out.main : out.agents, c);
  return out;
}

export interface Band {
  lo: number; // tokens, inclusive
  hi: number; // exclusive; Infinity for the last
  turns: number;
  share: number; // of all turns given
  quPerTurn: number;
  rereadPerTurn: number;
}
export const BAND_EDGES = [0, 100_000, 200_000, 300_000, 400_000, 500_000, Infinity];

// Main-session turns by the context each one read: a turn's cost rises with what it re-reads.
export function ctxBands(main: Attributed[], edges = BAND_EDGES): Band[] {
  const total = main.length;
  return edges.slice(0, -1).flatMap((lo, i) => {
    const hi = edges[i + 1]!;
    const cs = main.filter((c) => c.ctx >= lo && c.ctx < hi);
    if (!cs.length) return [];
    const sum = (f: (c: Attributed) => number) => cs.reduce((x, c) => x + f(c), 0);
    return [
      {
        lo,
        hi,
        turns: cs.length,
        share: cs.length / total,
        quPerTurn: sum((c) => c.qu) / cs.length,
        rereadPerTurn: sum((c) => c.parts.reread) / cs.length,
      },
    ];
  });
}

export const GROWTH_AT = [1, 10, 50, 100, 200];

// Median context at a lane session's nth turn, over the tracks that reached it; turn 1 is the fixed load a session
// starts with. Tracks are a lane's main-session calls, one list per track.
export function growth(
  tracks: Attributed[][],
  at = GROWTH_AT,
): { turn: number; ctx: number; n: number }[] {
  const sorted = tracks.map((t) => [...t].sort((a, b) => a.ts - b.ts));
  return at.flatMap((turn) => {
    const xs = sorted.filter((t) => t.length >= turn).map((t) => t[turn - 1]!.ctx);
    return xs.length ? [{ turn, ctx: median(xs), n: xs.length }] : [];
  });
}

export interface AgentPrice {
  agentType: string;
  model: string; // normalised
  runs: number;
  median: number;
  p25: number;
  p75: number;
}

// Each agent type × model: runs and QU per run.
export function agentPrices(rows: PRRow[]): AgentPrice[] {
  const by = new Map<string, { agentType: string; model: string; qu: number[] }>();
  for (const r of rows)
    for (const run of r.runs) {
      const model = normalizeModel(run.model);
      const k = `${run.agentType}|${model}`;
      const v = by.get(k) ?? { agentType: run.agentType, model, qu: [] };
      v.qu.push(run.qu);
      by.set(k, v);
    }
  return [...by.values()]
    .map((v) => ({
      agentType: v.agentType,
      model: v.model,
      runs: v.qu.length,
      median: median(v.qu),
      p25: quantile(v.qu, 0.25),
      p75: quantile(v.qu, 0.75),
    }))
    .sort((a, b) => b.runs - a.runs || a.agentType.localeCompare(b.agentType));
}

// Per agent type, over the PRs that ran it: the median of its runs' QU summed per PR (what one PR spends on it), the
// median per run, and how many runs and PRs that rests on.
export function typePrices(
  rows: PRRow[],
): Map<string, { perPR: number; perRun: number; runs: number; prs: number }> {
  const perPR = new Map<string, number[]>();
  const perRun = new Map<string, number[]>();
  for (const r of rows) {
    const sum = new Map<string, number>();
    for (const run of r.runs) {
      sum.set(run.agentType, (sum.get(run.agentType) ?? 0) + run.qu);
      perRun.set(run.agentType, [...(perRun.get(run.agentType) ?? []), run.qu]);
    }
    for (const [t, q] of sum) perPR.set(t, [...(perPR.get(t) ?? []), q]);
  }
  return new Map(
    [...perPR].map(([t, xs]) => {
      const runs = perRun.get(t)!;
      return [t, { perPR: median(xs), perRun: median(runs), runs: runs.length, prs: xs.length }];
    }),
  );
}
