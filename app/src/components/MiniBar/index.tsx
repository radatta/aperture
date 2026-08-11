import { cx } from '../../lib/cx';
import { miniBar } from './miniBar';

export interface MiniBarProps {
  plannedMin: number;
  availableMin: number;
  className?: string;
}

export function MiniBar({ plannedMin, availableMin, className }: MiniBarProps) {
  const model = miniBar(plannedMin, availableMin);
  return (
    <div
      className={cx(
        'h-2 w-full overflow-hidden rounded-full border border-line bg-surface',
        className,
      )}
      role="progressbar"
      aria-valuenow={Math.round(model.fillPct)}
    >
      <div
        className={cx('h-full rounded-full transition-[width]', model.over ? 'bg-gold' : 'bg-teal')}
        style={{ width: `${model.fillPct}%` }}
      />
    </div>
  );
}
