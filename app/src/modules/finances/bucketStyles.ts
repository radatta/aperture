import type { FinanceBucket, FinanceSpendBucket } from '@aperture/shared';

// The bucket colour as a fill (legend dots, bars). Tags use border + soft fill instead (BucketTag).
export const bucketFillClass: Record<FinanceSpendBucket, string> = {
  parents_pay: 'bg-teal',
  budget: 'bg-gold',
  i_pay: 'bg-ink-muted',
};

// Text is always `ink`/`ink-muted` (content tiers); the colour rides the border + soft fill only, so
// the label never depends on a tint for contrast. Unsorted is dashed `ink-muted`, never `ink-subtle`;
// Not spending is a plain solid border with muted text — sorted, but out of every total.
export const bucketToneClass: Record<FinanceBucket, string> = {
  parents_pay: 'border-teal bg-teal-soft text-ink',
  budget: 'border-gold bg-gold-soft text-ink',
  i_pay: 'border-line-strong bg-panel-2 text-ink',
  not_spending: 'border-line text-ink-muted',
};
