import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { ReactNode } from 'react';
import { dayKey, todayKey } from '@aperture/shared';
import { cx } from '../../lib/cx';
import { Button, ButtonLink } from '../../components/Button';
import { DeltaBar } from '../../components/DeltaBar';
import { EmptyState } from '../../components/EmptyState';
import { MiniBar } from '../../components/MiniBar';
import { Text } from '../../components/Text';
import { ChevronRightIcon } from '../../components/icons';
import { fmtClock, fmtDuration, fmtTime } from '../../lib/format';
import { useBacklog } from '../../data/hooks/useBacklog';
import { useHabits } from '../../data/hooks/useHabits';
import { useLog } from '../../data/hooks/useLog';
import { useSettings } from '../../data/hooks/useSettings';
import { useAllTasks } from '../../data/hooks/useTasks';
import { useDay, useSetIntent, useSetReflection } from '../../data/hooks/useDay';
import { useHomeMode } from '../../modules/home/home-context';
import { usePomodoro } from '../../modules/pomodoro/pomodoro-context';
import { useTodayPlan } from '../../modules/tasks/useTodayPlan';
import { HabitCheckList } from '../../modules/habits/HabitCheckList';
import { reflectionPromptFor } from '../../modules/reflection/prompts';
import { HomeCard } from './HomeCard';

// The glanceable home. Auto morning/day/night (HomeModeProvider), ≤5 elements per mode — the global
// capture bar is element 1 everywhere, so each mode adds ~3 cards. Phase 5 lit up the plan / tasks /
// budget / estimate-vs-actual slots; the rest stay honest placeholders until their phases land.
export function HomePage() {
  const { mode } = useHomeMode();
  const { data: settings } = useSettings();
  const today = todayKey(settings?.dayStartHour ?? 4);

  if (mode === 'morning') return <MorningHome />;
  if (mode === 'day') return <DaytimeHome />;
  return <NightHome today={today} />;
}

// A quiet "go to the deep view" affordance — teal text + a chevron (SVG, so no tofu glyph).
function CardLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="flex items-center gap-0.5 text-teal">
      <Text size="xs" tone="teal">
        {children}
      </Text>
      <ChevronRightIcon size={13} />
    </Link>
  );
}

// ☀️ Plan the day — catch under-scoping before it becomes stress.
function MorningHome() {
  return (
    <div className="flex flex-col gap-4">
      <PlanTodayCard />
      <HabitsCard title="Habits due today" />
      <IntentCard />
    </div>
  );
}

// ⚙️ Do + capture — light now, grows at school.
function DaytimeHome() {
  return (
    <div className="flex flex-col gap-4">
      <TodayTasksCard />
      <FocusCard />
      <TimeBudgetCard />
    </div>
  );
}

// 🌙 Log + reflect — the honest mirror.
function NightHome({ today }: { today: string }) {
  return (
    <div className="flex flex-col gap-4">
      <ReviewCard today={today} />
      <HomeCard title="Habits check">
        <HabitCheckList />
      </HomeCard>
      <ReflectionCard today={today} />
    </div>
  );
}

// Morning: one optional line to aim the day — never scored.
function IntentCard() {
  const { data: settings } = useSettings();
  const today = todayKey(settings?.dayStartHour ?? 4);
  const { data: day } = useDay(today);
  const setIntent = useSetIntent(today);
  const [value, setValue] = useState('');
  useEffect(() => setValue(day?.intent ?? ''), [day?.intent]);
  const commit = () => value !== (day?.intent ?? '') && setIntent.mutate(value.trim());
  return (
    <HomeCard title="Intent">
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        placeholder="One line to aim the day…"
        aria-label="Day intent"
        className="w-full bg-transparent text-ink outline-none placeholder:text-ink-muted"
      />
    </HomeCard>
  );
}

// Night: one rotating prompt, fully skippable.
function ReflectionCard({ today }: { today: string }) {
  const { data: day } = useDay(today);
  const setReflection = useSetReflection(today);
  const prompt = day?.reflectionPrompt ?? reflectionPromptFor(today);
  const [text, setText] = useState('');
  useEffect(() => setText(day?.reflectionText ?? ''), [day?.reflectionText]);
  return (
    <HomeCard title="Reflection">
      <div className="flex flex-col gap-2">
        <Text size="sm" tone="muted">
          {prompt}
        </Text>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Optional — skip freely."
          aria-label="Reflection"
          rows={2}
          className="w-full resize-none rounded-xl border border-line bg-surface px-3 py-2 text-ink outline-none placeholder:text-ink-muted focus:border-teal"
        />
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            disabled={!text.trim() || setReflection.isPending}
            onClick={() => setReflection.mutate({ prompt, text: text.trim() })}
          >
            Save
          </Button>
          <Text size="xs" tone="subtle">
            {day?.reflectionText ? 'Saved' : 'Fully skippable'}
          </Text>
        </div>
      </div>
    </HomeCard>
  );
}

