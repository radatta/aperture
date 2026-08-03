// Planned-vs-available model. fillPct clamps to the track; `over` means planned exceeds the day
// (e.g. 11h into a 6h day → ratio 1.83, over). The morning plan pass uses this to catch
// under-scoping before it becomes stress.
export interface MiniBarModel {
  fillPct: number; // 0–100
  over: boolean;
  ratio: number;
}

export function miniBar(plannedMin: number, availableMin: number): MiniBarModel {
  if (availableMin <= 0) {
    const over = plannedMin > 0;
    return { fillPct: over ? 100 : 0, over, ratio: over ? Infinity : 0 };
  }
  const ratio = plannedMin / availableMin;
  return { fillPct: Math.min(100, ratio * 100), over: ratio > 1, ratio };
}
