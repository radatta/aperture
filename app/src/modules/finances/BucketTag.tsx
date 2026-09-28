import { FINANCE_BUCKET_LABELS } from '@aperture/shared';
import type { FinanceBucket } from '@aperture/shared';
import { cx } from '../../lib/cx';

// Text is always `ink`/`ink-muted` (content tiers); the colour rides the border + soft fill only, so
// the label never depends on a tint for contrast. Unsorted is dashed `ink-muted`, never `ink-subtle`.
const toneClass: Record<FinanceBucket, string> = {
  parents_pay: 'border-teal bg-teal-soft text-ink',
  budget: 'border-gold bg-gold-soft text-ink',
  i_pay: 'border-line-strong bg-panel-2 text-ink',
};

export function BucketTag({ bucket }: { bucket: FinanceBucket | null }) {
  return (
    <span
      className={cx(
        'inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs',
        bucket ? toneClass[bucket] : 'border-dashed border-line-strong text-ink-muted',
      )}
    >
      {bucket ? FINANCE_BUCKET_LABELS[bucket] : 'Unsorted'}
    </span>
  );
}
