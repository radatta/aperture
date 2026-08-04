import { useState } from 'react';
import type { ReactNode } from 'react';
import type { PomodoroSession, Task } from '@aperture/shared';
import { Button } from '../../components/Button';
import { Text } from '../../components/Text';
import { cx } from '../../lib/cx';
import { fmtClock } from '../../lib/format';
import { useAllTasks } from '../../data/hooks/useTasks';
import { usePomodoro } from './pomodoro-context';
import type { RunningTimer } from './pomodoro-context';

// The persistent pomodoro UI — a stack fixed above the capture bar, following you across every view
// (pomodoro is not a route). One row per concurrent timer, plus stale keep/discard prompts and a
// "new focus" starter for ad-hoc parallel work.
export function TimerBar() {
  const {
    timers,
    stale,
    pause,
    resume,
    extend,
    stop,
    startFocus,
    startBreak,
    keepStale,
    discardStale,
  } = usePomodoro();
  const { data: tasks = [] } = useAllTasks();

  if (timers.length === 0 && stale.length === 0)
    return <NewFocus onStart={startFocus} onBreak={startBreak} idle />;

  return (
    <div className="fixed bottom-24 right-4 z-30 flex w-72 flex-col gap-2">
      {stale.map((s) => (
        <StaleRow
          key={s.id}
          session={s}
          tasks={tasks}
          onKeep={() => keepStale(s.id)}
          onDiscard={() => discardStale(s.id)}
        />
      ))}
      {timers.map((t) => (
        <TimerRow
          key={t.session.id}
          timer={t}
          tasks={tasks}
          onPause={() => pause(t.session.id)}
          onResume={() => resume(t.session.id)}
          onExtend={() => extend(t.session.id)}
          onStop={() => stop(t.session.id, 'completed')}
        />
      ))}
      <NewFocus onStart={startFocus} onBreak={startBreak} />
    </div>
  );
}

function timerLabel(session: PomodoroSession, tasks: Task[]): string {
  if (session.kind === 'break') return 'Break';
  if (session.label) return session.label;
  if (session.taskId) return tasks.find((t) => t.id === session.taskId)?.title ?? 'Focus';
  return 'Focus';
}

function Row({ done, children }: { done?: boolean; children: ReactNode }) {
  return (
    <div
      className={cx(
        'flex items-center gap-2 rounded-2xl border bg-panel-2 p-2 shadow-lg',
        done ? 'border-gold' : 'border-line',
      )}
    >
      {children}
    </div>
  );
}

function TimerRow({
  timer,
  tasks,
  onPause,
  onResume,
  onExtend,
  onStop,
}: {
  timer: RunningTimer;
  tasks: Task[];
  onPause: () => void;
  onResume: () => void;
  onExtend: () => void;
  onStop: () => void;
}) {
  const { session, paused, remaining, done } = timer;
  const running = !paused && !done;
  return (
    <Row done={done}>
      <span
        className={cx(
          'h-2 w-2 shrink-0 rounded-full',
          done ? 'bg-gold' : running ? 'animate-pulse bg-teal' : 'bg-ink-subtle',
        )}
      />
      <div className="min-w-0 flex-1 truncate">
        <Text size="sm">{timerLabel(session, tasks)}</Text>
      </div>
      <Text size="sm" tabular tone={done ? 'gold' : undefined} className="shrink-0">
        {done ? 'Done' : fmtClock(remaining)}
      </Text>
      {done ? (
        <Button variant="ghost" size="sm" onClick={onExtend}>
          +1
        </Button>
      ) : paused ? (
        <Button variant="ghost" size="sm" onClick={onResume}>
          Resume
        </Button>
      ) : (
        <Button variant="ghost" size="sm" onClick={onPause}>
          Pause
        </Button>
      )}
      <Button variant="ghost" size="sm" onClick={onStop}>
        Stop
      </Button>
    </Row>
  );
}

function StaleRow({
  session,
  tasks,
  onKeep,
  onDiscard,
}: {
  session: PomodoroSession;
  tasks: Task[];
  onKeep: () => void;
  onDiscard: () => void;
}) {
  return (
    <Row>
      <div className="min-w-0 flex-1 truncate">
        <Text size="sm" tone="muted">
          {timerLabel(session, tasks)} — was left running
        </Text>
      </div>
      <Button size="sm" onClick={onKeep}>
        Keep
      </Button>
      <Button variant="ghost" size="sm" onClick={onDiscard}>
        Discard
      </Button>
    </Row>
  );
}

// Start an ad-hoc parallel focus by name, or a break. `idle` renders it standalone-docked when
// nothing is running yet (so there's always a way to start one).
function NewFocus({
  onStart,
  onBreak,
  idle = false,
}: {
  onStart: (input?: { label?: string | null }) => void;
  onBreak: () => void;
  idle?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');

  function start() {
    onStart(label.trim() ? { label: label.trim() } : undefined);
    setLabel('');
    setOpen(false);
  }

  const inner = open ? (
    <Row>
      <input
        autoFocus
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && start()}
        placeholder="New focus…"
        aria-label="New focus label"
        className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 py-1 text-sm text-ink outline-none focus:border-teal"
      />
      <Button size="sm" onClick={start}>
        Start
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </Row>
  ) : (
    <Row>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        + New focus
      </Button>
      <Button variant="ghost" size="sm" onClick={onBreak}>
        Break
      </Button>
    </Row>
  );

  if (!idle) return inner;
  return <div className="fixed bottom-24 right-4 z-30 flex w-72 flex-col gap-2">{inner}</div>;
}
