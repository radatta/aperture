import type { BusyInterval } from '@aperture/shared';
import type { BusyResult } from './gateway';

// Normalize a Google Calendar events.list response into busy intervals. This is the quietest bug
// source in the feature — it fails silently, producing a plausible-but-wrong number rather than an
// error — so every rule here is fixture-tested (normalize.test.ts). See docs/areas/calendar/.
//
// Rules:
//  - timed events (start.dateTime) → a committed interval; date-only events (start.date) are all-day
//    (end.date is EXCLUSIVE) → counted, never a clock commitment.
//  - dropped entirely: status:cancelled, transparency:transparent (marked Free), declined invites,
//    and eventType:focusTime (self-imposed, not an external commitment).
//  - dateTime carries an offset (RFC3339), so Date.parse is timezone-independent → DST-safe by
//    construction; nothing here adds raw ms.

export interface GcalEventTime {
  date?: string; // all-day: YYYY-MM-DD (end is exclusive)
  dateTime?: string; // timed: RFC3339 with offset
  timeZone?: string;
}
export interface GcalAttendee {
  self?: boolean;
  responseStatus?: string; // 'accepted' | 'declined' | 'tentative' | 'needsAction'
}
export interface GcalEvent {
  status?: string; // 'confirmed' | 'tentative' | 'cancelled'
  transparency?: string; // 'opaque' (busy) | 'transparent' (free)
  eventType?: string; // 'default' | 'focusTime' | 'outOfOffice' | 'workingLocation' | …
  start?: GcalEventTime;
  end?: GcalEventTime;
  attendees?: GcalAttendee[];
}
export interface GcalEventsResponse {
  items?: GcalEvent[];
}

function isDeclined(ev: GcalEvent): boolean {
  return (ev.attendees ?? []).some((a) => a.self && a.responseStatus === 'declined');
}

export function normalizeEvents(items: GcalEvent[]): BusyResult {
  const intervals: BusyInterval[] = [];
  let allDayCount = 0;
  for (const ev of items) {
    if (ev.status === 'cancelled') continue;
    if (ev.transparency === 'transparent') continue;
    if (ev.eventType === 'focusTime') continue;
    if (isDeclined(ev)) continue;

    const start = ev.start ?? {};
    const end = ev.end ?? {};

    // All-day: date-only, no clock time. Context, not committed time.
    if (start.date && !start.dateTime) {
      allDayCount++;
      continue;
    }

    if (start.dateTime && end.dateTime) {
      const startMs = Date.parse(start.dateTime);
      const endMs = Date.parse(end.dateTime);
      if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
        intervals.push({ startMs, endMs });
      }
    }
  }
  return { intervals, allDayCount };
}

export function normalizeResponse(res: GcalEventsResponse): BusyResult {
  return normalizeEvents(res.items ?? []);
}
