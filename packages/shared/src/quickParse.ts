// Quick add: one natural-language capture line ("aperture, fix login bug due fri 30m") → create_task
// fields. Claude Haiku does the parsing server-side (the BFF owns the one prompt — lambdas/src/anthropic);
// this module is everything around it that both the Lambda and the app's stub share: the result
// contract, the validator for Haiku's untrusted JSON, and the flow (grammar bypass → model → validate).
// Design record: docs/areas/tasks/quick-add.md.

import { isDayKey, isTimeKey } from './dates';
import { hasTaskTokens, parseTaskLine, toCreateInput } from './bulkTasks';
import { TASK_NOTES_MAX } from './taskNotes';
import type { CreateTaskInput } from './api';
import type { Category } from './types';

// Longer than this is never sent to the model; the raw save still takes the whole line as the title.
export const PARSE_TEXT_MAX = 5_000;
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
  today: string;
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

  // A time with no day means today (a product call); a time whose day was dropped is dropped too.
  if (p.dueTime != null) {
    const t = str(p.dueTime) && /^\d:/.test(p.dueTime) ? `0${p.dueTime}` : p.dueTime;
    if (str(t) && isTimeKey(t) && (input.dueDay != null || p.dueDay == null)) {
      input.dueTime = t;
      input.dueDay ??= ctx.today;
    } else dropped.push('dropped due time');
  }

  // 0 is "no estimate" (the grammar wants >= 1), so it clears quietly rather than reading as an error.
  if (p.estimateMin != null && p.estimateMin !== 0) {
    if (typeof p.estimateMin === 'number' && Number.isInteger(p.estimateMin) && p.estimateMin > 0)
      input.estimateMin = p.estimateMin;
    else dropped.push('dropped estimate');
  }

  return { input, categoryLabel, dropped };
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
    const l = parseTaskLine(line, ctx.categories);
    if (l.errors.length) return { ok: false, reason: 'grammar', detail: l.errors[0] };
    const label = ctx.categories.find((c) => c.id === l.categoryId)?.label ?? null;
    return {
      ok: true,
      source: 'grammar',
      input: toCreateInput(l),
      categoryLabel: label,
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
  const out = await model(line);
  if (!out.ok) return out;
  const v = validateParsedTask(out.fields, ctx);
  if (!v) return { ok: false, reason: 'empty-title' };
  return { ok: true, source: 'haiku', ...v, today: ctx.today };
}

// One line for a toast or receipt: why a parse fell back to a raw save.
export const parseFailText = (r: { reason: ParseFailReason; detail?: string }): string =>
  r.detail ? `${r.reason}: ${r.detail}` : r.reason;