// Morning: planned hours vs available — the signature under-scoping catch, on the home.
function PlanTodayCard() {
  const { plannedMin, totalCount, pva } = useTodayPlan();
  const { data: backlog = [] } = useBacklog();
  return (
    <HomeCard title="Plan today" aside={<CardLink to="/tasks">Plan</CardLink>}>
      {pva.availableMin === null ? (
        <div className="flex flex-col items-start gap-2">
          <Text tone="muted" size="sm">
            {totalCount > 0
              ? `${totalCount} planned · ${fmtDuration(plannedMin)}`
              : 'Nothing planned yet.'}
            {backlog.length > 0 ? ` · ${backlog.length} waiting in the backlog` : ''}
          </Text>
          <Text tone="muted" size="xs">
            Set your available hours to catch over-scoping before it becomes stress.
          </Text>
          {/* An empty state that only describes the emptiness is a dead end — hand over the control. */}
          <ButtonLink size="sm" to="/tasks">
            Start the plan pass
          </ButtonLink>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <MiniBar plannedMin={pva.plannedMin} availableMin={pva.availableMin} />
          <Text size="sm" tone={pva.over ? 'gold' : 'muted'} tabular>
            {fmtDuration(plannedMin)} planned into a {fmtDuration(pva.availableMin)} day
            {pva.over ? ` · ${fmtDuration(pva.overByMin)} over` : ''}
          </Text>
        </div>
      )}
    </HomeCard>
  );
}

// Daytime: what's left today, planned vs elapsed.
function TodayTasksCard() {
  const { rows, doneCount, totalCount, isPending, isError } = useTodayPlan();
  return (
    <HomeCard title="Today's tasks" aside={<CardLink to="/tasks">Open</CardLink>}>
      {totalCount === 0 ? (
        <EmptyState
          pending={isPending}
          error={isError}
          title="Nothing planned today."
          action={
            <ButtonLink size="sm" to="/tasks">
              Open the backlog
            </ButtonLink>
          }
        >
          Capture with the bar below, or pull something in from the backlog.
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-1.5">
          <Text size="sm" tone="muted">
            {doneCount}/{totalCount} done
          </Text>
          {rows.slice(0, 3).map(({ plan, task }) => (
            <div key={plan.id} className="flex items-center justify-between gap-3">
              <Text
                size="sm"
                className={cx('truncate', task.status === 'done' && 'text-ink-subtle line-through')}
              >
                {task.title}
              </Text>
              <Text size="xs" tone="subtle" tabular>
                {fmtDuration(task.actualAccruedMin)}/{fmtDuration(plan.plannedMinutes)}
              </Text>
            </div>
          ))}
        </div>
      )}
    </HomeCard>
  );
}

