import { useState } from 'react';
import { addDays } from '@aperture/shared';
import { Button } from '../../components/Button';
import { Text } from '../../components/Text';
import { useAddToDay } from '../../data/hooks/useAddToDay';
import { usePlansForDay } from '../../data/hooks/usePlans';
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
  const { rows } = useTodayPlan();
  const { data: tomorrowPlans = [], isSuccess } = usePlansForDay(tomorrow);
  const toTomorrow = useAddToDay(tomorrow);
  const { unplan } = useAddToDay();
  const [left, setLeft] = useState(() => readLeft(today));
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const [failed, setFailed] = useState(false);

  const open = stillOpen(rows, new Set(tomorrowPlans.map((p) => p.taskId)), left);
  // Until tomorrow's plan loads we can't tell what's already headed there — show nothing yet.
  if (!isSuccess || open.length === 0) return null;

  async function run(id: string, action: () => Promise<unknown>) {
    setFailed(false);
    setBusy((s) => new Set(s).add(id));
    try {
      await action();
    } catch {
      setFailed(true);
    } finally {
      setBusy((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  }

  function leave(id: string) {
    const next = new Set(left).add(id);
    setLeft(next);
    writeLeft(today, next);
  }

  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <Text size="xs" tone="muted" weight="medium" className="uppercase tracking-wider">
        Still open — when?
      </Text>
      <Text size="sm" tone="muted">
        Unfinished is fine. Say when.
      </Text>
      {open.map((r) => (
        <StillOpenRow
          key={r.plan.id}
          row={r}
          busy={busy.has(r.task.id)}
          // Tomorrow keeps today's row as history; a started task stays started.
          onTomorrow={() => run(r.task.id, () => toTomorrow.addToDay(r.task))}
          // Backlog is a real rollover, started or not — the task keeps its locked estimate + time.
          onBacklog={() => run(r.task.id, () => unplan(r.plan, r.task, { fromInProgress: true }))}
          onLeave={() => leave(r.task.id)}
        />
      ))}
      <div role="status">
        {failed && (
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
      className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1"
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
