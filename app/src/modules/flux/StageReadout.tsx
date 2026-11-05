import type { ExerciseDefinition, ExerciseState } from '@aperture/shared/flux';
import { cx } from '../../lib/cx';
import { HoldRing } from './HoldRing';
import { liveReadout, restLine, type RestInfo } from './readout';

// The set's live numbers on the video itself, so the count and hold timer are readable mid-set without
// scrolling to the panel (D29). Right-hand column under the voice button: clear of the face, the
// tracking pill, the cue toast and the Calibrate / Stop row. Never takes taps. Between sets the note is
// the rest's countdown (D42) — the finished set's count stays above it.
export function StageReadout({
  def,
  state,
  rest = null,
}: {
  def: ExerciseDefinition;
  state: ExerciseState | null;
  rest?: RestInfo | null;
}) {
  const r = liveReadout(def, state);
  if (!r) return null;
  const note = r.note ?? (rest && restLine(rest));
  return (
    <section
      aria-label="Live readout"
      className="pointer-events-none absolute top-14 right-3 flex flex-col items-end gap-2"
    >
      {r.count && (
        <div className="rounded-xl bg-surface/85 px-3 py-1.5 text-right">
          <span
            className={cx('text-3xl font-semibold tabular-nums', r.done ? 'text-gold' : 'text-ink')}
          >
            {r.count.n}
          </span>
          <span className="ml-1 text-xs text-ink-muted">
            {r.count.of !== undefined ? `/ ${r.count.of} ` : ''}
            {r.count.unit}
          </span>
        </div>
      )}
      {r.ring && (
        <div className="rounded-full bg-surface/85 p-1">
          <HoldRing {...r.ring} small />
        </div>
      )}
      {note && (
        <span className="rounded-full bg-surface/85 px-2.5 py-1 text-xs text-ink tabular-nums">
          {note}
        </span>
      )}
    </section>
  );
}
