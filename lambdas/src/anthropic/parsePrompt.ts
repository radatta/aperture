import { fmtWeekday, PARSE_TITLE_MAX } from '@aperture/shared';
import type { ParseCategory } from '@aperture/shared';

// Quick add's one prompt — the BFF owns it, for the app and Raycast alike (tools/raycast/aperture-add.sh
// calls the parse_task MCP tool). Pure, so a snapshot pins the exact wording sent to the model.

export const PARSE_MODEL = 'claude-haiku-5-5';

export function parseSystemPrompt(today: string, categories: readonly ParseCategory[]): string {
  const cats = categories.length
    ? categories.map((c) => `${c.id}: ${c.label}`).join('\n')
    : '(none — categoryId must be null)';
  return `You turn one quick-capture line into fields for a task tracker. Today is ${today} (${fmtWeekday(today)}) in America/Los_Angeles.
Categories (id: label) — use the id, or null if none clearly matches:
${cats}
Rules:
- title: short and imperative-ish, at most ${PARSE_TITLE_MAX} characters, in the user's own words. Strip the parsed meta: a leading category word ("aperture,"), due phrases ("due tmw", "by friday") and estimates ("30m", "2h").
- notes: if the line has more detail than fits the title, move the rest here with light cleanup only (fix obvious typos, keep the user's wording and order). Otherwise null.
- dueDay: YYYY-MM-DD, only if the user gave a day ("tmw" = tomorrow, a weekday name = the next such day, "today" = today), or today if they gave only a clock time. Otherwise null.
- dueTime: HH:MM 24h, only if a clock time was given (a time with no day means today). Otherwise null.
- estimateMin: whole minutes, only if the user gave an estimate. Never invent one. Otherwise null.
- Set a field only when the user stated it. Do not add tasks, advice or commentary.`;
}

// Structured outputs can't carry numeric, length or calendar constraints — validateParsedTask checks those.
export function parseOutputSchema(categoryIds: readonly string[]): Record<string, unknown> {
  const nullable = (s: Record<string, unknown>) => ({ anyOf: [s, { type: 'null' }] });
  return {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'notes', 'categoryId', 'dueDay', 'dueTime', 'estimateMin'],
    properties: {
      title: { type: 'string' },
      notes: nullable({ type: 'string' }),
      categoryId: categoryIds.length
        ? nullable({ type: 'string', enum: [...categoryIds] })
        : { type: 'null' },
      dueDay: nullable({ type: 'string', format: 'date' }),
      dueTime: nullable({ type: 'string', description: 'HH:MM, 24h' }),
      estimateMin: nullable({ type: 'integer' }),
    },
  };
}
