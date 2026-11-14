import { useState } from 'react';
import type { RefObject } from 'react';
import type { Task } from '@aperture/shared';
import { Button } from '../../components/Button';
import { Field } from '../../components/Field';
import { Text } from '../../components/Text';
import { cx } from '../../lib/cx';
import { useSetEstimate, useTransitionTask } from '../../data/hooks/useTasks';
import { typedBadMinutes, WHOLE_MINUTES_ERROR, wholeMinutes } from './taskMath';

const CHIPS = [15, 30, 45, 60, 90, 120];
const BUSY = 'aria-disabled:pointer-events-none aria-disabled:opacity-50';

// Start on an unscoped task: a nudge, not a wall (discouraged, never blocked). A chip lands the
// estimate BEFORE the start, so the lock freezes on it; "Start without one" starts with no lock, and the
// Done form asks in hindsight (docs/areas/calibration/integrity.md). A write that fails keeps this open and
// says so; an estimate that landed before a failed start is simply there on the retry.
export function EstimateChips({
  task,
  onClose,
  startRef,
  className,
}: {
  task: Task;
  onClose: () => void;
  startRef: RefObject<HTMLButtonElement | null>; // the Start that opened this: Cancel gives focus back
  className?: string;
}) {
  const setEstimate = useSetEstimate();
  const transition = useTransitionTask();
  const [custom, setCustom] = useState<string | null>(null);
  // One start per tap, set before the first await (a mutation's isPending arrives a tick late).
  const [busy, setBusy] = useState(false);
  const customOk = custom !== null && wholeMinutes(custom);

  async function start(estimateMin: number | null) {
    if (busy) return;
    setBusy(true);
    try {
      if (estimateMin !== null)
        await setEstimate.mutateAsync({ id: task.id, estimateMin, bufferMin: task.bufferMin });
      await transition.mutateAsync({ id: task.id, to: 'in_progress' });
      onClose();
    } catch {
      // Said below.
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="group"
      aria-label={`Estimate for ${task.title}`}
      data-row-control
      className={cx('flex flex-col gap-2', className)}
    >
      <Text size="xs" tone="muted">
        How long will it take? (minutes)
      </Text>
      <div className="flex flex-wrap items-center gap-1.5">
        {CHIPS.map((m) => (
          <Button
            key={m}
            variant="ghost"
            size="sm"
            aria-disabled={busy}
            className={BUSY}
            onClick={() => void start(m)}
          >
            {m}
          </Button>
        ))}
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={custom !== null}
          className={cx(BUSY, custom !== null && 'border-teal')}
          onClick={() => setCustom((c) => (c === null ? '' : null))}
        >
          Custom
        </Button>
      </div>
      {custom !== null && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (customOk) void start(Number(custom));
          }}
        >
          <Field
            label="Estimate (min)"
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            autoFocus
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            className="w-28"
          />
          <Button
            type="submit"
            size="sm"
            disabled={!customOk}
            aria-disabled={busy}
            className={BUSY}
          >
            Start with this
          </Button>
        </form>
      )}
      {custom !== null && typedBadMinutes(custom) && (
        <Text size="xs" tone="danger">
          {WHOLE_MINUTES_ERROR}
        </Text>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="quiet"
          size="sm"
          aria-disabled={busy}
          className={BUSY}
          onClick={() => void start(null)}
        >
          Start without one
        </Button>
        {/* Not mid-write: the start would land after it, and a failure would have nowhere to show. */}
        <Button
          variant="quiet"
          size="sm"
          aria-disabled={busy}
          className={BUSY}
          onClick={() => {
            onClose();
            startRef.current?.focus();
          }}
        >
          Cancel
        </Button>
      </div>
      {(setEstimate.isError || transition.isError) && (
        <div role="alert">
          <Text size="xs" tone="danger">
            Couldn’t start it — try again.
          </Text>
        </div>
      )}
    </div>
  );
}
