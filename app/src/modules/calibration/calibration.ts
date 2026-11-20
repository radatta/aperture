import { laneOf, scoresGap } from '@aperture/shared';
import type { CalibrationLane, CalibrationPoint } from '@aperture/shared';
import { fmtDuration } from '../../lib/format';

// Aggregate estimate-vs-actual over a set of done tasks. `ratio` > 1 means you run over estimate
// (the honest bias this app exists to surface). Null ratio = nothing to compare yet — kept honest
// rather than faked to 0. Only points that score the gap count (scoresGap): a done parent's rollup is left
// out — its parts are points already, and counting both would weigh that work twice (it still shows in
// Recent and the night review) — and so is a backfilled ticket, counted apart as `backfilled`.
export interface CalibrationAggregate {
  count: number;
  totalEstimateMin: number;
  totalActualMin: number;
  ratio: number | null;
  overPct: number | null;
  retroCount: number; // of `count`: estimated after the fact (footnoted, never a score)
  backfilledCount: number; // apart from `count`: closed after the fact, never in the gap
  backfilledActualMin: number;
}

export function aggregate(all: CalibrationPoint[]): CalibrationAggregate {
  const points = all.filter(scoresGap);
  const backfilled = all.filter((p) => !p.parts && p.backfilled);
  const totalEstimateMin = points.reduce((s, p) => s + p.estimateLockedMin, 0);
  const totalActualMin = points.reduce((s, p) => s + p.actualAccruedMin, 0);
  const ratio = totalEstimateMin > 0 ? totalActualMin / totalEstimateMin : null;
  return {
    count: points.length,
    totalEstimateMin,
    totalActualMin,
    ratio,
    overPct: ratio === null ? null : Math.round((ratio - 1) * 100),
    retroCount: points.filter((p) => p.estimateSource === 'retro').length,
    backfilledCount: backfilled.length,
    backfilledActualMin: backfilled.reduce((s, p) => s + p.actualAccruedMin, 0),
  };
}

// The lanes (docs/areas/calibration/dev-lane.md): Aperture's dev work apart from the rest of life. Null when
// there is no Aperture point at all — the page reads as one headline, as it always has.
export function laneAggregates(
  all: CalibrationPoint[],
): Record<CalibrationLane, CalibrationAggregate> | null {
  const dev = all.filter((p) => laneOf(p) === 'aperture');
  if (dev.length === 0) return null;
  return { life: aggregate(all.filter((p) => laneOf(p) === 'life')), aperture: aggregate(dev) };
}

// The latest `n` points, newest first. A day's points come in no set order, so within a day the later
// completion goes first (a parent's rollup above the parts that finished it). Unknown → oldest. A backfilled
// point is left out: a batch of old tickets would bury the real ones.
export function recentPoints(
  points: CalibrationPoint[],
  completedAt: (taskId: string) => number | null | undefined,
  n = 8,
): CalibrationPoint[] {
  const at = (p: CalibrationPoint) => completedAt(p.taskId) ?? 0;
  return points
    .filter((p) => !p.backfilled)
    .sort((a, b) => a.day.localeCompare(b.day) || at(a) - at(b))
    .slice(-n)
    .reverse();
}

// The row's drift label (docs/areas/calibration/integrity.md → Drift): the working estimate moved after the
// lock froze. Null when it didn't — a retro point's lock is its estimate, so it never reads as revised — and
// on a rollup, whose estimate is derived (an older Lambda's point has no estimateMin at all).
export function driftLabel(p: CalibrationPoint): string | null {
  if (p.parts || p.estimateMin == null || p.estimateMin === p.estimateLockedMin) return null;
  return `est ${fmtDuration(p.estimateLockedMin)} → ${fmtDuration(p.estimateMin)} · actual ${fmtDuration(p.actualAccruedMin)}`;
}

// A done parent's bar label: the rollup says how many parts it covers.
export const rollupLabel = (title: string, parts: number): string =>
  parts > 0 ? `${title} · ${parts} ${parts === 1 ? 'part' : 'parts'}` : title;

// Planned load vs the day's manual capacity. availableMin is null when capacity isn't set yet.
export interface PlannedVsAvailable {
  plannedMin: number;
  availableMin: number | null;
  over: boolean;
  overByMin: number;
}

export function plannedVsAvailable(
  plannedMin: number,
  capacityHours: number | null,
): PlannedVsAvailable {
  const availableMin = capacityHours === null ? null : Math.round(capacityHours * 60);
  const over = availableMin !== null && plannedMin > availableMin;
  return { plannedMin, availableMin, over, overByMin: over ? plannedMin - availableMin! : 0 };
}
