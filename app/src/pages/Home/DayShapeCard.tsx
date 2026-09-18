import { Link } from 'react-router';
import { computeDayShape, todayKey } from '@aperture/shared';
import { Text } from '../../components/Text';
import { fmtDuration } from '../../lib/format';
import { useSettings } from '../../data/hooks/useSettings';
import { useCalendarBusy, useGoogleStatus } from '../../data/hooks/useCalendar';
import { focusWindowMs } from '../../modules/calendar/window';
import { HomeCard } from './HomeCard';

// The calendar-derived "shape" of the day — the longest uninterrupted free stretch plus how fragmented
// the rest is, replacing the manual capacity guess. Morning shows the whole focus window; daytime clips
// to what's still ahead of now. Falls back to a connect prompt when no calendars feed it.
export function DayShapeCard({ mode }: { mode: 'morning' | 'day' }) {
  const { data: settings } = useSettings();
  const { data: status } = useGoogleStatus();
  const today = todayKey(settings?.dayStartHour ?? 4);
  const { startMs, endMs } = focusWindowMs(
    today,
    settings?.dayFocusStart ?? 8,
    settings?.dayEndHour ?? 22,
  );
  const hasAccounts = (settings?.googleAccounts.length ?? 0) > 0;
  const hasRefs = (settings?.calendarShapeRefs.length ?? 0) > 0;
  const { data: busy, isLoading } = useCalendarBusy(
    { day: today, windowStartMs: startMs, windowEndMs: endMs },
    hasAccounts && hasRefs,
  );

  if (!settings) return null;

  if (!hasAccounts) {
    return (
      <HomeCard title="Day shape">
        <div className="flex flex-col gap-1">
          <Text size="sm" tone="muted">
            Connect a calendar to see how your day is actually broken up.
          </Text>
          <Link to="/settings" className="text-teal">
            <Text size="xs" tone="teal">
              Connect Google Calendar →
            </Text>
          </Link>
        </div>
      </HomeCard>
    );
  }

  if (!hasRefs) {
    return (
      <HomeCard title="Day shape">
        <div className="flex flex-col gap-1">
          <Text size="sm" tone="muted">
            Pick which calendars feed your day shape.
          </Text>
          <Link to="/settings" className="text-teal">
            <Text size="xs" tone="teal">
              Choose calendars →
            </Text>
          </Link>
        </div>
      </HomeCard>
    );
  }

  const needsReconnect = status?.accounts.filter((a) => a.reconnectRequired) ?? [];
  // Daytime mode measures only the time still ahead; morning measures the whole window.
  const shapeStart = mode === 'day' ? Math.max(startMs, Date.now()) : startMs;
  const shape = computeDayShape(busy ?? { intervals: [], allDayCount: 0 }, shapeStart, endMs);

  return (
    <HomeCard title="Day shape">
      <div className="flex flex-col gap-2">
        {isLoading ? (
          <Text size="sm" tone="muted">
            Reading your calendars…
          </Text>
        ) : (
          <>
            <div className="flex items-baseline gap-2">
              <Text size="2xl" weight="semibold">
                {fmtDuration(shape.longestFreeStretchMin)}
              </Text>
              <Text size="sm" tone="muted">
                longest free stretch
              </Text>
            </div>
            <Text size="sm" tone="muted">
              {fmtDuration(shape.committedMin)} committed · {fmtDuration(shape.freeMin)} free
              {shape.fragmentCount > 0 &&
                ` · ${shape.fragmentCount} short ${shape.fragmentCount === 1 ? 'gap' : 'gaps'}`}
              {shape.allDayCount > 0 &&
                ` · ${shape.allDayCount} all-day ${shape.allDayCount === 1 ? 'event' : 'events'}`}
            </Text>
          </>
        )}
        {needsReconnect.length > 0 && (
          <Link to="/settings" className="text-gold">
            <Text size="xs" tone="gold">
              {needsReconnect.map((a) => a.email).join(', ')} needs reconnecting →
            </Text>
          </Link>
        )}
      </div>
    </HomeCard>
  );
}
