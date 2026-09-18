import { describe, expect, it } from 'vitest';
import { normalizeEvents, type GcalEvent } from './normalize';

const timed = (startISO: string, endISO: string, over: Partial<GcalEvent> = {}): GcalEvent => ({
  status: 'confirmed',
  start: { dateTime: startISO },
  end: { dateTime: endISO },
  ...over,
});

describe('normalizeEvents', () => {
  it('keeps accepted timed events and outOfOffice; drops the rest per the rules', () => {
    const items: GcalEvent[] = [
      timed('2026-01-05T09:00:00-08:00', '2026-01-05T10:00:00-08:00'), // committed meeting
      { status: 'confirmed', start: { date: '2026-01-05' }, end: { date: '2026-01-06' } }, // all-day
      timed('2026-01-05T11:00:00-08:00', '2026-01-05T12:00:00-08:00', {
        attendees: [{ self: true, responseStatus: 'declined' }],
      }), // declined → dropped
      timed('2026-01-05T13:00:00-08:00', '2026-01-05T14:00:00-08:00', { transparency: 'transparent' }), // free → dropped
      timed('2026-01-05T15:00:00-08:00', '2026-01-05T16:00:00-08:00', { status: 'cancelled' }), // dropped
      timed('2026-01-05T16:00:00-08:00', '2026-01-05T17:00:00-08:00', { eventType: 'focusTime' }), // dropped
      timed('2026-01-05T18:00:00-08:00', '2026-01-05T19:00:00-08:00', { eventType: 'outOfOffice' }), // committed
    ];
    const res = normalizeEvents(items);
    expect(res.allDayCount).toBe(1);
    expect(res.intervals).toHaveLength(2);
    expect((res.intervals[0]!.endMs - res.intervals[0]!.startMs) / 60_000).toBe(60);
  });

  it('does not drop tentative/accepted/needsAction attendees (only declined)', () => {
    const res = normalizeEvents([
      timed('2026-01-05T09:00:00-08:00', '2026-01-05T09:30:00-08:00', {
        attendees: [{ self: true, responseStatus: 'tentative' }],
      }),
    ]);
    expect(res.intervals).toHaveLength(1);
  });

  it('is DST-safe — committed minutes come from the offsets, not the wall clock', () => {
    // Spring-forward day; 01:30 is PST (-08:00), 03:30 is PDT (-07:00). Wall clock reads 2h, but only
    // 1 real hour elapsed (02:00–03:00 does not exist). A naive same-offset impl would report 120.
    const res = normalizeEvents([timed('2026-03-08T01:30:00-08:00', '2026-03-08T03:30:00-07:00')]);
    expect((res.intervals[0]!.endMs - res.intervals[0]!.startMs) / 60_000).toBe(60);
  });

  it('ignores zero-length and malformed times', () => {
    const res = normalizeEvents([
      timed('2026-01-05T09:00:00-08:00', '2026-01-05T09:00:00-08:00'), // zero length
      { status: 'confirmed', start: { dateTime: 'not-a-date' }, end: { dateTime: 'nope' } },
    ]);
    expect(res.intervals).toHaveLength(0);
  });
});
