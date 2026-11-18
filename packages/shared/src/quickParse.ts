// Quick add: one natural-language capture line ("aperture, fix login bug due fri 30m") → create_task
// fields. Claude Haiku does the parsing server-side (the BFF owns the one prompt — lambdas/src/anthropic);
// this module is everything around it that both the Lambda and the app's stub share: the result
// contract, the validator for Haiku's untrusted JSON, and the flow (grammar bypass → model → validate).
// Design record: docs/areas/tasks/quick-add.md.

import {
  addDays,
  isDayKey,
  isTimeKey,
  USER_TIME_ZONE,
  weekdayOf,
  zonedDayTime,
  zonedEpoch,
} from './dates';
import { nightDueDay } from './due';
import { hasTaskTokens, parseTaskLine, toCreateInput, type PlaceRef } from './bulkTasks';
import { TASK_NOTES_MAX } from './taskNotes';
import { keepTitleWords, type Range, type TitleMeta } from './titleWords';
import type { CreateTaskInput } from './api';
import type { Category } from './types';
import {
  DAY_PART_TIME,
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
      source: 'haiku' | 'grammar'; // 'haiku' means the model, whichever it is (kept on the wire for old clients)
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

// Every match of a global regex, as line ranges.
const rangesOf = (line: string, re: RegExp): Range[] =>
  [...line.matchAll(re)].map((m) => [m.index, m.index + m[0].length] as const);

// Something a spoken clock the voice grammar can't read is made of: a digit, an hour word, a quarter or a
// half ("quarter past five", "half 6").
const SPOKEN_CLOCK_HINT =
  /\d|\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|noon|midnight|quarter|half)\b/i;

// A spoken clock with its half of the day said, in its own words or right beside them: "5 pm", "17:30", "noon",
// "at 5 in the evening", "tonight at 9". Without one, the model's clock is a bare hour and the server picks
// morning or evening. Only beside the clock: "at 9 book the night bus" says no half. "5:30" is 12-hour, so
// only a 24-hour form ("17:30", "08:15") counts.
const HALF_IN =
  /(?:\d|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|clock))\s*(?:a\.?m|p\.?m)\b|\b(?:0\d|1[3-9]|2[0-3]):\d{2}\b|\b(?:noon|midnight|morning|afternoon|evening|night|tonight)\b/i;
