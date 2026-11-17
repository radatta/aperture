import { fmtDayHeading, fmtDuration, hasReviewWords, sittingMinutes, todayKey } from '@aperture/shared';
import type { Sitting } from '@aperture/shared';
import { Link } from 'react-router';
import { EmptyState } from '../../components/EmptyState';
import { Text } from '../../components/Text';
import { useSettings } from '../../data/hooks/useSettings';
import { useSittings } from '../../data/hooks/useSittings';
import { useNow } from '../../lib/useNow';
import { TodayCard } from './TodayCard';
import { endedNote, groupSittings, sittingOutcome, summarizeSittings } from './recruitingHelpers';

// The Sittings tab: the coach's Today card, then every go at a LeetCode problem, captured by the extension
// (docs/areas/recruiting). The open sitting sits on top with its running clock; the rest are grouped by day. Each
// row opens the sitting's page (its timeline, review, and End sitting); a sitting starts from the extension's
// overlay.
export function SittingsSection() {
  return (
    <div className="flex flex-col gap-6">
      <TodayCard />
      <SittingsList />
    </div>
  );
}

function SittingsList() {
  const { data: sittings = [], isPending, isError, refetch } = useSittings();
  const now = useNow();
  const { data: settings } = useSettings();
  const today = todayKey(settings?.dayStartHour ?? 4, now);
  const { open, days } = groupSittings(sittings);
  const s = summarizeSittings(sittings);

  if (sittings.length === 0)
    return (
      <div className="py-8">
        <EmptyState
          pending={isPending}
          error={isError}
          onRetry={() => void refetch()}
          title="No sittings yet."
        >
          Open a LeetCode problem with the extension installed and press Start — it lands here.
        </EmptyState>
      </div>
    );

  return (
    <section aria-label="All sittings" className="flex flex-col gap-4">
      {/* Only once there's something to count — a zero summary would assert a total while loading. */}
      <Text as="p" size="sm" tone="muted">
        {s.sittings} {s.sittings === 1 ? 'sitting' : 'sittings'} · {s.problems}{' '}
        {s.problems === 1 ? 'problem' : 'problems'} · {s.firstTry} first-submit accepted
      </Text>
      {open.length > 0 && (
        <section aria-labelledby="sittings-now" className="flex flex-col gap-1">
          <Text as="h2" id="sittings-now" size="sm" weight="semibold" tone="muted">
            Now
          </Text>
          <div className="flex flex-col divide-y divide-line">
            {open.map((x) => (
              <SittingRow key={x.id} sitting={x} now={now} />
            ))}
          </div>
        </section>
      )}
      {days.map(([day, rows]) => (
        <section key={day} aria-labelledby={`sittings-${day}`} className="flex flex-col gap-1">
          <Text as="h2" id={`sittings-${day}`} size="sm" weight="semibold" tone="muted">
            {day === today ? 'Today' : fmtDayHeading(day)}
          </Text>
          <div className="flex flex-col divide-y divide-line">
            {rows.map((x) => (
              <SittingRow key={x.id} sitting={x} now={now} />
            ))}
          </div>
        </section>
      ))}
    </section>
  );
}

function SittingRow({ sitting, now }: { sitting: Sitting; now: number }) {
  const outcome = sittingOutcome(sitting, now);
  const open = sitting.status === 'active';
  const minutes = sittingMinutes(sitting, now);
  return (
    <Link
      to={`/recruiting/sittings/${sitting.id}`}
      className="-mx-2 flex items-start justify-between gap-4 rounded-lg px-2 py-3 transition hover:bg-panel"
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <Text weight="medium" className="truncate">
            {sitting.problemTitle}
          </Text>
          {hasReviewWords(sitting.review) && (
            <span
              role="img"
              aria-label="reviewed"
              title="Reviewed"
              className="size-1.5 shrink-0 rounded-full bg-teal"
            />
          )}
          {sitting.difficulty && (
            <Text size="xs" tone="subtle">
              {sitting.difficulty}
            </Text>
          )}
          {sitting.review?.test === true && (
            <Text size="xs" tone="subtle" className="shrink-0">
              Doesn’t count
            </Text>
          )}
        </div>
        <Text size="xs" tone="subtle">
          {open ? 'In progress · ' : ''}
          {fmtDuration(minutes)}
          {sitting.summary.runs > 0
            ? ` · ${sitting.summary.runs} ${sitting.summary.runs === 1 ? 'run' : 'runs'}`
            : ''}
          {endedNote(sitting) ? ` · ${endedNote(sitting)}` : ''}
          {sitting.prepTarget !== 'General' ? ` · ${sitting.prepTarget}` : ''}
        </Text>
      </div>
      <Text size="sm" weight="medium" tone={outcome.tone} className="shrink-0 text-right">
        {outcome.label}
      </Text>
    </Link>
  );
}
