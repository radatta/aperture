import { FINANCE_BUCKET_LABELS } from '@aperture/shared';
import type { FinanceBucket } from '@aperture/shared';
import { cx } from '../../lib/cx';
import { bucketToneClass } from './bucketStyles';

// `split`: the row's money lands in more than one bucket (a split charge, or a refund on one or across
// charges) — a neutral "Split" tag; the row's meta line names the parts.
export function BucketTag({ bucket, split }: { bucket: FinanceBucket | null; split?: boolean }) {
  return (
    <span
      className={cx(
        'inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs',
        split
          ? 'border-line-strong text-ink'
          : bucket
            ? bucketToneClass[bucket]
            : 'border-dashed border-line-strong text-ink-muted',
      )}
    >
      {split ? 'Split' : bucket ? FINANCE_BUCKET_LABELS[bucket] : 'Unsorted'}
    </span>
  );
}
