// Calls → the lane phase they were spent in. Lane status files hold only the current phase, so the timeline comes
// from each session's own markers: an explicit `pnpm board lane <phase>` wins; otherwise tool-use heuristics move
// the phase forward (FEATURE-WORKFLOW.md's order). Subagents take their parent's phase at their first call.
// docs/ops/USAGE-METER.md → Phases.
import { minOf } from './stats.ts';
import type { Marker } from './transcript.ts';

export const PHASES = [
  'unattributed',
  'plan',
  'build',
  'gate',
  'review',
  'local',
  'dev',
  'pr',
  'post',
] as const;
export type Phase = (typeof PHASES)[number];
const order = (p: Phase) => PHASES.indexOf(p);

const EXPLICIT: Record<string, Phase | null> = {
  plan: 'plan',
  build: 'build',
  gate: 'gate',
  review: 'review',
  local: 'local',
  dev: 'dev',
  pr: 'pr',
  merged: 'post',
  cleanup: 'post',
  parked: null, // keeps the phase it paused in
  blocked: null,
};
const HEURISTIC: Partial<Record<Marker['kind'], Phase>> = {
  plan: 'plan',
  gate: 'gate',
  review: 'review',
  local: 'local',
  dev: 'dev',
  devcheck: 'dev',
  pr: 'pr',
};

// Where a step came from: an explicit `pnpm board lane` in the transcript, the phase logger, or tool-use heuristics.
export type PhaseSrc = 'marker' | 'log' | 'heuristic';
export interface Step {
  ts: number;
  phase: Phase;
  src: PhaseSrc;
}

// A session's phase timeline. With any explicit marker, heuristics count only before the first one (a lane that
// writes its status file says exactly where it is from then on).
export function timeline(markers: Marker[]): Step[] {
  const ms = [...markers].sort((a, b) => a.ts - b.ts);
  // the first explicit marker that names a phase; a leading parked/blocked says nothing yet
  const firstExplicit =
    ms.find((m) => m.kind === 'lane-phase' && m.phase && EXPLICIT[m.phase])?.ts ?? Infinity;
  const out: Step[] = [];
  let cur = 'unattributed' as Phase;
  let reviewed = false;
  const set = (ts: number, p: Phase, src: PhaseSrc = 'heuristic') => {
    if (p === cur) return;
    cur = p;
    out.push({ ts, phase: p, src });
  };
  for (const m of ms) {
    if (m.kind === 'lane-phase') {
      // `board lane ready` from dev on was refused (lanes.ts writeLane): the lane never moved
      if (m.alias && order(cur) >= order('dev')) continue;
      const p = m.phase ? EXPLICIT[m.phase] : null;
      if (p) set(m.ts, p, m.src === 'log' ? 'log' : 'marker');
      if (p === 'review') reviewed = true;
      continue;
    }
    if (m.ts >= firstExplicit) continue;
    if (m.kind === 'edit' && (m.cls === 'src' || m.cls === 'test')) {
      // build until the first review; a fix after a red gate goes back to build
      if (!reviewed && (order(cur) < order('build') || cur === 'gate')) set(m.ts, 'build');
      continue;
    }
    const p = HEURISTIC[m.kind];
    if (!p) continue;
    // a Plan run after the PR step starts the next cycle on the same track (a second PR on the branch)
    if (p === 'plan' && order(cur) >= order('pr')) {
      reviewed = false;
      set(m.ts, 'plan');
      continue;
    }
    if (p === 'review') reviewed = true;
    if (order(p) > order(cur)) set(m.ts, p);
  }
  // calls before the first marker were the kickoff's reading: plan, when planning came first
  if (out[0]?.phase === 'plan') out[0] = { ...out[0], ts: -Infinity };
  return out;
}

export function stepAt(steps: Step[], ts: number): Step | null {
  let lo = 0;
  let hi = steps.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (steps[mid]!.ts <= ts) lo = mid + 1;
    else hi = mid;
  }
  return lo ? steps[lo - 1]! : null;
}
export const phaseAt = (steps: Step[], ts: number): Phase =>
  stepAt(steps, ts)?.phase ?? 'unattributed';

// Clusters of markers, a new cluster after `gapMin` quiet minutes: review rounds, devcheck runs. `which` is the kinds
// to count, or a predicate.
export function clusters(
  markers: Marker[],
  which: Marker['kind'][] | ((m: Marker) => boolean),
  gapMin = 10,
): number[] {
  const pick = typeof which === 'function' ? which : (m: Marker) => which.includes(m.kind);
  const ts = markers
    .filter(pick)
    .map((m) => m.ts)
    .sort((a, b) => a - b);
  // a gap is measured from the previous marker, not the cluster's start, so a long round stays one round
  const out: number[] = [];
  let prev = -Infinity;
  for (const t of ts) {
    if (t - prev > gapMin * 60_000) out.push(t);
    prev = t;
  }
  return out;
}

// How far the explicit and heuristic timelines agree, by QU, on tracks that have both — over the calls from the first
// explicit marker on, since before it the explicit timeline has nothing to say.
export function agreement(
  markers: Marker[],
  calls: { ts: number; qu: number }[],
): { agree: number; total: number } | null {
  if (!markers.some((m) => m.kind === 'lane-phase')) return null;
  const explicit = timeline(markers.filter((m) => m.kind === 'lane-phase'));
  const heuristic = timeline(markers.filter((m) => m.kind !== 'lane-phase'));
  const from = minOf(
    markers.filter((m) => m.kind === 'lane-phase' && m.phase && EXPLICIT[m.phase]).map((m) => m.ts),
  );
  let agree = 0;
  let total = 0;
  for (const c of calls) {
    if (c.ts < from) continue;
    total += c.qu;
    if (phaseAt(explicit, c.ts) === phaseAt(heuristic, c.ts)) agree += c.qu;
  }
  return { agree, total };
}
