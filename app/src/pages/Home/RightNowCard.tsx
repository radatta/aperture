import { useCallback, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  deadlineOf,
  dueUrgency,
  fmtClock12,
  fmtWeekdayShort,
  parentOf,
  placedByTime,
  todayKey,
} from '@aperture/shared';
import type { DueUrgency, Task } from '@aperture/shared';
import { cx } from '../../lib/cx';
import { Button, ButtonLink } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { Text } from '../../components/Text';
import { fmtDuration, fmtTime } from '../../lib/format';
import { useNow } from '../../lib/useNow';
import { useRowAction } from '../../lib/useRowAction';
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

// A part's category is its parent's, so on a phone it gives way to "of P2" — the title needs the room.
function PartCategory({ task }: { task: Task }) {
  return (
    <span
      className={cx('contents', task.parentId && 'max-sm:hidden')}
      data-phone-hidden={task.parentId ? '' : undefined}
    >
      <CategoryTag categoryId={task.categoryId} />
    </span>
  );
}

// A row's title, then its tags. On a phone a tag-heavy row's tags — a part's "of P2 · ends 3pm · due
// Mon 5pm", a roll rep's category, roll and time — take a second line, so the title keeps the row;
// elsewhere it's one line. On that line a "·" sits before every piece after the first one shown (a
// part's category is there but hidden — `data-phone-hidden` — so the dots skip it), and the parent's
// name (PartOf) gives way before any tag does.
function RowText({ task, title, children }: { task: Task; title: ReactNode; children: ReactNode }) {
  const part = !!task.parentId || !!task.rollId;
  return (
    <div
      className={cx(
        'flex min-w-0 items-center gap-2',
        part && 'max-sm:flex-col max-sm:items-start max-sm:gap-0.5',
      )}
    >
      {title}
      <span
        className={cx(
          'contents',
          part &&
            "max-sm:flex max-sm:max-w-full max-sm:items-center max-sm:gap-2 max-sm:[&>:not([data-phone-hidden])~*]:before:mr-2 max-sm:[&>:not([data-phone-hidden])~*]:before:text-ink-subtle max-sm:[&>:not([data-phone-hidden])~*]:before:content-['·'_/_'']",
        )}
      >
        {children}
      </span>
    </div>
  );
}

// "of P2" on a part, so the row says what it's working toward.
function PartOf({ task }: { task: Task }) {
  const { data: tasks = [] } = useAllTasks();
  const parent = parentOf(tasks, task);
  if (!parent) return null;
  // Capped beside the title; on a phone it sits on the line under it (RowText), where it's the piece
  // that shrinks — the tags beside it never do.
  return (
    <Text size="xs" tone="muted" className="min-w-0 truncate max-sm:flex-1 sm:max-w-[35%]">
      of {parent.title}
    </Text>
  );
}

// The deadline, on timed tasks only — the day's plan already says "today" for the rest. Compact, so a
// phone-width row keeps room for its title: "by 4:30pm" today, else "Sun 6:16pm" (whether that's past
// is the row's colour, and the screen-reader text). "by 12:30am" for tonight's post-midnight deadline
// too — its app day is today. On a part it's its parent's, so it says "due" — apart from the part's own
// "ends".
function DueTime({ task }: { task: Task }) {
  const { data: settings } = useSettings();
  const label = urgencyLabel(useUrgency(task));
  const { dueDay, dueTime } = useDeadline(task);
  if (!dueDay || !dueTime) return null;
  const dayStartHour = settings?.dayStartHour ?? 4;
  return (
    <Text size="xs" tone="subtle" className="shrink-0">
      {task.parentId && 'due '}
      {placedByTime({ dueDay, dueTime }, todayKey(dayStartHour), dayStartHour)
        ? `${task.parentId ? '' : 'by '}${fmtClock12(dueTime)}`
        : `${fmtWeekdayShort(dueDay)} ${fmtClock12(dueTime)}`}
      {label && <span className="sr-only">, {label}</span>}
    </Text>
  );
}

const PROMOTE = 'promote'; // one key: any "Focus this" holds them all

