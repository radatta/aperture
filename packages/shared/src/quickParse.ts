// Quick add: one natural-language capture line ("aperture, fix login bug due fri 30m") → create_task
// fields. Claude Haiku does the parsing server-side (the BFF owns the one prompt — lambdas/src/anthropic);
// this module is everything around it that both the Lambda and the app's stub share: the result
// contract, the validator for Haiku's untrusted JSON, and the flow (grammar bypass → model → validate).
// Design record: docs/areas/tasks/quick-add.md.

import { addDays, isDayKey, isTimeKey, weekdayOf } from './dates';
import { nightDueDay } from './due';
import { hasTaskTokens, parseTaskLine, toCreateInput, type PlaceRef } from './bulkTasks';
import { TASK_NOTES_MAX } from './taskNotes';
import type { CreateTaskInput } from './api';
import type { Category } from './types';
import {
  DAY_WORD,
  dueClock,
  resolveSpoken,
  spokenTimeIn,
  withoutRelative,
  type SpokenTime,
} from './spokenTime';

// Longer than this is never sent to the model; the raw save still takes the whole line as the title.
// Sized to the model's output: the overflow comes back as notes, so a much longer line can't fit in
// max_tokens (lambdas/src/anthropic/liveAnthropic.ts) or the 8s budget.
export const PARSE_TEXT_MAX = 2_500;
// The title length the prompt asks for. A prompt rule only — titles are stored verbatim.
export const PARSE_TITLE_MAX = 80;

export type ParseFailReason =
  | 'unavailable' // no key on this stage, parsing off (testMode), or the text is over PARSE_TEXT_MAX
  | 'timeout'
  | 'network'
  | 'api' // non-200, or a stop other than end_turn (refusal, max_tokens)
  | 'bad-json'
  | 'empty-title' // nothing usable came back
  | 'grammar'; // a ' | ' line that fails the strict grammar (MCP/Raycast callers — the app checks it locally)

export type ParseTaskResult =
  | {
      ok: true;
      source: 'haiku' | 'grammar';
      input: CreateTaskInput;
      categoryLabel: string | null;
      placeName: string | null; // the list a known `@slug` put it on (places.ts)
      dropped: string[]; // fields the model returned that the server would reject, named for the receipt
      today: string; // the day "today"/"tmw" were resolved against (the user's dayStartHour)
    }
  | { ok: false; reason: ParseFailReason; detail?: string };

// What the model is asked for: one object, every key present, nulls allowed.
export interface ParsedTaskFields {
  title: string;
  notes: string | null;
  categoryId: string | null;
  dueDay: string | null;
  dueTime: string | null;
  estimateMin: number | null;
}

export type ParseCategory = Pick<Category, 'id' | 'label'>;

export interface ParseContext {
  categories: readonly ParseCategory[]; // active only
  places: readonly PlaceRef[]; // alive — a known `@slug` word is taken before the model sees the line
  today: string; // the app's today (dayStartHour)
  dayStartHour: number; // the day start `today` was resolved with — a small-hours clock on it is its night's
  now: number; // a clock with no day of its own lands on its next occurrence after this (spokenTime.ts)
  line?: string; // the typed line, when known — the guards check it for a clock / a duration
  // A spoken line (voice capture, capture.md): its time comes from the words — the model's dueTime is
  // ignored. Absent: the typed rules (the model's clock, or one stated outright).
  voice?: boolean;
}

// A clock the user actually wrote: "4pm", "9:30am", "4 p", "16:00", "noon", "midnight". A model has read
// a bare "today" as 10am, and "10m" (an estimate) as a time — a due time with no clock in the line is one
// it made up, so the validator drops it (it would also put an invented block on the calendar).
const CLOCK_IN_LINE =
  /\b\d{1,2}(:\d{2})?\s*(am|pm|a\.m\.|p\.m\.|a|p)\b|\b\d{1,2}:\d{2}\b|\bnoon\b|\bmidnight\b/i;
// A duration the user actually wrote: "30m", "2h", "1.5 hrs", "90 min", "an hour", "half an hour". Dev check
// 2026-10-13: "call dentist tonight" came back with a 15m estimate nobody typed — dropped the same way.
const DURATION_IN_LINE =
  /\b\d+(\.\d+)?\s*(m|mins?|minutes?|h|hrs?|hours?)\b|\b(an?|one|two|three|half an?)\s+hours?\b|\bhalf\s+hour\b/i;

