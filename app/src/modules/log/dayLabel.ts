import { addDays, fmtMonthDayYear } from '@aperture/shared';

// Relative day heading for the log: "Today" / "Yesterday" / "6/7/2026".
export function dayLabel(day: string, today: string): string {
  if (day === today) return 'Today';
  if (day === addDays(today, -1)) return 'Yesterday';
  return fmtMonthDayYear(day);
}
