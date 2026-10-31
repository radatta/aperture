import { useCallback, useRef, useState } from 'react';
import { useRolls } from '../../data/hooks/useRolls';
import { useSettings } from '../../data/hooks/useSettings';
import { useAllTasks, useTransitionTask } from '../../data/hooks/useTasks';
import { liveElapsedMin } from '../home/rightNow';
import { usePomodoro } from '../pomodoro/pomodoro-context';
import { useTodayPlan } from '../tasks/useTodayPlan';
import { prefillMinutes, repTie } from './repState';

// The Roll tie's state for the stage (RepTie.tsx renders it): which rep a Flux session counts toward,
// and the two moments that touch it — the first set saved (finished or stopped early), and Stop.
export function useRepTie() {
  const settingsQ = useSettings();
  const rollsQ = useRolls();
  const tasksQ = useAllTasks();
  const settings = settingsQ.data;
  const rolls = rollsQ.data ?? [];
  const tasks = tasksQ.data ?? [];
  // Until all three land, an empty list would read as "no rep today" and offer a duplicate Pick.
  const loading = settingsQ.isPending || rollsQ.isPending || tasksQ.isPending;
  const loadError = settingsQ.isError || rollsQ.isError || tasksQ.isError;
  const { day, dayStartHour } = useTodayPlan();
  const { timers } = usePomodoro();
  const transition = useTransitionTask();
  const tie = repTie(settings?.fluxRollId ?? null, rolls, tasks, day, dayStartHour);

  const [doneMin, setDoneMin] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tieRef = useRef(tie);
  tieRef.current = tie;
  const timersRef = useRef(timers);
  timersRef.current = timers;
  const starting = useRef<Promise<unknown> | null>(null);
  const { mutateAsync: transitionAsync } = transition;

  // Returns the rep this set counts toward (the saved set links to it, D47): today's rep, whether it's
  // just being started, already running, or done — a set after the rep is done is still the day's work.
  const onSetCompleted = useCallback((): string | null => {
    const t = tieRef.current;
    if (t.kind === 'unlinked' || t.kind === 'none') return null;
    if (t.kind !== 'ready' || starting.current) return t.task.id;
    setError(null);
    starting.current = transitionAsync({ id: t.task.id, to: 'in_progress' }).catch(() => {
      starting.current = null;
      setError(`Couldn’t start today’s ${t.roll.name} rep. Start it from Home.`);
    });
    return t.task.id;
  }, [transitionAsync]);

  const onStop = useCallback(async (sessionMs: number) => {
    // A rep started by this session may still be landing; wait for it rather than miss the prompt.
    await starting.current;
    starting.current = null;
    const t = tieRef.current;
    const live =
      t.kind === 'ready' || t.kind === 'in_progress'
        ? liveElapsedMin(t.task, timersRef.current)
        : 0;
    if (t.kind === 'in_progress' || t.kind === 'ready') setDoneMin(prefillMinutes(sessionMs, live));
  }, []);

  return {
    tie,
    loading,
    loadError,
    day,
    dayStartHour,
    doneMin,
    error,
    closeDone: () => setDoneMin(null),
    onSetCompleted,
    onStop,
  };
}

export type RepTieHandle = ReturnType<typeof useRepTie>;
