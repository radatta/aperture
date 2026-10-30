import { useRef } from 'react';
import {
  fmtClock12,
  fmtDuration,
  fmtMonthShortDay,
  hhmmOfEpoch,
  type FluxSet,
} from '@aperture/shared';
import { isExerciseId, getExercise, setMetric, sideLabel } from '@aperture/shared/flux';
import { Button } from '../../components/Button';
import { Text } from '../../components/Text';
import { useDeleteFluxSet } from '../../data/hooks/useFluxSets';
import { useDisclosure } from '../../lib/useDisclosure';
import { focusablesAfter, moveFocus } from './focus';
import { MeasurementBadge } from './ExerciseLibrary';

// One saved set in History: time · exercise · side · its one number · duration. Delete is a soft-delete
// that asks first — the app has no undo — and leaves the Roll rep the set counted toward alone (D53).
// The confirm replaces its trigger, so useDisclosure hands focus back on Cancel or Escape; a deleted row
// hands it to the next row's Delete (else the previous one, else `fallbackFocus` — History's All chip
// when a chip filter is about to vanish — else whatever follows the list).
export function SetRow({
  set,
  fallbackFocus,
}: {
  set: FluxSet;
  fallbackFocus?: () => HTMLElement | null;
}) {
  const { open: confirming, triggerRef, onOpen, onClose } = useDisclosure();
  const rowRef = useRef<HTMLLIElement>(null);
  const del = useDeleteFluxSet();
  const def = isExerciseId(set.exerciseId) ? getExercise(set.exerciseId) : null;
  const name = def?.name ?? set.exerciseId;
  const side = def && set.side ? sideLabel(def, set.side) : null;
  const metric = def ? setMetric(def, set) : null;
  const secs = Math.round(set.durationSec);
  const duration = secs < 60 ? `${secs}s` : fmtDuration(secs / 60);
  const time = fmtClock12(hhmmOfEpoch(set.completedAt));
  const summary =
    def?.kind === 'romReps'
      ? `${set.count} reps${metric ? ` · avg ${metric.value.toFixed(0)}°` : ''}`
      : def?.kind === 'reposition'
        ? `${set.count} trials${metric ? ` · ${metric.value.toFixed(1)}° error` : ''}`
        : def?.kind === 'oscillation'
          ? `${set.count} cycles`
          : `${set.count} ${def?.kind === 'holdAtTarget' ? 'holds' : 'reps'}`;

  return (
    <li
      ref={rowRef}
      data-flux-set=""
      className="flex flex-col gap-2 border-b border-line py-3 last:border-b-0"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Text size="sm" weight="medium">
              {name}
            </Text>
            {def && <MeasurementBadge ex={def} />}
          </div>
          {/* The side leads the second line, so a long name never pushes rows out of step. */}
          <Text size="xs" tone="muted" tabular>
            {side && (
              <>
                <Text size="xs" weight="medium">
                  {side}
                </Text>
                {' · '}
              </>
            )}
            {time} · {summary} · {duration}
            {set.repTaskId ? ' · Roll rep' : ''}
          </Text>
        </div>
        {!confirming && (
          <Button
            ref={triggerRef}
            variant="quiet"
            size="sm"
            data-flux-delete=""
            aria-label={`Delete ${name} set from ${fmtMonthShortDay(set.day)}, ${time}`}
            onClick={onOpen}
          >
            Delete
          </Button>
        )}
      </div>
      {confirming && (
        <div
          role="alertdialog"
          aria-label={`Delete this ${name} set?`}
          className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-3"
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            onClose();
          }}
        >
          <Text size="sm" tone="muted">
            Remove this set from your history?{' '}
            {set.repTaskId ? 'The Roll rep it counted toward isn’t affected.' : ''}
          </Text>
          <div className="flex gap-2">
            <Button
              autoFocus
              variant="gold"
              size="sm"
              disabled={del.isPending}
              onClick={() => {
                const row = rowRef.current;
                const targets = focusAfterDelete(row, fallbackFocus);
                // Awaited, not a per-call onSuccess (TanStack drops those once the row unmounts).
                del.mutateAsync(set.id).then(
                  () => moveFocus(targets, row),
                  () => undefined, // shown below (del.isError)
                );
              }}
            >
              Delete
            </Button>
            <Button variant="quiet" size="sm" onClick={onClose}>
              Cancel
            </Button>
          </div>
          <div role="alert">
            {del.isError && (
              <Text size="xs" tone="danger">
                Couldn&apos;t delete that — check your connection and try again.
              </Text>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

function focusAfterDelete(
  row: HTMLLIElement | null,
  fallback?: () => HTMLElement | null,
): (HTMLElement | null)[] {
  if (!row) return [];
  // Rows with their own confirm open have no Delete trigger — skip them (their confirm's Delete is one
  // Enter from a second deletion).
  const rows = [...document.querySelectorAll<HTMLElement>('[data-flux-set]')];
  const i = rows.indexOf(row);
  const trigger = (r: HTMLElement | undefined) =>
    r?.querySelector<HTMLElement>('[data-flux-delete]') ?? null;
  const after =
    rows
      .slice(i + 1)
      .map(trigger)
      .find(Boolean) ?? null;
  const before = rows.slice(0, i).reverse().map(trigger).find(Boolean) ?? null;
  return [after, before, fallback?.() ?? null, ...focusablesAfter(row)];
}
