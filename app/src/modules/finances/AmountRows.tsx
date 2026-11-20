import type { ReactNode } from 'react';
import { Text } from '../../components/Text';
import { cx } from '../../lib/cx';

// The pieces both amount editors share (a charge split across buckets, a refund across charges): a
// dollars field and the running remainder under the rows.

// 16px (text-base): iOS Safari zooms into a smaller field on focus (fieldSize.test.ts).
export function MoneyInput({
  label,
  value,
  onChange,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
}) {
  return (
    <span className="flex items-center gap-1">
      <span aria-hidden className="text-ink-muted">
        $
      </span>
      <input
        type="text"
        inputMode="decimal"
        aria-label={label}
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        className="w-24 rounded-xl border border-line bg-surface px-2 py-1 text-right text-base text-ink tabular-nums outline-none focus:border-teal"
      />
    </span>
  );
}

// Always mounted: a live region announces text that changes in it, not a region that appears.
export function Remainder({ children, tone }: { children: ReactNode; tone: 'muted' | 'danger' }) {
  return (
    <div role="status">
      <Text size="sm" tone={tone} className={cx(tone === 'muted' && 'tabular-nums')}>
        {children}
      </Text>
    </div>
  );
}
