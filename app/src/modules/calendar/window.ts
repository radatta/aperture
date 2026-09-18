// The focus window for the shape read, as epoch ms. Built from a local day-key + hour via local Date
// construction, so the platform handles DST and we never add raw ms — the BFF receives bounds and does
// no date math (it runs in UTC). See docs/areas/calendar/.
export function focusWindowMs(
  dayKey: string,
  focusStartHour: number,
  endHour: number,
): { startMs: number; endMs: number } {
  const [y, m, d] = dayKey.split('-').map(Number) as [number, number, number];
  const startMs = new Date(y, m - 1, d, focusStartHour, 0, 0, 0).getTime();
  const endMs = new Date(y, m - 1, d, endHour, 0, 0, 0).getTime();
  return { startMs, endMs };
}
