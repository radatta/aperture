import { cx } from '../../lib/cx';
import { fmtDuration } from '../../lib/format';
import { Text } from '../Text';
import { deltaBar } from './deltaBar';
import { statDelta } from './stat';

export interface DeltaBarProps {
  estimateMin: number;
  actualMin: number;
  label?: string; // the task title, when the bar stands alone in a list
  className?: string;
}

// Estimate vs actual, drawn. The bar runs to whichever was longer; the estimate mark is where it
// was supposed to stop. Overrun spills past the mark in gold — evidence, not an alarm (PRODUCT
// forbids anything that reads as a scold, which is why over is warm gold and never red).
export function DeltaBar({ estimateMin, actualMin, label, className }: DeltaBarProps) {
  const m = deltaBar(estimateMin, actualMin);
  const delta = statDelta(estimateMin, actualMin);

  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      {label && (
        <Text size="sm" tone="muted" className="truncate">
          {label}
        </Text>
      )}

      <div
        className="relative h-2.5 w-full overflow-hidden rounded-full bg-surface"
        role="img"
        aria-label={`${fmtDuration(actualMin)} actual against ${fmtDuration(estimateMin)} estimated`}
      >
        {/* the run up to the estimate */}
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-teal transition-[width]"
          style={{ width: `${Math.min(m.actualPct, m.estimatePct)}%` }}
        />
        {/* the overrun, past where it should have stopped */}
        {m.overhangPct > 0 && (
          <div
            className="absolute inset-y-0 bg-gold transition-[width]"
            style={{ left: `${m.estimatePct}%`, width: `${m.overhangPct}%` }}
          />
        )}
        {/* the estimate mark — only meaningful when the actual ran past or short of it */}
        <div
          className="absolute inset-y-0 w-px bg-ink"
          style={{ left: `${m.estimatePct}%`, opacity: m.estimatePct >= 99.5 ? 0 : 0.55 }}
        />
      </div>

      <div className="flex items-baseline gap-2">
        <Text size="sm" weight="medium" tabular>
          {fmtDuration(actualMin)}
        </Text>
        <Text size="xs" tone="subtle" tabular>
          {fmtDuration(estimateMin)} est
        </Text>
        {/* The word carries the direction, so the number is unsigned — "-20% under" was saying it
            twice, and contradicting itself on the second reading. */}
        {delta && (
          <Text size="xs" tone={delta.over ? 'gold' : 'teal'} tabular className="ml-auto">
            {delta.over ? '+' : ''}
            {Math.abs(delta.pct)}%{' '}
            <Text size="xs" tone="muted">
              {delta.over ? 'over' : delta.pct === 0 ? '' : 'under'}
            </Text>
          </Text>
        )}
      </div>
    </div>
  );
}