// Something a spoken clock the voice grammar can't read is made of: a digit, an hour word, a quarter or a
// half ("quarter past five", "half 6").
const SPOKEN_CLOCK_HINT =
  /\d|\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|noon|midnight|quarter|half)\b/i;

// The model's outcome, as the flow sees it. A failure never throws — every one is a raw save.
export type ModelOutcome =
  | { ok: true; fields: unknown }
  | { ok: false; reason: Exclude<ParseFailReason, 'empty-title' | 'grammar'>; detail?: string };

// The model's time budget: 4s, +1s per 400 characters (long lines come back as long notes), capped at 8s
// — well inside the Lambda's 15s with the SSM + DynamoDB reads in front of it.
export const parseBudgetMs = (text: string): number =>
  Math.min(4_000 + Math.floor(text.length / 400) * 1_000, 8_000);

const str = (v: unknown): v is string => typeof v === 'string';

// One `input` shape for both sources: only the fields that are set. create_task (MCP) reads a present
// null as "given" and rejects it, so a grammar line's nulls would turn a good parse into a raw save.
const present = (input: CreateTaskInput): CreateTaskInput =>
  Object.fromEntries(Object.entries(input).filter(([, v]) => v != null)) as CreateTaskInput;

const TODAY_WORD = /\b(today|tdy|tonight)\b/i;
const TOMORROW_WORD = /\b(tomorrow|tmrw?|tmw)\b/i;
const MONTH_WORDS = [
  'jan(uary)?',
  'feb(ruary)?',
  'mar(ch)?',
  'apr(il)?',
  'may',
  'june?',
  'july?',
  'aug(ust)?',
  'sept?(ember)?',
  'oct(ober)?',
  'nov(ember)?',
  'dec(ember)?',
];
const WEEKDAY_WORDS = [
  'sun(day)?',
  'mon(day)?',
  'tue(s|sday)?',
  'wed(nesday)?',
  'thu(r|rs|rsday)?',
  'fri(day)?',
  'sat(urday)?',
];
// Whether the typed words name this very day: its weekday, its month and day, "m/d" or "YYYY-MM-DD" — never a
// day word on its own ("may need to…", "2nd interview", "month-end"), which the model's "today" for a bare clock
// would otherwise freeze.
function wordsNameDate(line: string, day: string): boolean {
  if (line.includes(day)) return true;
  const [, m, d] = day.split('-').map(Number) as [number, number, number];
  const month = MONTH_WORDS[m - 1]!;
  const dd = `0?${d}(st|nd|rd|th)?`;
  return [
    `\\b${WEEKDAY_WORDS[weekdayOf(day)]}\\b`,
    `\\b0?${m}/0?${d}(/\\d{2,4})?\\b`,
    `\\b${month}\\.?\\s*${dd}\\b`,
    `\\b${dd}\\s+(of\\s+)?${month}\\b`,
  ].some((re) => new RegExp(re, 'i').test(line));
}
// The day a typed line names (the maintainer, 2026-11-17): "today" / "tonight" is the app's today (its small
// hours that day's night), "tomorrow" the day after — from the words, whatever day the model read; any other day
// only when the words name the model's. Null: no day of its own, so the clock rolls.
function wordsDay(
  line: string,
  modelDay: string | null,
  today: string,
): { day: string; today: boolean } | null {
  if (TODAY_WORD.test(line)) return { day: today, today: true };
  if (TOMORROW_WORD.test(line)) return { day: addDays(today, 1), today: false };
  return modelDay && wordsNameDate(line, modelDay) ? { day: modelDay, today: false } : null;
}

