import { dayKey, fmtMonthShortDay } from '@aperture/shared';

// UI formatters. Durations ("45m" / "1h 18m") live in shared — the calendar pull's note uses them too;
// the timer clock reads "25:00".
export { fmtDuration } from '@aperture/shared';

export function fmtClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${mm}:${String(ss).padStart(2, '0')}`;
}

// Time-of-day for a log timestamp, e.g. "9:42 AM" (local).
export function fmtTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// A log timestamp as calendar day + time, e.g. "Sep 20 · 9:42 AM" (local). Calendar day (dayStartHour
// 0), not the logical day — a 1 AM finish should read as today, not yesterday.
export function fmtDateTime(epochMs: number): string {
  return `${fmtMonthShortDay(dayKey(epochMs, 0))} · ${fmtTime(epochMs)}`;
}

// File sizes read as "12 B" / "834 KB" / "2.4 MB" — one decimal below 10, whole numbers above.
export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}
