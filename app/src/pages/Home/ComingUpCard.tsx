import { dueUrgency, fmtDueDay, partsOf, partsSummary, todayKey } from '@aperture/shared';
import { EmptyState } from '../../components/EmptyState';
import { Text } from '../../components/Text';
import { useSettings } from '../../data/hooks/useSettings';
import { useAllTasks } from '../../data/hooks/useTasks';
import { cx } from '../../lib/cx';
import { useNow } from '../../lib/useNow';
import { urgencyClass, urgencyLabel } from '../../modules/tasks/dueStyle';
import { useTodayPlan } from '../../modules/tasks/useTodayPlan';
import { CategoryTag } from '../../modules/tasks/CategoryTag';
import { comingUp } from '../../modules/home/comingUp';
import { CardLink, HomeCard } from './HomeCard';

// The deadline radar. Excludes anything already on the tight plane above (today's plan + any in-progress
// task) so a deadline never shows twice. Quiet, no tally — you plan from it; only a TIMED row takes the
// urgency colour as its time nears or passes (dueStyle.ts).
export function ComingUpCard() {
  const { data: settings } = useSettings();
  const dayStartHour = settings?.dayStartHour ?? 4;
  const today = todayKey(dayStartHour);
  const { rows } = useTodayPlan();
  const { data: allTasks = [], isPending, isError } = useAllTasks();
  const now = useNow();

  const excludeIds = new Set<string>([
    ...rows.map((r) => r.task.id),
    ...allTasks.filter((t) => t.status === 'in_progress').map((t) => t.id),
  ]);
  const cu = comingUp(allTasks, today, excludeIds, dayStartHour);
  const moreLabel =
    cu.moreThisWeek > 0
      ? `+${cu.moreThisWeek} more this week`
      : cu.moreLater > 0
        ? `+${cu.moreLater} more`
        : null;

  return (
    <HomeCard
      title="Coming up"
      aside={moreLabel ? <CardLink to="/tasks?lens=week">{moreLabel}</CardLink> : undefined}
    >
      {cu.items.length === 0 ? (
        <EmptyState pending={isPending} error={isError} title="No deadlines on the radar.">
          Set a due day when you scope a task and it’ll show up here.
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-1.5">
          {cu.items.map((t) => {
            const u = dueUrgency(t, now);
            const label = urgencyLabel(u);
            // A parent shows its progress, and quietly says when it's ready to submit — the button is on
            // its card and in its editor, not on the glance (parts.ts).
            const parts = partsOf(allTasks, t.id);
            const sum = parts.length ? partsSummary(parts) : null;
            return (
              <div
                key={t.id}
                className={cx(
                  '-mx-2 flex items-center justify-between gap-3 rounded-lg border border-transparent px-2 py-0.5',
                  urgencyClass(u),
                )}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <Text size="sm" tone="subtle" className="truncate">
                    {t.title}
                  </Text>
                  {/* A parent's progress outranks its category on a phone — the title needs the room. */}
                  <span className={cx('contents', sum && 'max-sm:hidden')}>
                    <CategoryTag categoryId={t.categoryId} />
                  </span>
                  {sum && (
                    <Text
                      size="xs"
                      tone={sum.allDone ? 'teal' : 'muted'}
                      className="shrink-0"
                      tabular
                    >
                      {sum.allDone ? 'all parts done' : `${sum.done}/${sum.total}`}
                    </Text>
                  )}
                </div>
                <Text size="xs" tone="subtle" className="shrink-0">
                  {fmtDueDay(t.dueDay!, today, t.dueTime, { dayStartHour })}
                  {label && <span className="sr-only">, {label}</span>}
                </Text>
              </div>
            );
          })}
        </div>
      )}
    </HomeCard>
  );
}
