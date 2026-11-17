// Quick add: one natural-language capture line ("aperture, fix login bug due fri 30m") → create_task
// fields. Claude Haiku does the parsing server-side (the BFF owns the one prompt — lambdas/src/anthropic);
// this module is everything around it that both the Lambda and the app's stub share: the result
// contract, the validator for Haiku's untrusted JSON, and the flow (grammar bypass → model → validate).
// Design record: docs/areas/tasks/quick-add.md.

import { isDayKey, isTimeKey } from './dates';
import { nightDueDay } from './due';
import { hasTaskTokens, parseTaskLine, toCreateInput, type PlaceRef } from './bulkTasks';
import { TASK_NOTES_MAX } from './taskNotes';
import type { CreateTaskInput } from './api';
import type { Category } from './types';
import { resolveSpoken, spokenTimeIn, withoutRelative } from './spokenTime';

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
  today: string;
  dayStartHour: number; // the day start `today` was resolved with — a small-hours clock is tonight's
  line?: string; // the typed line, when known — the guards check it for a clock / a duration
  // A spoken line (voice capture, capture.md): its time comes from the words, resolved against `now` by
  // spokenTime.ts — the model's dueTime is ignored, a past time rolls forward. Absent: the typed rules.
  voice?: { now: number };
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

  // Spoken: the time is the words', never the model's (spokenTime.ts) — and with it the day, when the words
  // were relative or the time had already passed. A day the model gave stays only as "the day named".
  if (ctx.voice) {
    const spoken = spokenTimeIn(ctx.line ?? '');
    if (spoken) {
      const r = resolveSpoken(spoken, input.dueDay ?? null, { now: ctx.voice.now, today: ctx.today });
      input.dueDay = r.day;
      input.dueTime = r.time;
    } else if (p.dueTime != null) dropped.push('dropped due time');
  }
  // A time with no day means today (a product call); a small-hours clock on today means tonight
  // (nightDueDay); a time whose day was dropped is dropped too.
  else if (p.dueTime != null) {
    const t = str(p.dueTime) && /^\d:/.test(p.dueTime) ? `0${p.dueTime}` : p.dueTime;
    const stated = ctx.line === undefined || CLOCK_IN_LINE.test(ctx.line);
    if (str(t) && isTimeKey(t) && stated && (input.dueDay != null || p.dueDay == null)) {
      input.dueTime = t;
      input.dueDay = nightDueDay(input.dueDay ?? ctx.today, t, ctx.today, ctx.dayStartHour);
    } else dropped.push('dropped due time');
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
