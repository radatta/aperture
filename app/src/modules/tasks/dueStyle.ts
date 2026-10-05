import type { DueUrgency } from '@aperture/shared';

// The urgency look for a TIMED task's row (due.ts dueUrgency; due-dates D5 revisited): a gold edge
// inside 6h, a gold fill inside the hour, a red fill once the time has passed. Text keeps its own ink —
// the tints sit under it at the same alpha as the active-row fill, so contrast holds. The edge is an
// important border colour (it must beat the row's own border-line) and the fill an inset shadow, which
// paints over the row's background colour without replacing it. Callers give the row a border
// (transparent when quiet) so a colour change never shifts layout.
const FILL = 'shadow-[inset_0_0_0_100vmax_var(--fill)]';
export function urgencyClass(u: DueUrgency): string {
  switch (u) {
    case 'soon':
      return 'border-gold!';
    case 'imminent':
      return `border-gold! [--fill:var(--gold-soft)] ${FILL}`;
    case 'past':
      return `border-danger! [--fill:var(--danger-soft)] ${FILL}`;
    case 'none':
      return '';
  }
}

// The same signal for a screen reader (colour alone isn't one).
export function urgencyLabel(u: DueUrgency): string | null {
  return u === 'soon'
    ? 'due within 6 hours'
    : u === 'imminent'
      ? 'due within the hour'
      : u === 'past'
        ? 'past due'
        : null;
}