// Keep each field the server would accept; a bad one is dropped and named. The model's JSON is untrusted
// (structured outputs can't carry numeric or calendar constraints), so this takes `unknown`. Returns null
// only for an unusable (blank or missing) title.
export function validateParsedTask(
  raw: unknown,
  ctx: ParseContext,
): { input: CreateTaskInput; categoryLabel: string | null; dropped: string[] } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  const title = str(p.title) ? p.title.trim() : '';
  if (!title) return null;
  const input: CreateTaskInput = { title };
  const dropped: string[] = [];
  let categoryLabel: string | null = null;

  if (str(p.notes) && p.notes.trim()) {
    const notes = p.notes.replace(/\r\n?/g, '\n').trim();
    input.notes = notes.slice(0, TASK_NOTES_MAX).trim();
    if (notes.length > TASK_NOTES_MAX) dropped.push('notes cut');
  }

  if (p.categoryId != null) {
    const cat = str(p.categoryId) ? ctx.categories.find((c) => c.id === p.categoryId) : undefined;
    if (cat) {
      input.categoryId = cat.id;
      categoryLabel = cat.label;
    } else dropped.push('unknown category');
  }

  if (p.dueDay != null) {
    if (str(p.dueDay) && isDayKey(p.dueDay)) input.dueDay = p.dueDay;
    else dropped.push('dropped due day');
  }

  // A clock lands on its next occurrence after now, typed or spoken (the maintainer, 2026-11-17): "1 am" at
  // 02:01 is tomorrow's 01:00, "9am" at 3pm tomorrow's. A day the model gave counts only when it's after the
  // calendar's today (resolveSpoken) — except a day a typed line names, below.
  const line = ctx.line;
  const spoken = line === undefined ? null : spokenTimeIn(line);
  const keptWords = (t: SpokenTime) => title.toLowerCase().includes(t.said.toLowerCase());
  // A stated clock phrased as a due ("at 1 am", "by 5pm") is the due time even when the model kept it in its
  // title — seen on dev, 2026-11-17, "…at 1 am" back unchanged with no time. The phrase leaves the title.
  const due = spoken?.kind === 'clock' ? dueClock(line!, title, spoken.said) : null;
  const clock = str(p.dueTime) && /^\d:/.test(p.dueTime) ? `0${p.dueTime}` : p.dueTime;
  const resolve = (t: SpokenTime) => {
    const r = resolveSpoken(t, input.dueDay ?? null, {
      now: ctx.now,
      today: ctx.today,
      dayInWords: DAY_WORD.test(line ?? ''),
    });
    input.dueDay = r.day;
    input.dueTime = r.time;
  };
  // Spoken: the time is the words', never the model's (spokenTime.ts) — and with it the day, when the words
  // were relative or the time had already passed. A day the model gave stays only as "the day named".
  if (ctx.voice) {
    // The model kept the words in its title: it read them as part of the task, not a time ("look at one
    // of the leases", "email the team about the 3pm meeting") — unless they were an at/by clock. A delay
    // ("in 20 minutes") is a time whatever the model did with its title.
    const kept = !!spoken && spoken.kind !== 'relative' && keptWords(spoken);
    if (spoken && (!kept || due)) {
      resolve(spoken);
      if (due) input.title = due.title;
    }
    // Words the grammar can't read ("quarter past five"): the model was given the typed prompt, which
    // sets a clock only when one was said — taken, and rolled forward like any stated time.
    // A line with no number or hour word in it had no clock to read: a time there is one the model made up.
    else if (!spoken && str(clock) && isTimeKey(clock) && SPOKEN_CLOCK_HINT.test(line ?? ''))
      resolve({ said: '', kind: 'clock', hhmm: clock });
    else if (p.dueTime != null) dropped.push('dropped due time');
  }
  // Typed: the model's clock when the line states one; a time whose day was dropped is dropped too. A clock
  // the line states outright that the model missed ("call the bank at 6 pm" back with no time, dev 2026-11-16)
  // is filled from the words — when the model took them out of its title, or they're an at/by clock. Kept
  // otherwise ("watch 9pm show", "move the 3pm to 5pm"), they weren't the due time. A different model time
  // stands.
  else {
    const stated = line === undefined || CLOCK_IN_LINE.test(line);
    const dayKept = input.dueDay != null || p.dueDay == null;
    const modelTime = p.dueTime != null && str(clock) && isTimeKey(clock) && stated ? clock : null;
    const words = spoken?.kind === 'clock' ? spoken : null;
    const time = modelTime ?? (words && (due || !keptWords(words)) ? words.hhmm : null);
    if (time && dayKept) {
      // A day the typed line names stays as written (the maintainer, 2026-11-17): "pay rent today 9am" at 3pm is
      // overdue, "nov 10 9am" is Nov 10. A small-hours clock on the app's today is that day's night — "today
      // 1am" at 02:01 is the 01:00 just gone (nightDueDay). Only a clock with no day word rolls.
      const named = line === undefined ? null : wordsDay(line, input.dueDay ?? null, ctx.today);
      if (named) {
        input.dueTime = time;
        input.dueDay = named.today
          ? nightDueDay(named.day, time, ctx.today, ctx.dayStartHour)
          : named.day;
      } else resolve({ said: '', kind: 'clock', hhmm: time });
      // The same line keeps the same title whatever the model did with the phrase.
      if (due && time === words?.hhmm) input.title = due.title;
    } else if (p.dueTime != null) dropped.push('dropped due time');
  }

  // 0 is "no estimate" (the grammar wants >= 1), so it clears quietly rather than reading as an error.
  if (p.estimateMin != null && p.estimateMin !== 0) {
    const estLine = ctx.line !== undefined && ctx.voice ? withoutRelative(ctx.line) : ctx.line;
    const statedEst = estLine === undefined || DURATION_IN_LINE.test(estLine);
    if (
      statedEst &&
      typeof p.estimateMin === 'number' &&
      Number.isInteger(p.estimateMin) &&
      p.estimateMin > 0
    )
      input.estimateMin = p.estimateMin;
    else dropped.push('dropped estimate');
  }

  return { input, categoryLabel, dropped };
}

