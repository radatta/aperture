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
    errors: [],
    errorKinds: [],
    warnings: r.dropped,
  };
}

// The one-line readback of what a quick add saved — "fix login bug · Aperture · due Fri · 30m · +notes".
// `today` is the server's (the day "tmw" was resolved against), so the phrasing matches the parse.
export function savedSummary(
  input: CreateTaskInput,
  categoryLabel: string | null,
  today: string,
  dropped: readonly string[] = [],
): string {
  return [
    input.title,
    categoryLabel ?? 'no category',
    input.dueDay ? fmtDueDay(input.dueDay, today, input.dueTime) : null,
    input.estimateMin ? fmtDuration(input.estimateMin) : null,
    input.notes ? '+notes' : null,
    ...dropped,
  ]
    .filter(Boolean)
    .join(' · ');
}
