import { useState } from 'react';
import type { ReactNode } from 'react';
import {
  deadlineOf,
  dueUrgency,
  fmtClock12,
  fmtWeekdayShort,
  parentOf,
  todayKey,
} from '@aperture/shared';
import type { DueUrgency, Task } from '@aperture/shared';
import { cx } from '../../lib/cx';
import { Button, ButtonLink } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { Text } from '../../components/Text';
import { fmtDuration, fmtTime } from '../../lib/format';
import { useNow } from '../../lib/useNow';
import { useSettings } from '../../data/hooks/useSettings';
import { urgencyClass, urgencyLabel } from '../../modules/tasks/dueStyle';
import { useUpsertPlan } from '../../data/hooks/usePlans';
import { useAllTasks, useTransitionTask } from '../../data/hooks/useTasks';
import { usePomodoro } from '../../modules/pomodoro/pomodoro-context';
import { useTodayPlan } from '../../modules/tasks/useTodayPlan';
import { CategoryTag } from '../../modules/tasks/CategoryTag';
import { RollTag } from '../../modules/rolls/RollTag';
import { DoneForm } from '../../modules/tasks/DoneForm';
import { liveElapsedMin, promote, rightNow } from '../../modules/home/rightNow';
import type { RightNowRow } from '../../modules/home/rightNow';
import { AddToTodayButton } from '../../modules/tasks/AddToTodayDialog';
import { CardLink, HomeCard } from './HomeCard';

// "Return to what's next" — a gentle prompt when nothing's running, never an auto-loaded next task.
const PROMPT_COPY: Record<'pick' | 'next' | 'all-done', string> = {
  pick: 'Pick one to start.',
  next: 'Done — nice. What’s next?',
  'all-done': 'Big 3 done. That’s the day’s win.',
};

// The working estimate — the hero counts up against what you currently think it'll take.
const estimateOf = (t: Task): number | null => t.estimateMin;

// A TIMED task's row takes the urgency colour (dueStyle.ts); every row carries a transparent border so
// the colour never shifts layout. Re-read every minute.
const ROW = '-mx-2 rounded-lg border border-transparent px-2';
// The deadline a row answers to — a part's is its parent's (parts.ts).
function useDeadline(t: Task) {
  const { data: tasks = [] } = useAllTasks();
  return deadlineOf(t, tasks);
}

function useUrgency(t: Task): DueUrgency {
  return dueUrgency(useDeadline(t), useNow());
}

// "of P2" on a part, so the row says what it's working toward.
function PartOf({ task }: { task: Task }) {
  const { data: tasks = [] } = useAllTasks();
  const parent = parentOf(tasks, task);
  if (!parent) return null;
  // Capped, so on a phone the part's own title keeps most of the row.
  return (
    <Text size="xs" tone="muted" className="min-w-0 max-w-[35%] truncate">
      of {parent.title}
    </Text>
  );
}

// The deadline, on timed tasks only — the day's plan already says "today" for the rest. Compact, so a
// phone-width row keeps room for its title: "by 4:30pm" today, else "Sun 6:16pm" (whether that's past
// is the row's colour, and the screen-reader text).
function DueTime({ task }: { task: Task }) {
  const { data: settings } = useSettings();
  const label = urgencyLabel(useUrgency(task));
  const { dueDay, dueTime } = useDeadline(task);
  if (!dueDay || !dueTime) return null;
  const today = todayKey(settings?.dayStartHour ?? 4);
  return (
    <Text size="xs" tone="subtle" className="shrink-0">
      {dueDay === today
        ? `by ${fmtClock12(dueTime)}`
        : `${fmtWeekdayShort(dueDay)} ${fmtClock12(dueTime)}`}
      {label && <span className="sr-only">, {label}</span>}
    </Text>
  );
}

