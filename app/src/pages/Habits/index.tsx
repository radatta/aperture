import { useState } from 'react';
import { fmtDayHeading, fmtMonthShortDay, todayKey } from '@aperture/shared';
import type { Habit } from '@aperture/shared';
import { cx } from '../../lib/cx';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Field } from '../../components/Field';
import { Menu } from '../../components/Menu';
import { Select } from '../../components/Select';
import { Text } from '../../components/Text';
import { PlusIcon } from '../../components/icons';
import { useCategories } from '../../data/hooks/useCategories';
import {
  useCheckHabit,
  useHabitChecks,
  useHabits,
  useUpsertHabit,
} from '../../data/hooks/useHabits';
import { useSettings } from '../../data/hooks/useSettings';
import { useDisclosure } from '../../lib/useDisclosure';
import { CategoryTag } from '../../modules/tasks/CategoryTag';
import { countIn, recentWeeks, weekDates } from '../../modules/habits/habitWeek';

const DOW = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const WEEKS = 4;

// Habits deep view (PRODUCT §4b): create habits, mark them (repair-friendly — any past day is
// toggleable), and see the calendar history. No streaks — a miss is just an empty cell.
export function HabitsPage() {
  const { data: settings } = useSettings();
  const today = todayKey(settings?.dayStartHour ?? 4);
  const weeks = recentWeeks(today, WEEKS);
  const from = weeks[0]![0]!;
  const to = weeks[WEEKS - 1]![6]!;

  const { data: habits = [] } = useHabits();
  const { data: checks = [] } = useHabitChecks(from, to);
  const active = habits.filter((h) => h.active);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Text as="h1" size="2xl" weight="semibold">
          Habits
        </Text>
      </div>
      <HabitForm />
      <div className="flex flex-col gap-3">
        {active.length === 0 ? (
          <Text tone="subtle" size="sm">
            No habits yet. Start one with “New habit” — weekly cadence, no streaks, and a miss is
            just a miss.
          </Text>
        ) : (
          active.map((h) => (
            <HabitCard
              key={h.id}
              habit={h}
              today={today}
              weeks={weeks}
              checkedDates={new Set(checks.filter((c) => c.habitId === h.id).map((c) => c.date))}
            />
          ))
        )}
      </div>
    </div>
  );
}

