import { fmtWeekday, PARSE_TITLE_MAX } from '@aperture/shared';
import type { ParseCategory } from '@aperture/shared';

// Quick add's one prompt — the BFF owns it, for the app and Raycast alike (tools/raycast/aperture-add.sh
// calls the parse_task MCP tool). Pure, so a snapshot pins the exact wording sent to the model.

export const PARSE_MODEL = 'claude-haiku-5-5';

// A spoken line (voice capture, capture.md) adds VOICE_RULES: the server reads the time from the words
// (spokenTime.ts), so the model only strips them from the title and leaves dueTime null.
const VOICE_RULES = `
The line was spoken, not typed:
- Also remove from the title any spoken time ("at 5", "five o'clock", "at 8 tonight", "in 20 minutes", "in an hour", "tonight", "this morning", "tomorrow morning") and a leading "remind me to" or "remind me". The server works out the time itself: dueTime is always null.
- dueDay: only for a day the user said ("tomorrow", "friday", "next monday"). A spoken time alone, "today", "tonight" or "this morning" is not a day: null.`;

export function parseSystemPrompt(
  today: string,
  categories: readonly ParseCategory[],
  opts: { voice?: boolean } = {},
): string {
  const cats = categories.length
    ? categories.map((c) => `${c.id}: ${c.label}`).join('\n')
    : '(none — categoryId must be null)';
  return `You turn one quick-capture line into fields for a task tracker. Today is ${today} (${fmtWeekday(today)}) in America/Los_Angeles.
Categories (id: label) — use the id, or null if none clearly matches:
${cats}
Rules:
- title: the user's own words, at most ${PARSE_TITLE_MAX} characters. Remove only the parsed meta: a leading category word ("aperture,"), due phrases ("due tmw", "by friday", "today 4pm") and estimates ("30m", "2h"). Keep every other word, in the user's order and casing — never paraphrase, reword, drop or recapitalize a word, even one that looks like noise or a code word.
- notes: if what's left after removing the meta is longer than the title allows, cut the title at a word boundary and put the rest here verbatim (fix obvious typos only). Otherwise null. Every word the user typed ends up in the title, the notes, or a parsed field.
- dueDay: YYYY-MM-DD, only if the user gave a day ("tmw" = tomorrow, a weekday name = the next such day, "today" = today), or today if they gave only a clock time. Otherwise null.
- dueTime: HH:MM 24h, only if the user wrote a clock time ("4pm", "9:30am", "16:00", "noon"). A day alone ("today", "tonight", "tmw") has no time. "10m" or "30m" is an estimate in minutes, never a time. Otherwise null.
- estimateMin: whole minutes, only if the user typed a duration ("30m", "2h", "90 min", "an hour"). Never invent or guess one, even when a task usually takes a known time; "10 pages" is not a duration. Otherwise null.
- Set a field only when the user stated it. Do not add tasks, advice or commentary.${opts.voice ? VOICE_RULES : ''}`;
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
