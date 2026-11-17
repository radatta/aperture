import { useEffect, useState } from 'react';
import { contributesCalibration, dayKey, rollupParts, todayKey } from '@aperture/shared';
import { Button, ButtonLink } from '../../components/Button';
import { DeltaBar } from '../../components/DeltaBar';
import { EmptyState } from '../../components/EmptyState';
import { MiniBar } from '../../components/MiniBar';
import { LoadError } from '../../components/LoadError';
import { Text } from '../../components/Text';
import { fmtDuration, fmtTime } from '../../lib/format';
import { useBacklog } from '../../data/hooks/useBacklog';
import { useHabits } from '../../data/hooks/useHabits';
import { useLog } from '../../data/hooks/useLog';
import { useSettings } from '../../data/hooks/useSettings';
import { useAllTasks } from '../../data/hooks/useTasks';
import { useDay, useSetIntent, useSetReflection } from '../../data/hooks/useDay';
import { useHomeMode } from '../../modules/home/home-context';
import { RollPicker } from '../../modules/rolls/RollPicker';
import { rollupLabel } from '../../modules/calibration/calibration';
import { useTodayPlan } from '../../modules/tasks/useTodayPlan';
import { AddToTodayButton } from '../../modules/tasks/AddToTodayDialog';
import { HabitCheckList } from '../../modules/habits/HabitCheckList';
import { reflectionPromptFor } from '../../modules/reflection/prompts';
import { notesPlainText } from '../../modules/tasks/notes/parseNotes';
import { CardLink, HomeCard } from './HomeCard';
import { DayShapeCard } from './DayShapeCard';
import { RightNowCard } from './RightNowCard';
import { ComingUpCard } from './ComingUpCard';
import { StillOpenSection } from './StillOpenSection';
import { FinanceGlance } from './FinanceGlance';
import { FluxGlance } from './FluxGlance';
import { LeetcodeGlance } from './LeetcodeGlance';
import { PushSyncNotice } from '../../modules/push/PushSyncNotice';
import { API_MODE } from '../../shared/env';
import { LockIcon } from '../../components/icons';

// The glanceable home. Auto morning/day/night (HomeModeProvider), ≤5 elements per mode — the global
// capture bar is element 1 everywhere, so each mode adds ~3 cards. Phase 5 lit up the plan / tasks /
// budget / estimate-vs-actual slots; the rest stay honest placeholders until their phases land.
export function HomePage() {
  const { mode } = useHomeMode();
  const { data: settings } = useSettings();
  const today = todayKey(settings?.dayStartHour ?? 4);

  return (
    <div className="flex flex-col gap-4">
      {/* Every mode: a device whose reminders couldn't refresh on launch says so (reminders D7). */}
      <PushSyncNotice enabled={API_MODE === 'http'} />
      {mode === 'morning' ? (
        <MorningHome />
      ) : mode === 'day' ? (
        <DaytimeHome />
      ) : (
        <NightHome today={today} />
      )}
    </div>
  );
}

// ☀️ Plan the day — catch under-scoping before it becomes stress.
function MorningHome() {
  return (
    <div className="flex flex-col gap-4">
      <DayShapeCard mode="morning" />
      <FinanceGlance mode="morning" />
      <LeetcodeGlance />
      <PlanTodayCard />
      <HabitsCard title="Habits due today" />
      <IntentCard />
    </div>
  );
}

// ⚙️ Do — what's happening now (Big 3 + hero) over the deadline radar. Both always shown, fixed order.
function DaytimeHome() {
  return (
    <div className="flex flex-col gap-4">
      <DayShapeCard mode="day" />
      <RightNowCard />
      <ComingUpCard />
      <TimeBudgetCard />
    </div>
  );
}

// 🌙 Log + reflect — the honest mirror.
function NightHome({ today }: { today: string }) {
  return (
    <div className="flex flex-col gap-4">
      <ReviewCard today={today} />
      <FinanceGlance mode="night" />
      <FluxGlance today={today} />
      <HomeCard title="Habits check">
        <HabitCheckList />
      </HomeCard>
      <ReflectionCard today={today} />
    </div>
  );
}

// The day record, or why it can't load: useDay waits for settings, so a failed settings read leaves it
// pending for good — said here too, not left as a disabled field with no reason.
function useDayOrFail(today: string) {
  const settingsQ = useSettings();
  const dayQ = useDay(today);
  const failed =
    dayQ.data === undefined && (dayQ.isError || (settingsQ.isError && !settingsQ.data));
  const retry = () => {
    if (settingsQ.isError) void settingsQ.refetch();
    if (dayQ.isError) void dayQ.refetch();
  };
  return { data: dayQ.data, failed, retry };
}

