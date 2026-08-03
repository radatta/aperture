import { todayKey } from '@aperture/shared';
import { cx } from '../../lib/cx';
import { CheckIcon } from '../../components/icons';
import { Text } from '../../components/Text';
import { useCheckHabit, useHabitChecks, useHabits } from '../../data/hooks/useHabits';
import { useSettings } from '../../data/hooks/useSettings';
import { countIn, weekDates } from './habitWeek';

// Today's habits with a tap-to-check circle + this-week progress ("2/3 this week"). Used on the night
// home. No streaks, no guilt — an unchecked circle is just a miss, and it's repair-friendly.
export function HabitCheckList() {
  const { data: settings } = useSettings();
  const today = todayKey(settings?.dayStartHour ?? 4);
  const week = weekDates(today);

  const { data: habits = [] } = useHabits();
  const { data: checks = [] } = useHabitChecks(week[0]!, week[6]!);
  const check = useCheckHabit();

  const active = habits.filter((h) => h.active);
  if (active.length === 0)
    return (
      <Text tone="subtle" size="sm">
        No habits yet — add some on the Habits page.
      </Text>
    );

  const checkedToday = new Set(checks.filter((c) => c.date === today).map((c) => c.habitId));

  return (
    <div className="flex flex-col gap-2">
      {active.map((h) => {
        const done = checkedToday.has(h.id);
        const weekDatesSet = new Set(checks.filter((c) => c.habitId === h.id).map((c) => c.date));
        const count = countIn(weekDatesSet, week);
        return (
          <button
            key={h.id}
            type="button"
            aria-pressed={done}
            onClick={() => check.mutate({ habitId: h.id, date: today, checked: !done })}
            className="flex items-center justify-between gap-3 rounded-xl px-1 py-1 text-left hover:bg-panel-2"
          >
            <div className="flex items-center gap-2.5">
              <span
                className={cx(
                  'flex h-5 w-5 items-center justify-center rounded-full border transition',
                  done ? 'border-teal bg-teal text-surface' : 'border-line text-transparent',
                )}
              >
                <CheckIcon size={13} />
              </span>
              <Text size="sm">{h.name}</Text>
            </div>
            <Text size="xs" tone={count >= h.cadencePerWeek ? 'teal' : 'subtle'} tabular>
              {count}/{h.cadencePerWeek} this week
            </Text>
          </button>
        );
      })}
    </div>
  );
}
