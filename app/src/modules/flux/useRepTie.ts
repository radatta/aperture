import { useCallback, useRef, useState } from 'react';
import { useRolls } from '../../data/hooks/useRolls';
import { useSettings } from '../../data/hooks/useSettings';
import { useAllTasks, useTransitionTask } from '../../data/hooks/useTasks';
import { liveElapsedMin } from '../home/rightNow';
import { usePomodoro } from '../pomodoro/pomodoro-context';
import { useTodayPlan } from '../tasks/useTodayPlan';
import { prefillMinutes, repTie } from './repState';

// The Roll tie's state for the stage (RepTie.tsx renders it): which rep a Flux session counts toward,
// and the two moments that touch it — the first finished set, and Stop.
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

  const onSetCompleted = useCallback(() => {
    const t = tieRef.current;
    if (t.kind !== 'ready' || starting.current) return;
    setError(null);
    starting.current = transitionAsync({ id: t.task.id, to: 'in_progress' }).catch(() => {
      starting.current = null;
      setError(`Couldn’t start today’s ${t.roll.name} rep. Start it from Home.`);
    });
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
    doneMin,
    error,
    closeDone: () => setDoneMin(null),
    onSetCompleted,
    onStop,
  };
}

export type RepTieHandle = ReturnType<typeof useRepTie>;
