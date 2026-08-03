import { cx } from '../../lib/cx';
import { fmtClock } from '../../lib/format';
import { Text } from '../Text';

export interface TimerPillProps {
  seconds: number;
  running?: boolean;
  label?: string;
}

// The persistent pomodoro pill (follows you across views in Phase 6). Presentational here.
export function TimerPill({ seconds, running = false, label }: TimerPillProps) {
  return (
    <div
      className={cx(
        'inline-flex items-center gap-2 rounded-full border px-3 py-1.5',
        running ? 'border-teal bg-teal-soft' : 'border-line bg-panel',
      )}
    >
      <span
        className={cx('h-2 w-2 rounded-full', running ? 'animate-pulse bg-teal' : 'bg-ink-subtle')}
      />
      <Text size="sm" tabular>
        {fmtClock(seconds)}
      </Text>
      {label && (
        <Text size="xs" tone="muted">
          {label}
        </Text>
      )}
    </div>
  );
}
