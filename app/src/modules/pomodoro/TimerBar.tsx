import { useState } from 'react';
import type { ReactNode } from 'react';
import type { PomodoroSession, Task } from '@aperture/shared';
import { Button } from '../../components/Button';
import { LoadError } from '../../components/LoadError';
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
// Idle, it renders nothing here: the cold-start control is IdleFocus, docked inside the capture
// panel's top row. It used to float in a transparent row above the panel, where it sat over whatever
// right-aligned content was scrolling underneath. It can't go away entirely: the Focus card that
// offers a cold start only renders in DAYTIME mode, so dropping it left 18 hours of the day (morning
// and night) with no way to start an ad-hoc block at all.
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
    staleErrors,
    adoptFailed,
    retryAdopt,
    startError,
  } = usePomodoro();
  // A failed tasks read only costs the label ("Focus"); the page's own tasks error says it.
  const { data: tasks = [] } = useAllTasks();

  const running = timers.length > 0 || stale.length > 0;
  if (!running && !adoptFailed && !startError) return null;

  return (
    <div className="flex flex-col gap-2 sm:ml-auto sm:w-80">
      {adoptFailed && (
        <Row>
          <LoadError onRetry={retryAdopt}>Couldn’t check for running timers.</LoadError>
        </Row>
      )}
      {startError && (
        <Row>
          <div role="alert">
            <Text size="sm" tone="danger">
              {startError}
            </Text>
          </div>
        </Row>
      )}
      {stale.map((s) => (
        <StaleRow
          key={s.id}
          session={s}
          error={staleErrors[s.id] ?? null}
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
          // A failed stop rejects for callers that act on success; here the row's own error says it.
          onStop={() => void stop(t.session.id, 'completed').catch(() => {})}
        />
      ))}
      {running && <NewFocus onStart={startFocus} onBreak={startBreak} />}
    </div>
  );
}

// The idle cold start, for the capture panel's top row (AppShell passes it in). Deliberately
// icon+word and nothing else — a break from cold is a fringe intent and lives on the daytime Focus
// card; once anything is running, TimerBar's full controls take over and this steps aside.
export function IdleFocus() {
  const { timers, stale, startFocus } = usePomodoro();
  if (timers.length > 0 || stale.length > 0) return null;
  return (
    <Button
      variant="quiet"
      size="sm"
      onClick={() => startFocus()}
      title="Start a 25-minute focus block"
      className="shrink-0 gap-1.5 px-2"
    >
      <TimerIcon size={15} /> Focus
    </Button>
  );
}

function timerLabel(session: PomodoroSession, tasks: Task[]): string {
  if (session.kind === 'break') return 'Break';
  if (session.label) return session.label;
  if (session.taskId) return tasks.find((t) => t.id === session.taskId)?.title ?? 'Focus';
  return 'Focus';
}

function Row({
  done,
  error,
  children,
}: {
  done?: boolean;
  error?: string | null; // the last action on this row failed — said under it
  children: ReactNode;
}) {
  return (
    <div
      className={cx(
        'pointer-events-auto flex flex-col gap-1 rounded-2xl border bg-panel-2 p-1.5 pl-2.5 shadow-[var(--shadow-dock)]',
        error ? 'border-danger' : done ? 'border-gold' : 'border-line',
      )}
    >
      <div className="flex items-center gap-1.5">{children}</div>
      {error && (
        <div role="alert">
          <Text size="xs" tone="danger">
            {error}
          </Text>
        </div>
      )}
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
  const { session, paused, remaining, done, error, syncFailed } = timer;
  const running = !paused && !done;
  return (
    <Row done={done} error={error}>
      <span
        className={cx(
          'h-2 w-2 shrink-0 rounded-full',
          done ? 'bg-gold' : running ? 'animate-pulse bg-teal' : 'bg-ink-subtle',
        )}
      />
      <div className="min-w-0 flex-1 truncate">
        <Text size="sm">{timerLabel(session, tasks)}</Text>
      </div>
      {syncFailed && (
        <span title="The last heartbeats didn’t reach the server — time may not be saved">
          <Text size="xs" tone="gold" className="shrink-0">
            not syncing
          </Text>
        </span>
      )}
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
  error,
  tasks,
  onKeep,
  onDiscard,
}: {
  session: PomodoroSession;
  error: string | null;
  tasks: Task[];
  onKeep: () => void;
  onDiscard: () => void;
}) {
  return (
    <Row error={error}>
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
        className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 py-1 text-ink outline-none focus:border-teal"
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