// A known `@slug` word in a natural-language line ("shampoo @grocer"): the place, and the line without it.
// Deterministic, like the grammar — the model never guesses a place. An unknown `@word` stays in the line.
// Trailing punctuation ("@grocer, nails") goes with the word.
export function takePlaceWord(
  line: string,
  places: readonly PlaceRef[],
): { place: PlaceRef | null; rest: string } {
  for (const m of line.matchAll(/(^|\s)@([A-Za-z0-9][A-Za-z0-9-]*)([,.;:!?]*)(?=\s|$)/g)) {
    const place = places.find((p) => p.slug === m[2]!.toLowerCase());
    if (!place) continue;
    const at = m.index + m[1]!.length;
    const rest = (line.slice(0, at) + line.slice(at + 1 + m[2]!.length + m[3]!.length))
      .replace(/\s+/g, ' ')
      .trim();
    return { place, rest };
  }
  return { place: null, rest: line };
}

// The one flow both the Lambda and the stub run. A ' | ' line takes the strict grammar (deterministic —
// the model never sees it); anything else goes to `model`, and its fields through validateParsedTask.
export async function runQuickParse(
  text: string,
  ctx: ParseContext,
  model: (line: string) => Promise<ModelOutcome>,
): Promise<ParseTaskResult> {
  const line = text.trim();
  if (!line) return { ok: false, reason: 'empty-title' };
  if (hasTaskTokens(line)) {
    const l = parseTaskLine(line, ctx.categories, ctx.places);
    if (l.errors.length) return { ok: false, reason: 'grammar', detail: l.errors[0] };
    const label = ctx.categories.find((c) => c.id === l.categoryId)?.label ?? null;
    return {
      ok: true,
      source: 'grammar',
      input: present(toCreateInput(l)),
      categoryLabel: label,
      placeName: ctx.places.find((p) => p.slug === l.place)?.name ?? null,
      dropped: l.warnings,
      today: ctx.today,
    };
  }
  if (line.length > PARSE_TEXT_MAX)
    return {
      ok: false,
      reason: 'unavailable',
      detail: `over ${PARSE_TEXT_MAX.toLocaleString('en-US')} characters`,
    };
  const { place, rest } = takePlaceWord(line, ctx.places);
  if (!rest) return { ok: false, reason: 'empty-title' };
  const out = await model(rest);
  if (!out.ok) return out;
  const v = validateParsedTask(out.fields, { ...ctx, line: rest });
  if (!v) return { ok: false, reason: 'empty-title' };
  if (place) v.input.place = place.slug;
  return { ok: true, source: 'haiku', ...v, placeName: place?.name ?? null, today: ctx.today };
}

// One line for a toast or receipt: why a parse fell back to a raw save.
export const parseFailText = (r: { reason: ParseFailReason; detail?: string }): string =>
  r.detail ? `${r.reason}: ${r.detail}` : r.reason;
