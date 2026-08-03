// The estimate-vs-actual delta. Positive pct = took longer than estimated (the honest signal
// this app exists to surface). Null when there's no estimate to compare against.
export interface StatDelta {
  deltaMin: number;
  pct: number;
  over: boolean;
}

export function statDelta(estimateMin: number, actualMin: number): StatDelta | null {
  if (estimateMin <= 0) return null;
  const deltaMin = actualMin - estimateMin;
  return { deltaMin, pct: Math.round((deltaMin / estimateMin) * 100), over: deltaMin > 0 };
}
