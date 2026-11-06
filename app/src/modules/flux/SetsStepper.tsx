import { FLUX_MAX_SETS, FLUX_MIN_SETS } from '@aperture/shared/flux';
import { Button } from '../../components/Button';

// How many sets this session (D42), chosen before Start so nothing needs a tap once it runs: a good day
// can be 3, a rough day 1. It opens at the count this exercise was last started with (Settings
// `fluxSets`, written on Start — D61), else 2.
export const MIN_SETS = FLUX_MIN_SETS;
export const MAX_SETS = FLUX_MAX_SETS;

export function SetsStepper({
  value,
  onChange,
}: {
  value: number;
  onChange: (sets: number) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Sets this session"
      className="inline-flex items-center rounded-xl border border-line bg-surface p-0.5"
    >
      <Button
        variant="quiet"
        size="sm"
        aria-label="Fewer sets"
        disabled={value <= MIN_SETS}
        onClick={() => onChange(value - 1)}
      >
        −
      </Button>
      <span className="min-w-[4.5rem] text-center text-sm text-ink tabular-nums" aria-live="polite">
        {value} {value === 1 ? 'set' : 'sets'}
      </span>
      <Button
        variant="quiet"
        size="sm"
        aria-label="More sets"
        disabled={value >= MAX_SETS}
        onClick={() => onChange(value + 1)}
      >
        +
      </Button>
    </div>
  );
}
