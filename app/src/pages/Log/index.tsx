import { useState } from 'react';
import { addDays, todayKey } from '@aperture/shared';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { Text } from '../../components/Text';
import { ChevronLeftIcon, ChevronRightIcon } from '../../components/icons';
import { useLog, useSetLogEntryPrivate, useUpdateLogEntry } from '../../data/hooks/useLog';
import { useSettings } from '../../data/hooks/useSettings';
import { LogEntryRow } from '../../modules/log/LogEntryRow';
import { dayLabel } from '../../modules/log/dayLabel';

// The interstitial log: append-only, one day per page, browse backward. New entries always land on
// today via the capture bar (no backdating) — here you read past days and fix typos.
export function LogPage() {
  const { data: settings } = useSettings();
  const today = todayKey(settings?.dayStartHour ?? 4);
  const [day, setDay] = useState(today);
  const isToday = day === today;

  const { data: entries = [], isPending, isError, refetch } = useLog(day);
  const update = useUpdateLogEntry(day);
  const setPrivate = useSetLogEntryPrivate(day);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center justify-between gap-4">
        <div>
          <Text as="h1" size="2xl" weight="semibold">
            {dayLabel(day, today)}
          </Text>
          <Text as="p" size="sm" tone="muted">
            {entries.length} {entries.length === 1 ? 'entry' : 'entries'}
          </Text>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            aria-label="Previous day"
            onClick={() => setDay(addDays(day, -1))}
          >
            <ChevronLeftIcon />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setDay(today)} disabled={isToday}>
            Today
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Next day"
            onClick={() => setDay(addDays(day, 1))}
            disabled={isToday}
          >
            <ChevronRightIcon />
          </Button>
        </div>
      </header>

      {/* A failed toggle rolls the lock back — said out loud, since it's a privacy control. */}
      {setPrivate.isError && (
        <div role="alert">
          <Text as="p" size="sm" tone="danger">
            Couldn&apos;t change that entry&apos;s lock — it&apos;s back as it was. Try again.
          </Text>
        </div>
      )}
      <ul className="flex flex-col divide-y divide-line">
        {entries.length === 0 ? (
          <li className="py-8">
            <EmptyState
              pending={isPending}
              error={isError}
              onRetry={() => void refetch()}
              title={`Nothing logged ${isToday ? 'yet today' : 'this day'}.`}
            >
              {isToday
                ? 'The bar below is already in Log mode — plain text, no fields, straight into today.'
                : 'Entries land on the day they were captured; there is no backdating.'}
            </EmptyState>
          </li>
        ) : (
          entries.map((entry) => (
            <LogEntryRow
              key={entry.id}
              entry={entry}
              onSave={(text) => update.mutate({ id: entry.id, text })}
              onTogglePrivate={() =>
                setPrivate.mutate({ id: entry.id, isPrivate: entry.private !== true })
              }
            />
          ))
        )}
      </ul>
    </div>
  );
}
