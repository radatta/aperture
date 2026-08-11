// Geometry for the estimate-vs-actual bar. The whole point of Aperture's signature surface is to
// make the GAP visible without reading two numbers and subtracting them in your head, so the model
// is expressed as percentages of one shared track.
//
// The track always spans max(estimate, actual), so the longer of the two fills it completely and
// the shorter one is read against it. The estimate mark is where the bar "should" have stopped.
export interface DeltaBarModel {
  estimatePct: number; // where the estimate mark sits, 0–100
  actualPct: number; // how far the actual ran, 0–100
  overhangPct: number; // the part of the actual past the estimate — the honest signal
  over: boolean;
  under: boolean;
}

export function deltaBar(estimateMin: number, actualMin: number): DeltaBarModel {
  const est = Math.max(0, estimateMin);
  const act = Math.max(0, actualMin);
  const span = Math.max(est, act);
  if (span === 0) {
    return { estimatePct: 0, actualPct: 0, overhangPct: 0, over: false, under: false };
  }
  const estimatePct = (est / span) * 100;
  const actualPct = (act / span) * 100;
  return {
    estimatePct,
    actualPct,
    overhangPct: Math.max(0, actualPct - estimatePct),
    over: act > est,
    under: act < est,
  };
}
