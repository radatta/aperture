import { FINANCE_BUCKET_LABELS } from '@aperture/shared';
import type { FinanceBucket } from '@aperture/shared';
import { cx } from '../../lib/cx';
import { bucketToneClass } from './bucketStyles';

export function BucketTag({ bucket }: { bucket: FinanceBucket | null }) {
  return (
    <span
      className={cx(
        'inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs',
        bucket ? bucketToneClass[bucket] : 'border-dashed border-line-strong text-ink-muted',
      )}
    >
      {bucket ? FINANCE_BUCKET_LABELS[bucket] : 'Unsorted'}
    </span>
  );
}
