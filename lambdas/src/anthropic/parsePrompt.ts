import { DUE_TIME_HALVES, fmtWeekday, PARSE_TITLE_MAX } from '@aperture/shared';
import type { ParseCategory } from '@aperture/shared';

// Quick add's one prompt — the BFF owns it, for the app, Siri and Raycast alike (the capture route,
// /api/capture) and the parse_task MCP tool. Pure, so a snapshot pins the exact wording sent to the model.

// Sonnet, not Haiku (the maintainer, 2026-11-17: the parse is every capture's path, the app's ✨ and Siri alike).
// Thinking off (`between_tools` — Sonnet 5.5 refuses `disabled`) at low effort: the parse is on Siri's clock.
export const PARSE_MODEL = 'claude-sonnet-5-5';
export const PARSE_THINKING = 'between_tools';
export const PARSE_EFFORT = 'low';

// A spoken line (voice capture, capture.md) adds VOICE_RULES: the model reads the clock as said and says whether
// the words gave its half of the day (dueTimeHalf); the server places it (a bare hour's morning or evening, a
// night's small hours after its day, a past clock rolled forward, "in 20 minutes" from its own clock —
// quickParse.ts validateParsedTask).
const VOICE_RULES = `
The line was spoken, not typed:
- Also remove from the title any spoken time ("at 5", "five o'clock", "at 8 tonight", "in 20 minutes", "in an hour", "tonight", "this morning", "tomorrow morning") and a leading "remind me to" or "remind me".
- dueTime, instead of the rule above: the clock the user said, HH:MM 24h, read as said. "at 5" or "five o'clock" with nothing in the line saying its half of the day is 05:00 — give the hour as said; the server picks morning or evening. "5 pm" is 17:00, "quarter past five pm" 17:15, "half past 6 in the morning" 06:30, "at 8 tonight" 20:00, "at 1 tonight" 01:00, "noon" 12:00. "tonight" with no clock is 20:00; "this morning" or "tomorrow morning" with no clock is 09:00. A delay ("in 20 minutes", "in an hour") is not a clock: null, the server works it out. No time said: null. "at 12 tonight" is 00:00. When the words say the half of the day, anywhere in the line, give the 24h time: "at 5 in the evening" or "at 5 o'clock this evening" 17:00, "at 8 tomorrow evening" 20:00, "remind me this afternoon to call mum at 4" 16:00.
- dueDay: only for a day the user said ("tomorrow", "friday", "next monday"). A spoken time alone, "today", "tonight" or "this morning" is not a day: null. For "friday night" or "tomorrow night" give that day even for a small hour ("at 1 friday night" is friday, 01:00) — never move the day yourself; the server does.
- dueTimeHalf: whether the user's words say which half of the day dueTime is in. null when dueTime is null.
  "night": a night phrase about that time, anywhere in the line — "tonight", "at night", "friday night", "tomorrow night" ("at 8 tonight", "at 1 friday night", "remind me tonight to call mum at 9", "1 am friday night"), or "tonight" with no clock. It wins over "stated".
  "stated": am/pm ("5 pm"), a 24-hour clock ("17:30"), noon or midnight, or a morning / afternoon / evening phrase about that time, anywhere in the line ("at 5 in the evening", "at 8 tomorrow evening", "remind me this afternoon to call mum at 4"), or "this morning" / "tomorrow morning" with no clock.
  "none": a clock with nothing saying which half — "at 5", "five o'clock", "at 5:30", "quarter past five", "friday at 5". A day-part word that belongs to the task says nothing: "at 5 send the morning report", "at 5 send this morning's notes", "at 9 book the night bus", "at 9 book the tonight show tickets" are all "none".`;

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
- categoryId: null unless the line names a category's label or is plainly about it. Most lines have none. Never pick a category because it is the only one or the nearest.
- title: the user's own words, at most ${PARSE_TITLE_MAX} characters. Remove only the parsed meta: a leading category word ("aperture,") only when it names one of the categories above — then set categoryId to it —, due phrases ("due tmw", "by friday", "before 3pm", "until 5pm", "today 4pm") and estimates ("30m", "2h"). Keep every other word, in the user's order and casing — never paraphrase, reword, drop or recapitalize a word, even one that looks like noise, a remark or a code word. A word beside a time is still a title word: "email the plumber done at 9 am" is titled "email the plumber done".
- notes: if what's left after removing the meta is longer than the title allows, cut the title at a word boundary and put the rest here verbatim (fix obvious typos only). Otherwise null. Every word the user typed ends up in the title, the notes, or a parsed field.
- dueDay: YYYY-MM-DD, only if the user gave a day ("tmw" = tomorrow, a weekday name = the next such day, "today" = today), or today if they gave only a clock time. Otherwise null.
- dueTime: HH:MM 24h, only if the user wrote a clock time ("4pm", "9:30am", "16:00", "noon"). A day alone ("today", "tonight", "tmw") has no time. "10m" or "30m" is an estimate in minutes, never a time. Otherwise null.
- estimateMin: whole minutes, only if the user typed a duration ("30m", "2h", "90 min", "an hour"). Never invent or guess one, even when a task usually takes a known time; "10 pages" is not a duration. Otherwise null.
- Set a field only when the user stated it. Do not add tasks, advice or commentary.${opts.voice ? VOICE_RULES : ''}`;
}

// Structured outputs can't carry numeric, length or calendar constraints — validateParsedTask checks those.
export function parseOutputSchema(
  categoryIds: readonly string[],
  opts: { voice?: boolean } = {},
): Record<string, unknown> {
  const nullable = (s: Record<string, unknown>) => ({ anyOf: [s, { type: 'null' }] });
  // A spoken line also says whether its words gave the clock's half of the day (quickParse.ts placeModelClock).
  const half = opts.voice
    ? {
        dueTimeHalf: nullable({
          type: 'string',
          enum: [...DUE_TIME_HALVES],
          description:
            'Whether the words say which half of the day dueTime is in. null when dueTime is null.',
        }),
      }
    : {};
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'title',
      'notes',
      'categoryId',
      'dueDay',
      'dueTime',
      'estimateMin',
      ...(opts.voice ? ['dueTimeHalf'] : []),
    ],
    properties: {
      title: { type: 'string' },
      notes: nullable({ type: 'string' }),
      categoryId: categoryIds.length
        ? nullable({ type: 'string', enum: [...categoryIds] })
        : { type: 'null' },
      dueDay: nullable({ type: 'string', format: 'date' }),
      dueTime: nullable({ type: 'string', description: 'HH:MM, 24h' }),
      estimateMin: nullable({ type: 'integer' }),
      ...half,
    },
  };
}
