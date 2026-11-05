import { dayKey, fmtClock12, fmtMonthShortDay, hhmmOfEpoch, PUSH_STALE_MS } from '@aperture/shared';
import type { PushDevice, PushPollerHealth } from '@aperture/shared';

// The words Settings › Notifications shows for reminder health (D6) — the poller's heartbeat, its last
// send or error, and each device's. Pure, so the time math stays out of the component.

export interface HealthLine {
  tone: 'muted' | 'danger';
  text: string;
}

// "9:02am" today, "Nov 3 9:02am" before (a calendar day, not the logical one).
export const fmtWhen = (at: number, now: number): string =>
  dayKey(at, 0) === dayKey(now, 0)
    ? fmtClock12(hhmmOfEpoch(at))
    : `${fmtMonthShortDay(dayKey(at, 0))} ${fmtClock12(hhmmOfEpoch(at))}`;

// An error newer than the last success still stands; an older one has been superseded.
const standing = (err: string | null, errAt: number | null, okAt: number | null) =>
  err !== null && (okAt === null || (errAt ?? 0) >= okAt);

// The poller: never ran (neutral), a heartbeat past PUSH_STALE_MS (red — nothing is going out), or fresh.
export function pollerLines(p: PushPollerHealth, now: number): HealthLine[] {
  if (p.lastRunAt === null)
    return [{ tone: 'muted', text: 'Reminder checks haven’t run yet — nothing has been sent.' }];
  const lines: HealthLine[] = [];
  const ago = Math.floor((now - p.lastRunAt) / 60_000);
  const sent = p.lastSentAt !== null ? ` · last sent ${fmtWhen(p.lastSentAt, now)}` : '';
  if (now - p.lastRunAt > PUSH_STALE_MS)
    lines.push({
      tone: 'danger',
      text: `Reminders paused since ${fmtWhen(p.lastRunAt, now)}${sent}`,
    });
  else
    lines.push({
      tone: 'muted',
      text: `Reminders on · checked ${ago < 1 ? 'just now' : `${ago} min ago`}${sent}`,
    });
  if (standing(p.lastError, p.lastErrorAt, p.lastSentAt))
    lines.push({
      tone: 'danger',
      text: `Last problem: ${p.lastError}${p.lastErrorAt !== null ? ` (${fmtWhen(p.lastErrorAt, now)})` : ''}`,
    });
  return lines;
}

// One device: when it was added and last sent to, and its error while it stands. "Sent" is the push
// service accepting the message — whether the phone showed it, only the phone knows.
export function deviceLines(d: PushDevice, now: number): HealthLine[] {
  const lines: HealthLine[] = [
    {
      tone: 'muted',
      text: `Added ${fmtWhen(d.createdAt, now)} · ${d.lastOkAt !== null ? `last sent ${fmtWhen(d.lastOkAt, now)}` : 'nothing sent yet'}`,
    },
  ];
  if (standing(d.lastError, d.lastErrorAt, d.lastOkAt))
    lines.push({
      tone: 'danger',
      text: `Last error: ${d.lastError}${d.lastErrorAt !== null ? ` (${fmtWhen(d.lastErrorAt, now)})` : ''}`,
    });
  return lines;
}