// The daytime hero: what's happening right now (the in-progress task, count-up vs estimate) over the
// Big 3, then the rest of today. Replaces the old FocusCard + TodayTasksCard.
export function RightNowCard() {
  const { rows, isPending, isError, retry } = useTodayPlan();
  const { data: allTasks = [] } = useAllTasks();
  const { timers, startFocus, startBreak, stop } = usePomodoro();
  const transition = useTransitionTask();
  const upsertPlan = useUpsertPlan({ settled: true }); // the lock below holds through the refetch
  // One "Focus this" at a time: a second tap computed from a half-applied renumbering leaves two rows on
  // one order. Resolves once the plan is refetched. A partial failure heals on the next tap (`promote`
  // renumbers whatever is off).
  const alsoRef = useRef<HTMLDivElement>(null);
  const focusAction = useRowAction(alsoRef);
  const [doneInitial, setDoneInitial] = useState<number | null>(null);
  // Done opens the form with Actual focused, as the task modal's finish intent does — you tapped Done to
  // enter the number. Stable, so it focuses once on mount, not on every render.
  const focusActual = useCallback((el: HTMLInputElement | null) => el?.focus(), []);

  const rn = rightNow(rows, allTasks);
  const hero = rn.hero;
  const heroElapsed = hero ? liveElapsedMin(hero, timers) : 0;
  const heroTimer = hero
    ? timers.find((t) => t.session.kind === 'work' && t.session.taskId === hero.id)
    : undefined;

  const focusRest = rn.focus.filter((r) => r.task.id !== hero?.id);
  const byTimeRest = rn.byTime.filter((r) => r.task.id !== hero?.id);
  const alsoRest = rn.alsoToday.filter((r) => r.task.id !== hero?.id);
  const noTimers = timers.length === 0;
  const start = (id: string) => transition.mutate({ id, to: 'in_progress' });

  // Nothing planned and nothing running — the honest empty state, then the cold-start pair the old
  // FocusCard owned (the timer dock only appears while something runs, so its entry lives here).
  if (!hero && rn.focus.length === 0 && rn.byTime.length === 0 && rn.alsoToday.length === 0) {
    return (
      <HomeCard title="Right now" aside={<Asides />}>
        <div className="flex flex-col gap-3">
          <EmptyState
            pending={isPending}
            error={isError}
            onRetry={retry}
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
            {/* Two lines, like a task card's title (PR 101): one line cut a phone-width hero short. */}
            <Text size="lg" weight="semibold" className="line-clamp-2 break-words">
              {hero.title}
            </Text>
            <div className="flex flex-wrap items-center gap-2">
              <PartCategory task={hero} />
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
                  // A stop that didn't land keeps the timer; its row in the bar below says so, and the
                  // Actual form waits until the time is really saved.
                  if (
                    heroTimer &&
                    !(await stop(heroTimer.session.id).then(
                      () => true,
                      () => false,
                    ))
                  )
                    return;
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
                actualRef={focusActual}
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

        {/* Due today at a time: here by its time, not chosen — so no "Make it a focus" (D11). */}
        {byTimeRest.length > 0 && (
          <div className="flex flex-col gap-1.5 border-t border-line pt-3">
            <Text size="xs" tone="muted" weight="medium" className="uppercase tracking-wider">
              By time
            </Text>
            {byTimeRest.map((r) => (
              <FocusRow key={r.task.id} row={r} onStart={start} byTime />
            ))}
          </div>
        )}

        {alsoRest.length > 0 && (
          <div
            ref={alsoRef}
            tabIndex={-1}
            className="flex flex-col gap-1.5 border-t border-line pt-3 outline-none"
          >
            <Text size="xs" tone="muted" weight="medium" className="uppercase tracking-wider">
              Also today
            </Text>
            {alsoRest.map((r) => (
              <AlsoRow
                key={r.task.id}
                row={r}
                busy={focusAction.isBusy(PROMOTE)}
                onFocus={(id) =>
                  focusAction.run(PROMOTE, async () => {
                    // allSettled: the lock holds until every write is back, a failed one or not.
                    const writes = promote(rows, id).map((u) => upsertPlan.mutateAsync(u));
                    const results = await Promise.allSettled(writes);
                    if (results.some((r) => r.status === 'rejected')) throw new Error('promote');
                  })
                }
              />
            ))}
            <div role="status">
              {focusAction.failed && (
                <Text size="sm" tone="danger">
                  Couldn&apos;t save that — try again.
                </Text>
              )}
            </div>
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
function FocusRow({
  row,
  onStart,
  byTime = false,
}: {
  row: RightNowRow;
  onStart: (id: string) => void;
  byTime?: boolean;
}) {
  const t = row.task;
  const u = useUrgency(t);
  return (
    <div className={cx('flex items-center justify-between gap-3', ROW, urgencyClass(u))}>
      <RowText
        task={t}
        title={
          <Text
            size="sm"
            className={cx(
              'min-w-0 max-w-full truncate',
              t.status === 'done' && 'text-ink-subtle line-through',
            )}
          >
            {t.title}
          </Text>
        }
      >
        <PartCategory task={t} />
        <PartOf task={t} />
        <RollTag rollId={t.rollId} />
        {/* A part's deadline (and colour) is its parent's; in "By time" its own end is why it's here. */}
        {byTime && t.parentId && t.dueTime && (
          <Text size="xs" tone="subtle" className="shrink-0">
            ends {fmtClock12(t.dueTime)}
          </Text>
        )}
        <DueTime task={t} />
      </RowText>
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
function AlsoRow({
  row,
  busy,
  onFocus,
}: {
  row: RightNowRow;
  busy: boolean;
  onFocus: (id: string) => void;
}) {
  const t = row.task;
  const canFocus = row.plan != null && (t.status === 'backlog' || t.status === 'planned');
  const u = useUrgency(t);
  return (
    <div className={cx('flex items-center justify-between gap-3', ROW, urgencyClass(u))}>
      <RowText
        task={t}
        title={
          <Text
            size="sm"
            tone="muted"
            className={cx('min-w-0 max-w-full truncate', t.status === 'done' && 'line-through')}
          >
            {t.title}
          </Text>
        }
      >
        <PartCategory task={t} />
        <PartOf task={t} />
        <RollTag rollId={t.rollId} />
        <DueTime task={t} />
        {row.unplanned && (
          <Text size="xs" tone="subtle">
            not planned today
          </Text>
        )}
      </RowText>
      <div className="flex shrink-0 items-center gap-2">
        {t.status === 'in_progress' && (
          <Text size="xs" tone="muted" tabular>
            {fmtDuration(t.actualAccruedMin)} in
          </Text>
        )}
        {canFocus && (
          <Button variant="quiet" size="sm" disabled={busy} onClick={() => onFocus(t.id)}>
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
