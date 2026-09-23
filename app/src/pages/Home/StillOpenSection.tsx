import { useRef, useState } from 'react';
import { addDays } from '@aperture/shared';
import { Button } from '../../components/Button';
import { Text } from '../../components/Text';
import { useRowAction } from '../../lib/useRowAction';
import { useAddToDay } from '../../data/hooks/useAddToDay';
import { usePlansForDay } from '../../data/hooks/usePlans';
import { usePomodoro } from '../../modules/pomodoro/pomodoro-context';
import { CategoryTag } from '../../modules/tasks/CategoryTag';
import { useTodayPlan } from '../../modules/tasks/useTodayPlan';
import { stillOpen, type PlanRow } from '../../modules/home/stillOpen';

const LEFT_KEY = 'aperture.night.left';

// "Leave" is for this session only — tomorrow morning the stale sweep puts it back in the backlog.
function readLeft(day: string): Set<string> {
  try {
    const raw = JSON.parse(sessionStorage.getItem(LEFT_KEY) ?? 'null') as {
      day: string;
      ids: string[];
    } | null;
    return new Set(raw?.day === day ? raw.ids : []);
  } catch {
    return new Set();
  }
}
function writeLeft(day: string, ids: Set<string>): void {
  try {
    sessionStorage.setItem(LEFT_KEY, JSON.stringify({ day, ids: [...ids] }));
  } catch {
    // not persisted — it's still hidden until the page reloads
  }
}

// Night: every unfinished thing from today's plan gets a "when?" — Tomorrow, Backlog, or Leave it.
// No count and no red: unfinished is information, not a verdict. Lives inside "Today in review".
export function StillOpenSection({ today }: { today: string }) {
  const tomorrow = addDays(today, 1);
  const { rows, isError: todayError, totalCount } = useTodayPlan();
  const tomorrowQ = usePlansForDay(tomorrow);
  const toTomorrow = useAddToDay(tomorrow);
  const { unplan } = useAddToDay();
  const { timers, stop } = usePomodoro();
  const [left, setLeft] = useState(() => readLeft(today));
  // Once something's been answered, the section closes on a line instead of vanishing — focus needs
  // somewhere to land when the last row goes.
  const [answered, setAnswered] = useState(false);
  const headingRef = useRef<HTMLDivElement>(null);
  const action = useRowAction(headingRef);

  // An error only matters with nothing in hand; a failed background refetch keeps the last answer.
  if ((todayError && totalCount === 0) || (tomorrowQ.isError && !tomorrowQ.data))
    return (
      <Text size="sm" tone="danger" className="border-t border-line pt-3">
        Couldn&apos;t load today&apos;s plan to ask what&apos;s still open.
      </Text>
    );
  const open = stillOpen(rows, new Set((tomorrowQ.data ?? []).map((p) => p.taskId)), left);
  // Until tomorrow's plan loads we can't tell what's already headed there — show nothing yet.
  if (!tomorrowQ.data) return null;
  if (open.length === 0)
    return answered ? (
      <div ref={headingRef} tabIndex={-1} className="border-t border-line pt-3 outline-none">
        <Text size="sm" tone="muted">
          Everything open has a when.
        </Text>
      </div>
    ) : null;

  // Backlog on a started task: stop its running focus first, so the session's minutes land now
  // instead of accruing onto a task that's no longer in play.
  async function toBacklog(r: PlanRow) {
    for (const t of timers)
      if (t.session.kind === 'work' && t.session.taskId === r.task.id) await stop(t.session.id);
    await unplan(r.plan, r.task, { fromInProgress: true });
  }

  const answer = (id: string, fn: () => Promise<unknown>) => {
    setAnswered(true);
    return action.run(id, fn);
  };

  function leave(id: string) {
    setAnswered(true);
    const next = new Set(left).add(id);
    setLeft(next);
    writeLeft(today, next);
    requestAnimationFrame(() => headingRef.current?.focus()); // the row, and its button, just left
  }

  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <div ref={headingRef} tabIndex={-1} className="outline-none">
        <Text size="xs" tone="muted" weight="medium" className="uppercase tracking-wider">
          Still open — when?
        </Text>
      </div>
      <Text size="sm" tone="muted">
        Unfinished is fine. Say when.
      </Text>
      {open.map((r) => (
        <StillOpenRow
          key={r.plan.id}
          row={r}
          busy={action.isBusy(r.task.id)}
          // Tomorrow keeps today's row as history; a started task stays started.
          onTomorrow={() => answer(r.task.id, () => toTomorrow.addToDay(r.task))}
          // Backlog is a real rollover, started or not — the task keeps its locked estimate + time.
          onBacklog={() => answer(r.task.id, () => toBacklog(r))}
          onLeave={() => leave(r.task.id)}
        />
      ))}
      <div role="status">
        {action.failed && (
          <Text size="sm" tone="danger">
            Couldn&apos;t save that — try again.
          </Text>
        )}
      </div>
    </div>
  );
}

function StillOpenRow({
  row,
  busy,
  onTomorrow,
  onBacklog,
  onLeave,
}: {
  row: PlanRow;
  busy: boolean;
  onTomorrow: () => void;
  onBacklog: () => void;
  onLeave: () => void;
}) {
  const { task } = row;
  return (
    <div
      role="group"
      aria-label={task.title}
      // Stacked on phones so every row's buttons line up, whatever the title's length.
      className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
    >
      <div className="flex min-w-0 items-center gap-2">
        <Text size="sm" className="min-w-0 truncate">
          {task.title}
        </Text>
        <CategoryTag categoryId={task.categoryId} />
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button variant="ghost" size="sm" disabled={busy} onClick={onTomorrow}>
          Tomorrow
        </Button>
        <Button variant="quiet" size="sm" disabled={busy} onClick={onBacklog}>
          Backlog
        </Button>
        <Button variant="quiet" size="sm" disabled={busy} onClick={onLeave}>
          Leave
        </Button>
      </div>
    </div>
  );
}
