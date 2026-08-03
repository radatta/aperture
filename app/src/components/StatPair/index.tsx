import { fmtDuration } from '../../lib/format';
import { Text } from '../Text';
import { statDelta } from './stat';

export interface StatPairProps {
  estimateMin: number;
  actualMin: number;
}

// Reads as evidence, not judgment: the actual leads, the estimate sits quiet beside it, and the
// delta is a gold nudge when over (never red/alarming).
export function StatPair({ estimateMin, actualMin }: StatPairProps) {
  const delta = statDelta(estimateMin, actualMin);
  return (
    <div className="flex items-baseline gap-3">
      <Text size="xl" tabular>
        {fmtDuration(actualMin)}
      </Text>
      <Text size="sm" tone="muted" tabular>
        {fmtDuration(estimateMin)} est
      </Text>
      {delta && (
        <Text size="sm" tone={delta.over ? 'gold' : 'teal'} tabular>
          {delta.pct > 0 ? '+' : ''}
          {delta.pct}%
        </Text>
      )}
    </div>
  );
}
