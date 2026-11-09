import type { DueUrgency } from '@aperture/shared';

// The urgency look for a TIMED task's row (due.ts dueUrgency; due-dates D5 revisited): a gold edge
// inside 6h, an amber fill inside the hour, a red fill once the time has passed. The fills are their own
// tokens (tokens.css --due-*-fill), and every text on them keeps 4.5:1 (tokens.test.ts): ink and ink-muted
// as they are, ink-subtle lifted to ink-muted (3.7:1 under a light fill otherwise), and teal / gold / danger
// re-pointed to their --*-on-fill shades for the row and everything in it (the light accents dip to 3.9:1
// under a fill otherwise). The edge is an important border colour (it must beat the row's own
// border-line) and the fill an inset shadow, which paints over the row's background colour without
// replacing it. Callers give the row a border (transparent when quiet) so a colour change never shifts
// layout.
const FILLED =
  'shadow-[inset_0_0_0_100vmax_var(--fill)] [&_.text-ink-subtle]:text-ink-muted ' +
  '[--teal:var(--teal-on-fill)] [--gold:var(--gold-on-fill)] [--danger:var(--danger-on-fill)]';
export function urgencyClass(u: DueUrgency): string {
  switch (u) {
    case 'soon':
      return 'border-gold!';
    case 'imminent':
      return `border-gold! [--fill:var(--due-imminent-fill)] ${FILLED}`;
    case 'past':
      return `border-danger! [--fill:var(--due-past-fill)] ${FILLED}`;
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
