import { useState } from 'react';
import type { ReactNode } from 'react';
import type { PomodoroSession, Task } from '@aperture/shared';
import { Button } from '../../components/Button';
import { Text } from '../../components/Text';
import { TimerIcon } from '../../components/icons';
import { cx } from '../../lib/cx';
import { fmtClock } from '../../lib/format';
import { useAllTasks } from '../../data/hooks/useTasks';
import { usePomodoro } from './pomodoro-context';
import type { RunningTimer } from './pomodoro-context';

// The persistent pomodoro UI — one row per concurrent timer, plus stale keep/discard prompts,
// stacked directly above the capture bar by AppShell (pomodoro is not a route).
//
// Idle, it collapses to a single icon button rather than the old floating "+ New focus | Break"
// panel, which competed with capture for the same corner of vision on every screen. It can't
// collapse to nothing: the Focus card that offers a cold start only renders in DAYTIME mode, so
// dropping the idle control entirely left 18 hours of the day (morning and night) with no way to
// start an ad-hoc block at all.
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
    return <IdleStarter onStart={() => startFocus()} />;

  return (
    <div className="flex flex-col gap-2 sm:ml-auto sm:w-80">
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

// One quiet control, right-aligned so it never sits where the capture text begins. Deliberately
// icon+word and nothing else — a break from cold is a fringe intent and lives on the daytime
// Focus card; once anything is running, the full controls appear below.
function IdleStarter({ onStart }: { onStart: () => void }) {
  return (
    <div className="flex justify-end">
      <Button
        variant="ghost"
        size="sm"
        onClick={onStart}
        title="Start a 25-minute focus block"
        className="pointer-events-auto gap-1.5 bg-panel-2 shadow-[var(--shadow-dock)]"
      >
        <TimerIcon size={15} /> Focus
      </Button>
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
        'pointer-events-auto flex items-center gap-1.5 rounded-2xl border bg-panel-2 p-1.5 pl-2.5 shadow-[var(--shadow-dock)]',
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
        <Button variant="ghost" size="sm" onClick={onExtend} title="One more block">
          Again
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

// Start another parallel focus by name, or a break — only offered while something is already
// running, since that's when "and also this" is a real thought.
function NewFocus({
  onStart,
  onBreak,
}: {
  onStart: (input?: { label?: string | null }) => void;
  onBreak: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');

  function start() {
    onStart(label.trim() ? { label: label.trim() } : undefined);
    setLabel('');
    setOpen(false);
  }

  if (!open) {
    return (
      <Row>
        <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
          + New focus
        </Button>
        <Button variant="ghost" size="sm" onClick={onBreak}>
          Break
        </Button>
      </Row>
    );
  }

  return (
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
  );
}
