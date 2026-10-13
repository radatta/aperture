import { Button } from '../../components/Button';

// How many sets this session (D42), chosen before Start so nothing needs a tap once it runs: a good day
// can be 3, a rough day 1. Per-exercise prescriptions come with Flux history (the next PR).
export const MIN_SETS = 1;
export const MAX_SETS = 5;

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