const HALF_AFTER =
  /^\s*(?:o['’]?\s?clock\s*)?(?:a\.?m\b|p\.?m\b|(?:in the|this) (?:morning|afternoon|evening)\b|at night\b|tonight\b)/i;
const HALF_BEFORE =
  /\b(?:tonight|this (?:morning|afternoon|evening)|morning|afternoon|evening|night)\s*(?:at|by|around)?\s*$/i;
const halfSaid = (line: string, said: string): boolean => {
  const i = said ? line.toLowerCase().indexOf(said.toLowerCase()) : -1;
  if (i < 0) return HALF_IN.test(line); // the grammar found no clock: the line is all there is
  return (
    HALF_IN.test(said) ||
    HALF_AFTER.test(line.slice(i + said.length)) ||
    HALF_BEFORE.test(line.slice(0, i))
  );
};

// Where the model's spoken clock lands: the grammar's own reading when the two agree (it keeps the rules a bare
// hour, "tonight" and "morning" carry), else the model's — a bare hour when the line says no half of the day.
function placeModelClock(hhmm: string, spoken: SpokenTime | null, line: string): SpokenTime {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const agrees =
    spoken?.kind === 'clock'
      ? spoken.hhmm === hhmm
      : spoken?.kind === 'bare'
        ? spoken.hour % 12 === h % 12 &&
          spoken.minute === m &&
          // a bare hour where the line says its half ("at 5 in the evening") is the grammar missing it
          (spoken.part !== null || !halfSaid(line, spoken.said))
        : spoken?.kind === 'part'
          ? DAY_PART_TIME[spoken.part] === hhmm
          : false;
  if (spoken && agrees) return spoken;
  const said = spoken?.said ?? '';
  return halfSaid(line, said)
    ? { said, kind: 'clock', hhmm }
    : { said, kind: 'bare', hour: h % 12 || 12, minute: m, part: null };
}

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
// Not "the day after tomorrow": that names another day (its own words, the model's).
const TOMORROW_WORD = /(?<!\bday\s+after\s+)\b(tomorrow|tmrw?|tmw)\b/i;
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
// Where the typed words name this very day: its weekday, its month and day, "m/d" or "YYYY-MM-DD" — never a day
// word on its own ("may need to…", "2nd interview", "month-end"), which the model's "today" for a bare clock would
// otherwise freeze.
function dateRanges(line: string, day: string): Range[] {
  const [, m, d] = day.split('-').map(Number) as [number, number, number];
  const month = MONTH_WORDS[m - 1]!;
  const dd = `0?${d}(st|nd|rd|th)?`;
  return [
    day.replace(/-/g, '\\-'),
    `\\b${WEEKDAY_WORDS[weekdayOf(day)]}\\b`,
    `\\b0?${m}/0?${d}(/\\d{2,4})?\\b`,
    `\\b${month}\\.?\\s*${dd}\\b`,
    `\\b${dd}\\s+(of\\s+)?${month}\\b`,
  ].flatMap((re) => rangesOf(line, new RegExp(re, 'gi')));
}
const wordsNameDate = (line: string, day: string) => dateRanges(line, day).length > 0;
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
  // Whole words: "flat 2" isn't "at 2". "at 5" kept from "at 5 o'clock" is kept too, as before AT_HOUR took o'clock.
  const keptWords = (t: SpokenTime) =>
    saidAt(title, t.said) !== null ||
    (/^at\s/i.test(t.said) && saidAt(title, t.said.replace(/\s*o['’]?\s?clock$/i, '')) !== null);
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
  // Spoken: the model reads the clock as said, the code places it (spokenTime.ts) — a bare hour's morning or
  // evening, a past time rolled forward, "in 20 minutes" from the server's clock — and with it the day, when the
  // words were relative or the time had already passed. A day the model gave stays only as "the day named". The
  // grammar's own reading is the fallback (the maintainer, 2026-11-17: the model is the parser): it places a
  // clock the model agrees with, and fills one the model missed.
  if (ctx.voice) {
    // The model kept the words in its title: it read them as part of the task, not a time ("look at one
    // of the leases", "email the team about the 3pm meeting") — unless they were an at/by clock. A delay
    // ("in 20 minutes") is a time whatever the model did with its title.
    const kept = !!spoken && spoken.kind !== 'relative' && keptWords(spoken);
    // A line with no number or hour word in it had no clock to read: a time there is one the model made up.
    const modelClock =
      str(clock) && isTimeKey(clock) && SPOKEN_CLOCK_HINT.test(line ?? '') ? clock : null;
    if (spoken?.kind === 'relative') resolve(spoken);
    else if (modelClock && (!spoken || !kept || due)) {
      const placed = placeModelClock(modelClock, spoken, line ?? '');
      resolve(placed);
      if (due && placed === spoken) input.title = due.title;
    } else if (spoken && (!kept || due)) {
      resolve(spoken);
      if (due) input.title = due.title;
    } else if (p.dueTime != null) dropped.push('dropped due time');
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

  // The title keeps every word the parse didn't use, and loses a due phrase it did (titleWords.ts).
  if (line !== undefined) {
    const meta = titleMeta(line, input, p.dueDay, ctx, categoryLabel, spoken);
    if (meta) input.title = keepTitleWords(line, input.title, meta);
    else if (input.notes)
      titleBackFromNotes(line, input, (i) =>
        titleMeta(line, i, p.dueDay, ctx, categoryLabel, spoken),
      );
  }
  return { input, categoryLabel, dropped };
}

const wordsOf = (t: string) => t.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
// Notes are for a line too long for its title. On a short one the model sometimes moves words it read as noise
// there instead ("devcheck <nonce> call the dentist typed tomorrow at 5 pm" → "call the dentist", notes
// "devcheck <nonce> typed" — dev, 2026-11-18, F232): when every notes word is the line's own and the title with them
// put back still fits, they go back, in place, and the notes go. Otherwise the notes stand, words and all.
function titleBackFromNotes(
  line: string,
  input: CreateTaskInput,
  metaFor: (input: CreateTaskInput) => TitleMeta | null,
): void {
  const lineWords = new Set(wordsOf(line));
  const noteWords = wordsOf(input.notes!);
  if (!noteWords.length || !noteWords.every((w) => lineWords.has(w))) return;
  const meta = metaFor({ ...input, notes: undefined });
  if (!meta) return;
  const title = keepTitleWords(line, input.title, meta);
  const titleWords = new Set(wordsOf(title));
  if (title.length > PARSE_TITLE_MAX || !noteWords.every((w) => titleWords.has(w))) return;
  input.title = title;
  delete input.notes;
}

// A word the parse used is often led by one that goes with it: "before 3pm", "due by fri", "the 20th", "~30m",
// "around 5pm", "for about 30m".
const ABOUT = String.raw`(?:\b(?:around|about|approx(?:imately)?|roughly|after)\s+|~\s*)?`;
const CLOCK_LEAD = new RegExp(
  String.raw`(?:(?:\bdue\s+)?\b(?:at|by|before|until|till|from)\s+|\bdue\s+|@\s*)?${ABOUT}$`,
  'i',
);
const DAY_LEAD =
  /(?:(?:\bdue\s+)?\b(?:by|on|before|until|till)\s+|\bdue\s+)?(?:\b(?:this|next|the|coming)\s+)*$/i;
// "today" / "tomorrow" take no "on" or "this": "decide what to work on tomorrow" keeps its "on".
const REL_DAY_LEAD = /(?:(?:\bdue\s+)?\b(?:by|before|until|till)\s+|\bdue\s+)?$/i;
const EST_LEAD = new RegExp(String.raw`(?:\bfor\s+)?${ABOUT}$`, 'i');
// A range grows to the whole words it touches ("5 p" of "5 p.m.", "30pm" of "5.30pm"), then takes its leader.
function led(line: string, [s, e]: Range, lead: RegExp): Range {
  while (s > 0 && !/\s/.test(line[s - 1]!)) s--;
  while (e < line.length && !/\s/.test(line[e]!)) e++;
  return [s - lead.exec(line.slice(0, s))![0].length, e];
}
const CLOCKS = new RegExp(CLOCK_IN_LINE.source, 'gi');
const DURATIONS = new RegExp(DURATION_IN_LINE.source, 'gi');
const DAY_WORDS = /\b(today|tdy|tonight)\b|(?<!\bday\s+after\s+)\b(tomorrow|tmrw?|tmw)\b/gi;
const DAY_PARTS =
  /\b(?:(?:this|tomorrow|in the)\s+)?(?:morning|afternoon|evening|night)\b|\btonight\b/gi;
// A clock or day the task is about, not when it's due: "move standup to 5pm", "prep for this friday 5pm".
const OBJECT_OF = /\b(?:to|for|of|about|from|than)\s+$/i;
// A clock used as a noun is the task's too: "prep notes for the 3pm", "skip my 9am".
const CLOCK_OBJECT = /\b(?:to|for|of|about|from|than|the|my|our|your|that)\s+$/i;
// The rest of a compound duration: "an hour and a half", "1 hour and 30 minutes", "2h and 30m".
// The rest of a clock range: "3pm to 4pm", "3-4pm" is one token already.
const MORE_CLOCK = new RegExp(
  String.raw`^\s*(?:to|until|till|[-–])\s*(?:${CLOCK_IN_LINE.source})`,
  'i',
);
const MORE_DURATION = /^\s+and\s+(?:a\s+half|\d+\s*(?:m|mins?|minutes?))\b/i;
// A spoken line's lead-in, and the "to" / "that" / "about" after it once the time is said: "remind me tomorrow to …".
const REMIND = /^\s*remind me\b/i;
const REMIND_JOIN = /^\s*(?:to|that|about)\b/i;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Where the grammar's `said` sits: its first whole-word occurrence ("at 2", not the "at 2" in "flat 2").
function saidAt(line: string, said: string): Range | null {
  const m = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(said)}`, 'iu').exec(line);
  return m ? [m.index, m.index + said.length] : null;
}

// The line ranges the parse used, for keepTitleWords: a clock (a spoken time on voice) when a time was set, the
// day words when a day was, a duration when an estimate was, the category word when that category was. Null — the
// model's title stands — when a set field has no words to show for it (a day from "end of month", a clock from
// "quarter past five") or notes took the overflow: words the model dropped then may have been the field's.
function titleMeta(
  line: string,
  input: CreateTaskInput,
  modelDay: unknown,
  ctx: ParseContext,
  categoryLabel: string | null,
  spoken: SpokenTime | null,
): TitleMeta | null {
  if (input.notes) return null;
  const clocks: Range[] = [];
  if (input.dueTime) {
    for (const [s0, e0] of rangesOf(line, CLOCKS))
      clocks.push([s0, e0 + (MORE_CLOCK.exec(line.slice(e0))?.[0].length ?? 0)]);
    const said =
      spoken && (ctx.voice || spoken.kind === 'clock') ? saidAt(line, spoken.said) : null;
    if (said) clocks.push(said);
    clocks.push(...rangesOf(line, DAY_PARTS));
  }
  if (input.dueTime && !clocks.length) return null;
  // A clock the task is about isn't the due's: "move standup to 5pm" keeps "to 5pm".
  const due = clocks
    .map((r) => led(line, r, CLOCK_LEAD))
    .filter((r) => !CLOCK_OBJECT.test(line.slice(0, r[0])));
  // The words for the due day, led: "today" / "tomorrow" only when they name it ("the day after tomorrow" doesn't),
  // a weekday or date the parse's day matches. On voice, "today" goes with a said time whatever the day.
  const days: Range[] = [];
  const dayKnown = (d: unknown): d is string => str(d) && isDayKey(d);
  const parsedDays = [...new Set([input.dueDay, modelDay].filter(dayKnown))];
  const calToday = zonedDayTime(ctx.now, USER_TIME_ZONE).day;
  const named = (word: string) =>
    (TOMORROW_WORD.test(word)
      ? [addDays(ctx.today, 1), addDays(calToday, 1)]
      : [ctx.today, calToday, addDays(ctx.today, 1)]
    ).some((d) => parsedDays.includes(d));
  if (input.dueDay || (ctx.voice && input.dueTime)) {
    for (const m of line.matchAll(DAY_WORDS))
      if (named(m[0]) || (ctx.voice && input.dueTime && TODAY_WORD.test(m[0])))
        days.push(led(line, [m.index, m.index + m[0].length], REL_DAY_LEAD));
    for (const d of parsedDays)
      days.push(...dateRanges(line, d).map((r) => led(line, r, DAY_LEAD)));
  }
  // A day with no words for it is the model's reading of a phrase no list knows — unless it's the day a bare
  // clock lands on ("call 9am": today, or tomorrow when the model rolled a past one itself).
  const dueTime = input.dueTime;
  const clockDay =
    dueTime != null &&
    (modelDay == null ||
      modelDay === ctx.today ||
      modelDay === calToday ||
      // tomorrow only when the clock had passed today: the model rolled it as the server would
      (modelDay === addDays(calToday, 1) &&
        zonedEpoch(calToday, dueTime, USER_TIME_ZONE) <= ctx.now));
  if (input.dueDay && !days.length && !clockDay) return null;
  const meta: Range[] = [...due, ...days];
  if (input.dueDay) meta.push(...rangesOf(line, DAY_PARTS)); // "tomorrow morning", typed with no clock
  if (input.estimateMin)
    for (const r of rangesOf(line, DURATIONS)) {
      const more = MORE_DURATION.exec(line.slice(r[1]));
      meta.push(led(line, [r[0], r[1] + (more?.[0].length ?? 0)], EST_LEAD));
    }
  if (input.dueDay || input.dueTime) meta.push(...rangesOf(line, /\bdue\b/gi));
  const lead: Range[] = [];
  if (ctx.voice) {
    const remind = REMIND.exec(line);
    if (remind) {
      // Past the lead-in and any said time or day after it: a joining "to" is the lead-in's too, and the whole
      // run goes from the title even when the model kept it ("remind me tomorrow at 9 am to …").
      let at = remind[0].length;
      for (;;) {
        const next = meta.find(([s, e]) => e > at && /^\s*$/.test(line.slice(at, s)));
        if (!next) break;
        at = next[1];
      }
      const join = REMIND_JOIN.exec(line.slice(at));
      meta.push([0, remind[0].length], ...(join ? [[at, at + join[0].length] as const] : []));
      lead.push(join ? [0, at + join[0].length] : [0, remind[0].length]);
    }
  }
  // The category word: the model may drop it; with a separator after it ("aperture, …") it always goes.
  if (categoryLabel) {
    const label = escapeRe(categoryLabel.trim()).replace(/\s+/g, '\\s+');
    const word = new RegExp(`^\\s*${label}(?![\\p{L}\\p{N}])`, 'iu').exec(line);
    if (word) {
      const sep = /^(?:\s*[,:]|\s+[-–—]+(?=\s))/.exec(line.slice(word[0].length));
      meta.push([0, word[0].length + (sep?.[0].length ?? 0)]);
      if (sep) lead.push([0, word[0].length + sep[0].length]);
    }
  }
  return { meta, tail: dueTail(line, input, days), lead };
}

// A due phrase the parse used, taken out when it ends the title: the line's one stated clock when it is the due
// time, led ("before 3pm", "until 5pm") or bare ("call the bank 6pm" — a bare clock mid-title, "watch 9pm show",
// stays), and a day beside it or with its own connector ("today 3pm", "5pm friday", "by friday").
function dueTail(line: string, input: CreateTaskInput, days: readonly Range[]): Range[] {
  const spoken = spokenTimeIn(line);
  if (spoken?.kind !== 'clock' || spoken.hhmm !== input.dueTime) return [];
  const said = saidAt(line, spoken.said);
  if (!said) return [];
  // A second stated clock ("move standup at 3pm to 5pm") makes this one no surer than the other.
  if (spokenTimeIn(line.slice(0, said[0]) + line.slice(said[1]))?.kind === 'clock') return [];
  const clock = led(line, said, CLOCK_LEAD);
  if (CLOCK_OBJECT.test(line.slice(0, clock[0]))) return [];
  const near = (a: Range, b: Range) =>
    /^\s*$/.test(line.slice(Math.min(a[1], b[1]), Math.max(a[0], b[0])));
  // "this friday" alone isn't a connector, and a day the task is about stays: "prep for this friday 5pm".
  const own = (d: Range) => /^(?:due|by|on|before|until|till)\b/i.test(line.slice(d[0]));
  const day = input.dueDay
    ? days.filter((d) => (near(d, clock) || own(d)) && !OBJECT_OF.test(line.slice(0, d[0])))
    : [];
  return [clock, ...day];
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

// A spoken line saved without the model (it failed, timed out, or was past a cap): the time its own words say,
// placed by the voice rules, so a reminder still rings (the maintainer, 2026-11-17: the grammar is the fallback).
// "today" / "tonight" name no other day and "tomorrow" is the app's next, as the model reads it; any other day word ("friday",
// "in 2 days", "the 20th") the grammar can't place, so no time at all — a wrong day is worse than none.
export function spokenFallbackDue(
  line: string,
  ctx: Pick<ParseContext, 'now' | 'today'>,
): { dueDay: string; dueTime: string } | null {
  const spoken = spokenTimeIn(line);
  if (!spoken) return null;
  const tomorrow = spoken.kind !== 'relative' && TOMORROW_WORD.test(line);
  const rest = line
    .replace(new RegExp(TODAY_WORD.source, 'gi'), ' ')
    .replace(new RegExp(TOMORROW_WORD.source, 'gi'), ' ');
  if (spoken.kind !== 'relative' && DAY_WORD.test(rest)) return null;
  const r = resolveSpoken(spoken, tomorrow ? addDays(ctx.today, 1) : null, {
    now: ctx.now,
    today: ctx.today,
    dayInWords: tomorrow,
  });
  return { dueDay: r.day, dueTime: r.time };
}

// One line for a toast or receipt: why a parse fell back to a raw save.
export const parseFailText = (r: { reason: ParseFailReason; detail?: string }): string =>
  r.detail ? `${r.reason}: ${r.detail}` : r.reason;
