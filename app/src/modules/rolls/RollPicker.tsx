import type { Roll, TaskStatus } from '@aperture/shared';
import { cx } from '../../lib/cx';
import { Text } from '../../components/Text';
import { CheckIcon } from '../../components/icons';
import { useRolls, usePickRollToday } from '../../data/hooks/useRolls';
import { useTodayPlan } from '../tasks/useTodayPlan';

// The morning ritual: "pick 1–2 today." Tapping a roll drops a tagged rep task onto today's plan, where
// it flows into the Right-now lane and completing it becomes the rep. Chips reflect today's state; a
// done roll stays tappable because a second rep in a day is honest (two problems = two reps).
type Today = 'none' | 'planned' | 'in_progress' | 'done';

export function RollPicker({ className }: { className?: string }) {
  const { rows, day } = useTodayPlan();
  const { data: rolls = [] } = useRolls();
  const pick = usePickRollToday();
  const active = rolls.filter((r) => r.active);
  if (active.length === 0) return null;

  // Today's rep tasks per roll → the chip's state (in_progress > planned > done > none).
  const statesByRoll = new Map<string, TaskStatus[]>();
  for (const { task } of rows) {
    if (!task.rollId) continue;
    const list = statesByRoll.get(task.rollId) ?? [];
    list.push(task.status);
    statesByRoll.set(task.rollId, list);
  }
  const stateFor = (rollId: string): Today => {
    const s = statesByRoll.get(rollId) ?? [];
    if (s.includes('in_progress')) return 'in_progress';
    if (s.includes('planned') || s.includes('backlog')) return 'planned';
    if (s.includes('done')) return 'done';
    return 'none';
  };

  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <Text size="xs" tone="subtle">
        Roll today
      </Text>
      <div className="flex flex-wrap gap-2">
        {active.map((roll) => (
          <RollChip
            key={roll.id}
            roll={roll}
            state={stateFor(roll.id)}
            pending={pick.isPending}
            onPick={() => pick.mutate({ rollId: roll.id, day })}
          />
        ))}
      </div>
    </div>
  );
}

function RollChip({
  roll,
  state,
  pending,
  onPick,
}: {
  roll: Roll;
  state: Today;
  pending: boolean;
  onPick: () => void;
}) {
  const onPlan = state === 'planned' || state === 'in_progress';
  const done = state === 'done';
  return (
    <button
      type="button"
      disabled={pending}
      onClick={onPick}
      aria-label={
        onPlan ? `${roll.name} — on today's plan` : done ? `${roll.name} — done today, pick again` : `Pick ${roll.name} for today`
      }
      className={cx(
        'inline-flex items-center gap-1 rounded-full border px-3 py-1 text-sm transition disabled:opacity-50',
        onPlan || done
          ? 'border-teal bg-teal-soft text-teal'
          : 'border-line text-ink-muted hover:border-teal hover:text-ink',
      )}
    >
      {(onPlan || done) && <CheckIcon size={13} />}
      {roll.name}
    </button>
  );
}
