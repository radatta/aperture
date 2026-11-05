import { useEffect, useRef } from 'react';
import { Link } from 'react-router';
import { Button } from '../../components/Button';
import { CheckCircleIcon } from '../../components/icons';
import { Text } from '../../components/Text';
import { usePickRollToday } from '../../data/hooks/useRolls';
import { revealFocus } from '../../lib/focus';
import { fmtDuration } from '../../lib/format';
import { liveElapsedMin } from '../home/rightNow';
import { usePomodoro } from '../pomodoro/pomodoro-context';
import { DoneForm } from '../tasks/DoneForm';
import { prefillMinutes } from './repState';
import type { RepTieHandle } from './useRepTie';

// The Roll tie on the exercise stage. The first set a session saves (finished or stopped early — D55) starts today’s rep
// (planned|backlog → in_progress — there's no planned → done); Stop offers the DoneForm prefilled
// with the session's minutes. Nothing auto-completes, and every write failure shows inline.

// `activeMs` is the running session's active time: a rep this session started has no focus-timer
// minutes, so the strip shows whichever is more (the same rule as the DoneForm prefill).
export function RepTieStrip({ handle, activeMs }: { handle: RepTieHandle; activeMs: number }) {
  const { tie, day, doneMin, error, closeDone, loading, loadError } = handle;
  const pick = usePickRollToday();
  const { timers } = usePomodoro();
  const stripRef = useRef<HTMLDivElement>(null);
  const showDone = doneMin !== null && tie.kind === 'in_progress';
  const message = error ?? (pick.isError ? 'Couldn’t pick the rep — try again.' : null);

  // Stop unmounts the button that was focused; hand focus to the strip (not the Actual field — opening
  // it shouldn't raise the iOS keyboard, task-editor.md).
  useEffect(() => {
    if (showDone) revealFocus(stripRef.current);
  }, [showDone]);

  if (loadError)
    return (
      <p role="alert" className="text-sm text-danger">
        Couldn&apos;t load your Roll — check your connection. Sets still count on this screen.
      </p>
    );
  if (loading || tie.kind === 'unlinked') return null;
  const { roll } = tie;

  return (
    <div
      ref={stripRef}
      tabIndex={-1}
      aria-label={`${roll.name} rep`}
      className="flex flex-col gap-2 rounded-xl border border-line bg-panel px-3 py-2.5 outline-none"
    >
      {tie.kind === 'none' && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Text size="sm" tone="muted">
            Sessions count toward {roll.name}.
          </Text>
          <Button
            size="sm"
            variant="ghost"
            aria-disabled={pick.isPending || undefined}
            onClick={() => !pick.isPending && pick.mutate({ rollId: roll.id, day })}
          >
            Pick {roll.name} for today
          </Button>
        </div>
      )}
      {tie.kind === 'ready' && (
        <Text size="sm">
          Today&apos;s {roll.name} rep
          <Text size="sm" tone="muted">
            {' '}
            · your first set starts it
          </Text>
        </Text>
      )}
      {tie.kind === 'in_progress' && (
        <Text size="sm" tabular>
          {roll.name} rep in progress
          <Text size="sm" tone="muted">
            {' '}
            · {fmtDuration(prefillMinutes(activeMs, liveElapsedMin(tie.task, timers)))}
            {tie.task.estimateMin != null && ` of ${fmtDuration(tie.task.estimateMin)}`}
          </Text>
        </Text>
      )}
      {tie.kind === 'done' && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Text size="sm" className="inline-flex items-center gap-1.5">
            <CheckCircleIcon className="text-gold" /> {roll.name} rep done today
          </Text>
          <Button
            size="sm"
            variant="quiet"
            aria-disabled={pick.isPending || undefined}
            onClick={() => !pick.isPending && pick.mutate({ rollId: roll.id, day })}
          >
            Pick again
          </Button>
        </div>
      )}
      {showDone && (
        <div>
          <Text size="sm" weight="medium">
            Log today&apos;s {roll.name} rep
          </Text>
          <DoneForm task={tie.task} initialActualMin={doneMin} onDone={closeDone} />
        </div>
      )}
      {message && (
        <p role="alert" className="text-sm text-danger">
          {message}
        </p>
      )}
    </div>
  );
}

// The library's one line when no Roll is linked yet. A plain inline link, not a ButtonLink: the sentence
// wraps as prose at phone width, and the full stop sits flush against it.
export function UnlinkedRollNote() {
  return (
    <Text as="p" size="sm" tone="muted">
      Flux sessions can count as a Roll&apos;s daily rep —{' '}
      <Link to="/settings#flux" className="text-teal underline underline-offset-2">
        link one in Settings
      </Link>
      .
    </Text>
  );
}
