import { useRef, useState } from 'react';
import { fmtDueDay, isTimed, placedByTime, todayKey } from '@aperture/shared';
import type { Task } from '@aperture/shared';
import { Button } from '../../components/Button';
import { Text } from '../../components/Text';
import { PlusIcon } from '../../components/icons';
import { cx } from '../../lib/cx';
import { returnFocus } from '../../lib/useDisclosure';
import { fmtDuration } from '../../lib/format';
import { useAddToDay } from '../../data/hooks/useAddToDay';
import { usePlansForDay } from '../../data/hooks/usePlans';
import { useSettings } from '../../data/hooks/useSettings';
import { useOpenTask } from './task-modal-context';

// A parent's parts, nested under its card in Week/Backlog (parts.ts): one compact line each — the title
// opens the part, then its estimate and where it stands. An open part not yet on a day gets "+ Today";
// one on today's plan just says so (its full card is on Today). A timed part's day is its time
// (lenses.md D13): it reads "today" on its day, else when it ends — never "+ Today".
export function PartsList({ parts }: { parts: Task[] }) {
  const { data: settings } = useSettings();
  const dayStartHour = settings?.dayStartHour ?? 4;
  const today = todayKey(dayStartHour);
  const { data: plans = [] } = usePlansForDay(today);
  const onToday = new Set(plans.map((p) => p.taskId));
  return (
    <ul className="mt-2 flex flex-col gap-1 border-t border-line pt-2">
      {parts.map((p) => (
        <PartRow
          key={p.id}
          part={p}
          today={isTimed(p) ? placedByTime(p, today, dayStartHour) : onToday.has(p.id)}
          day={today}
          dayStartHour={dayStartHour}
        />
      ))}
    </ul>
  );
}

function PartRow({
  part,
  today,
  day,
  dayStartHour,
}: {
  part: Task;
  today: boolean;
  day: string;
  dayStartHour: number;
}) {
  const openTask = useOpenTask();
  const { addToDay } = useAddToDay();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const titleRef = useRef<HTMLButtonElement>(null);
  const finished = part.status === 'done' || part.status === 'cancelled';
  const where =
    part.status === 'done'
      ? 'done'
      : part.status === 'cancelled'
        ? 'dropped'
        : part.status === 'in_progress'
          ? 'in progress'
          : today
            ? 'today'
            : isTimed(part)
              ? fmtDueDay(part.dueDay!, day, part.dueTime, { verb: 'ends', dayStartHour })
              : part.status === 'planned'
                ? 'planned'
                : null;

  async function add() {
    setBusy(true);
    setFailed(false);
    try {
      await addToDay(part);
      // The button gives way to "today" — focus goes to this part's title, never <body>.
      requestAnimationFrame(() => titleRef.current && returnFocus(titleRef.current));
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex items-center justify-between gap-3">
      <button
        ref={titleRef}
        type="button"
        aria-haspopup="dialog"
        data-task-id={part.id}
        title={part.title}
        onClick={(e) => openTask?.(part, 'view', e.currentTarget)}
        className={cx(
          'min-w-0 truncate text-left text-sm hover:underline',
          finished ? 'text-ink-muted line-through' : 'text-ink',
        )}
      >
        {part.title}
      </button>
      <div className="flex shrink-0 items-center gap-2">
        {part.estimateMin != null && (
          <Text size="xs" tone="muted" tabular>
            {fmtDuration(part.estimateMin)}
          </Text>
        )}
        {where ? (
          <Text size="xs" tone={where === 'today' || where === 'in progress' ? 'teal' : 'muted'}>
            {where}
          </Text>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="gap-1"
            disabled={busy}
            aria-label={`Add ${part.title} to today`}
            onClick={add}
          >
            <PlusIcon size={13} />
            <span className="max-sm:hidden">Today</span>
          </Button>
        )}
        {failed && (
          <span role="alert">
            <Text size="xs" tone="danger">
              Couldn’t add — try again
            </Text>
          </span>
        )}
      </div>
    </li>
  );
}