// The daytime hero: what's happening right now (the in-progress task, count-up vs estimate) over the
// Big 3, then the rest of today. Replaces the old FocusCard + TodayTasksCard.
export function RightNowCard() {
  const { rows, isPending, isError } = useTodayPlan();
  const { data: allTasks = [] } = useAllTasks();
  const { timers, startFocus, startBreak, stop } = usePomodoro();
  const transition = useTransitionTask();
  const upsertPlan = useUpsertPlan();
  const [doneInitial, setDoneInitial] = useState<number | null>(null);

  const rn = rightNow(rows, allTasks);
  const hero = rn.hero;
  const heroElapsed = hero ? liveElapsedMin(hero, timers) : 0;
  const heroTimer = hero
    ? timers.find((t) => t.session.kind === 'work' && t.session.taskId === hero.id)
    : undefined;

  const focusRest = rn.focus.filter((r) => r.task.id !== hero?.id);
  const alsoRest = rn.alsoToday.filter((r) => r.task.id !== hero?.id);
  const noTimers = timers.length === 0;
  const start = (id: string) => transition.mutate({ id, to: 'in_progress' });

  // Nothing planned and nothing running — the honest empty state, then the cold-start pair the old
  // FocusCard owned (the timer dock only appears while something runs, so its entry lives here).
  if (!hero && rn.focus.length === 0 && rn.alsoToday.length === 0) {
    return (
      <HomeCard title="Right now" aside={<Asides />}>
        <div className="flex flex-col gap-3">
          <EmptyState
            pending={isPending}
            error={isError}
            title="Nothing planned today."
            action={
              <ButtonLink size="sm" to="/tasks">
                Plan the day
              </ButtonLink>
            }
          >
            Pull a few things in from the backlog, or capture with the bar below.
          </EmptyState>
          {noTimers && <ColdStart onFocus={() => startFocus()} onBreak={startBreak} />}
        </div>
      </HomeCard>
    );
  }

  return (
    <HomeCard title="Right now" aside={<Asides />}>
      <div className="flex flex-col gap-3">
        {hero ? (
          <Hero task={hero}>
            <Text size="lg" weight="semibold" className="truncate">
              {hero.title}
            </Text>
            <div className="flex flex-wrap items-center gap-2">
              <CategoryTag categoryId={hero.categoryId} />
              <PartOf task={hero} />
              <RollTag rollId={hero.rollId} />
              {/* Count-UP vs the estimate, flat — no bar, no colour flip past 100%, no countdown. */}
              <DueTime task={hero} />
              <Text size="sm" tone="muted" tabular>
                {fmtDuration(heroElapsed)}
                {estimateOf(hero) != null ? ` of ~${fmtDuration(estimateOf(hero)!)}` : ' logged'}
              </Text>
              {hero.startedAt != null && (
                <Text size="xs" tone="subtle">
                  started {fmtTime(hero.startedAt)}
                </Text>
              )}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {heroTimer ? (
                <Text size="xs" tone="muted">
                  Timer running · controls in the bar below.
                </Text>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => startFocus({ taskId: hero.id })}>
                  Focus
                </Button>
              )}
              <Button
                size="sm"
                onClick={async () => {
                  const elapsed = heroElapsed; // capture before the timer stops
                  if (heroTimer) await stop(heroTimer.session.id);
                  setDoneInitial(elapsed);
                }}
              >
                Done
              </Button>
            </div>
            {doneInitial !== null && (
              <DoneForm
                task={hero}
                initialActualMin={doneInitial}
                onDone={() => setDoneInitial(null)}
              />
            )}
          </Hero>
        ) : (
          rn.nextPrompt && <Text tone="muted">{PROMPT_COPY[rn.nextPrompt]}</Text>
        )}

        {focusRest.length > 0 && (
          <div className="flex flex-col gap-1.5 border-t border-line pt-3">
            {focusRest.map((r) => (
              <FocusRow key={r.task.id} row={r} onStart={start} />
            ))}
          </div>
        )}

        {alsoRest.length > 0 && (
          <div className="flex flex-col gap-1.5 border-t border-line pt-3">
            <Text size="xs" tone="muted" weight="medium" className="uppercase tracking-wider">
              Also today
            </Text>
            {alsoRest.map((r) => (
              <AlsoRow
                key={r.task.id}
                row={r}
                onFocus={(id) => promote(rows, id).forEach((u) => upsertPlan.mutate(u))}
              />
            ))}
          </div>
        )}

        {noTimers && (
          <div className="border-t border-line pt-3">
            <ColdStart onFocus={() => startFocus()} onBreak={startBreak} />
          </div>
        )}
      </div>
    </HomeCard>
  );
}