function HabitCard({
  habit,
  today,
  weeks,
  checkedDates,
}: {
  habit: Habit;
  today: string;
  weeks: string[][];
  checkedDates: Set<string>;
}) {
  const check = useCheckHabit();
  const upsert = useUpsertHabit();
  const thisWeek = weekDates(today);
  const count = countIn(checkedDates, thisWeek);

  // Archiving hides the habit everywhere and there's no unarchive path in v1, so it asks first —
  // matching how the other destructive actions in the app (category delete, work-flip) behave.
  const [confirming, setConfirming] = useState(false);
  const menuItems = [
    { label: 'Archive habit…', tone: 'danger' as const, onSelect: () => setConfirming(true) },
  ];
  const archive = () =>
    upsert.mutate({
      id: habit.id,
      name: habit.name,
      categoryId: habit.categoryId,
      cadencePerWeek: habit.cadencePerWeek,
      active: false,
    });

  // Info column and calendar sit side by side once there's room — the grid is ~260px wide and was
  // stranded at the left edge of a 768px card with nothing beside it.
  return (
    <Card>
      {/* One flex row, reordered rather than duplicated: on a phone the grid drops to its own line
          under the name; on desktop everything sits inline with the menu last. Rendering two menus
          behind sm:hidden/hidden-sm:block would put two identically-labelled controls in the
          accessibility tree. */}
      <div className="flex flex-wrap items-start gap-x-6 gap-y-4">
        <div className="order-1 flex min-w-0 flex-1 flex-col gap-1.5">
          <Text weight="medium" className="truncate">
            {habit.name}
          </Text>
          <div className="flex flex-wrap items-center gap-2">
            <CategoryTag categoryId={habit.categoryId} />
            <Text size="xs" tone={count >= habit.cadencePerWeek ? 'teal' : 'muted'} tabular>
              {count}/{habit.cadencePerWeek} this week
            </Text>
          </div>
        </div>

        {/* Archiving is rare and mildly destructive; it doesn't earn a permanent button on a card
            whose job is to be tapped every day. */}
        <div className="order-2 shrink-0 sm:order-3">
          <Menu label={`More actions for ${habit.name}`} items={menuItems} />
        </div>

        {/* Week rows are labelled with the Monday they start, so four unlabelled bands of squares
            stop being "some past". Empty cells use line-strong — at 9% alpha they were invisible,
            which made a light week look like no habit at all. */}
        <div className="order-3 w-full shrink-0 sm:order-2 sm:w-auto">
          <div className="flex flex-col gap-1">
            <div className="flex gap-1">
              <div className="w-10 shrink-0" />
              {DOW.map((d, i) => (
                <div key={i} className="w-6 text-center">
                  <Text size="xs" tone="subtle">
                    {d}
                  </Text>
                </div>
              ))}
            </div>
            {weeks.map((week, wi) => (
              <div key={wi} className="flex items-center gap-1">
                <div className="w-10 shrink-0">
                  <Text size="xs" tone="subtle" tabular>
                    {wi === weeks.length - 1 ? 'now' : fmtMonthShortDay(week[0]!)}
                  </Text>
                </div>
                {week.map((date) => {
                  const done = checkedDates.has(date);
                  const future = date > today;
                  return (
                    <button
                      key={date}
                      type="button"
                      disabled={future}
                      aria-pressed={done}
                      aria-label={`${habit.name} on ${fmtDayHeading(date)}`}
                      title={fmtDayHeading(date)}
                      onClick={() => check.mutate({ habitId: habit.id, date, checked: !done })}
                      className={cx(
                        'h-6 w-6 rounded-md border transition',
                        future && 'cursor-default border-dashed border-line opacity-40',
                        !future &&
                          (done
                            ? 'border-teal bg-teal'
                            : 'border-line-strong hover:border-teal hover:bg-teal-soft'),
                        !future && date === today && !done && 'ring-1 ring-gold',
                      )}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      {confirming && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-3">
          <Text size="sm" tone="muted">
            Archive “{habit.name}”? It stops showing up in the nightly check. Its history is kept.
          </Text>
          <Button variant="gold" size="sm" onClick={archive}>
            Archive
          </Button>
          <Button variant="quiet" size="sm" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </div>
      )}
    </Card>
  );
}

// Collapsed by default. Adding a habit is a once-a-month act; the page's real job is the daily
// check-off, and a permanently-open three-field form was the first thing on it.
function HabitForm() {
  const { data: cats = [] } = useCategories();
  const upsert = useUpsertHabit();
  const { open, triggerRef, onOpen, onClose } = useDisclosure();
  const [name, setName] = useState('');
  const [cadence, setCadence] = useState('3');
  const [categoryId, setCategoryId] = useState('');

  async function create() {
    // `name` only clears once the await resolves, so without this a fast double-Enter creates the
    // habit twice. The button is `disabled` while pending; the Enter path had no such guard.
    if (!name.trim() || upsert.isPending) return;
    await upsert.mutateAsync({
      name: name.trim(),
      categoryId: categoryId || null,
      cadencePerWeek: Math.max(1, Number(cadence) || 1),
    });
    setName('');
    onClose();
  }

  // Cancel discards the draft — the form stays mounted, so without this, reopening resurrects the
  // half-typed name you just walked away from. Cadence and category stay put; they're preferences.
  function cancel() {
    setName('');
    onClose();
  }

  if (!open) {
    return (
      <div>
        <Button ref={triggerRef} variant="ghost" size="sm" onClick={onOpen} className="gap-1.5">
          <PlusIcon size={15} /> New habit
        </Button>
      </div>
    );
  }

  return (
    <Card>
      <div className="flex flex-wrap items-end gap-3">
        <Field
          autoFocus
          label="New habit"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && create()}
          placeholder="Read 20 min, call home…"
          className="w-56"
        />
        <Field
          label="× / week"
          type="number"
          min={1}
          max={7}
          value={cadence}
          onChange={(e) => setCadence(e.target.value)}
          className="w-24"
        />
        <Select
          label="Category"
          placeholder="Uncategorized"
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
          options={cats.map((c) => ({ value: c.id, label: c.label }))}
          className="w-40"
        />
        <Button size="sm" onClick={create} disabled={!name.trim() || upsert.isPending}>
          Add habit
        </Button>
        <Button variant="quiet" size="sm" onClick={cancel}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}
