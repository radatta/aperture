import { fmtClock12, fmtDuration, hhmmOfEpoch, type FluxSet } from '@aperture/shared';
import { isExerciseId, getExercise, setMetric, sideLabel } from '@aperture/shared/flux';
import { Button } from '../../components/Button';
import { Text } from '../../components/Text';
import { useDeleteFluxSet } from '../../data/hooks/useFluxSets';
import { useDisclosure } from '../../lib/useDisclosure';
import { MeasurementBadge } from './ExerciseLibrary';

// One saved set in History: time · exercise · side · its one number · duration. Delete is a soft-delete
// that asks first — the app has no undo — and leaves the Roll rep the set counted toward alone (D53).
// The confirm replaces its trigger, so useDisclosure hands focus back on Cancel or Escape.
export function SetRow({ set }: { set: FluxSet }) {
  const { open: confirming, triggerRef, onOpen, onClose } = useDisclosure();
  const del = useDeleteFluxSet();
  const def = isExerciseId(set.exerciseId) ? getExercise(set.exerciseId) : null;
  const name = def?.name ?? set.exerciseId;
  const side = def && set.side ? sideLabel(def, set.side) : null;
  const metric = def ? setMetric(def, set) : null;
  const secs = Math.round(set.durationSec);
  const duration = secs < 60 ? `${secs}s` : fmtDuration(secs / 60);
  const summary =
    def?.kind === 'romReps'
      ? `${set.count} reps${metric ? ` · avg ${metric.value.toFixed(0)}°` : ''}`
      : def?.kind === 'reposition'
        ? `${set.count} trials${metric ? ` · ${metric.value.toFixed(1)}° error` : ''}`
        : def?.kind === 'oscillation'
          ? `${set.count} cycles`
          : `${set.count} ${def?.kind === 'holdAtTarget' ? 'holds' : 'reps'}`;

  return (
    <li className="flex flex-col gap-2 border-b border-line py-3 last:border-b-0">
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
            {fmtClock12(hhmmOfEpoch(set.completedAt))} · {summary} · {duration}
            {set.repTaskId ? ' · Roll rep' : ''}
          </Text>
        </div>
        {!confirming && (
          <Button
            ref={triggerRef}
            variant="quiet"
            size="sm"
            aria-label={`Delete ${name} set`}
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
              onClick={() => del.mutate(set.id)}
            >
              Delete
            </Button>
            <Button variant="quiet" size="sm" onClick={onClose}>
              Cancel
            </Button>
          </div>
          {del.isError && (
            <Text size="xs" tone="danger">
              Couldn&apos;t delete that — check your connection and try again.
            </Text>
          )}
        </div>
      )}
    </li>
  );
}
