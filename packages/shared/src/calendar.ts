// Google Calendar shape reading. The BFF returns RAW busy intervals (normalized from each account's
// events.list, merged across accounts by the client here); the SHAPE MATH is this pure function, run
// CLIENT-SIDE. The headline is never "hours free" — it's the longest uninterrupted free stretch plus
// how fragmented the rest of the window is. See docs/areas/calendar/.

// A timed busy block on the day's timeline, epoch ms. All-day events are NOT intervals — they carry no
// clock commitment — so the BFF excludes them and reports a count instead (see CalendarBusy.allDayCount).
export interface BusyInterval {
  startMs: number;
  endMs: number;
}

// What getCalendarBusy returns: raw timed intervals (unmerged, concatenated across every connected
// account's selected calendars) plus a count of all-day events for context. The client merges + clips.
export interface CalendarBusy {
  intervals: BusyInterval[];
  allDayCount: number;
}

// Free gaps shorter than this aren't usable time — they're fragmentation, not a stretch you can work in.
// Deliberately a hardcoded constant, NOT a setting (a knob nobody would tune well).
export const FRAGMENT_GAP_MIN = 45;

// The computed shape of a day, all fields in minutes except the two counts. `longestFreeStretchMin` is
// the headline; `fragmentCount` is how many free slivers are too short to use.
export interface DayShape {
  windowMin: number; // total length of the focus window
  committedMin: number; // busy time inside the window (merged across accounts, clipped to the window)
  freeMin: number; // windowMin − committedMin
  longestFreeStretchMin: number; // the single longest uninterrupted free run — the number that matters
  fragmentCount: number; // free gaps shorter than FRAGMENT_GAP_MIN
  allDayCount: number; // passed through from CalendarBusy for display
}

const MS_PER_MIN = 60_000;

// Sort, drop empties, and merge overlapping OR touching intervals. This is where a lecture that appears
// on two connected accounts stops being double-counted, and where two back-to-back blocks collapse so
// they never produce a spurious zero-length gap.
export function mergeBusyIntervals(intervals: BusyInterval[]): BusyInterval[] {
  const sorted = intervals
    .filter((iv) => iv.endMs > iv.startMs)
    .sort((a, b) => a.startMs - b.startMs);
  const merged: BusyInterval[] = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last && iv.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, iv.endMs);
    } else {
      merged.push({ startMs: iv.startMs, endMs: iv.endMs });
    }
  }
  return merged;
}

// Pure. Given raw busy intervals and the window bounds (epoch ms, computed by the client in its own
// timezone — this function does no date math and adds no ms, so it's DST-safe by construction), return
// the day's shape. An event straddling `now` in daytime mode is clipped to the window, so only the part
// still ahead counts as committed.
export function computeDayShape(
  busy: CalendarBusy,
  windowStartMs: number,
  windowEndMs: number,
): DayShape {
  const windowMs = Math.max(0, windowEndMs - windowStartMs);
  const windowMin = Math.round(windowMs / MS_PER_MIN);
  const { allDayCount } = busy;
  if (windowMs === 0) {
    return { windowMin, committedMin: 0, freeMin: 0, longestFreeStretchMin: 0, fragmentCount: 0, allDayCount };
  }

  const clipped = busy.intervals
    .map((iv) => ({ startMs: Math.max(iv.startMs, windowStartMs), endMs: Math.min(iv.endMs, windowEndMs) }))
    .filter((iv) => iv.endMs > iv.startMs);
  const merged = mergeBusyIntervals(clipped);

  const committedMs = merged.reduce((sum, iv) => sum + (iv.endMs - iv.startMs), 0);

  // Free gaps = the complement of the merged busy blocks within the window (leading + between + trailing).
  const gaps: number[] = [];
  let cursor = windowStartMs;
  for (const iv of merged) {
    if (iv.startMs > cursor) gaps.push(iv.startMs - cursor);
    cursor = iv.endMs;
  }
  if (windowEndMs > cursor) gaps.push(windowEndMs - cursor);

  const longestFreeStretchMs = gaps.reduce((max, g) => Math.max(max, g), 0);
  const fragmentThresholdMs = FRAGMENT_GAP_MIN * MS_PER_MIN;

  return {
    windowMin,
    committedMin: Math.round(committedMs / MS_PER_MIN),
    freeMin: Math.round((windowMs - committedMs) / MS_PER_MIN),
    longestFreeStretchMin: Math.round(longestFreeStretchMs / MS_PER_MIN),
    fragmentCount: gaps.filter((g) => g > 0 && g < fragmentThresholdMs).length,
    allDayCount,
  };
}
