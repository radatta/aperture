import { fmtDueDay, todayKey } from '@aperture/shared';
import { EmptyState } from '../../components/EmptyState';
import { Text } from '../../components/Text';
import { useSettings } from '../../data/hooks/useSettings';
import { useAllTasks } from '../../data/hooks/useTasks';
import { useTodayPlan } from '../../modules/tasks/useTodayPlan';
import { CategoryTag } from '../../modules/tasks/CategoryTag';
import { comingUp } from '../../modules/home/comingUp';
import { CardLink, HomeCard } from './HomeCard';

// The gentle deadline radar. Excludes anything already on the tight plane above (today's plan + any
// in-progress task) so a deadline never shows twice. Flat, quiet, no red, no tally — you plan from it.
export function ComingUpCard() {
  const { data: settings } = useSettings();
  const today = todayKey(settings?.dayStartHour ?? 4);
  const { rows } = useTodayPlan();
  const { data: allTasks = [], isPending, isError } = useAllTasks();

  const excludeIds = new Set<string>([
    ...rows.map((r) => r.task.id),
    ...allTasks.filter((t) => t.status === 'in_progress').map((t) => t.id),
  ]);
  const cu = comingUp(allTasks, today, excludeIds);
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
          {cu.items.map((t) => (
            <div key={t.id} className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <Text size="sm" tone="subtle" className="truncate">
                  {t.title}
                </Text>
                <CategoryTag categoryId={t.categoryId} />
              </div>
              <Text size="xs" tone="subtle" className="shrink-0">
                {fmtDueDay(t.dueDay!, today)}
              </Text>
            </div>
          ))}
        </div>
      )}
    </HomeCard>
  );
}
