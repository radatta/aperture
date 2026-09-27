import type { FinanceBucket } from '@aperture/shared';

// The bucket colour as a fill (legend dots, bars). Tags use border + soft fill instead (BucketTag).
export const bucketFillClass: Record<FinanceBucket, string> = {
  parents_pay: 'bg-teal',
  budget: 'bg-gold',
  i_pay: 'bg-ink-muted',
};