// Daytime: the pomodoro. Controls live in the bottom dock's timer stack; this card starts a
// focus block on an in-progress task (so work time accrues to it) and reflects the running set —
// you can have several going at once (parallel focus).
function FocusCard() {
  const { timers, startFocus, startBreak } = usePomodoro();
  const { data: tasks = [] } = useAllTasks();
  const inProgress = tasks.filter((t) => t.status === 'in_progress');

  if (timers.length > 0) {
    return (
      <HomeCard title="Focus">
        <div className="flex flex-col gap-1.5">
          {timers.map(({ session, remaining, done }) => {
            const title =
              session.kind === 'break'
                ? 'Break'
                : (session.label ??
                  (session.taskId
                    ? (tasks.find((t) => t.id === session.taskId)?.title ?? 'Focus')
                    : 'Focus'));
            return (
              <div key={session.id} className="flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1 truncate">
                  <Text size="sm" tone="muted">
                    {title}
                  </Text>
                </div>
                <Text size="sm" tabular tone={done ? 'gold' : undefined} className="shrink-0">
                  {done ? 'Done' : fmtClock(remaining)}
                </Text>
              </div>
            );
          })}
        </div>
        {/* The timer stack moved into the bottom dock above the capture bar — it is no longer a
            floating panel in the bottom-right corner. */}
        <Text size="xs" tone="muted" className="mt-2">
          {timers.length === 1
            ? 'Controls are in the bar at the bottom.'
            : `${timers.length} running · controls in the bar at the bottom.`}
        </Text>
      </HomeCard>
    );
  }

  return (
    <HomeCard title="Focus">
      {inProgress.length > 0 ? (
        <div className="flex flex-col gap-2">
          {inProgress.slice(0, 3).map((t) => (
            <div key={t.id} className="flex items-center justify-between gap-3">
              <Text size="sm" className="truncate">
                {t.title}
              </Text>
              <Button size="sm" onClick={() => startFocus({ taskId: t.id })}>
                Focus
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <Text size="sm" tone="muted">
            Start a task, then focus it here — or a free block. Run several at once if you're
            juggling.
          </Text>
          {/* Both cold-start entry points live here now that the timer dock only appears while
              something is actually running. */}
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" size="sm" onClick={() => startFocus()}>
              Start 25-min focus
            </Button>
            <Button variant="quiet" size="sm" onClick={() => startBreak()}>
              Take a break
            </Button>
          </div>
        </div>
      )}
    </HomeCard>
  );
}

// Daytime: hours spent vs planned — the running calibration.
function TimeBudgetCard() {
  const { spentMin, plannedMin } = useTodayPlan();
  return (
    <HomeCard title="Time budget">
      {plannedMin === 0 ? (
        <Text tone="muted" size="sm">
          No plan to budget against yet.
        </Text>
      ) : (
        <div className="flex flex-col gap-2">
          <MiniBar plannedMin={spentMin} availableMin={plannedMin} />
          <Text size="sm" tone="muted" tabular>
            {fmtDuration(spentMin)} spent of {fmtDuration(plannedMin)} planned
          </Text>
        </div>
      )}
    </HomeCard>
  );
}

// Night: today's log peek + the estimate-vs-actual on tasks finished today.
function ReviewCard({ today }: { today: string }) {
  const { data: settings } = useSettings();
  const start = settings?.dayStartHour ?? 4;
  const { data: entries = [] } = useLog(today);
  const { data: tasks = [] } = useAllTasks();
  const recent = entries.slice(-3).reverse();
  const doneToday = tasks.filter(
    (t) =>
      t.status === 'done' &&
      t.completedAt != null &&
      t.estimateLockedMin != null &&
      dayKey(t.completedAt, start) === today,
  );

  return (
    <HomeCard title="Today in review" aside={<CardLink to="/log">Open log</CardLink>}>
      <div className="flex flex-col gap-3">
        {entries.length === 0 ? (
          <Text tone="muted" size="sm">
            Nothing logged yet today — the bar below is already in Log mode.
          </Text>
        ) : (
          <div className="flex flex-col gap-1.5">
            {recent.map((e) => (
              <div key={e.id} className="flex gap-3">
                {/* fixed, non-wrapping — "10:46 PM" was breaking across two lines on a phone */}
                <Text
                  size="xs"
                  tone="subtle"
                  tabular
                  className="w-[4.5rem] shrink-0 whitespace-nowrap pt-0.5"
                >
                  {fmtTime(e.createdAt)}
                </Text>
                <Text size="sm" tone="muted" className="min-w-0 flex-1 truncate">
                  {e.text}
                </Text>
              </div>
            ))}
            <Text size="xs" tone="subtle">
              {entries.length} {entries.length === 1 ? 'entry' : 'entries'} today
            </Text>
          </div>
        )}
        {doneToday.length > 0 && (
          <div className="flex flex-col gap-3 border-t border-line pt-3">
            <Text size="xs" tone="muted" weight="medium" className="uppercase tracking-wider">
              Done today · estimate vs actual
            </Text>
            {doneToday.map((t) => (
              <DeltaBar
                key={t.id}
                label={t.title}
                estimateMin={t.estimateLockedMin!}
                actualMin={t.actualAccruedMin}
              />
            ))}
          </div>
        )}
      </div>
    </HomeCard>
  );
}

// Shared between morning ("due") and night ("check"). Read-only for now — marking them off + the
// weekly calendar are Phase 7. Shows the real seeded habits so the shell isn't hollow.
function HabitsCard({ title }: { title: string }) {
  const { data: habits = [], isPending, isError } = useHabits();
  const active = habits.filter((h) => h.active);
  return (
    <HomeCard title={title}>
      {active.length === 0 ? (
        <EmptyState
          pending={isPending}
          error={isError}
          title="No habits yet."
          action={
            <ButtonLink size="sm" to="/habits">
              Add a habit
            </ButtonLink>
          }
        >
          Weekly cadence, no streaks — a miss is just a miss.
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            {active.map((h) => (
              <span
                key={h.id}
                className="rounded-full border border-line px-2.5 py-1 text-xs text-ink-muted"
              >
                {h.name}
                <Text size="xs" tone="muted">
                  {' '}
                  · {h.cadencePerWeek}×
                </Text>
              </span>
            ))}
          </div>
          <Text size="xs" tone="muted">
            Check them off tonight, or on the Habits page.
          </Text>
        </div>
      )}
    </HomeCard>
  );
}