// Morning: one optional line to aim the day — never scored.
function IntentCard() {
  const { data: settings } = useSettings();
  const today = todayKey(settings?.dayStartHour ?? 4);
  const { data: day, failed, retry } = useDayOrFail(today);
  const setIntent = useSetIntent(today);
  const [value, setValue] = useState('');
  useEffect(() => setValue(day?.intent ?? ''), [day?.intent]);
  // Only once the day has loaded: typing over an intent you were never shown would overwrite it.
  const commit = () => day && value !== (day.intent ?? '') && setIntent.mutate(value.trim());
  return (
    <HomeCard title="Intent">
      {failed && <LoadError onRetry={retry}>Couldn’t load today’s intent.</LoadError>}
      <input
        disabled={!day}
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
  const { data: day, failed, retry } = useDayOrFail(today);
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
        {failed && <LoadError onRetry={retry}>Couldn’t load today’s reflection.</LoadError>}
        <textarea
          disabled={!day} // a reflection you were never shown would be saved over
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
            disabled={!day || !text.trim() || setReflection.isPending}
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
  const { plannedMin, totalCount, pva, isPending, isError, dayError, retry } = useTodayPlan();
  const { data: backlog = [] } = useBacklog(); // the same tasks query: its failure is isError above
  return (
    <HomeCard
      title="Plan today"
      aside={
        <div className="flex items-center gap-3">
          <AddToTodayButton />
          <CardLink to="/tasks">Plan</CardLink>
        </div>
      }
    >
      {/* The plan summary, then the roll picker: picking one drops a rep onto today's plan (and into
          the daytime Right-now lane). The picker self-hides when there are no rolls. */}
      {isPending || isError ? (
        <EmptyState pending={isPending && !isError} error={isError} onRetry={retry} title="" />
      ) : dayError ? (
        <LoadError onRetry={retry}>Couldn’t load today’s capacity.</LoadError>
      ) : pva.availableMin === null ? (
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
      <RollPicker className="mt-3 border-t border-line pt-3" />
    </HomeCard>
  );
}

// Daytime: hours spent vs planned — the running calibration.
function TimeBudgetCard() {
  const { spentMin, plannedMin, isPending, isError, retry } = useTodayPlan();
  return (
    <HomeCard title="Time budget">
      {isPending || isError ? (
        <EmptyState pending={isPending && !isError} error={isError} onRetry={retry} title="" />
      ) : plannedMin === 0 ? (
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

// A task finished without an estimate: its actual, plainly — no bar to measure against.
function NoEstimateRow({ label, actualMin }: { label: string; actualMin: number }) {
  return (
    <div className="flex flex-col gap-1">
      <Text size="sm" tone="muted" className="truncate">
        {label}
      </Text>
      <div className="flex items-baseline gap-2">
        <Text size="sm" weight="medium" tabular>
          {fmtDuration(actualMin)}
        </Text>
        <Text size="xs" tone="muted">
          no estimate
        </Text>
      </div>
    </div>
  );
}

// Night: today's log peek + the estimate-vs-actual on tasks finished today.
function ReviewCard({ today }: { today: string }) {
  const { data: settings } = useSettings();
  const start = settings?.dayStartHour ?? 4;
  const logQ = useLog(today);
  const tasksQ = useAllTasks();
  const { data: entries = [] } = logQ;
  const { data: tasks = [] } = tasksQ;
  const logFailed = logQ.isError && logQ.data === undefined;
  const tasksFailed = tasksQ.isError && tasksQ.data === undefined;
  const recent = entries.slice(-3).reverse();
  // Every task finished today is listed. A calibration point (done + locked) gets its estimate-vs-actual
  // bar — a part on its own, and a parent marked done as the rollup of its parts (parts.ts); a task
  // finished without an estimate gets a plain row.
  const doneToday = tasks.filter(
    (t) => t.status === 'done' && t.completedAt != null && dayKey(t.completedAt, start) === today,
  );
  const label = (t: (typeof tasks)[number]) => rollupLabel(t.title, rollupParts(tasks, t.id));

  return (
    <HomeCard title="Today in review" aside={<CardLink to="/log">Open log</CardLink>}>
      <div className="flex flex-col gap-3">
        {(logFailed || tasksFailed) && (
          <LoadError
            onRetry={() => {
              if (logFailed) void logQ.refetch();
              if (tasksFailed) void tasksQ.refetch();
            }}
          >
            Couldn’t load today’s review.
          </LoadError>
        )}
        {logFailed ? null : entries.length === 0 ? (
          <Text tone="muted" size="sm">
            Nothing logged yet today — the bar below is already in Log mode.
          </Text>
        ) : (
          <div className="flex flex-col gap-1.5">
            <div role="list" className="flex flex-col gap-1.5">
              {recent.map((e) => (
                <div key={e.id} role="listitem" className="flex gap-3">
                  {/* fixed, non-wrapping — "10:46 PM" was breaking across two lines on a phone */}
                  <Text
                    size="xs"
                    tone="subtle"
                    tabular
                    className="w-[4.5rem] shrink-0 whitespace-nowrap pt-0.5"
                  >
                    {fmtTime(e.createdAt)}
                  </Text>
                  {e.private && (
                    <span role="img" aria-label="Private" className="mt-0.5 shrink-0 text-teal">
                      <LockIcon size={12} />
                    </span>
                  )}
                  <Text size="sm" tone="muted" className="min-w-0 flex-1 truncate">
                    {e.text}
                  </Text>
                </div>
              ))}
            </div>
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
              <div key={t.id} className="flex flex-col gap-1">
                {contributesCalibration(t) ? (
                  <DeltaBar
                    label={label(t)}
                    estimateMin={t.estimateLockedMin!}
                    actualMin={t.actualAccruedMin}
                  />
                ) : (
                  <NoEstimateRow label={label(t)} actualMin={t.actualAccruedMin} />
                )}
                {/* The why beside the delta: one line, italic so it doesn't read as another task's
                    label; nothing at all when there's none. */}
                {t.reflection && (
                  <Text size="sm" tone="muted" className="truncate italic">
                    {notesPlainText(t.reflection)}
                  </Text>
                )}
              </div>
            ))}
          </div>
        )}
        {!tasksFailed && <StillOpenSection today={today} dayStartHour={start} />}
      </div>
    </HomeCard>
  );
}

// Shared between morning ("due") and night ("check"). Read-only for now — marking them off + the
// weekly calendar are Phase 7. Shows the real seeded habits so the shell isn't hollow.
function HabitsCard({ title }: { title: string }) {
  const { data: habits = [], isPending, isError, refetch } = useHabits();
  const active = habits.filter((h) => h.active);
  return (
    <HomeCard title={title}>
      {active.length === 0 ? (
        <EmptyState
          pending={isPending}
          error={isError}
          onRetry={() => void refetch()}
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
