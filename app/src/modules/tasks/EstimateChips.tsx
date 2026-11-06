import { useRef, useState } from 'react';
import type { Task } from '@aperture/shared';
import { Button } from '../../components/Button';
import { Field } from '../../components/Field';
import { Text } from '../../components/Text';
import { cx } from '../../lib/cx';
import { useSetEstimate, useTransitionTask } from '../../data/hooks/useTasks';

const CHIPS = [15, 30, 45, 60, 90, 120];

// Start on an unscoped task: a nudge, not a wall ("I shouldn't, but I should be able to"). A chip lands the
// estimate BEFORE the start, so the lock freezes on it; "Start without one" starts with no lock, and the
// Done form asks in hindsight (docs/areas/calibration/integrity.md). A write that fails keeps this open and
// says so; an estimate that landed before a failed start is simply there on the retry.
export function EstimateChips({
  task,
  onClose,
  className,
}: {
  task: Task;
  onClose: () => void;
  className?: string;
}) {
  const setEstimate = useSetEstimate();
  const transition = useTransitionTask();
  const [custom, setCustom] = useState<string | null>(null);
  // One start per tap, set before the first await (a mutation's isPending arrives a tick late).
  const [busy, setBusy] = useState(false);
  const opener = useRef(document.activeElement as HTMLElement | null); // Cancel gives focus back to Start
  const customOk = custom !== null && custom.trim() !== '' && Number(custom) >= 1;
  const customLow = custom !== null && custom.trim() !== '' && !customOk;

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
            variant="quiet"
            size="sm"
            aria-disabled={busy}
            className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
            onClick={() => void start(m)}
          >
            {m}
          </Button>
        ))}
        <Button
          variant="quiet"
          size="sm"
          aria-expanded={custom !== null}
          onClick={() => setCustom((c) => (c === null ? '' : null))}
        >
          Custom
        </Button>
      </div>
      {custom !== null && (
        <div className="flex flex-wrap items-end gap-2">
          <Field
            label="Estimate (min)"
            type="number"
            min={1}
            inputMode="numeric"
            autoFocus
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            className="w-28"
          />
          <Button
            size="sm"
            disabled={!customOk}
            aria-disabled={busy}
            className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
            onClick={() => void start(Number(custom))}
          >
            Start with this
          </Button>
        </div>
      )}
      {customLow && (
        <Text size="xs" tone="danger">
          Minutes need to be at least 1.
        </Text>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="ghost"
          size="sm"
          aria-disabled={busy}
          className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
          onClick={() => void start(null)}
        >
          Start without one
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            onClose();
            opener.current?.focus();
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