// A Big-3 row that isn't the hero: done (struck), in-progress (elapsed), or ready-to-start.
function FocusRow({ row, onStart }: { row: RightNowRow; onStart: (id: string) => void }) {
  const t = row.task;
  const u = useUrgency(t);
  return (
    <div className={cx('flex items-center justify-between gap-3', ROW, urgencyClass(u))}>
      <div className="flex min-w-0 items-center gap-2">
        <Text
          size="sm"
          className={cx('min-w-0 truncate', t.status === 'done' && 'text-ink-subtle line-through')}
        >
          {t.title}
        </Text>
        <CategoryTag categoryId={t.categoryId} />
        <PartOf task={t} />
        <RollTag rollId={t.rollId} />
        <DueTime task={t} />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {t.status === 'done' ? (
          <Text size="xs" tone="subtle">
            done
          </Text>
        ) : t.status === 'in_progress' ? (
          <Text size="xs" tone="muted" tabular>
            {fmtDuration(t.actualAccruedMin)} in
          </Text>
        ) : (
          <>
            {estimateOf(t) != null && (
              <Text size="xs" tone="subtle" tabular>
                {fmtDuration(estimateOf(t)!)}
              </Text>
            )}
            <Button variant="quiet" size="sm" onClick={() => onStart(t.id)}>
              Start
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

// A lighter "also today" row — the plan's tail + any off-plan in-progress task. "Focus this" is the
// only way to actually CHOOSE the Big 3 (there is no reorder UI); it renumbers the day's plan.
function AlsoRow({ row, onFocus }: { row: RightNowRow; onFocus: (id: string) => void }) {
  const t = row.task;
  const canFocus = row.plan != null && (t.status === 'backlog' || t.status === 'planned');
  const u = useUrgency(t);
  return (
    <div className={cx('flex items-center justify-between gap-3', ROW, urgencyClass(u))}>
      <div className="flex min-w-0 items-center gap-2">
        <Text
          size="sm"
          tone="muted"
          className={cx('min-w-0 truncate', t.status === 'done' && 'line-through')}
        >
          {t.title}
        </Text>
        <CategoryTag categoryId={t.categoryId} />
        <PartOf task={t} />
        <RollTag rollId={t.rollId} />
        <DueTime task={t} />
        {row.unplanned && (
          <Text size="xs" tone="subtle">
            not planned today
          </Text>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {t.status === 'in_progress' && (
          <Text size="xs" tone="muted" tabular>
            {fmtDuration(t.actualAccruedMin)} in
          </Text>
        )}
        {canFocus && (
          <Button variant="quiet" size="sm" onClick={() => onFocus(t.id)}>
            Focus this
          </Button>
        )}
      </div>
    </div>
  );
}

function Hero({ task, children }: { task: Task; children: ReactNode }) {
  return (
    <div className={cx('flex flex-col gap-1 py-1', ROW, urgencyClass(useUrgency(task)))}>
      {children}
    </div>
  );
}

function Asides() {
  return (
    <div className="flex items-center gap-3">
      <AddToTodayButton />
      <CardLink to="/tasks">Plan</CardLink>
    </div>
  );
}

function ColdStart({ onFocus, onBreak }: { onFocus: () => void; onBreak: () => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="ghost" size="sm" onClick={onFocus}>
        Start 25-min focus
      </Button>
      <Button variant="quiet" size="sm" onClick={onBreak}>
        Take a break
      </Button>
    </div>
  );
}
