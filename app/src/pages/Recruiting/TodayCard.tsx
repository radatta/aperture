import { useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { PATTERN_NAMES, PATTERNS } from '@aperture/shared';
import type { CoachSlot, CoachToday, PatternId } from '@aperture/shared';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { LoadError } from '../../components/LoadError';
import { Select } from '../../components/Select';
import { Text } from '../../components/Text';
import {
  useCoachToday,
  useSetCoachFloor,
  useSetCoachFocus,
  useSetCoachSlot,
} from '../../data/hooks/useCoach';
import { dueLabel, SLOT_KIND_LABEL, slotState } from './recruitingHelpers';

const sittingPath = (id: string) => `/recruiting/sittings/${id}`;
const ENGINE = ''; // the focus picker's "the coach's pick" option (clears the override)

// The coach's day on the Sittings tab (docs/areas/recruiting/coach.md): the focus pattern, up to four slots with
// their reasons, the floor option, what's due in the next 48 hours and the week's momentum. The thread in
// claude.ai drives the coaching; this is the glance, plus the few changes worth a tap: another problem, skip,
// restore, a floor day, the focus override. Every write is reversible, and a refused one says why inline.
export function TodayCard() {
  const { data: today, isPending, isError, refetch } = useCoachToday();
  const id = useId();
  return (
    <Card aria-labelledby={`${id}-h`} role="region" className="flex flex-col gap-3">
      <Text as="h2" id={`${id}-h`} size="lg" weight="semibold">
        Today’s practice
      </Text>
      {isError && !today ? (
        <LoadError onRetry={() => void refetch()}>Couldn’t load today’s plan.</LoadError>
      ) : isPending || !today ? (
        <Text size="sm" tone="muted">
          Loading today’s plan…
        </Text>
      ) : (
        <TodayBody today={today} />
      )}
    </Card>
  );
}

function TodayBody({ today }: { today: CoachToday }) {
  const slot = useSetCoachSlot();
  const floor = useSetCoachFloor();
  const [error, setError] = useState<string | null>(null);
  const busy = slot.isPending || floor.isPending;
  // One write at a time: a second tap while one is in flight does nothing, so a double tap is one change. A ref,
  // since both taps of a double tap land before the pending state renders.
  const inFlight = useRef(false);
  async function run(write: () => Promise<unknown>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    try {
      await write();
    } catch (e) {
      setError((e as Error).message || 'Couldn’t change the plan — try again.');
    } finally {
      inFlight.current = false;
    }
  }
  const change = (s: CoachSlot, action: 'swap' | 'skip' | 'restore') =>
    run(() => slot.mutateAsync({ slug: s.slug, action }));
  const queue = [
    ...today.due.filter((q) => !today.slots.some((s) => s.slug === q.slug)),
    ...today.next48h,
  ];

  return (
    <div className="flex flex-col gap-4">
      <FocusLine today={today} />

      {today.slots.length === 0 ? (
        <Text size="sm" tone="muted">
          Nothing to plan today — every problem in reach is done or queued for later.
        </Text>
      ) : (
        <ul aria-label="Today’s slots" className="flex flex-col divide-y divide-line">
          {today.slots.map((s) => (
            <SlotRow
              key={`${s.kind}-${s.swappedFrom ?? s.slug}`}
              slot={s}
              busy={busy}
              onChange={change}
            />
          ))}
        </ul>
      )}

      {today.floor && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-dashed border-line px-3 py-2">
          <div className="flex min-w-0 flex-col gap-0.5">
            <Text size="sm" weight="medium">
              {today.floor.on ? 'Floor day: just ' : 'Short on time? Floor: '}
              <a
                href={`https://leetcode.com/problems/${today.floor.slug}/`}
                target="_blank"
                rel="noreferrer"
                className="underline-offset-2 hover:underline"
              >
                {today.floor.title}
              </a>
              {today.floor.done && (
                <Text as="span" size="sm" tone="teal">
                  {' '}
                  · done
                </Text>
              )}
            </Text>
            <Text size="xs" tone="muted">
              {today.floor.reason}
            </Text>
          </div>
          <Button
            variant="ghost"
            size="sm"
            aria-disabled={busy || undefined}
            onClick={() => void run(() => floor.mutateAsync(!today.floor!.on))}
          >
            {today.floor.on ? 'Full day' : 'Floor day'}
          </Button>
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      {today.offPlan.length > 0 && (
        <Text size="sm" tone="muted">
          Also today:{' '}
          {today.offPlan.map((o, i) => (
            <span key={o.sittingId}>
              {i > 0 && ', '}
              <Link
                to={sittingPath(o.sittingId)}
                className="text-ink underline-offset-2 hover:underline"
              >
                {o.title}
              </Link>
            </span>
          ))}{' '}
          (off plan)
        </Text>
      )}

      {today.unreviewed.length > 0 && (
        <Text size="sm" tone="muted">
          No cause yet:{' '}
          {today.unreviewed.map((u, i) => (
            <span key={u.sittingId}>
              {i > 0 && ', '}
              <Link
                to={sittingPath(u.sittingId)}
                className="text-ink underline-offset-2 hover:underline"
              >
                {u.title}
              </Link>
            </span>
          ))}
        </Text>
      )}

      {queue.length > 0 && (
        <section aria-label="Re-solves coming up" className="flex flex-col gap-1">
          <Text size="sm" weight="semibold" tone="muted">
            Re-solves, next 48 hours
          </Text>
          <ul className="flex flex-col gap-0.5">
            {queue.map((q) => (
              <li key={q.slug} className="flex items-baseline justify-between gap-3">
                <Text size="sm" className="min-w-0 truncate">
                  {q.title}
                  <Text as="span" size="xs" tone="subtle">
                    {' '}
                    · {PATTERN_NAMES[q.pattern]}
                    {q.track === 'peeked' ? ' · peeked' : ''}
                  </Text>
                </Text>
                <Text size="xs" tone="muted" className="shrink-0">
                  {dueLabel(q.dueDay, today.day)}
                </Text>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Text size="xs" tone="muted" tabular>
        {today.momentum.activeDays} of {today.momentum.of} days practised this week
      </Text>
    </div>
  );
}

function FocusLine({ today }: { today: CoachToday }) {
  const focus = useSetCoachFocus();
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const f = today.focus;
  async function pick(v: string) {
    if (focus.isPending) return;
    setError(null);
    try {
      await focus.mutateAsync(v === ENGINE ? null : (v as PatternId));
      setPicking(false);
    } catch (e) {
      setError((e as Error).message || 'Couldn’t change the focus — try again.');
    }
  }
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Text size="sm" weight="medium">
          {PATTERN_NAMES[f.pattern]} · day {f.day} of {f.of}
          {f.source === 'override' ? ' · your pick' : ''}
        </Text>
        <Button
          variant="quiet"
          size="sm"
          aria-expanded={picking}
          onClick={() => {
            setError(null);
            setPicking(!picking);
          }}
        >
          {picking ? 'Cancel' : 'Change'}
        </Button>
      </div>
      <Text size="xs" tone="muted">
        {f.why}
      </Text>
      {picking && (
        <Select
          label="Focus pattern"
          value={f.source === 'override' ? f.pattern : ENGINE}
          aria-disabled={focus.isPending || undefined}
          onChange={(e) => void pick(e.target.value)}
          options={[
            { value: ENGINE, label: 'The coach’s pick' },
            ...PATTERNS.map((p) => ({ value: p, label: PATTERN_NAMES[p] })),
          ]}
        />
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function SlotRow({
  slot: s,
  busy,
  onChange,
}: {
  slot: CoachSlot;
  busy: boolean;
  onChange: (s: CoachSlot, action: 'swap' | 'skip' | 'restore') => void;
}) {
  const state = slotState(s);
  const act = (action: 'swap' | 'skip' | 'restore') => () => onChange(s, action);
  const quiet = (label: string, action: 'swap' | 'skip' | 'restore', name: string) => (
    <Button
      variant="quiet"
      size="sm"
      aria-label={`${name} — ${s.title}`}
      aria-disabled={busy || undefined}
      onClick={act(action)}
    >
      {label}
    </Button>
  );
  return (
    <li className="flex flex-col gap-1 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <Text size="xs" tone="subtle" weight="medium">
            {SLOT_KIND_LABEL[s.kind]}
            {s.difficulty ? ` · ${s.difficulty}` : ''} · {s.capMin} min
          </Text>
          <a
            href={s.url}
            target="_blank"
            rel="noreferrer"
            className={`font-medium underline-offset-2 hover:underline ${s.status === 'skipped' ? 'text-ink-subtle line-through' : 'text-ink'}`}
          >
            {s.title}
          </a>
        </div>
        <Text size="sm" tone={state.tone} className="shrink-0 text-right">
          {state.label}
        </Text>
      </div>
      <Text size="xs" tone="muted">
        {s.reason}
      </Text>
      <div className="-ml-2 flex flex-wrap items-center gap-1">
        {s.status === 'in-progress' && s.sittingId && (
          <Link to={sittingPath(s.sittingId)} className="px-2 text-sm text-teal hover:underline">
            Open sitting →
          </Link>
        )}
        {s.status === 'done' && s.sittingId && (
          <Link
            to={sittingPath(s.sittingId)}
            className="px-2 text-sm text-ink-muted hover:underline"
          >
            Review →
          </Link>
        )}
        {/* Another only while an easier unseen problem is left in the pattern (the engine's own pick). */}
        {s.status === 'open' &&
          s.alternatives.length > 0 &&
          quiet('Another', 'swap', 'Another problem')}
        {s.status === 'open' && quiet('Skip today', 'skip', 'Skip today')}
        {(s.status === 'skipped' || (s.status === 'open' && s.swappedFrom)) &&
          quiet('Restore', 'restore', 'Restore')}
      </div>
    </li>
  );
}
