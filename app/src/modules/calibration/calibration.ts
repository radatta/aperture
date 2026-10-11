import type { CalibrationPoint } from '@aperture/shared';

// Aggregate estimate-vs-actual over a set of done tasks. `ratio` > 1 means you run over estimate
// (the honest bias this app exists to surface). Null ratio = nothing to compare yet — kept honest
// rather than faked to 0. A done parent's rollup is left out: its parts are points already, and counting
// both would weigh that work twice (it still shows in Recent and the night review).
export interface CalibrationAggregate {
  count: number;
  totalEstimateMin: number;
  totalActualMin: number;
  ratio: number | null;
  overPct: number | null;
}

export function aggregate(all: CalibrationPoint[]): CalibrationAggregate {
  const points = all.filter((p) => !p.parts); // an older Lambda's point (no field) is no rollup
  const totalEstimateMin = points.reduce((s, p) => s + p.estimateLockedMin, 0);
  const totalActualMin = points.reduce((s, p) => s + p.actualAccruedMin, 0);
  const ratio = totalEstimateMin > 0 ? totalActualMin / totalEstimateMin : null;
  return {
    count: points.length,
    totalEstimateMin,
    totalActualMin,
    ratio,
    overPct: ratio === null ? null : Math.round((ratio - 1) * 100),
  };
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
