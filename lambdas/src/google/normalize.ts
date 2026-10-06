import type { BusyInterval, PulledEvent } from '@aperture/shared';
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
  id?: string;
  summary?: string;
  updated?: string; // RFC3339 — last change to the main event data
  recurrence?: string[];
  recurringEventId?: string;
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

    // All-day: date-only, no clock time. Context, not committed time. (A timed outOfOffice falls
    // through to a committed interval below; an all-day OOO is counted here like any all-day block.)
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

// One events.list delta item → the shape the two-way planner reads (calendarPull.ts). A cancelled item
// may be a bare stub (only `id` is guaranteed — deleted, or moved to another calendar), so every other
// field is optional here; a missing `updated` reads as `nowMs`.
export function toPulledEvent(ev: GcalEvent, nowMs: number): PulledEvent | null {
  if (!ev.id) return null;
  const start = ev.start ?? {};
  const end = ev.end ?? {};
  const allDay = !!start.date && !start.dateTime;
  const startMs = !allDay && start.dateTime ? Date.parse(start.dateTime) : NaN;
  const endMs = !allDay && end.dateTime ? Date.parse(end.dateTime) : NaN;
  const timed = Number.isFinite(startMs) && Number.isFinite(endMs);
  const updatedMs = ev.updated ? Date.parse(ev.updated) : NaN;
  return {
    eventId: ev.id,
    cancelled: ev.status === 'cancelled',
    recurring: !!ev.recurrence?.length || !!ev.recurringEventId,
    title: ev.summary ?? null,
    allDay,
    startMs: timed ? startMs : null,
    endMs: timed ? endMs : null,
    updatedMs: Number.isFinite(updatedMs) ? updatedMs : nowMs,
  };
}
