import { cx } from '../../lib/cx';
import type { LensId } from './query';

const LENSES: { id: LensId; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'Week' },
  { id: 'backlog', label: 'Backlog' },
  { id: 'done', label: 'Done' },
  { id: 'recurring', label: 'Recurring' },
  { id: 'calibration', label: 'Calibration' },
];

// The /tasks views as one pill row. It scrolls sideways at phone width (AppNav's precedent) — the
// last pill peeking past the edge is the "there's more" cue. Counts only on Today and Week: those are
// the two you plan against; a backlog count would be a tally to feel bad about.
export function LensStrip({
  lens,
  counts,
  onChange,
}: {
  lens: LensId;
  counts: { today: number; week: number };
  onChange: (lens: LensId) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Tasks view"
      className="no-scrollbar -mx-5 flex gap-1.5 overflow-x-auto px-5"
    >
      {LENSES.map(({ id, label }) => {
        const on = id === lens;
        const n = id === 'today' ? counts.today : id === 'week' ? counts.week : 0;
        return (
          <button
            key={id}
            type="button"
            aria-pressed={on}
            // Spelled out: the name computed across the text + span drops the space before "·".
            aria-label={n > 0 ? `${label} · ${n}` : undefined}
            onClick={() => onChange(id)}
            className={cx(
              'shrink-0 whitespace-nowrap rounded-full border px-3 py-1 text-sm transition',
              on
                ? 'border-teal bg-teal-soft font-medium text-ink'
                : 'border-line text-ink-muted hover:text-ink',
            )}
          >
            {label}
            {n > 0 && <span className="tabular-nums text-ink-muted"> · {n}</span>}
          </button>
        );
      })}
    </div>
  );
}
