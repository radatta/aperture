import { daysBetween, fmtMonthShortDay } from '@aperture/shared';
import { recentWeeks } from '../habits/habitWeek';

// The forgiving "contact sheet": a GitHub-contributions-style grid derived from a roll's reps. It only
// ever FILLS — a gap is a lighter cell, never a reset or a zero or a broken streak. The count is
// ALL-TIME (it can't decrease as days scroll past the window — a windowed count would be a decaying
// score, which is the guilt mechanic we're avoiding).

export const CONTACT_WEEKS = 5;

export interface ContactCell {
  date: string;
  reps: number; // 0 = a lighter dot (nothing asked), ≥1 = filled
  future: boolean; // not drawn as a real cell — the grid never shows what it's "waiting for"
}

export interface ContactSheet {
  rows: ContactCell[][]; // recentWeeks, oldest first; each row is Mon…Sun
  total: number; // all-time rep count (sum over ALL rep days, not just the window)
  lastRepDay: string | null; // most recent day with a rep, or null
}

export function contactSheet(
  reps: Map<string, number>,
  today: string,
  weeks: number = CONTACT_WEEKS,
): ContactSheet {
  const rows = recentWeeks(today, weeks).map((week) =>
    week.map((date) => ({ date, reps: reps.get(date) ?? 0, future: date > today })),
  );
  let total = 0;
  let lastRepDay: string | null = null;
  for (const [day, n] of reps) {
    if (n <= 0) continue;
    total += n;
    if (lastRepDay === null || day > lastRepDay) lastRepDay = day;
  }
  return { rows, total, lastRepDay };
}

// The relative phrase for the "last …" caption: today / yesterday / Sep 15. Null → the caller shows
// the no-reps-yet copy instead.
export function fmtLastRep(lastRepDay: string, today: string): string {
  const ago = daysBetween(lastRepDay, today);
  if (ago <= 0) return 'today';
  if (ago === 1) return 'yesterday';
  return fmtMonthShortDay(lastRepDay);
}
