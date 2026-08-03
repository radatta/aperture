import { Button } from '../../components/Button';
import { Text } from '../../components/Text';
import { TimerPill } from '../../components/TimerPill';
import { useAllTasks } from '../../data/hooks/useTasks';
import { usePomodoro } from './pomodoro-context';

// The persistent pomodoro UI — fixed above the capture bar, follows you across every view (pomodoro
// is not a route). Shows the stale keep/discard prompt, or the running timer with pause/stop.
export function TimerBar() {
  const { session, paused, stale, remaining, pause, resume, stop, keepStale, discardStale } =
    usePomodoro();
  const { data: tasks = [] } = useAllTasks();

  if (stale) {
    return (
      <Dock>
        <Text size="sm" tone="muted">
          Timer was left running.
        </Text>
        <Button size="sm" onClick={keepStale}>
          Keep
        </Button>
        <Button variant="ghost" size="sm" onClick={discardStale}>
          Discard
        </Button>
      </Dock>
    );
  }

  if (!session) return null;

  const label =
    session.kind === 'break'
      ? 'Break'
      : session.taskId
        ? (tasks.find((t) => t.id === session.taskId)?.title ?? 'Focus')
        : 'Focus';

  return (
    <Dock>
      <div className="max-w-[10rem] truncate">
        <TimerPill seconds={remaining} running={!paused} label={label} />
      </div>
      {paused ? (
        <Button size="sm" onClick={resume}>
          Resume
        </Button>
      ) : (
        <Button variant="ghost" size="sm" onClick={pause}>
          Pause
        </Button>
      )}
      <Button variant="ghost" size="sm" onClick={() => stop('completed')}>
        Stop
      </Button>
    </Dock>
  );
}

function Dock({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed bottom-24 right-4 z-30 flex items-center gap-2 rounded-full border border-line bg-panel-2 p-2 shadow-lg">
      {children}
    </div>
  );
}
