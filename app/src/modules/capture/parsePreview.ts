import { fmtDueDay, fmtDuration } from '@aperture/shared';
import type { BulkLine, CreateTaskInput, ParseTaskResult } from '@aperture/shared';

type Parsed = Extract<ParseTaskResult, { ok: true }>;

// A parse result as a BulkLine, so the preview reads back through the same TaskTokenChips as the
// grammar. What the model returned but the server would reject arrives as yellow warnings.
export function previewLine(r: Parsed): BulkLine {
  const i = r.input;
  return {
    line: 1,
    raw: '',
    title: i.title,
    estimateMin: i.estimateMin ?? null,
    categoryLabel: r.categoryLabel,
    categoryId: i.categoryId ?? null,
    dueDay: i.dueDay ?? null,
    dueTime: i.dueTime ?? null,
    notes: i.notes ?? null,
    placeSlug: i.place ?? null,
    place: i.place ?? null,
    errors: [],
    errorKinds: [],
    warnings: r.dropped,
  };
}

// The one-line readback of what a quick add saved — "fix login bug · Aperture · @Grocer · due Fri · 30m ·
// +notes".
// `today` is the server's (the day "tmw" was resolved against), so the phrasing matches the parse;
// `dayStartHour` reads tomorrow's small hours as tonight's.
export function savedSummary(
  input: CreateTaskInput,
  categoryLabel: string | null,
  today: string,
  dropped: readonly string[] = [],
  dayStartHour?: number,
  placeName?: string | null,
): string {
  return [
    input.title,
    categoryLabel ?? 'no category',
    placeName ? `@${placeName}` : null,
    input.dueDay ? fmtDueDay(input.dueDay, today, input.dueTime, { dayStartHour }) : null,
    input.estimateMin ? fmtDuration(input.estimateMin) : null,
    input.notes ? '+notes' : null,
    ...dropped,
  ]
    .filter(Boolean)
    .join(' · ');
}
